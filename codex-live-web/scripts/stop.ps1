$ErrorActionPreference = 'Stop'
$pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pidPaths = @(
  (Join-Path $pluginRoot '.codex-live-web.pid')
  (Join-Path $env:LOCALAPPDATA 'CodexLiveWeb\codex-live-web.pid')
)
$stopped = $false
foreach ($pidPath in $pidPaths) {
  if (-not (Test-Path -LiteralPath $pidPath)) { continue }
  $serverPid = 0
  [int]::TryParse((Get-Content -Raw -LiteralPath $pidPath), [ref]$serverPid) | Out-Null
  if ($serverPid -gt 0) {
    Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
    $stopped = $true
  }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}
if ($stopped) { Write-Output 'Codex Live Web stopped.' } else { Write-Output 'Codex Live Web is not running.' }
