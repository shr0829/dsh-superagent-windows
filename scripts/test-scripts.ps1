#Requires -Version 5.1
<#
.SYNOPSIS
    仓库自检：.ps1 的 BOM、语法，以及语法树里点源/调用到的文件是否存在。

.DESCRIPTION
    为什么需要它：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 文件按 ANSI 解码，
    中文注释能吃掉落后的引号和换行，脚本变成一个语法错误集合，而 PS7 上一切正常。
    这类问题只能靠"检查 BOM 位"提前发现，跑起来才报错就太晚了。

    退出码：0 全部通过；1 有失败项。
#>
[CmdletBinding()]
param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\common.ps1')
Set-ConsoleUtf8

$root = Split-Path -Parent $PSScriptRoot
$failures = New-Object System.Collections.ArrayList
$checked = 0

$files = @(Get-ChildItem -LiteralPath $root -Recurse -File |
        Where-Object {
            ($_.Extension -eq '.ps1' -or $_.Extension -eq '.psm1') -and
            $_.FullName -notmatch '\\upstream\\|\\node_modules\\|\\.artifacts\\'
        })

foreach ($file in $files) {
    $checked++
    $relative = $file.FullName.Substring($root.Length + 1)
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)

    # 1) BOM
    if (-not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) {
        [void]$failures.Add("$relative : 缺少 UTF-8 BOM（Windows PowerShell 5.1 会按 ANSI 解码，中文注释会破坏语法）")
    }

    # 2) 语法。必须用 ReadAllText（会自动识别 BOM 与 UTF-8），不能用 Get-Content 的默认编码。
    $text = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
        foreach ($parseError in $errors | Select-Object -First 3) {
            [void]$failures.Add("$relative : 第 $($parseError.Extent.StartLineNumber) 行 语法错误：$($parseError.Message)")
        }
        continue
    }

    # 3) 点源引用的文件是否存在：. (Join-Path $PSScriptRoot 'lib\common.ps1')
    $matches = [regex]::Matches($text, "Join-Path\s+\`$PSScriptRoot\s+'([^']+)'")
    foreach ($match in $matches) {
        $target = Join-Path $PSScriptRoot $match.Groups[1].Value
        if (-not (Test-Path -LiteralPath $target)) {
            [void]$failures.Add("$relative : 引用了不存在的文件 $($match.Groups[1].Value)")
        }
    }
}

if ($failures.Count -gt 0) {
    foreach ($failure in $failures) { [Console]::Error.WriteLine($failure) }
    [Console]::Error.WriteLine("$($failures.Count) 项失败，共检查 $checked 个脚本。")
    exit 1
}

if (-not $Quiet) { Write-Output "OK: $checked 个脚本，BOM 与语法全部通过。" }
exit 0
