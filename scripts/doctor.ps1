#Requires -Version 5.1
<#
.SYNOPSIS
    Windows 环境体检：把 dsh-superagent 跑起来需要的每一项逐条验证，输出 PASS/WARN/FAIL 表。

.DESCRIPTION
    只读脚本，不安装、不改配置。对应上游 SETUP.md 的"探针"环节，判据换成 Windows 的。
    退出码：0 = 没有 FAIL；1 = 至少一项 FAIL。
#>
[CmdletBinding()]
param(
    [string]$Profile = $(if ($env:DSH_SUPERAGENT_PROFILE) { $env:DSH_SUPERAGENT_PROFILE } else { 'superagent' }),
    [string]$Url = $(if ($env:DSH_SUPERAGENT_URL) { $env:DSH_SUPERAGENT_URL } else { 'http://127.0.0.1:3082' }),

    # 生产仓库的 owner/name；给了就额外校验 agent CLI 的仓库访问
    [string]$Repository = $env:DSH_SUPERAGENT_GITHUB_REPOSITORY,

    # 上游 engines.dsh
    [string]$ExpectedDshMinor = '0.2'
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib\common.ps1')
Set-ConsoleUtf8

$script:Root     = Split-Path -Parent $PSScriptRoot
$script:Rows     = New-Object System.Collections.ArrayList
$script:Failures = 0
$script:Warnings = 0

function Add-Row {
    param([string]$Check, [string]$Status, [string]$Detail)
    if ($Status -eq 'FAIL') { $script:Failures++ }
    if ($Status -eq 'WARN') { $script:Warnings++ }
    [void]$script:Rows.Add([pscustomobject]@{ Check = $Check; Status = $Status; Detail = $Detail })
}

function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------- PowerShell
if ($PSVersionTable.PSVersion -ge [version]'5.1') {
    $edition = $PSVersionTable.PSEdition
    Add-Row 'Windows PowerShell 5.1+' 'PASS' "$($PSVersionTable.PSVersion) ($edition)"
} else {
    Add-Row 'Windows PowerShell 5.1+' 'FAIL' "当前 $($PSVersionTable.PSVersion)"
}

# ---------------------------------------------------------------- Node
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
    $nodeText = ((& node -v 2>&1) -join ' ').Trim()
    $nodeVersion = Get-VersionNumber -Text $nodeText
    $supported = $false
    if ($nodeVersion) {
        $supported = (($nodeVersion.Major -eq 22 -and $nodeVersion -ge [version]'22.19.0') -or $nodeVersion.Major -ge 24)
    }
    if ($supported) {
        Add-Row 'Node ^22.19 || >=24' 'PASS' "$nodeText ($($nodeCommand.Source))"
    } else {
        Add-Row 'Node ^22.19 || >=24' 'FAIL' "$nodeText 不在 engines.node 范围内"
    }
} else {
    Add-Row 'Node ^22.19 || >=24' 'FAIL' 'PATH 里没有 node'
}

# ---------------------------------------------------------------- git
$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if ($gitCommand) {
    $gitText = ((& git --version 2>&1) -join ' ').Trim()
    $gitVersion = Get-VersionNumber -Text $gitText
    if ($gitVersion -and $gitVersion -ge [version]'2.32.0') {
        Add-Row 'git 2.32+' 'PASS' $gitText
    } else {
        Add-Row 'git 2.32+' 'FAIL' "$gitText 太旧：worker-gitconfig 的凭据配置需要 git 2.32+"
    }
    $longpaths = ((& git config --global --get core.longpaths 2>&1) -join ' ').Trim()
    if ($longpaths -eq 'true') {
        Add-Row 'git core.longpaths' 'PASS' 'true'
    } else {
        Add-Row 'git core.longpaths' 'WARN' "当前 '$longpaths'；建议 git config --global core.longpaths true"
    }
    $autocrlf = ((& git config --global --get core.autocrlf 2>&1) -join ' ').Trim()
    Add-Row 'git core.autocrlf' 'PASS' "$autocrlf（本仓库 .gitattributes 已固定换行）"
} else {
    Add-Row 'git 2.32+' 'FAIL' 'PATH 里没有 git'
}

