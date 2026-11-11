#Requires -Version 5.1
<#
.SYNOPSIS
    本仓库所有脚本共用的工具函数。用点源引用：. "$PSScriptRoot\lib\common.ps1"

.DESCRIPTION
    目标环境是 stock Windows：Windows PowerShell 5.1 能跑，PowerShell 7 也照样能跑。
    为此这里有三个刻意的选择：
      - 文件读写一律显式用无 BOM 的 UTF-8，不依赖 Get-Content/Set-Content 的默认编码
        （5.1 的默认是系统 ANSI 代码页，读 UTF-8 的 YAML 会变乱码，写回去就毁文件）；
      - HTTP 用 HttpWebRequest 而不是 Invoke-RestMethod，因为 5.1 没有 -NoProxy，
        而本机配了系统代理时 127.0.0.1 的请求可能被代理吞掉；
      - 不用 `??`、`-AsHashtable`、三元运算符这些 6+ 才有的语法。
#>

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Set-ConsoleUtf8 {
    try {
        [Console]::OutputEncoding = $script:Utf8NoBom
        $global:OutputEncoding = $script:Utf8NoBom
    } catch { }
}

# 读文本：文件不存在返回空串（调用方少写一次 Test-Path）
function Read-Utf8Text {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

# 写文本：自动建父目录，无 BOM，保证换行是 CRLF（这些文件都在 Windows 上被别的程序读）
function Write-Utf8Text {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text
    )
    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

# 本地管理 API 的 GET：失败返回 $null，调用方据此判断"没有应答"
function Invoke-JsonGet {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [int]$TimeoutSec = 3,
        [hashtable]$Headers = @{},
        [switch]$Raw
    )
    $request = $null
    $response = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create($Uri)
        $request.Method = 'GET'
        $request.Proxy = $null
        $request.AllowAutoRedirect = $false
        $request.UserAgent = 'dsh-superagent-windows'
        $request.Timeout = $TimeoutSec * 1000
        $request.ReadWriteTimeout = $TimeoutSec * 1000
        foreach ($key in $Headers.Keys) {
            $request.Headers.Add([string]$key, [string]$Headers[$key])
        }
        $response = $request.GetResponse()
        $stream = $response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
        $reader.Dispose()
        $stream.Dispose()
        if ($Raw) { return $text }
        return ($text | ConvertFrom-Json)
    } catch {
        return $null
    } finally {
        if ($response) { $response.Close() }
    }
}

# 版本号：从 "v22.19.0" / "git version 2.47.1" 这类字符串里抠出 [version]
function Get-VersionNumber {
    param([string]$Text)
    if (-not $Text) { return $null }
    $match = [regex]::Match($Text, '(\d+)\.(\d+)\.(\d+)')
    if (-not $match.Success) { return $null }
    return (New-Object System.Version(
            [int]$match.Groups[1].Value,
            [int]$match.Groups[2].Value,
            [int]$match.Groups[3].Value))
}
