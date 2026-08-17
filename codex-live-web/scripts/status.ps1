$pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pidPaths = @(
  (Join-Path $pluginRoot '.codex-live-web.pid')
  (Join-Path $env:LOCALAPPDATA 'CodexLiveWeb\codex-live-web.pid')
)
$port = if ($env:CODEX_LIVE_WEB_PORT) { [int]$env:CODEX_LIVE_WEB_PORT } else { 17346 }
foreach ($pidPath in $pidPaths) {
  if (Test-Path -LiteralPath $pidPath) {
    $serverPid = 0
    [int]::TryParse((Get-Content -Raw -LiteralPath $pidPath), [ref]$serverPid) | Out-Null
    if ($serverPid -gt 0 -and (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
      Write-Output "Codex Live Web is running: http://127.0.0.1:$port/"
      exit 0
    }
  }
}
Write-Output 'Codex Live Web is not running.'
