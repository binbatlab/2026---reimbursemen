param(
  [switch]$CheckOnly,
  [string]$Script = "",
  [string[]]$ScriptArgs = @()
)

# 西电报销助手 · 统一启动器
#   launch.ps1 -CheckOnly
#   launch.ps1 -Script scripts\ywtb.mjs -ScriptArgs "--mode","seven"
#   launch.ps1 -Script scripts\extract_invoices.py -ScriptArgs "invoices\raw"
# 说明：.py 用自带便携 Python 跑，.mjs 用 Node 跑；浏览器统一带调试端口拉起。

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$Here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillRoot = Split-Path -Parent $Here
$Port      = if ($env:YWTB_CDP_PORT) { [int]$env:YWTB_CDP_PORT } else { 9222 }
$ProfileDir = if ($env:YWTB_PROFILE) { $env:YWTB_PROFILE }
              else { Join-Path $env:LOCALAPPDATA "ywtb-skill\profile" }
$BundledPy  = Join-Path $SkillRoot "runtime\python\python.exe"

function Find-Node {
  if ($env:YWTB_NODE -and (Test-Path $env:YWTB_NODE)) { return $env:YWTB_NODE }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $bundled = Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path $bundled) { return $bundled }
  return $null
}

function Find-Python {
  # 优先用包里自带的便携 Python，别人无需安装
  if (Test-Path $BundledPy) { return $BundledPy }
  if ($env:YWTB_PYTHON -and (Test-Path $env:YWTB_PYTHON)) { return $env:YWTB_PYTHON }
  foreach ($n in @("python.exe", "python3.exe")) {
    $cmd = Get-Command $n -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return $null
}

function Find-Chrome {
  if ($env:YWTB_CHROME -and (Test-Path $env:YWTB_CHROME)) { return $env:YWTB_CHROME }
  $cands = @(
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe")
  )
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function Test-Cdp {
  try { (Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2).Browser }
  catch { $null }
}

$node   = Find-Node
$python = Find-Python
$chrome = Find-Chrome

if ($CheckOnly) {
  $cdp = Test-Cdp
  Write-Output "node    : $node"
  Write-Output "python  : $python"
  Write-Output "chrome  : $chrome"
  Write-Output "port    : $Port  (CDP: $(if($cdp){$cdp}else{'未启动'}))"
  Write-Output "profile : $ProfileDir"
  if (-not $node) { Write-Output "RESULT: 缺少 Node（DSH 自带，检查安装）"; exit 1 }
  if (-not $python) { Write-Output "RESULT: 缺少 Python（包内 runtime 缺失）"; exit 1 }
  if (-not $chrome) { Write-Output "RESULT: 找不到 Chrome/Edge"; exit 1 }
  Write-Output "RESULT: OK"
  exit 0
}

if (-not $Script) { Write-Output "缺少 -Script 参数"; exit 1 }

# powershell -File 传数组时会退化成 "a,b" 单个字符串，这里还原
if ($ScriptArgs.Count -eq 1 -and $ScriptArgs[0] -is [string] -and $ScriptArgs[0].Contains(",")) {
  $ScriptArgs = $ScriptArgs[0] -split ","
}

# 中文/¥ 等字符在 GBK 控制台下会崩，强制 Python 走 UTF-8
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"
$env:YWTB_PROFILE = $ProfileDir
$env:YWTB_CDP_PORT = "$Port"
if (-not $env:YWTB_WORKDIR) { $env:YWTB_WORKDIR = (Get-Location).Path }

# 只跑 .py（解析发票）时不需要浏览器
$isPython = $Script -match '\.py$'

if (-not $isPython -and -not (Test-Cdp)) {
  if (-not $chrome) { Write-Output "找不到 Chrome/Edge"; exit 1 }
  New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
  Start-Process -FilePath $chrome -ArgumentList @(
    "--remote-debugging-port=$Port", "--remote-allow-origins=*",
    "--no-first-run", "--no-default-browser-check", "--disable-breakpad",
    "--user-data-dir=$ProfileDir", "about:blank"
  ) | Out-Null
  $ok = $false
  for ($i = 0; $i -lt 50; $i++) { Start-Sleep -Milliseconds 500; if (Test-Cdp) { $ok = $true; break } }
  if (-not $ok) { Write-Output "浏览器未能在 25 秒内开放调试端口（可能是权限限制）"; exit 1 }
}

$full = $null
foreach ($cand in @((Join-Path $Here $Script), (Join-Path $Here (Split-Path $Script -Leaf)),
                    (Join-Path $SkillRoot $Script), $Script)) {
  if (Test-Path $cand) { $full = (Resolve-Path $cand).Path; break }
}
if (-not $full) { Write-Output "找不到脚本: $Script"; exit 1 }

if ($isPython) {
  & $python $full @ScriptArgs
} else {
  & $node $full @ScriptArgs
}
exit $LASTEXITCODE
