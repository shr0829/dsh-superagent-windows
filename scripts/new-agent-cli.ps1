#Requires -Version 5.1
<#
.SYNOPSIS
    生成 agent 专用的 CLI 包装器：gh-agent / lark-bot（Windows 上就是两个 .cmd）。

.DESCRIPTION
    上游用 sh 脚本把凭据目录隔离出来：
      gh-agent:  GH_CONFIG_DIR=$HOME/.config/gh-agent exec gh "$@"
      lark-bot:  LARKSUITE_CLI_CONFIG_DIR=$HOME/.lark-cli-dsh-superagent exec lark-cli "$@"
    Windows 上没有 exec，改用 .cmd：设置环境变量后把 %* 原样转发给真实可执行文件。
    这样 dsh-superagent 的 worker-bin shim 只要指向 gh-agent.cmd，agent 就永远用自己那套凭据，
    不会碰操作者本人 gh 的登录态。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\new-agent-cli.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\new-agent-cli.ps1 -BinDir D:\bin -Force
#>
[CmdletBinding()]
param(
    [string]$BinDir = (Join-Path $env:USERPROFILE '.local\bin'),
    [string]$GhPath = '',
    [string]$LarkPath = '',
    [string]$Profile = 'superagent',
    [switch]$NoPathUpdate,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\common.ps1')
Set-ConsoleUtf8

function Resolve-Tool {
    param([string]$Name, [string]$Explicit, [string[]]$Candidates)
    if ($Explicit) {
        if (Test-Path -LiteralPath $Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
        throw "not found: $Explicit"
    }
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in $Candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# ---------------------------------------------------------------- gh-agent
$gh = Resolve-Tool -Name 'gh' -Explicit $GhPath -Candidates @(
    (Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'GitHub CLI\gh.exe'),
    (Join-Path $env:LOCALAPPDATA 'GitHubCLI\bin\gh.exe')
)
if ($gh) {
    $target = Join-Path $BinDir 'gh-agent.cmd'
    if ((Test-Path -LiteralPath $target) -and -not $Force) {
        Write-Output "exists: $target (pass -Force to rewrite)"
    } else {
        $lines = @(
            '@echo off',
            'rem 由 dsh-superagent-windows/scripts/new-agent-cli.ps1 生成',
            'rem agent 的 GitHub 身份：凭据目录与操作者本人的 ~/.config/gh 完全隔离',
            'setlocal',
            'set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-agent"',
            "`"$gh`" %*"
        )
        Set-Content -LiteralPath $target -Value $lines -Encoding ascii
        Write-Output "wrote $target -> $gh"
    }
} else {
    Write-Output 'gh not found: install GitHub CLI 2.48+ (winget install --id GitHub.cli) then rerun with -GhPath'
}

# ---------------------------------------------------------------- lark-bot
$lark = Resolve-Tool -Name 'lark-cli' -Explicit $LarkPath -Candidates @(
    (Join-Path $env:USERPROFILE '.local\bin\lark-cli.exe'),
    (Join-Path $env:APPDATA 'npm\lark-cli.cmd')
)
if ($lark) {
    $target = Join-Path $BinDir 'lark-bot.cmd'
    if ((Test-Path -LiteralPath $target) -and -not $Force) {
        Write-Output "exists: $target (pass -Force to rewrite)"
    } else {
        $lines = @(
            '@echo off',
            'rem 由 dsh-superagent-windows/scripts/new-agent-cli.ps1 生成',
            'rem 飞书 bot 身份：独立凭据目录；host 会拒绝能冒充用户的 CLI 配置',
            'setlocal',
            'set "LARKSUITE_CLI_CONFIG_DIR=%USERPROFILE%\.lark-cli-dsh-superagent"',
            "`"$lark`" %*"
        )
        Set-Content -LiteralPath $target -Value $lines -Encoding ascii
        Write-Output "wrote $target -> $lark"
    }
} else {
    Write-Output 'lark-cli not found: 只接 GitHub 时不需要；要接飞书再装并重跑 -LarkPath'
}

# ---------------------------------------------------------------- PATH
if (-not $NoPathUpdate) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @()
    if ($userPath) { $entries = $userPath -split ';' | Where-Object { $_ } }
    if ($entries -notcontains $BinDir) {
        $updated = (@($entries) + $BinDir) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
        Write-Output "added to user PATH: $BinDir（新开终端生效）"
    } else {
        Write-Output "already on user PATH: $BinDir"
    }
}

Write-Output ''
Write-Output '验证（新开一个终端）：'
Write-Output '  gh-agent auth login --hostname github.com --git-protocol https'
Write-Output '  gh-agent api user --jq .login        # 应打印 agent 账号，不是操作者本人'
if ($lark) {
    Write-Output '  lark-bot config init --app-id <cli_xxx> --app-secret-stdin'
    Write-Output '  lark-bot config strict-mode bot --global'
}
Write-Output ''
Write-Output "提示：在 Settings → Sources 里把 agent CLI 填成 gh-agent（PATH 上的 .cmd），Eval/Execution 里把 agent 个人 CLI 列进 blockedCommands。"
