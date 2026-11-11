#Requires -Version 5.1
<#
.SYNOPSIS
    dsh-superagent 的 Windows 服务控制脚本。语义对齐上游 POSIX 脚本 scripts/dsh-superagent。

.DESCRIPTION
    上游用 tmux + fcntl.flock + ps + SIGINT 管理一个常驻的 DSH profile 进程。Windows 上没有这些原语，
    本脚本用下面的替代物实现同一套语义：

      上游                        本脚本
      fcntl.flock 操作互斥     →  命名 Mutex "Local\dsh-superagent-<profile>"
      ps 扫描进程              →  Get-CimInstance Win32_Process + 命令行里的 --profile
      tmux 会话保活            →  cmd.exe 子进程（隐藏窗口，输出重定向到 .artifacts 日志）
      os.kill(pid, SIGINT)     →  AttachConsole + GenerateConsoleCtrlEvent(CTRL_C_EVENT)
      tmux 会话结束            →  轮询进程消失；超时报错退出、不强杀（与上游一致，-Force 才强杀）

    退出码（与上游一致，巡检脚本依赖它）：
      0  正常 / 已停止 / 有意停机被跳过
      1  未运行、双实例、无应答、runtime 报错（restart 可能修好）
      2  运行中但非 runtime 组件报错，例如 Source、sync:<source id>（restart 修不好）
      3  运行中等待 setup（restart 修不好）

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 start
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 status
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 restart -RespectStop
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'start', 'stop', 'restart', 'logs', 'open', 'doctor')]
    [string]$Action = 'status',

    [string]$Profile = $(if ($env:DSH_SUPERAGENT_PROFILE) { $env:DSH_SUPERAGENT_PROFILE } else { 'superagent' }),

    [string]$Url = $(if ($env:DSH_SUPERAGENT_URL) { $env:DSH_SUPERAGENT_URL } else { 'http://127.0.0.1:3082' }),

    [int]$Timeout = 60,
    [int]$StopTimeout = 300,

    # 巡检用：manually-stopped 标记存在时，start/restart 直接返回 0，不拉起服务
    [switch]$RespectStop,

    # stop 用：超时后强杀（默认不强杀，与上游一致）
    [switch]$Force,

    # 指定 dsh 可执行文件（默认取 PATH 里的 dsh）
    [string]$DshExe = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\common.ps1')
Set-ConsoleUtf8

$script:Root        = Split-Path -Parent $PSScriptRoot
$script:Artifacts   = Join-Path $script:Root '.artifacts'
$script:ControlRoot = Join-Path $script:Artifacts 'control\profiles'
$script:Control     = Join-Path $script:ControlRoot $Profile
$script:KeepLogs    = 20
$script:PidFile     = Join-Path $script:Control 'service.pid'
$script:StopMarker  = Join-Path $script:Control 'manually-stopped'

if ($Profile -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$') {
    [Console]::Error.WriteLine("Invalid profile name: $Profile")
    exit 1
}

# --------------------------------------------------------------------------- 基础设施

function Initialize-Control {
    New-Item -ItemType Directory -Force -Path $script:Control | Out-Null
    New-Item -ItemType Directory -Force -Path $script:Artifacts | Out-Null
}

function Enter-ControlLock {
    Initialize-Control
    $name = 'Local\dsh-superagent-' + ($Profile -replace '[^A-Za-z0-9_.-]', '_')
    $mutex = New-Object System.Threading.Mutex($false, $name)
    $acquired = $false
    try {
        $acquired = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $acquired = $true
    }
    if (-not $acquired) {
        $mutex.Dispose()
        throw 'Another dsh-superagent control operation is in progress.'
    }
    return $mutex
}

function Exit-ControlLock {
    param($Mutex)
    if ($null -eq $Mutex) { return }
    try { $Mutex.ReleaseMutex() } catch { }
    $Mutex.Dispose()
}

function Test-ManuallyStopped { return (Test-Path -LiteralPath $script:StopMarker) }

function Get-WordList {
    param([string]$CommandLine)
    $words = New-Object System.Collections.ArrayList
    foreach ($m in [regex]::Matches($CommandLine, '"([^"]*)"|(\S+)')) {
        if ($m.Groups[1].Success) { [void]$words.Add($m.Groups[1].Value) } else { [void]$words.Add($m.Groups[2].Value) }
    }
    return $words
}

