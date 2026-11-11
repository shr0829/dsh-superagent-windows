#Requires -Version 5.1
<#
.SYNOPSIS
    Execution 的 prepare 命令（Windows / PowerShell 版）。每个 Ticket 从本地克隆里拉出它自己的 worktree。

.DESCRIPTION
    上游示例是一条 POSIX 一行命令：
      git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" \
        "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" \
      && git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" \
        "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"

    Windows 上：
      - 没有 `${VAR:-default}` 语法，用 `$env:VAR ?? 'HEAD'`（PS7）
      - `&&` 在 PowerShell 7 里可用，但脚本里显式检查 $LASTEXITCODE 更可靠，也便于报错
      - 路径一律加引号：Windows 用户名与目录常含空格

    需要的环境变量（由 dsh-superagent 注入）：
      DSH_SUPERAGENT_GITHUB_REPOSITORY  owner/name
      DSH_SUPERAGENT_GITHUB_PR_HEAD     PR head ref（Issue 触发时为空）
      DSH_SUPERAGENT_TICKET             Ticket 标识
      DSH_SUPERAGENT_NAME               Session 名（用于分支名）
      DSH_SUPERAGENT_DIR                worktree 目标目录
    另有本机变量：
      DSH_SUPERAGENT_REPO_CLONE         本地克隆路径（在 Settings → Execution 里配进环境变量）

    在 Settings → Execution 的 prepare 命令里填：
      pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\path\to\repo\config\prepare-worktree.ps1"
#>
[CmdletBinding()]
param(
    [string]$Clone = $env:DSH_SUPERAGENT_REPO_CLONE,
    [string]$Repository = $env:DSH_SUPERAGENT_GITHUB_REPOSITORY,
    [string]$Ticket = $env:DSH_SUPERAGENT_TICKET,
    [string]$SessionName = $env:DSH_SUPERAGENT_NAME,
    [string]$Target = $env:DSH_SUPERAGENT_DIR,
    [string]$Head = $env:DSH_SUPERAGENT_GITHUB_PR_HEAD
)

$ErrorActionPreference = 'Stop'

foreach ($pair in @(
        @{ Name = 'DSH_SUPERAGENT_REPO_CLONE'; Value = $Clone },
        @{ Name = 'DSH_SUPERAGENT_GITHUB_REPOSITORY'; Value = $Repository },
        @{ Name = 'DSH_SUPERAGENT_TICKET'; Value = $Ticket },
        @{ Name = 'DSH_SUPERAGENT_NAME'; Value = $SessionName },
        @{ Name = 'DSH_SUPERAGENT_DIR'; Value = $Target })) {
    if (-not $pair.Value) { throw "missing environment variable: $($pair.Name)" }
}

if (-not $Head) { $Head = 'HEAD' }
if (-not (Test-Path -LiteralPath (Join-Path $Clone '.git'))) {
    throw "not a git clone: $Clone (set DSH_SUPERAGENT_REPO_CLONE)"
}
if (Test-Path -LiteralPath $Target) {
    throw "worktree target already exists: $Target"
}

$ref = "refs/dsh-superagent/$Ticket"
$remote = "https://github.com/$Repository.git"
$branch = "agent/$SessionName"

Write-Output "fetch $Head from $remote into $ref"
& git -C $Clone fetch --no-tags $remote "${Head}:$ref"
if ($LASTEXITCODE -ne 0) { throw "git fetch failed with exit code $LASTEXITCODE" }

Write-Output "worktree add $Target on $branch from $ref"
& git -C $Clone worktree add -b $branch $Target $ref
if ($LASTEXITCODE -ne 0) { throw "git worktree add failed with exit code $LASTEXITCODE" }

Write-Output "ready: $Target ($branch)"