# ---------------------------------------------------------------- pnpm（只有构建需要）
$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpmCommand) {
    Add-Row 'pnpm' 'PASS' "$(((& pnpm -v 2>&1) -join ' ').Trim()) ($($pnpmCommand.Source))"
} else {
    Add-Row 'pnpm' 'WARN' '没有 pnpm；build.ps1 会退回 npx pnpm@<锁定版本>'
}

# ---------------------------------------------------------------- dsh
$dshCommand = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCommand) {
    $dshText = ((& dsh --version 2>&1) -join ' ').Trim()
    $dshVersion = Get-VersionNumber -Text $dshText
    if ($dshCommand.Source -match 'app\.asar') {
        Add-Row 'dsh 独立安装' 'WARN' "$dshText ($($dshCommand.Source)) — 这是桌面版自带 CLI，profile 与插件解析路径与独立安装不同"
    } else {
        Add-Row 'dsh 独立安装' 'PASS' "$dshText ($($dshCommand.Source))"
    }
    if ($dshVersion) {
        $actual = "$($dshVersion.Major).$($dshVersion.Minor)"
        if ($actual -eq $ExpectedDshMinor) {
            Add-Row "dsh 版本 ^$ExpectedDshMinor.x" 'PASS' "$dshVersion"
        } else {
            Add-Row "dsh 版本 ^$ExpectedDshMinor.x" 'FAIL' "$dshVersion 与上游 engines.dsh 不匹配；插件会被判为不兼容"
        }
    }
} else {
    Add-Row 'dsh 在 PATH 里' 'FAIL' 'npm install -g @deepseek-ai/dsh@0.2.1-rc.3'
}

# ---------------------------------------------------------------- profile
$dshHome = $env:DSH_HOME
if (-not $dshHome) { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
$profilePatch = Join-Path $profileDir 'cordis.patch.yml'

if (Test-Path -LiteralPath $profileDir) {
    Add-Row "profile '$Profile'" 'PASS' $profileDir
} else {
    Add-Row "profile '$Profile'" 'FAIL' "不存在：$profileDir（先跑 scripts\install.ps1）"
}

$patchText = Read-Utf8Text -Path $profilePatch
if ($patchText) {
    if ($patchText -match '(?m)^\s*-\s*id:\s*dsh-superagent\s*$') {
        Add-Row 'bundle 已挂进 profile' 'PASS' $profilePatch
    } else {
        Add-Row 'bundle 已挂进 profile' 'FAIL' "没有 'id: dsh-superagent'；跑 dsh plugin --profile $Profile add link:<checkout>"
    }
    $stateDir = ''
    $match = [regex]::Match($patchText, 'stateDir:\s*([^\r\n#]+)')
    if ($match.Success) { $stateDir = $match.Groups[1].Value.Trim().Trim('"').Trim("'") }
    if ($stateDir) {
        if (-not [System.IO.Path]::IsPathRooted($stateDir)) {
            Add-Row 'stateDir 绝对路径' 'FAIL' $stateDir
        } elseif ($stateDir -match '\s') {
            Add-Row 'stateDir 绝对路径' 'WARN' "$stateDir 含空格；worker-bin 的 PATH 拼接可能出问题"
        } else {
            Add-Row 'stateDir 绝对路径' 'PASS' $stateDir
        }
        if (Test-Path -LiteralPath $stateDir) {
            Add-Row 'stateDir 存在' 'PASS' $stateDir
        } else {
            Add-Row 'stateDir 存在' 'WARN' "还没有创建：$stateDir（首次 start 会自动建）"
        }
    } else {
        Add-Row 'stateDir 已配置' 'FAIL' "patch 里没有 stateDir"
    }
} else {
    Add-Row 'profile cordis.patch.yml' 'FAIL' "不存在：$profilePatch"
}

# ---------------------------------------------------------------- 端口与 API
$portMatch = [regex]::Match($Url, ':(\d+)')
if ($portMatch.Success) {
    $port = [int]$portMatch.Groups[1].Value
    $listener = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listener.Count -gt 0) {
        Add-Row "端口 $port" 'PASS' "已监听（pid $($listener[0].OwningProcess)）"
    } else {
        Add-Row "端口 $port" 'WARN' '没有监听：服务未启动（start 之前正常）'
    }
}

