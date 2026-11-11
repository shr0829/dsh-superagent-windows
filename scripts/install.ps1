#Requires -Version 5.1
<#
.SYNOPSIS
    一键安装：构建 bundle → 建独立 profile → 挂 bundle → 写机器配置 → 生成账号包装器。

.DESCRIPTION
    等价于上游 docs/006-deployment.md 的 Install 段，把 POSIX 命令换成 Windows 上的等价操作：
      pnpm install + pnpm build               →  scripts\build.ps1（源码已入仓，基线记在 vendor\upstream.lock.json）
      dsh superagent --from-default-profile   →  同一命令，只是 profile 名与路径是 Windows 的
      dsh plugin add link:$PWD                →  同一命令，路径用绝对 Windows 路径
      复制 examples 的 profile patch          →  在已有 patch 上追加两段 override（不覆盖已有内容）

    重复执行是安全的：每一步都先判断现状，需要覆盖时要求 -Force。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Profile superagent -Port 3082
#>
[CmdletBinding()]
param(
    [string]$Profile = $(if ($env:DSH_SUPERAGENT_PROFILE) { $env:DSH_SUPERAGENT_PROFILE } else { 'superagent' }),
    [int]$Port = 3082,

    # stateDir 必须是绝对路径、不含空格；默认 %USERPROFILE%\.dsh\state\<profile>
    [string]$StateDir = '',

    # 从哪个 profile 模板复制；上游默认 web
    [string]$FromProfile = 'web',

    [string]$DshVersion = '0.2.1-rc.3',
    [string]$Bundle = '',
    [switch]$SkipBuild,
    [switch]$SkipPlugin,
    [switch]$SkipCli,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\common.ps1')
Set-ConsoleUtf8

$root = Split-Path -Parent $PSScriptRoot
if (-not $Bundle) { $Bundle = $root }
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
$profilePatch = Join-Path $profileDir 'cordis.patch.yml'
if (-not $StateDir) { $StateDir = Join-Path $dshHome "state\$Profile" }

function Assert-ExitCode {
    param([string]$What)
    if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE" }
}

function Step { param([string]$Text) Write-Output ''; Write-Output "== $Text" }

# ---------------------------------------------------------------- 0. 前置
Step 'preflight'
if ($PSVersionTable.PSVersion -lt [version]'5.1') { throw 'Windows PowerShell 5.1+ is required.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node was not found on PATH.' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git was not found on PATH.' }
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) {
    Write-Output "dsh not found; installing @deepseek-ai/dsh@$DshVersion globally"
    & npm install -g "@deepseek-ai/dsh@$DshVersion"
    Assert-ExitCode 'npm install -g @deepseek-ai/dsh'
    $dsh = Get-Command dsh -ErrorAction SilentlyContinue
    if (-not $dsh) { throw 'dsh still not found on PATH after npm install; check the npm global bin directory.' }
}
$dshVersion = ((& dsh --version 2>&1) -join ' ').Trim()
Write-Output "dsh: $dshVersion ($($dsh.Source))"
if ($dsh.Source -match 'app\.asar') {
    Write-Output 'warning: this dsh lives inside the DSH desktop app. A standalone npm install is what the upstream deployment path expects.'
}

if ([System.IO.Path]::IsPathRooted($StateDir) -eq $false) { throw "StateDir must be an absolute path: $StateDir" }
if ($StateDir -match '\s') { throw "StateDir must not contain spaces: $StateDir" }

# ---------------------------------------------------------------- 1. 构建上游
if (-not $SkipBuild) {
    Step 'build bundle'
    & (Join-Path $PSScriptRoot 'build.ps1')
    Assert-ExitCode 'build.ps1'
}
foreach ($artifact in @('lib\index.js', 'cordis.patch.yml', 'package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Bundle $artifact))) {
        throw "bundle at $Bundle has no $artifact; run scripts\build.ps1 first"
    }
}

# ---------------------------------------------------------------- 2. 建 profile
Step "profile $Profile"
if ((Test-Path -LiteralPath $profileDir) -and -not $Force) {
    Write-Output "profile directory already exists: $profileDir"
    Write-Output 'keeping it (pass -Force to recreate from the template; that deletes its cordis.patch.yml)'
} else {
    if ($Force -and (Test-Path -LiteralPath $profileDir)) {
        $backup = "$profileDir.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Write-Output "backing up $profileDir -> $backup"
        Copy-Item -LiteralPath $profileDir -Destination $backup -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $dshHome | Out-Null
    # 上游命令：以 web profile 为模板创建（会自动生成 config.yml 与 cordis.patch.yml）
    & dsh $Profile --from-default-profile $FromProfile --dump-config | Out-Null
    Assert-ExitCode "dsh $Profile --from-default-profile $FromProfile"
    Write-Output "created $profileDir"
}

# ---------------------------------------------------------------- 3. 挂 bundle
if (-not $SkipPlugin) {
    Step 'plugin add'
    $linked = ''
    if (Test-Path -LiteralPath $profilePatch) {
        $existing = Read-Utf8Text -Path $profilePatch
        if ($existing -match '(?m)^\s*-\s*id:\s*dsh-superagent\s*$') { $linked = 'already present' }
    }
    if ($linked) {
        Write-Output "dsh-superagent is already referenced by $profilePatch"
    } else {
        & dsh plugin --profile $Profile add "link:$Bundle"
        Assert-ExitCode "dsh plugin --profile $Profile add link:$Bundle"
    }
}

# ---------------------------------------------------------------- 4. 机器配置
Step 'machine configuration'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$patchText = Read-Utf8Text -Path $profilePatch
$append = @()
if ($patchText -notmatch '(?m)^\s*-\s*id:\s*webserver\s*$') {
    $append += @(
        '# 由 dsh-superagent-windows/scripts/install.ps1 追加：面板只监听回环地址',
        '- id: webserver',
        '  config:',
        '    host: 127.0.0.1',
        "    port: $Port"
    )
}
if ($patchText -notmatch 'stateDir:') {
    $append += @(
        '# 由 dsh-superagent-windows/scripts/install.ps1 追加：stateDir 必须绝对路径且不含空格',
        '- id: dsh-superagent',
        '  config:',
        "    stateDir: '$($StateDir -replace '\\', '/')'"
    )
}
if ($append.Count -gt 0) {
    if (Test-Path -LiteralPath $profilePatch) {
        $backup = "$profilePatch.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item -LiteralPath $profilePatch -Destination $backup -Force
        Write-Output "backed up existing patch -> $backup"
    }
    $entries = $append -join "`r`n"
    # 模板给出的 patch 只有注释和一个空数组 `[]`。把条目追在 `[]` 后面会得到「数组 + 序列」的文档，
    # YAML 解析直接失败，服务起不来；所以空数组时是替换掉那行，不是追加。
    if ($patchText -match '(?m)^\s*\[\]\s*$') {
        $body = ($patchText -replace '(?m)^\s*\[\][ \t]*(\r?\n)?', '') + $entries + "`r`n"
    } else {
        $body = ($patchText.TrimEnd() + "`r`n" + $entries + "`r`n")
    }
    Write-Utf8Text -Path $profilePatch -Text $body
    Write-Output "wrote $profilePatch"
} else {
    # 早先的追加把 `[]` 留在了条目上方；这种文档解析不了，就地修掉。
    if (($patchText -match '(?m)^\s*\[\]\s*$') -and ($patchText -match '(?m)^\s*-\s+id:\s*')) {
        $body = ($patchText -replace '(?m)^\s*\[\][ \t]*(\r?\n)?', '')
        Write-Utf8Text -Path $profilePatch -Text $body
        Write-Output "removed a stray [] above the existing entries of $profilePatch"
    } else {
        Write-Output "patch already carries webserver + stateDir: $profilePatch"
    }
}

# ---------------------------------------------------------------- 5. 后台自跑
Step 'background wake'
# 一个后台任务结束时，dsh-tool-jobs 默认会唤醒空闲会话开一个新回合（completionDelivery: wakeup，
# maxConsecutiveWakes 不配就没有上限），等于在没人说话的时候烧一次整段上下文。默认关掉。
# 想开回来：scripts\set-background-wake.ps1 -Profile $Profile -State on -MaxWakes 3
& (Join-Path $PSScriptRoot 'set-background-wake.ps1') -Profile $Profile -DshHome $dshHome -State off
Assert-ExitCode 'set-background-wake.ps1'

# ---------------------------------------------------------------- 6. 账号包装器
if (-not $SkipCli) {
    Step 'agent CLI wrappers'
    & (Join-Path $PSScriptRoot 'new-agent-cli.ps1') -Profile $Profile -NoPathUpdate
    Assert-ExitCode 'new-agent-cli.ps1'
}

# ---------------------------------------------------------------- 7. 下一步
Step 'next'
Write-Output "1) powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 start -Profile $Profile -Url http://127.0.0.1:$Port"
Write-Output "2) 打开 http://127.0.0.1:$Port ，在 Settings → Sources / Policy / Execution / Prompts 里填仓库与允许名单"
Write-Output "3) powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Profile $Profile   # 登录自启 + 每小时巡检"
Write-Output "4) powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1 -Profile $Profile -Url http://127.0.0.1:$Port"
Write-Output "5) 后台自跑已关；要让后台任务跑完自己接着干：powershell -File scripts\set-background-wake.ps1 -Profile $Profile -State on -MaxWakes 3（见 docs\08-background-wake.md）"
Write-Output ''
Write-Output "stateDir: $StateDir"
Write-Output "bundle:   $Bundle"
