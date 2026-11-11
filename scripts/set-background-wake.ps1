#Requires -Version 5.1
<#
.SYNOPSIS
    开关「后台自跑」：一个后台任务跑完之后，DSH 会不会在你没敲字的时候自己开一个新回合。

.DESCRIPTION
    为什么需要这个开关（机制细节见 docs\08-background-wake.md）：
    dsh-tool-jobs 在一个 job 结算时构造一条通知，若属主此刻空闲，就用 owner.followup(message)
    唤醒它——那等于开一个新回合。这条路径默认开着（completionDelivery 默认 wakeup），
    而 maxConsecutiveWakes 不配置就没有上限。每次唤醒都是一次完整请求，整段上下文重新发一遍。

    本脚本改写 profile 的 cordis.patch.yml，给 tool-jobs 写一条 override：

      off（默认）  completionDelivery: quiet + maxConsecutiveWakes: 1
                   通知留在收件箱，等你下次说话时随上下文一起带进来；job 本身照常跑完，
                   job_output / job_list 仍然随时能收，只是失败时不会有人敲你
      on           completionDelivery: wakeup + maxConsecutiveWakes: <MaxWakes>
                   后台任务结束就唤醒你；连续唤醒到上限后停下，等你开口再清零

    Cordis 的 patch 对 config 是**整块替换、不做深合并**，所以脚本会把现有的
    waitTimeoutMs / maxWaitTimeoutMs 一并抄进新块，等待语义保持不变。

    写完要重启 DSH 才生效（配置在进程启动时装载）。

.PARAMETER State
    status（默认，只读）/ off / on

.PARAMETER Profile
    DSH profile 名。默认取环境变量 DSH_SUPERAGENT_PROFILE，再默认 superagent。
    管自己那个会话就传 desktop 一类的名字。

.PARAMETER MaxWakes
    on 时的连续唤醒上限，默认 3。DSH 的 schema 是 min(1)，所以最小 1。

.PARAMETER DshHome
    DSH 数据目录，默认取环境变量 DSH_HOME，再默认 %USERPROFILE%\.dsh

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-background-wake.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-background-wake.ps1 -State off

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-background-wake.ps1 -Profile desktop -State on -MaxWakes 2

.NOTES
    退出码沿用本仓库约定：0 成功；2 写不进去（profile 不存在、patch 读不了、落盘失败）。
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'off', 'on')]
    [string]$State = 'status',

    [string]$Profile = $(if ($env:DSH_SUPERAGENT_PROFILE) { $env:DSH_SUPERAGENT_PROFILE } else { 'superagent' }),

    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),

    [int]$MaxWakes = 3
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\common.ps1')
Set-ConsoleUtf8

