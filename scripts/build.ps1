#Requires -Version 5.1
<#
.SYNOPSIS
    在本仓库根目录构建 dsh-superagent bundle（源码已随仓库提供）。

.DESCRIPTION
    上游源码已经入仓（src/、prompts/、locale/、skills/、cordis.patch.yml 等），
    所以这里不再 clone：pnpm install + pnpm build，产物落在 <repo>\lib\。
    vendor\upstream.lock.json 只记录基线 commit，用于比对与升级，不参与构建。

    要换上游版本，走 scripts\sync-upstream.ps1：先拉对照克隆、看差异、再决定怎么合。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1 -SkipInstall   # 依赖没变时跳过安装
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1 -Force         # 删掉 node_modules 与 lib 重来
#>
[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipBuild,

    # 干净重建：删掉 node_modules\ 与 lib\（依赖树损坏、产物过期时用）
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\common.ps1')
Set-ConsoleUtf8

$root = Split-Path -Parent $PSScriptRoot
$lockFile = Join-Path $root 'vendor\upstream.lock.json'
$packageFile = Join-Path $root 'package.json'

function Assert-ExitCode {
    param([string]$What)
    if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE" }
}

if (-not (Test-Path -LiteralPath $packageFile)) {
    throw "no package.json at $root; the vendored source is missing from this checkout"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node was not found on PATH.' }

$package = Read-Utf8Text -Path $packageFile | ConvertFrom-Json
Write-Output ("package {0} {1}; engines node={2} dsh={3}" -f $package.name, $package.version, $package.engines.node, $package.engines.dsh)

if (Test-Path -LiteralPath $lockFile) {
    $lock = Read-Utf8Text -Path $lockFile | ConvertFrom-Json
    Write-Output ("vendored baseline {0} ({1})" -f $lock.commit.Substring(0, 12), $lock.commitSubject)
}

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

if ($Force) {
    foreach ($path in @('node_modules', 'lib')) {
        $full = Join-Path $root $path
        if (Test-Path -LiteralPath $full) {
            Write-Output "removing $full"
            Remove-Item -LiteralPath $full -Recurse -Force
        }
    }
}

Push-Location $root
try {
    if (-not $SkipInstall) {
        Write-Output 'installing dependencies (frozen lockfile)'
        Invoke-Pnpm -Arguments @('install', '--frozen-lockfile')
    }

    if (-not $SkipBuild) {
        Write-Output 'building'
        Invoke-Pnpm -Arguments @('build')

        foreach ($artifact in @('lib\index.js', 'cordis.patch.yml')) {
            $path = Join-Path $root $artifact
            if (-not (Test-Path -LiteralPath $path)) { throw "build did not produce $artifact" }
        }
        foreach ($artifact in @('lib\index.js', 'lib\client.js')) {
            $path = Join-Path $root $artifact
            if (Test-Path -LiteralPath $path) {
                Write-Output ("built {0} ({1:N0} B)" -f $artifact, (Get-Item -LiteralPath $path).Length)
            }
        }
    }
} finally {
    Pop-Location
}

Write-Output ''
Write-Output 'next: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1'
