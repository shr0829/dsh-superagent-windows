#Requires -Version 5.1
<#
.SYNOPSIS
    用计划任务替代上游的 tmux 常驻 + 每小时巡检：登录时拉起，之后每 N 分钟跑一次 watchdog。

.DESCRIPTION
    两个任务：
      <prefix>-<profile>-logon    用户登录时 start（无控制台窗口）
      <prefix>-<profile>-hourly   每 60 分钟跑 watchdog.ps1；watchdog 自己决定重启还是只报告

    任务以当前用户的交互式令牌运行（-RunLevel Limited），不需要管理员。
    有意停机用 `dsh-superagent.ps1 stop`，它写的 manually-stopped 标记会让两个任务都不再拉起服务。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-task.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-task.ps1 -IntervalMinutes 30 -Force
#>
[CmdletBinding()]
param(
    [string]$Profile = $(if ($env:DSH_SUPERAGENT_PROFILE) { $env:DSH_SUPERAGENT_PROFILE } else { 'superagent' }),
    [string]$Url = $(if ($env:DSH_SUPERAGENT_URL) { $env:DSH_SUPERAGENT_URL } else { 'http://127.0.0.1:3082' }),
    [string]$TaskPrefix = 'dsh-superagent',
    [int]$IntervalMinutes = 60,
    [switch]$NoLogon,
    [switch]$NoHourly,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

# 计划任务要调起"能跑这些脚本的那个 PowerShell"：当前进程的可执行文件就是答案。
# 不要用 Get-Command pwsh —— 在只有 5.1 的机器上这个名字可能解析到 WindowsApps 的别名。
$shellPath = (Get-Process -Id $PID).Path
if (-not $shellPath) { $shellPath = Join-Path $PSHOME 'powershell.exe' }
if (-not (Test-Path -LiteralPath $shellPath)) { $shellPath = Join-Path $PSHOME 'pwsh.exe' }
if (-not (Test-Path -LiteralPath $shellPath)) { throw 'cannot locate a PowerShell executable to schedule.' }
$serviceScript = Join-Path $PSScriptRoot 'dsh-superagent.ps1'
$watchdogScript = Join-Path $PSScriptRoot 'watchdog.ps1'

if (-not (Test-Path -LiteralPath $serviceScript)) { throw "missing $serviceScript" }
if (-not (Test-Path -LiteralPath $watchdogScript)) { throw "missing $watchdogScript" }

$hourlyName = "$TaskPrefix-$Profile-hourly"
$logonName = "$TaskPrefix-$Profile-logon"

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType InteractiveToken -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)

function Register-RepoTask {
    param([string]$Name, [string]$Arguments, $Trigger)
    $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($existing -and -not $Force) {
        Write-Output "task already exists: $Name (pass -Force to replace)"
        return
    }
    $action = New-ScheduledTaskAction -Execute $shellPath -Argument $Arguments -WorkingDirectory $root
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger -Principal $principal -Settings $settings -Force | Out-Null
    Write-Output "registered $Name"
}

if (-not $NoHourly) {
    $hourlyTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(5)) `
        -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
        -RepetitionDuration (New-TimeSpan -Days 3650)
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Profile {1} -Url {2}' -f $watchdogScript, $Profile, $Url
    Register-RepoTask -Name $hourlyName -Arguments $arguments -Trigger $hourlyTrigger
}

if (-not $NoLogon) {
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Action start -Profile {1} -Url {2} -RespectStop' -f $serviceScript, $Profile, $Url
    Register-RepoTask -Name $logonName -Arguments $arguments -Trigger $logonTrigger
}

Write-Output ''
Write-Output 'tasks:'
Get-ScheduledTask -TaskName "$TaskPrefix-$Profile-*" -ErrorAction SilentlyContinue |
    Select-Object TaskName, State |
    Format-Table -AutoSize | Out-String -Width 160 | Write-Output
Write-Output "有意停机：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 stop -Profile $Profile"
Write-Output "撤销任务：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\unregister-task.ps1 -Profile $Profile"