$profileDir = Join-Path $DshHome ('profiles\' + $Profile)
$profilePatch = Join-Path $profileDir 'cordis.patch.yml'
$marker = '# 由 scripts\set-background-wake.ps1 写入'

# dsh-tool-jobs 的默认值。profile 里没写这两项时用它们补，等待语义不变。
$defaultWaitTimeoutMs = 30000
$defaultMaxWaitTimeoutMs = 600000

function Get-ToolJobsRow {
    param([string[]]$Lines)

    $start = -1
    for ($index = 0; $index -lt $Lines.Count; $index++) {
        if ($Lines[$index] -match '^\s*-\s*id:\s*tool-jobs\s*$') { $start = $index; break }
    }
    if ($start -lt 0) { return $null }

    # profile 的 patch 条目都顶格写；下一条顶格 '- ' 就是本条目的边界
    $end = $Lines.Count
    for ($index = $start + 1; $index -lt $Lines.Count; $index++) {
        if ($Lines[$index] -match '^-\s') { $end = $index; break }
    }

    return (New-Object psobject -Property @{ Start = $start; End = $end })
}

function Get-RowScalar {
    param([string[]]$Lines, $Row, [string]$Key)

    if ($null -eq $Row) { return '' }
    for ($index = $Row.Start; $index -lt $Row.End; $index++) {
        $match = [regex]::Match($Lines[$index], '^\s+' + [regex]::Escape($Key) + ':\s*(\S+)\s*$')
        if ($match.Success) { return $match.Groups[1].Value }
    }
    return ''
}

try {
    if (-not (Test-Path -LiteralPath $profilePatch)) {
        throw ('找不到 ' + $profilePatch + '。先跑 scripts\install.ps1，或用 -Profile 指定一个已存在的 profile。')
    }

    $text = Read-Utf8Text -Path $profilePatch
    $lines = @($text -split "`r?`n")
    while ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim() -eq '') {
        $lines = @($lines[0..($lines.Count - 2)])
    }
    if ($lines.Count -eq 0) { $lines = @() }

    $row = Get-ToolJobsRow -Lines $lines

    $delivery = Get-RowScalar -Lines $lines -Row $row -Key 'completionDelivery'
    $wakes = Get-RowScalar -Lines $lines -Row $row -Key 'maxConsecutiveWakes'

    # config 是整块替换，先把现有的等待参数抄下来
    $waitTimeoutMs = Get-RowScalar -Lines $lines -Row $row -Key 'waitTimeoutMs'
    $maxWaitTimeoutMs = Get-RowScalar -Lines $lines -Row $row -Key 'maxWaitTimeoutMs'
    if ($waitTimeoutMs -notmatch '^\d+$') { $waitTimeoutMs = $defaultWaitTimeoutMs }
    if ($maxWaitTimeoutMs -notmatch '^\d+$') { $maxWaitTimeoutMs = $defaultMaxWaitTimeoutMs }

    if ($State -eq 'status') {
        Write-Output ('profile:   ' + $profileDir)
        Write-Output ('patch:     ' + $profilePatch)
        if ($null -eq $row) {
            Write-Output 'tool-jobs: 未写 override —— 走 dsh-tool-jobs 默认：completionDelivery=wakeup，maxConsecutiveWakes 无上限'
            Write-Output '后台自跑: 开（无上限）。关掉：本脚本 -State off'
        }
        else {
            if ($delivery -eq '') { $delivery = 'wakeup(默认)' }
            if ($wakes -eq '') { $wakes = '未设(无上限)' }
            Write-Output ('tool-jobs: completionDelivery=' + $delivery + ' maxConsecutiveWakes=' + $wakes + ' waitTimeoutMs=' + $waitTimeoutMs + ' maxWaitTimeoutMs=' + $maxWaitTimeoutMs)
            if ($delivery -like 'quiet*') {
                Write-Output '后台自跑: 关（job 结束不唤醒；通知等你下次说话时随上下文带进来）'
            }
            else {
                Write-Output ('后台自跑: 开（job 结束就唤醒，连续上限 ' + $wakes + '）')
            }
        }
        exit 0
    }

    if ($MaxWakes -lt 1) { $MaxWakes = 1 }

    if ($State -eq 'off') {
        $header = $marker + '：后台自跑关（job 结算不唤醒空闲会话）'
        $deliveryValue = 'quiet'
        $wakesValue = 1
        $summary = '关（quiet，连续唤醒上限 1）'
    }
    else {
        $header = $marker + '：后台自跑开，连续唤醒上限 ' + $MaxWakes
        $deliveryValue = 'wakeup'
        $wakesValue = $MaxWakes
        $summary = '开（wakeup，连续唤醒上限 ' + $MaxWakes + '）'
    }

    # 注意：数组字面量里写成 `'a: ' + $x`，5.1 会把两边当成两个元素（+ 在数组上下文里是拼接数组）。
    # 一律用插值字符串，别用 + 拼。
    $block = @(
        $header,
        '- id: tool-jobs',
        '  config:',
        ("    completionDelivery: {0}" -f $deliveryValue),
        ("    maxConsecutiveWakes: {0}" -f $wakesValue),
        ("    waitTimeoutMs: {0}" -f $waitTimeoutMs),
        ("    maxWaitTimeoutMs: {0}" -f $maxWaitTimeoutMs)
    )

    if ($null -eq $row) {
        # 没有这一条：追加到末尾。顺手清掉模板遗留的空数组行，否则 YAML 解出来是个 null 条目。
        $kept = @()
        for ($index = 0; $index -lt $lines.Count; $index++) {
            if ($lines[$index].Trim() -ne '[]') { $kept += $lines[$index] }
        }
        while ($kept.Count -gt 0 -and $kept[$kept.Count - 1].Trim() -eq '') {
            $kept = @($kept[0..($kept.Count - 2)])
        }
        if ($kept.Count -gt 0) { $kept = @($kept) + @('') }
        $next = @($kept) + @($block)
    }
    else {
        # 上次写下的注释行一起换掉，重复运行时不会堆标记
        $insertAt = $row.Start
        if ($insertAt -gt 0 -and $lines[$insertAt - 1].Trim().StartsWith($marker)) { $insertAt = $insertAt - 1 }

        $head = @()
        if ($insertAt -gt 0) { $head = @($lines[0..($insertAt - 1)]) }

        $tail = @()
        if ($row.End -lt $lines.Count) {
            $tail = @($lines[$row.End..($lines.Count - 1)])
            while ($tail.Count -gt 0 -and $tail[0].Trim() -eq '') { $tail = @($tail[1..($tail.Count - 1)]) }
            if ($tail.Count -gt 0) { $tail = @('') + @($tail) }
        }

        $next = @($head) + @($block) + @($tail)
    }

    $unchanged = ((@($next) -join "`n") -eq (@($lines) -join "`n"))

    if ($unchanged) {
        Write-Output ('已是最新状态，未改动：' + $profilePatch)
        Write-Output ('后台自跑：' + $summary)
        exit 0
    }

    $backup = $profilePatch + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item -LiteralPath $profilePatch -Destination $backup -Force

    $body = (@($next) -join "`r`n") + "`r`n"
    Write-Utf8Text -Path $profilePatch -Text $body

    Write-Output ('已写入：' + $profilePatch)
    Write-Output ('备份：  ' + $backup)
    Write-Output ('后台自跑现在为：' + $summary)
    Write-Output '重启 DSH 才生效：scripts\dsh-superagent.ps1 restart（自己的会话就是重启 DSH 应用）。'
    Write-Output ('看当前值：powershell -File scripts\set-background-wake.ps1 -Profile ' + $Profile)
    exit 0
}
catch {
    [Console]::Error.WriteLine('写不进去：' + $_.Exception.Message)
    exit 2
}
