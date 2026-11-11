#Requires -Version 5.1
<#
.SYNOPSIS
    把上游基线拉到 upstream\ 作对照，并报出本仓库相对于基线改了什么。

.DESCRIPTION
    源码已经入仓，upstream\ 只是"原版长什么样"的参照物，不参与构建、不入库。
    流程：按 vendor\upstream.lock.json 的 commit 检出对照克隆 → 逐个比对入仓的目录与文件。
    输出是"哪些文件被改过"，用来判断升级时要手动合什么，而不是自动合并。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-upstream.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-upstream.ps1 -Force   # 删掉 upstream\ 重克隆
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-upstream.ps1 -Quiet  # 只报数量
#>
[CmdletBinding()]
param(
    [string]$Source = 'https://github.com/deepseek-ai/dsh-superagent-prototype.git',
    [string]$Ref = '',
    [switch]$Force,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\common.ps1')
Set-ConsoleUtf8

$root = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $root 'upstream'
$lockFile = Join-Path $root 'vendor\upstream.lock.json'

if (-not $Ref) {
    if (Test-Path -LiteralPath $lockFile) {
        $Ref = (Read-Utf8Text -Path $lockFile | ConvertFrom-Json).commit
    }
    if (-not $Ref) { throw "No ref given and no commit recorded in $lockFile" }
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git was not found on PATH.' }

if ($Force -and (Test-Path -LiteralPath $destination)) {
    Write-Output "removing $destination"
    Remove-Item -LiteralPath $destination -Recurse -Force
}
if (-not (Test-Path -LiteralPath (Join-Path $destination '.git'))) {
    Write-Output "cloning $Source -> $destination"
    & git clone --filter=blob:none --no-checkout $Source $destination
    if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit code $LASTEXITCODE" }
}

Push-Location $destination
try {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    # fetch 的 stderr 混着进度与错误，失败时只给一行摘要；要看原始输出加 -Verbose
    $fetchOut = (& git fetch --tags --force origin 2>&1)
    $fetchCode = $LASTEXITCODE
    $ErrorActionPreference = $previous
    if ($fetchCode -ne 0 -and -not $Quiet) {
        $fetchOut | ForEach-Object { Write-Verbose ([string]$_) }
    }
    if ($fetchCode -ne 0) {
        & git cat-file -e "$Ref^{commit}" 2>$null
        if ($LASTEXITCODE -ne 0) { throw "git fetch failed (exit $fetchCode) and $Ref is not in the local clone" }
        Write-Output "warning: git fetch failed (exit $fetchCode), using the commit already in the local clone"
    }
    & git checkout --force --detach $Ref
    if ($LASTEXITCODE -ne 0) { throw "git checkout $Ref failed with exit code $LASTEXITCODE" }
    Write-Output ("baseline {0}" -f (((& git rev-parse HEAD) -join '').Trim()))
} finally {
    Pop-Location
}

# 入仓的路径：目录按目录比，单文件按文件比
$vendored = @(
    'src', 'prompts', 'locale', 'skills', 'tests',
    'cordis.patch.yml', 'tsdown.config.ts', 'vitest.config.ts', 'tsconfig.json',
    'package.json', 'pnpm-lock.yaml'
)

$changed = New-Object System.Collections.Generic.List[string]
foreach ($relative in $vendored) {
    $upstreamPath = Join-Path $destination $relative
    $localPath = Join-Path $root $relative
    if (-not (Test-Path -LiteralPath $upstreamPath)) {
        $changed.Add("missing-in-upstream  $relative")
        continue
    }
    if (-not (Test-Path -LiteralPath $localPath)) {
        $changed.Add("missing-in-repo      $relative")
        continue
    }
    # git diff --no-index 有差异时退出码是 1，不是错误
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $diff = & git --no-index --name-status -- $upstreamPath $localPath 2>$null
    $ErrorActionPreference = $previous
    foreach ($line in $diff) {
        if (-not $line) { continue }
        $status = ($line -split "`t")[0]
        $path = ($line -split "`t")[-1]
        $changed.Add(("{0}  {1}" -f $status, ($path -replace [regex]::Escape("$destination\"), '')))
    }
}

Write-Output ''
if ($changed.Count -eq 0) {
    Write-Output 'vendored tree matches the baseline byte for byte.'
    exit 0
}

Write-Output ("{0} file(s) differ from baseline {1}:" -f $changed.Count, $Ref.Substring(0, 12))
if (-not $Quiet) {
    $changed | Sort-Object | ForEach-Object { Write-Output "  $_" }
}
Write-Output ''
Write-Output 'review these before merging an upstream bump; upstream edits never auto-apply.'
exit 0
