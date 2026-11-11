#Requires -Version 5.1
<#
.SYNOPSIS
    拉取并构建上游 dsh-superagent 原型（固定提交），产物落在 <repo>\upstream\。

.DESCRIPTION
    上游是 pnpm + tsdown 的 TypeScript 包，Windows 上的构建步骤本身跨平台；这个脚本做的事只有三件：
    把提交钉死、用正确的 pnpm 版本装依赖、构建后校验产物真的能当 bundle 用。
    用 vendor\upstream.lock.json 记录提交与 engines，仓库里不复制上游源码。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1 -Force   # 删掉 upstream\ 重来
#>
[CmdletBinding()]
param(
    [string]$Source = 'https://github.com/deepseek-ai/dsh-superagent-prototype.git',
    [string]$Ref = '',
    [string]$Destination = '',
    [switch]$SkipInstall,
    [switch]$SkipBuild,

    # 干净重建：删掉 upstream\ 再克隆（换 commit、构建产物损坏时用）
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\common.ps1')
Set-ConsoleUtf8

$root = Split-Path -Parent $PSScriptRoot
$lockFile = Join-Path $root 'vendor\upstream.lock.json'
if (-not $Destination) { $Destination = Join-Path $root 'upstream' }

function Assert-ExitCode {
    param([string]$What)
    if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE" }
}

if (-not $Ref) {
    if (Test-Path -LiteralPath $lockFile) {
        $Ref = (Read-Utf8Text -Path $lockFile | ConvertFrom-Json).commit
    }
    if (-not $Ref) { throw "No ref given and no commit recorded in $lockFile" }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git was not found on PATH.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node was not found on PATH.' }

# ---------------------------------------------------------------- 源码
if ($Force -and (Test-Path -LiteralPath $Destination)) {
    Write-Output "removing $Destination"
    Remove-Item -LiteralPath $Destination -Recurse -Force
}

if (-not (Test-Path -LiteralPath (Join-Path $Destination '.git'))) {
    Write-Output "cloning $Source -> $Destination"
    & git clone --filter=blob:none --no-checkout $Source $Destination
    Assert-ExitCode 'git clone'
}

Push-Location $Destination
try {
    Write-Output "checking out $Ref"
    # fetch 只是为了让新 pin 的 commit 可达；已经有本地副本时断网也要能构建。
    # 所以 fetch 失败不直接失败，能证明该 commit 已在库里就继续。
    $ErrorActionPreference = 'Continue'
    & git fetch --tags --force origin 2>&1 | ForEach-Object { Write-Output $_ }
    $fetchCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($fetchCode -ne 0) {
        & git cat-file -e "$Ref^{commit}" 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "git fetch failed (exit $fetchCode) and $Ref is not in the local clone"
        }
        Write-Output "warning: git fetch failed (exit $fetchCode), using the commit already in the local clone"
    }
    & git checkout --force --detach $Ref
    Assert-ExitCode "git checkout $Ref"
    $head = ((& git rev-parse HEAD) -join '').Trim()
    Write-Output "upstream HEAD = $head"

    $package = Read-Utf8Text -Path (Join-Path $Destination 'package.json') | ConvertFrom-Json
    Write-Output ("upstream package {0} {1}; engines node={2} dsh={3}" -f $package.name, $package.version, $package.engines.node, $package.engines.dsh)

    # pnpm 版本按 packageManager 字段钉死；没装 pnpm 时用 npx 拉同一个版本
    $pinnedPnpm = 'pnpm'
    if ($package.packageManager -match '^pnpm@(.+)$') {
        $pinnedPnpm = "pnpm@$($Matches[1])"
        Write-Output "pnpm pinned to $($Matches[1])"
    }
    $pnpmExe = 'pnpm'
    $pnpmPrefix = @()
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        $pnpmExe = 'npx'
        $pnpmPrefix = @('--yes', $pinnedPnpm)
        Write-Output "pnpm not on PATH; falling back to npx $pinnedPnpm"
    }

    function Invoke-Pnpm {
        param([string[]]$Arguments)
        # pnpm 会把进度提示与警告写到 stderr（例如 tsdown 的 CJS 格式建议）。
        # 本脚本默认 $ErrorActionPreference = 'Stop'，合并 2>&1 之后这些行会变成
        # ErrorRecord 把脚本直接终止，看起来像构建失败、其实只是警告。
        # 只在这一个调用范围内放宽，成功与否仍由退出码决定。
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & $pnpmExe @pnpmPrefix @Arguments 2>&1 | ForEach-Object { Write-Output $_ }
        } finally {
            $ErrorActionPreference = $previous
        }
        Assert-ExitCode "pnpm $($Arguments -join ' ')"
    }

    if (-not $SkipInstall) {
        Write-Output 'installing dependencies (frozen lockfile)'
        Invoke-Pnpm -Arguments @('install', '--frozen-lockfile')
    }

    if (-not $SkipBuild) {
        Write-Output 'building'
        Invoke-Pnpm -Arguments @('build')

        foreach ($artifact in @('lib\index.js', 'cordis.patch.yml')) {
            $path = Join-Path $Destination $artifact
            if (-not (Test-Path -LiteralPath $path)) { throw "build did not produce $artifact" }
        }
        $index = Join-Path $Destination 'lib\index.js'
        Write-Output ("built {0} ({1:N0} B)" -f $index, (Get-Item -LiteralPath $index).Length)
    }
} finally {
    Pop-Location
}

Write-Output ''
Write-Output "next: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1"
