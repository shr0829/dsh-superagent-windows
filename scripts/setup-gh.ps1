<#
.SYNOPSIS
    把本机 GitHub CLI（gh）配到「能推分支、能开 PR」的状态。

.DESCRIPTION
    super-agent 的执行器不点鼠标：它靠 gh 推分支、开 PR、回评论。所以 gh 必须满足
    三件事——装得上、认到账号、对目标仓库有写权限。本脚本按这个顺序做，每一步都验证。

    认证这一步刻意绕开 `gh auth login --with-token`：那条命令会强制校验 read:org，
    而 git credential 里现成的 OAuth token 往往只有 gist/repo/workflow，于是被拒。
    脚本改为直接写 gh 自己的 hosts.yml（与 gh 存的是同一份文件），再用 `gh auth status`
    复核。缺 read:org 只会影响 org 级命令，推分支与开 PR 不受影响。

.PARAMETER Repository
    目标仓库 owner/name，例如 shr0829/dsh-superagent-windows。给了才验证推送权限与 PR 能力。

.PARAMETER FromGitCredential
    从 `git credential fill` 取 github.com 的 token。本机一直是这么配的，默认就查它。

.PARAMETER Token
    直接给一个 token（PAT 或 OAuth）。两个来源都不给时只做检查与 setup-git，不动凭据。

.PARAMETER SkipInstall
    gh 不存在时不尝试 winget 安装。

.PARAMETER WhatIf
    只报告将要做什么，不写 hosts.yml、不跑 setup-git。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-gh.ps1 -Repository shr0829/dsh-superagent-windows

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-gh.ps1 -FromGitCredential -Repository owner/name
#>
#Requires -Version 5.1

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Repository,
    [switch]$FromGitCredential,
    [string]$Token,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\common.ps1')
Set-ConsoleUtf8

$hostName = 'github.com'

function Write-Step {
    param([string]$Text)
    Write-Output ''
    Write-Output "== $Text"
}

function Find-Gh {
    $command = Get-Command gh -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in @("$env:ProgramFiles\GitHub CLI\gh.exe", "${env:ProgramFiles(x86)}\GitHub CLI\gh.exe")) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

# ---------------------------------------------------------------- 1. gh 本体
Write-Step '1/5 GitHub CLI'

$gh = Find-Gh
if (-not $gh) {
    if ($SkipInstall) { throw 'gh 不在 PATH，也没有给 -SkipInstall 之外的办法：先装 winget install --id GitHub.cli --exact' }
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) { throw 'gh 未安装，且本机没有 winget。请手动安装 https://github.com/cli/cli/releases 后重跑。' }
    Write-Output 'gh 未安装，用 winget 装（包 ID 是 GitHub.cli，大小写无关但要 --exact）'
    if ($PSCmdlet.ShouldProcess('GitHub CLI', 'winget install')) {
        & winget install --id GitHub.cli --exact --accept-source-agreements --accept-package-agreements --silent
        if ($LASTEXITCODE -ne 0) { throw "winget install 失败，退出码 $LASTEXITCODE" }
    }
    $gh = Find-Gh
    if (-not $gh) { throw 'gh 装完了但找不到可执行文件；重开一个终端再跑。' }
}

$versionText = ((& $gh --version 2>&1) -join ' ')
$version = $null
if ($versionText -match 'gh version (\d+\.\d+\.\d+)') { $version = [version]$Matches[1] }
if (-not $version) { throw "读不到 gh 版本：$versionText" }
Write-Output "gh $version => $gh"
if ($version -lt [version]'2.48.0') {
    Write-Output 'warning: 上游要求 gh >= 2.48（docs/006-deployment.md），当前版本偏低。'
}

# ---------------------------------------------------------------- 2. 凭据
Write-Step '2/5 凭据'

if (-not $Token -and $FromGitCredential) {
    $filled = "protocol=https`nhost=$hostName`n`n" | git credential fill 2>$null
    $passwordLine = ($filled | Select-String '^password=').ToString()
    if ($passwordLine) { $Token = $passwordLine.Substring(9) }
    if (-not $Token) { Write-Output 'git credential 里没有 github.com 的凭据，跳过。' }
}

