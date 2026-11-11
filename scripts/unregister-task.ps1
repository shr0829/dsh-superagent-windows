#Requires -Version 5.1
<#
.SYNOPSIS
    删除 register-task.ps1 创建的计划任务。不碰服务进程、不删 profile、不删 stateDir。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\unregister-task.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\unregister-task.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Profile = $(if ($env:DSH_SUPERAGENT_PROFILE) { $env:DSH_SUPERAGENT_PROFILE } else { 'superagent' }),
    [string]$TaskPrefix = 'dsh-superagent'
)

$ErrorActionPreference = 'Stop'

$names = @("$TaskPrefix-$Profile-hourly", "$TaskPrefix-$Profile-logon")
foreach ($name in $names) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Output "not found: $name"
        continue
    }
    if ($PSCmdlet.ShouldProcess($name, 'Unregister-ScheduledTask')) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Output "removed $name"
    }
}