# 与上游 serves() 同构：逐词找 --profile <p> 或 --profile=<p>；出现 plugin 子命令则排除
function Test-Serves {
    param([string]$CommandLine)
    $words = Get-WordList -CommandLine $CommandLine
    $matched = $false
    for ($i = 1; $i -lt $words.Count; $i++) {
        $word = $words[$i]
        if ($word -eq '--profile') {
            if ($i + 1 -lt $words.Count -and $words[$i + 1] -eq $Profile) { $matched = $true }
        } elseif ($word -like '--profile=*') {
            if ($word.Substring(10) -eq $Profile) { $matched = $true }
        }
    }
    if (-not $matched) { return $false }
    foreach ($word in $words) { if ($word -eq 'plugin') { return $false } }
    return $true
}

function Get-ServiceProcesses {
    $found = New-Object System.Collections.ArrayList
    $cim = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'dsh.exe'" -ErrorAction SilentlyContinue)
    foreach ($process in $cim) {
        if (-not $process.CommandLine) { continue }
        if (Test-Serves -CommandLine $process.CommandLine) {
            [void]$found.Add([pscustomobject]@{
                    Pid         = [int]$process.ProcessId
                    ParentPid   = [int]$process.ParentProcessId
                    CommandLine = [string]$process.CommandLine
                })
        }
    }
    if (Test-Path -LiteralPath $script:PidFile) {
        $recorded = 0
        $raw = (Read-Utf8Text -Path $script:PidFile).Trim()
        if (-not [int]::TryParse($raw, [ref]$recorded)) { $recorded = 0 }
        if ($recorded -gt 0 -and -not ($found | Where-Object { $_.Pid -eq $recorded })) {
            if (Get-Process -Id $recorded -ErrorAction SilentlyContinue) {
                [void]$found.Add([pscustomobject]@{ Pid = $recorded; ParentPid = 0; CommandLine = '(recorded in service.pid)' })
            }
        }
    }
    return @($found.ToArray())
}

function Get-OrchestratorState {
    param([string]$Target)
    $raw = Invoke-JsonGet -Uri "$Target/orchestrator/api/state" -TimeoutSec 3 -Headers @{ 'x-orchestrator-request' = '1' }
    if ($null -eq $raw) { return $null }

    $health = [ordered]@{}
    $errors = [ordered]@{}
    $setup = ''
    $feishu = ''

    $healthProperty = $raw.PSObject.Properties['health']
    if ($healthProperty -and $healthProperty.Value) {
        foreach ($property in $healthProperty.Value.PSObject.Properties) {
            $entry = $property.Value
            if ($null -eq $entry) { continue }
            $stateText = ''
            $stateProperty = $entry.PSObject.Properties['state']
            if ($stateProperty) { $stateText = [string]$stateProperty.Value }
            $health[$property.Name] = $stateText
            if ($stateText -eq 'error') {
                $detailProperty = $entry.PSObject.Properties['detail']
                if ($detailProperty -and $detailProperty.Value) { $errors[$property.Name] = [string]$detailProperty.Value }
            }
        }
    }

    $setupProperty = $raw.PSObject.Properties['setup']
    if ($setupProperty -and $setupProperty.Value) {
        $problemProperty = $setupProperty.Value.PSObject.Properties['problem']
        if ($problemProperty -and $problemProperty.Value) { $setup = [string]$problemProperty.Value }
        $feishuProperty = $setupProperty.Value.PSObject.Properties['feishuProblem']
        if ($feishuProperty -and $feishuProperty.Value) { $feishu = [string]$feishuProperty.Value }
    }

    return [pscustomobject]@{ Health = $health; Errors = $errors; Setup = $setup; Feishu = $feishu }
}

function Get-Outcome {
    param($Processes, $State)
    if (@($Processes).Count -ne 1) { return 1 }
    if ($null -eq $State) { return 1 }
    $runtime = ''
    if ($State.Health.Contains('runtime')) { $runtime = [string]$State.Health['runtime'] }
    if ($runtime -ne 'ready' -and $runtime -ne 'paused') { return 1 }
    if ($State.Setup) { return 3 }
    if ($State.Errors.Count -gt 0) { return 2 }
    return 0
}

