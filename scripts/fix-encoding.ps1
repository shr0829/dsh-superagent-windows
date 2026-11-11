<#
.SYNOPSIS
    把仓库里的 PowerShell 脚本统一成 UTF-8 with BOM + CRLF。

.DESCRIPTION
    Windows PowerShell 5.1 读 .ps1 时按系统 ANSI 代码页解码（本机是 936/GBK）。
    文件里只要有中文，无 BOM 的 UTF-8 就会被解成乱码，而且乱码会把后面的引号和
    换行一起吃掉，解析器报出来的错（"字符串缺少终止符"）指向的位置根本不是问题所在。

    几乎每个编辑器都会在保存时丢掉 BOM（VS Code 默认、各种格式化工具、git 的
    过滤器）。所以改完脚本先跑 test-scripts.ps1；它报 "缺少 UTF-8 BOM" 时用本脚本修，
    不要靠手工加。

.PARAMETER Check
    只检查不写入。需要修的文件会被列出来，退出码 1；全都合格时退出码 0。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-encoding.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-encoding.ps1 -Check
#>
#Requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$skipped = @('upstream', 'node_modules', '.artifacts', '.git')
$files = Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object {
    $_.Extension -in '.ps1', '.psm1' -and
    -not ($_.FullName.Substring($root.Length).Split('\') | Where-Object { $_ -in $skipped })
}

$changed = 0

foreach ($file in $files) {
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $offset = 0
    if ($hasBom) { $offset = 3 }

    $text = $utf8Bom.GetString($bytes, $offset, $bytes.Length - $offset)
    $text = $text -replace "`r`n", "`n"
    $text = $text -replace "`n", "`r`n"

    # 没有 BOM 的文件必然要改；有 BOM 的还要看换行是否已经是 CRLF。
    # 注意：Encoding.GetBytes 不产生 BOM，preamble 必须自己拼上去，
    # 否则写回的文件看起来"有 BOM"其实没有，5.1 依旧按 ANSI 解码。
    $body = $utf8Bom.GetBytes($text)
    $normalized = New-Object byte[] ($utf8Bom.GetPreamble().Length + $body.Length)
    [System.Array]::Copy($utf8Bom.GetPreamble(), 0, $normalized, 0, $utf8Bom.GetPreamble().Length)
    [System.Array]::Copy($body, 0, $normalized, $utf8Bom.GetPreamble().Length, $body.Length)

    $same = $false
    if ($hasBom -and $normalized.Length -eq $bytes.Length) {
        $same = $true
        for ($i = 0; $i -lt $bytes.Length; $i++) {
            if ($bytes[$i] -ne $normalized[$i]) { $same = $false; break }
        }
    }

    if ($same) { continue }

    $relative = $file.FullName.Substring($root.Length + 1)
    if ($Check) {
        Write-Output "需要修：$relative"
        $changed++
        continue
    }

    [System.IO.File]::WriteAllBytes($file.FullName, $normalized)
    Write-Output "已规范化：$relative"
    $changed++
}

if ($Check) {
    if ($changed -gt 0) {
        Write-Output "$changed 个文件需要规范化；去掉 -Check 重跑即可修好。"
        exit 1
    }
    Write-Output "OK: $($files.Count) 个脚本均为 UTF-8 with BOM + CRLF。"
    exit 0
}

Write-Output "OK: 处理 $($files.Count) 个脚本，改写 $changed 个。"
exit 0
