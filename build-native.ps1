$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$nativeRoot = Join-Path $projectRoot 'codex-live-web\native'
$releaseExecutable = Join-Path $nativeRoot 'target\release\CodexLiveWeb.exe'
$distDirectory = Join-Path $projectRoot 'dist'
$pluginBinDirectory = Join-Path $projectRoot 'codex-live-web\bin'
$distExecutable = Join-Path $distDirectory 'CodexLiveWeb.exe'
$pluginExecutable = Join-Path $pluginBinDirectory 'CodexLiveWeb.exe'

if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
  throw 'Rust Cargo was not found. Install the Rust MSVC toolchain on the build machine.'
}

Push-Location $nativeRoot
try {
  cargo.exe test --locked
  if ($LASTEXITCODE -ne 0) { throw 'Native tests failed.' }

  cargo.exe build --release --locked
  if ($LASTEXITCODE -ne 0) { throw 'Native release build failed.' }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $distDirectory, $pluginBinDirectory | Out-Null
Copy-Item -LiteralPath $releaseExecutable -Destination $distExecutable -Force
Copy-Item -LiteralPath $releaseExecutable -Destination $pluginExecutable -Force

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $distExecutable
$size = (Get-Item -LiteralPath $distExecutable).Length
Write-Output "Built: $distExecutable"
Write-Output "Size: $size bytes"
Write-Output "SHA256: $($hash.Hash)"