if ($Token) {
    $ghHome = Join-Path $env:APPDATA 'GitHub CLI'
    $hostsFile = Join-Path $ghHome 'hosts.yml'
    if (Test-Path -LiteralPath $hostsFile) {
        $backup = "$hostsFile.bak-$([datetime]::Now.ToString('yyyyMMddHHmmss'))"
        if ($PSCmdlet.ShouldProcess($hostsFile, "备份到 $backup")) { Copy-Item -LiteralPath $hostsFile -Destination $backup }
    }
    # 先问一次 API 拿账号名，避免在 hosts.yml 里写错 user；失败就按 401 报出来
    $login = $null
    $probe = Invoke-JsonGet -Uri "https://api.github.com/user" -Headers @{ Authorization = "token $Token" }
    if ($probe) { $login = $probe.login }
    if (-not $login) { throw 'token 读不到账号（可能已过期或被撤销）。' }

    $yaml = "github.com:`n    user: $login`n    oauth_token: $Token`n    git_protocol: https`n"
    if ($PSCmdlet.ShouldProcess($hostsFile, "写入 $login 的凭据")) {
        Write-Utf8Text -Path $hostsFile -Text $yaml
        Write-Output "已写入 $hostsFile（账号 $login，行尾 LF、无 BOM）"
    }
} else {
    Write-Output '没有提供 token，沿用 gh 现有登录状态。'
}

# ---------------------------------------------------------------- 3. 状态
Write-Step '3/5 登录状态'

$statusText = ((& $gh auth status --hostname $hostName 2>&1) -join "`n")
Write-Output $statusText
if ($statusText -notmatch 'Logged in to github\.com account (\S+)') {
    throw 'gh 仍未登录。给 -FromGitCredential 或 -Token，或手动 gh auth login。'
}
$account = $Matches[1]

# ---------------------------------------------------------------- 4. git 凭据助手
Write-Step '4/5 git 走 gh 的凭据'

if ($PSCmdlet.ShouldProcess('git 全局凭据配置', 'gh auth setup-git')) {
    & $gh auth setup-git --hostname $hostName
    if ($LASTEXITCODE -ne 0) { throw "gh auth setup-git 失败，退出码 $LASTEXITCODE" }
}
# gh 会写两条：先一条空值清掉继承来的 helper，再一条真正的命令。空值不参与展示。
$helperValues = @(git config --global --get-all "credential.https://$hostName.helper" 2>$null) | Where-Object { $_ }
$helper = ($helperValues -join ' | ').Trim()
if ($helper -match 'gh') {
    Write-Output "credential.https://$hostName.helper = $helper"
} else {
    Write-Output 'warning: 全局凭据助手里没有 gh，HTTPS 推送可能仍用旧的 token。'
}

# ---------------------------------------------------------------- 5. 仓库权限
Write-Step '5/5 仓库权限'

if (-not $Repository) {
    Write-Output '没给 -Repository，跳过推送权限与 PR 能力验证。'
} else {
    $repo = Invoke-JsonGet -Uri "https://api.github.com/repos/$Repository" -Headers @{ Authorization = "token $Token" }
    if (-not $repo) {
        Write-Output "读不到 $Repository：可能名字不对，或 token 没有该仓库访问权。"
    } else {
        $push = $repo.permissions.push
        Write-Output ("{0}：push={1} admin={2} private={3}" -f $repo.full_name, $push, $repo.permissions.admin, $repo.private)
        if (-not $push) {
            throw "$account 对 $Repository 没有写权限，开不了 PR。"
        }
        $prList = ((& $gh pr list --repo $Repository --state open --limit 1 2>&1) -join ' ').Trim()
        if ($LASTEXITCODE -ne 0) {
            Write-Output "gh pr list 失败：$prList"
        } else {
            $openCount = 0
            if (-not [string]::IsNullOrWhiteSpace($prList)) { $openCount = 1 }
            Write-Output "gh pr list 正常（读到 open PR 行：$openCount）"
        }
    }
}

# ---------------------------------------------------------------- 收尾
Write-Output ''
Write-Output '完成。执行器推 PR 用的就是这套凭据：'
Write-Output '  git push -u origin HEAD'
Write-Output "  $gh pr create --repo <owner>/<name> --fill"
Write-Output "  $gh pr merge --repo <owner>/<name> --squash --auto --delete-branch"
Write-Output ''
Write-Output 'agent 用独立账号时：scripts\new-agent-cli.ps1 生成 gh-agent.cmd，'
Write-Output '再用 gh-agent auth login 登 bot 账号，两者互不覆盖。'
exit 0
