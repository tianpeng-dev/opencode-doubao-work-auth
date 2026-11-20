# 退出豆包工作后导入会话（Windows，纯 JS 实现，不依赖 Python / uv）
#
# 豆包工作在运行时会把 Cookies 数据库以独占方式锁住，任何进程都读不到，
# 所以首次导入必须在客户端完全退出时进行。这个脚本会等客户端退出，然后执行导入。
#
# 用法（在独立 PowerShell 窗口，且已退出豆包工作）：
#   cd "C:\Users\qiuzhenyu\DoubaoWork\chats\2026-11-13\new-chat\opencode-doubao-work-auth-win"
#   powershell -ExecutionPolicy Bypass -File .\import-doubao-work.ps1
#
# 注意：本文件必须保存为 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按 GBK 解码导致语法错误。

param(
    [string]$MagpiePath = "C:\Users\qiuzhenyu\DeskBox\DeskBox\magpie-windows-amd64.exe",
    [int]$TimeoutSeconds = 600,
    [switch]$SkipWait
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $MagpiePath)) {
    Write-Host "找不到 magpie：$MagpiePath" -ForegroundColor Red
    Write-Host "请用 -MagpiePath 指定 magpie-windows-amd64.exe 的实际路径。" -ForegroundColor Yellow
    exit 1
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
if ($SkipWait) {
    Write-Host "已跳过等待（-SkipWait），直接执行导入。" -ForegroundColor Yellow
} else {
    Write-Host "请完全退出豆包工作（包括托盘图标）。脚本会等待客户端退出后自动导入。" -ForegroundColor Cyan
}

while (-not $SkipWait -and ($null -ne (Get-Process -Name DoubaoWork -ErrorAction SilentlyContinue))) {
    if ((Get-Date) -gt $deadline) {
        Write-Host "等待超时（$TimeoutSeconds 秒），未执行导入。" -ForegroundColor Red
        exit 1
    }
    $count = @(Get-Process -Name DoubaoWork -ErrorAction SilentlyContinue).Count
    Write-Host ("  仍在运行：{0} 个进程，等待中… {1:HH:mm:ss}" -f $count, (Get-Date))
    Start-Sleep -Seconds 3
}

if ($SkipWait) { Write-Host "开始导入…" -ForegroundColor Green }
else { Write-Host "客户端已退出，开始导入…" -ForegroundColor Green }

$logPath = Join-Path $PSScriptRoot "import-last-run.log"
$startedAt = Get-Date
$utf8 = New-Object System.Text.UTF8Encoding($false)

# 统一用「文件重定向」跑 magpie：既避开 5.1 下 2>&1 把 stderr 包成 ErrorRecord 触发
# $ErrorActionPreference="Stop" 的问题，也能避免管道写 stdin 带 CRLF 的坑。
function Invoke-Magpie {
    param([string[]]$Arguments, [string]$StdinText)
    $dir = Join-Path $env:TEMP ("dw-" + [guid]::NewGuid().ToString("n"))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $out = Join-Path $dir "out.txt"
    $err = Join-Path $dir "err.txt"
    $extra = @{}
    if ($PSBoundParameters.ContainsKey("StdinText")) {
        $stdin = Join-Path $dir "in.txt"
        [IO.File]::WriteAllText($stdin, $StdinText, $utf8)
        $extra["RedirectStandardInput"] = $stdin
    }
    $proc = Start-Process -FilePath $MagpiePath -ArgumentList $Arguments `
        -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow -Wait -PassThru @extra
    $text = ""
    if (Test-Path -LiteralPath $out) { $text += [IO.File]::ReadAllText($out, $utf8) }
    if (Test-Path -LiteralPath $err) { $text += [IO.File]::ReadAllText($err, $utf8) }
    return [pscustomobject]@{ Code = $proc.ExitCode; Text = $text }
}

# magpie 只按 LF 切行读取交互输入：管道/WriteLine 会带 CRLF，收到 "auto\r" 会被判成
# 非法配置名直接退出。这里固定喂 "auto\n"。
$login = Invoke-Magpie -Arguments @("plugin", "login", "doubao-work") -StdinText "auto`n"
[IO.File]::WriteAllText($logPath, $login.Text, $utf8)
$login.Text.Trim() -split "`n" | Where-Object { $_ } | ForEach-Object { Write-Host $_ }
Write-Host "magpie 退出码：$($login.Code)"

# 以真实状态判定成败：成功导入时 magpie 可能既没有输出也没有非零退出码，
# 只看退出码会把成功判成失败（这个坑已经踩过一次）。
$listing = Invoke-Magpie -Arguments @("plugin")
$pluginList = $listing.Text
$doubaoLine = ($pluginList -split "`n" | Where-Object { $_ -match 'doubao-work \(' } | Select-Object -First 1)
$signedIn = $doubaoLine -match 'signed in'
$cachePath = Join-Path $env:LOCALAPPDATA "doubao-work-magpie\session.dpapi"
$cacheFresh = (Test-Path -LiteralPath $cachePath) -and ((Get-Item -LiteralPath $cachePath).LastWriteTime -ge $startedAt.AddSeconds(-5))

if ($signedIn) {
    Write-Host "导入完成：$($doubaoLine.Trim())" -ForegroundColor Green
    if (-not $cacheFresh) { Write-Host "提示：会话缓存没有刷新，可能是复用了已有缓存。" -ForegroundColor Yellow }
    Write-Host "验证：" -ForegroundColor Cyan
    Write-Host "  magpie plugin                                  # 看 doubao-work 的模型数"
    Write-Host "  magpie provider test doubao-work doubao-work-lite   # 真发一次请求"
    exit 0
}

Write-Host "导入失败。常见原因：" -ForegroundColor Red
Write-Host "  1) 托盘里还有常驻进程：任务管理器里结束所有 DoubaoWork 进程后重试"
Write-Host "  2) 客户端里没有登录会话：先登录豆包工作并打开一次对话页面"
Write-Host "  3) 以上都不是：把 $logPath 的内容发我，里面有完整报错"
if (Test-Path -LiteralPath $logPath) {
    $tail = @(Get-Content -LiteralPath $logPath -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Last 5)
    if ($tail.Count -gt 0) { Write-Host "--- 日志末尾 ---" -ForegroundColor Yellow; $tail | ForEach-Object { Write-Host $_ } }
}
exit 1
