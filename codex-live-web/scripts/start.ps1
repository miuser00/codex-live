$ErrorActionPreference = 'Stop'

$pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$port = if ($env:CODEX_LIVE_WEB_PORT) { [int]$env:CODEX_LIVE_WEB_PORT } else { 17346 }
$nativeExecutable = Join-Path $pluginRoot 'bin\CodexLiveWeb.exe'
if (Test-Path -LiteralPath $nativeExecutable -PathType Leaf) {
  Start-Process -FilePath $nativeExecutable
  Write-Output "Codex Live Web native viewer started: http://127.0.0.1:$port/"
  exit 0
}

$pidPath = Join-Path $pluginRoot '.codex-live-web.pid'
$logDir = Join-Path $pluginRoot '.logs'
$stdoutPath = Join-Path $logDir 'server.out.log'
$stderrPath = Join-Path $logDir 'server.err.log'
$listenHost = if ($env:CODEX_LIVE_WEB_HOST) { $env:CODEX_LIVE_WEB_HOST } else { '127.0.0.1' }
$url = "http://$listenHost`:$port/"

if (Test-Path -LiteralPath $pidPath) {
  $existingPid = 0
  [int]::TryParse((Get-Content -Raw -LiteralPath $pidPath), [ref]$existingPid) | Out-Null
  if ($existingPid -gt 0 -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
    Start-Process $url
    Write-Output "Codex Live Web is already running: $url"
    exit 0
  }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

& (Join-Path $PSScriptRoot 'ensure-node.ps1')

$dependencyMarker = Join-Path $pluginRoot 'node_modules\markdown-it\package.json'
if (-not (Test-Path -LiteralPath $dependencyMarker)) {
  npm.cmd install --omit=dev --prefix $pluginRoot
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$process = Start-Process node -ArgumentList @('server.mjs') -WorkingDirectory $pluginRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
$process.Id | Set-Content -LiteralPath $pidPath -Encoding ascii
Start-Sleep -Milliseconds 350
if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
  $details = if (Test-Path -LiteralPath $stderrPath) { Get-Content -Raw -LiteralPath $stderrPath } else { '' }
  throw "Web server failed to start. $details"
}
Start-Process $url
Write-Output "Codex Live Web started: $url"