$state = Invoke-JsonGet -Uri "$Url/orchestrator/api/state" -TimeoutSec 3 -Headers @{ 'x-orchestrator-request' = '1' }
if ($null -eq $state) {
    Add-Row 'Management API' 'WARN' "$Url 无应答：服务未启动（start 之前正常）"
} else {
    $runtime = ''
    $problems = New-Object System.Collections.ArrayList
    $healthProperty = $state.PSObject.Properties['health']
    if ($healthProperty -and $healthProperty.Value) {
        foreach ($property in $healthProperty.Value.PSObject.Properties) {
            $entry = $property.Value
            if ($null -eq $entry) { continue }
            $stateProperty = $entry.PSObject.Properties['state']
            $stateText = if ($stateProperty) { [string]$stateProperty.Value } else { '' }
            if ($property.Name -eq 'runtime') { $runtime = $stateText }
            if ($stateText -eq 'error') {
                $detailProperty = $entry.PSObject.Properties['detail']
                $detail = if ($detailProperty) { [string]$detailProperty.Value } else { '' }
                [void]$problems.Add("$($property.Name): $detail")
            }
        }
    }
    $setupProperty = $state.PSObject.Properties['setup']
    if ($setupProperty -and $setupProperty.Value) {
        $problemProperty = $setupProperty.Value.PSObject.Properties['problem']
        if ($problemProperty -and $problemProperty.Value) { [void]$problems.Add("setup: $($problemProperty.Value)") }
    }
    if ($problems.Count -eq 0) {
        Add-Row 'Management API' 'PASS' "runtime=$runtime，无报错"
    } else {
        Add-Row 'Management API' 'WARN' ($problems -join ' | ')
    }
}

# ---------------------------------------------------------------- 账号与凭据
$ghAgent = Get-Command gh-agent -ErrorAction SilentlyContinue
if ($ghAgent) {
    $login = ((& gh-agent api user --jq .login 2>&1) -join ' ').Trim()
    if ($login -match '^[A-Za-z0-9._-]+$') {
        Add-Row 'agent GitHub 账号' 'PASS' "gh-agent => $login"
    } else {
        Add-Row 'agent GitHub 账号' 'FAIL' "gh-agent 读不到账号：$login"
    }
    if ($Repository) {
        $repoCheck = ((& gh-agent api "repos/$Repository" --jq .full_name 2>&1) -join ' ').Trim()
        if ($repoCheck -eq $Repository) {
            Add-Row "仓库 $Repository" 'PASS' 'agent 账号可读'
        } else {
            Add-Row "仓库 $Repository" 'FAIL' $repoCheck
        }
    }
} else {
    Add-Row 'agent GitHub 账号' 'WARN' '没有 gh-agent 包装器：scripts\new-agent-cli.ps1 生成'
}

$lark = Get-Command lark-cli -ErrorAction SilentlyContinue
if ($lark) {
    Add-Row '飞书 lark-cli' 'PASS' $lark.Source
} else {
    Add-Row '飞书 lark-cli' 'WARN' '未安装；只接 GitHub 时不需要'
}

# ---------------------------------------------------------------- 输出
$table = $script:Rows | Format-Table -AutoSize -Wrap | Out-String -Width 200
Write-Output $table.TrimEnd()
Write-Output ("{0} 项检查：FAIL {1}，WARN {2}" -f $script:Rows.Count, $script:Failures, $script:Warnings)
if ($script:Failures -gt 0) { exit 1 }
exit 0