function New-StatusJson {
    param($Processes, $State)
    $payload = [ordered]@{
        pids             = @($Processes | ForEach-Object { $_.Pid })
        cwd              = $script:Root
        url              = $Url
        manually_stopped = (Test-ManuallyStopped)
        health           = $(if ($State) { $State.Health } else { [ordered]@{} })
        errors           = $(if ($State) { $State.Errors } else { [ordered]@{} })
        setup            = $(if ($State) { $State.Setup } else { '' })
        feishu           = $(if ($State) { $State.Feishu } else { '' })
    }
    return ($payload | ConvertTo-Json -Depth 6)
}

# --------------------------------------------------------------------------- 控制台信号

if (-not ('CtrlSignal' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CtrlSignal {
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
}
'@
}

# 上游 os.kill(pid, SIGINT) 的等价物：脱离自己的控制台 → 挂到目标进程的控制台 →
# 屏蔽本进程的 Ctrl+C 处理 → 对该控制台广播 CTRL_C_EVENT（node 收到 SIGINT）→ 挂回父控制台。
function Send-ConsoleCtrl {
    param([int]$ProcessId)
    $attached = $false
    try {
        [void][CtrlSignal]::FreeConsole()
        if ([CtrlSignal]::AttachConsole([uint32]$ProcessId)) {
            $attached = $true
            [void][CtrlSignal]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
            $delivered = [CtrlSignal]::GenerateConsoleCtrlEvent(0, 0)
            [void][CtrlSignal]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)
            return $delivered
        }
        return $false
    } catch {
        return $false
    } finally {
        if ($attached) { [void][CtrlSignal]::FreeConsole() }
        # ATTACH_PARENT_PROCESS = 0xFFFFFFFF：挂回自己的父控制台，否则后续输出无处可去
        [void][CtrlSignal]::AttachConsole([uint32]::MaxValue)
    }
}

# --------------------------------------------------------------------------- dsh 启动方式

function Resolve-DshInvocation {
    param([string]$Explicit)
    $command = $null
    if ($Explicit) {
        $command = Get-Command $Explicit -ErrorAction SilentlyContinue
        if (-not $command) { $command = Get-Item -LiteralPath $Explicit -ErrorAction SilentlyContinue }
    } else {
        $command = Get-Command 'dsh' -ErrorAction SilentlyContinue
    }
    if (-not $command) {
        throw 'dsh was not found. Install it with: npm install -g @deepseek-ai/dsh@0.2.1-rc.3'
    }
    $source = $command.Source
    if (-not $source) { $source = $command.FullName }

    # npm / pnpm 的 .cmd shim 里写着 node 与 bin.js 的路径。直接起 node，
    # 这样进程树里没有多余的 shell，Ctrl+C 也能落到 node 上。
    if ($source -match '\.(cmd|bat)$') {
        $text = Read-Utf8Text -Path $source
        if (-not $text) { $text = (Get-Content -LiteralPath $source -Raw) }
        $match = [regex]::Match($text, '"%dp0%\\([^"]+\.js)"')
        if (-not $match.Success) { $match = [regex]::Match($text, '"([^"]*node_modules[^"]+\.js)"') }
        if ($match.Success) {
            $relative = $match.Groups[1].Value -replace '%dp0%\\', ''
            $entry = Join-Path (Split-Path -Parent $source) $relative
            if (Test-Path -LiteralPath $entry) {
                $node = Join-Path (Split-Path -Parent $source) 'node.exe'
                if (-not (Test-Path -LiteralPath $node)) {
                    $nodeCommand = Get-Command 'node' -ErrorAction SilentlyContinue
                    if (-not $nodeCommand) { throw 'node was not found on PATH.' }
                    $node = $nodeCommand.Source
                }
                return [pscustomobject]@{ Node = $node; Entry = $entry; Resolved = $source }
            }
        }
    }
    return [pscustomobject]@{ Node = $null; Entry = $null; Resolved = $source }
}

