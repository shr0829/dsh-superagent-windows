#Requires -Version 5.1
<#
.SYNOPSIS
    每小时巡检的判断逻辑。上游把它写成一段给 agent 的 prompt，Windows 上还需要一个无 agent 也能跑的版本。

.DESCRIPTION
    判断顺序与上游 docs/006-deployment.md 的 Hourly check 一致：
      status 退出码 0        → 静默（服务健康，什么都不做）
      status 退出码 2 或 3    → 只报告，不重启（restart 修不好这类问题）
      manually_stopped=true  → 保持停机（操作者有意停的，巡检不许拉起）
      其它（1：未运行/无应答/runtime 报错） → restart -RespectStop，再报一次结果

    退出码固定为 0：巡检任务本身失败不应该让计划任务堆积错误状态，报告靠输出。
#>
[CmdletBinding()]
param(
    [string]$Profile = $(if ($env:DSH_SUPERAGENT_PROFILE) { $env:DSH_SUPERAGENT_PROFILE } else { 'superagent' }),
    [string]$Url = $(if ($env:DSH_SUPERAGENT_URL) { $env:DSH_SUPERAGENT_URL } else { 'http://127.0.0.1:3082' })
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib\common.ps1')
Set-ConsoleUtf8

$control = Join-Path $PSScriptRoot 'dsh-superagent.ps1'
$status = (& $control -Action status -Profile $Profile -Url $Url 2>&1 | Out-String)
$code = $LASTEXITCODE
$stamp = (Get-Date).ToString('s')

switch ($code) {
    0 { exit 0 }                                   # 健康：静默
    { $_ -in 2, 3 } {
        Write-Output "[$stamp] status=$code，不重启（restart 修不好这类问题）"
        Write-Output $status.Trim()
        exit 0
    }
}

if ($status -match '"manually_stopped":\s*true') {
    Write-Output "[$stamp] 有意停机中（manually-stopped 标记存在），跳过拉起"
    exit 0
}

Write-Output "[$stamp] status=$code，尝试 restart -RespectStop"
$restart = (& $control -Action restart -Profile $Profile -Url $Url -RespectStop 2>&1 | Out-String)
$restartCode = $LASTEXITCODE
Write-Output ($restart.Trim())
if ($restartCode -ne 0) {
    Write-Output "[$stamp] restart 失败（exit=$restartCode）。最近日志尾部："
    $logs = @(Get-ChildItem -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) '.artifacts') -Filter "dsh-superagent-$Profile-*.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending)
    if ($logs.Count -gt 0) { Get-Content -LiteralPath $logs[0].FullName -Tail 40 }
}
exit 0
