param(
  [ValidateSet('save','test','clear','reveal','import')]
  [string]$Action = 'test',
  [string]$User = '',
  [string]$File = ''
)

# DPAPI 凭据存取（绑定当前 Windows 用户账户加密）
#   save   : 从剪贴板读（两行=账号/密码，一行=密码配 -User）
#   import : 从 -File 指定的 JSON 读 {user, pass}，适合设置页调用
#   test   : 只验能不能解出来（不打印密码）
#   reveal : 打印 JSON {user, pass}，供启动脚本自动登录用
#   clear  : 删除
$credPath = Join-Path $PSScriptRoot '..\.ywtb.cred'
$credPath = [IO.Path]::GetFullPath($credPath)

function Get-Plain([Security.SecureString]$sec) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

switch ($Action) {
  'save' {
    $raw = Get-Clipboard -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) { throw '剪贴板为空：请先把账号密码复制到剪贴板' }
    $lines = @($raw -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
    $u = $User.Trim(); $p = $lines[0].Trim()
    if ($lines.Count -ge 2 -and [string]::IsNullOrWhiteSpace($u)) { $u = $lines[0].Trim(); $p = $lines[1].Trim() }
    if ([string]::IsNullOrWhiteSpace($u)) { throw '缺少账号：请用两行格式（账号/密码）或传 -User' }
    $sec = ConvertTo-SecureString -String $p -AsPlainText -Force
    $enc = ConvertFrom-SecureString -SecureString $sec
    [ordered]@{ user = $u; secret = $enc; savedAt = (Get-Date).ToString('s') } |
      ConvertTo-Json | Set-Content -Path $credPath -Encoding UTF8
    Set-Clipboard -Value ''
    "SAVED  user={0}***  pwdLen={1}" -f $u.Substring(0, [Math]::Min(2, $u.Length)), $p.Length
  }
  'import' {
    if ([string]::IsNullOrWhiteSpace($File) -or -not (Test-Path $File)) { throw '缺少 -File' }
    $o = Get-Content -Raw -Path $File | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($o.user) -or [string]::IsNullOrWhiteSpace($o.pass)) { throw 'JSON 需要 user 和 pass' }
    $sec = ConvertTo-SecureString -String $o.pass -AsPlainText -Force
    [ordered]@{ user = $o.user; secret = (ConvertFrom-SecureString -SecureString $sec); savedAt = (Get-Date).ToString('s') } |
      ConvertTo-Json | Set-Content -Path $credPath -Encoding UTF8
    "SAVED  user={0}***" -f $o.user.Substring(0, [Math]::Min(2, $o.user.Length))
  }
  'test' {
    if (-not (Test-Path $credPath)) { 'NO_CRED'; break }
    $obj = Get-Content -Raw $credPath | ConvertFrom-Json
    $p = Get-Plain (ConvertTo-SecureString $obj.secret)
    "OK  user={0}***  pwdLen={1}  savedAt={2}" -f $obj.user.Substring(0, [Math]::Min(2, $obj.user.Length)), $p.Length, $obj.savedAt
  }
  'reveal' {
    if (-not (Test-Path $credPath)) { 'NO_CRED'; break }
    $obj = Get-Content -Raw $credPath | ConvertFrom-Json
    [ordered]@{ user = $obj.user; pass = (Get-Plain (ConvertTo-SecureString $obj.secret)) } | ConvertTo-Json -Compress
  }
  'clear' {
    Remove-Item $credPath -Force -ErrorAction SilentlyContinue
    'CLEARED'
  }
}