function Remove-OldLogs {
    $logs = @(Get-ChildItem -LiteralPath $script:Artifacts -Filter "dsh-superagent-$Profile-*.log" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending)
    if ($logs.Count -gt $script:KeepLogs) {
        $logs[$script:KeepLogs..($logs.Count - 1)] | Remove-Item -Force -ErrorAction SilentlyContinue
    }
}

function New-LogPath {
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    return (Join-Path $script:Artifacts "dsh-superagent-$Profile-$stamp-$PID.log")
}

# --------------------------------------------------------------------------- 动作（都返回 @{ Code; Output }）

function New-Result {
    param([int]$Code, [string[]]$Output = @())
    return @{ Code = $Code; Output = $Output }
}

function Invoke-Start {
    if ($RespectStop -and (Test-ManuallyStopped)) {
        return (New-Result -Code 0 -Output @('Intentional stop is active; automatic recovery skipped.'))
    }
    $mutex = $null
    try {
        $mutex = Enter-ControlLock
        $existing = @(Get-ServiceProcesses)
        if ($existing.Count -gt 0) {
            return (New-Result -Code 1 -Output @("dsh-superagent is already running (pids: $(($existing | ForEach-Object { $_.Pid }) -join ', '))."))
        }
        if ($null -ne (Get-OrchestratorState -Target $Url)) {
            return (New-Result -Code 1 -Output @("Something already answers at $Url/orchestrator/api/state; refusing to start a second instance."))
        }

        $invocation = Resolve-DshInvocation -Explicit $DshExe
        Initialize-Control
        Remove-OldLogs
        $log = New-LogPath
        New-Item -ItemType File -Force -Path $log | Out-Null

        if ($invocation.Node -and $invocation.Entry) {
            $inner = '"{0}" "{1}" --profile {2} --no-open >> "{3}" 2>&1' -f $invocation.Node, $invocation.Entry, $Profile, $log
        } else {
            $inner = '"{0}" --profile {1} --no-open >> "{2}" 2>&1' -f $invocation.Resolved, $Profile, $log
        }
        $process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', $inner) `
            -WorkingDirectory $script:Root -WindowStyle Hidden -PassThru
        Write-Utf8Text -Path $script:PidFile -Text ([string]$process.Id)
        if (Test-ManuallyStopped) { Remove-Item -LiteralPath $script:StopMarker -Force }

        $output = New-Object System.Collections.ArrayList
        [void]$output.Add("started pid=$($process.Id) log=$log")

        $deadline = (Get-Date).AddSeconds($Timeout)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 1
            $state = Get-OrchestratorState -Target $Url
            if ($state) {
                $runtime = ''
                if ($state.Health.Contains('runtime')) { $runtime = [string]$state.Health['runtime'] }
                if ($runtime -eq 'ready' -or $runtime -eq 'paused') { break }
            }
            if (@(Get-ServiceProcesses).Count -eq 0) { break }
        }

        $state = Get-OrchestratorState -Target $Url
        $running = @(Get-ServiceProcesses)
        if ($state) {
            if ($state.Setup) { [void]$output.Add("setup: $($state.Setup)") }
            if ($state.Feishu) { [void]$output.Add("feishu: $($state.Feishu)") }
            foreach ($key in $state.Errors.Keys) {
                [void]$output.Add("error: ${key}: $($state.Errors[$key])")
            }
        } else {
            [void]$output.Add("no answer at $Url/orchestrator/api/state within $Timeout s; see $log")
        }
        $code = Get-Outcome -Processes $running -State $state
        return (New-Result -Code $code -Output $output.ToArray())
    } finally {
        Exit-ControlLock -Mutex $mutex
    }
}

