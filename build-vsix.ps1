$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$extensionRoot = Join-Path $projectRoot 'vscode-extension'
$sourceExecutable = Join-Path $projectRoot 'dist\CodexLiveWeb.exe'
$extensionBin = Join-Path $extensionRoot 'bin'
$extensionExecutable = Join-Path $extensionBin 'CodexLiveWeb.exe'
$manifestPath = Join-Path $extensionRoot 'package.json'
$extensionVersion = (Get-Content -Raw -Encoding utf8 -LiteralPath $manifestPath | ConvertFrom-Json).version
$outputPath = Join-Path $projectRoot "dist\CodexLiveWeb-$extensionVersion-win32-x64.vsix"

if (-not (Test-Path -LiteralPath $sourceExecutable -PathType Leaf)) {
  throw 'dist\CodexLiveWeb.exe was not found. Run build-native.ps1 first.'
}

$npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
if ($npxCommand) {
  $npxPath = $npxCommand.Source
} else {
  $npxPath = 'C:\Program Files\nodejs\npx.cmd'
  if (-not (Test-Path -LiteralPath $npxPath -PathType Leaf)) {
    throw 'npx.cmd was not found. Install Node.js on the build machine.'
  }
}

New-Item -ItemType Directory -Force -Path $extensionBin | Out-Null
Copy-Item -LiteralPath $sourceExecutable -Destination $extensionExecutable -Force

Push-Location $extensionRoot
try {
  & $npxPath --yes '@vscode/vsce' package --target win32-x64 --no-dependencies --allow-missing-repository --out $outputPath
  if ($LASTEXITCODE -ne 0) { throw 'VSIX packaging failed.' }
} finally {
  Pop-Location
}

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath
$size = (Get-Item -LiteralPath $outputPath).Length
Write-Output "Built: $outputPath"
Write-Output "Size: $size bytes"
Write-Output "SHA256: $($hash.Hash)"