function Invoke-Stop {
    param([switch]$Intentional)
    $mutex = $null
    try {
        $mutex = Enter-ControlLock
        $processes = @(Get-ServiceProcesses)
        if ($processes.Count -eq 0) {
            if (Test-Path -LiteralPath $script:PidFile) { Remove-Item -LiteralPath $script:PidFile -Force }
            return (New-Result -Code 0 -Output @('dsh-superagent is not running.'))
        }
        if ($Intentional) {
            Write-Utf8Text -Path $script:StopMarker -Text (Get-Date).ToString('o')
        }
        $output = New-Object System.Collections.ArrayList
        [void]$output.Add("stopping pids: $(($processes | ForEach-Object { $_.Pid }) -join ', ')")
        foreach ($target in $processes) {
            $delivered = Send-ConsoleCtrl -ProcessId $target.Pid
            if (-not $delivered) {
                [void]$output.Add("ctrl-c could not be delivered to pid $($target.Pid); waiting for it to exit anyway")
            }
        }
        $deadline = (Get-Date).AddSeconds($StopTimeout)
        while ((Get-Date) -lt $deadline) {
            if (@(Get-ServiceProcesses).Count -eq 0) { break }
            Start-Sleep -Milliseconds 500
        }
        $left = @(Get-ServiceProcesses)
        if ($left.Count -gt 0 -and $Force) {
            [void]$output.Add("force killing pids: $(($left | ForEach-Object { $_.Pid }) -join ', ')")
            foreach ($target in $left) { Stop-Process -Id $target.Pid -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Seconds 2
            $left = @(Get-ServiceProcesses)
        }
        if ($left.Count -gt 0) {
            [void]$output.Add("did not exit within $StopTimeout s (pids: $(($left | ForEach-Object { $_.Pid }) -join ', ')); not killing them. Rerun with -Force after saving Executor work.")
            return (New-Result -Code 1 -Output $output.ToArray())
        }
        if (Test-Path -LiteralPath $script:PidFile) { Remove-Item -LiteralPath $script:PidFile -Force }
        [void]$output.Add('stopped.')
        return (New-Result -Code 0 -Output $output.ToArray())
    } finally {
        Exit-ControlLock -Mutex $mutex
    }
}

function Invoke-Restart {
    $stop = Invoke-Stop
    if ($stop.Code -ne 0) { return $stop }
    Start-Sleep -Seconds 2
    $start = Invoke-Start
    return (New-Result -Code $start.Code -Output (@($stop.Output) + @($start.Output)))
}

function Invoke-Logs {
    $logs = @(Get-ChildItem -LiteralPath $script:Artifacts -Filter "dsh-superagent-$Profile-*.log" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending)
    if ($logs.Count -eq 0) {
        return (New-Result -Code 0 -Output @("no logs under $($script:Artifacts)"))
    }
    $output = New-Object System.Collections.ArrayList
    [void]$output.Add("logs ($($logs.Count), newest first):")
    foreach ($log in $logs) {
        [void]$output.Add(("  {0}  {1:yyyy-MM-dd HH:mm:ss}  {2} B" -f $log.Name, $log.LastWriteTime, $log.Length))
    }
    [void]$output.Add('')
    [void]$output.Add("tail of $($logs[0].Name):")
    foreach ($line in @(Get-Content -LiteralPath $logs[0].FullName -Tail 60)) { [void]$output.Add($line) }
    return (New-Result -Code 0 -Output $output.ToArray())
}

function Show-Result {
    param($Result)
    if ($Result.Output) { foreach ($line in $Result.Output) { Write-Output $line } }
}

# --------------------------------------------------------------------------- 分发

switch ($Action) {
    'status' {
        $processes = @(Get-ServiceProcesses)
        $state = $null
        if ($processes.Count -gt 0) { $state = Get-OrchestratorState -Target $Url }
        Write-Output (New-StatusJson -Processes $processes -State $state)
        exit (Get-Outcome -Processes $processes -State $state)
    }
    'start' {
        $result = Invoke-Start
        Show-Result -Result $result
        exit $result.Code
    }
    'stop' {
        $result = Invoke-Stop -Intentional
        Show-Result -Result $result
        exit $result.Code
    }
    'restart' {
        $result = Invoke-Restart
        Show-Result -Result $result
        exit $result.Code
    }
    'logs' {
        $result = Invoke-Logs
        Show-Result -Result $result
        exit $result.Code
    }
    'open' {
        Start-Process $Url
        exit 0
    }
    'doctor' {
        $doctor = Join-Path $PSScriptRoot 'doctor.ps1'
        & $doctor -Profile $Profile -Url $Url
        exit $LASTEXITCODE
    }
}
