$ErrorActionPreference = 'Stop'

$minimumNodeMajor = 18

function Get-NodeMajorVersion {
  param([Parameter(Mandatory = $true)][string]$NodePath)

  try {
    $versionText = (& $NodePath --version 2>$null | Select-Object -First 1)
    if ($versionText -match '^v(?<major>\d+)\.') {
      return [int]$Matches.major
    }
  } catch {
    return $null
  }

  return $null
}

function Update-ProcessPath {
  $registeredPath = @(
    [Environment]::GetEnvironmentVariable('Path', 'Machine')
    [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path
  ) -join ';'

  $seen = @{}
  $pathEntries = foreach ($entry in ($registeredPath -split ';')) {
    $trimmed = $entry.Trim()
    if ($trimmed -and -not $seen.ContainsKey($trimmed)) {
      $seen[$trimmed] = $true
      $trimmed
    }
  }

  $env:Path = $pathEntries -join ';'
}

function Enable-NodeEnvironment {
  Update-ProcessPath

  $candidateRoots = @()
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) { $candidateRoots += Split-Path -Parent $nodeCommand.Source }
  if ($env:ProgramW6432) { $candidateRoots += Join-Path $env:ProgramW6432 'nodejs' }
  if ($env:ProgramFiles) { $candidateRoots += Join-Path $env:ProgramFiles 'nodejs' }
  if ($env:LOCALAPPDATA) { $candidateRoots += Join-Path $env:LOCALAPPDATA 'Programs\nodejs' }

  $seen = @{}
  foreach ($candidateRoot in $candidateRoots) {
    if (-not $candidateRoot -or $seen.ContainsKey($candidateRoot)) { continue }
    $seen[$candidateRoot] = $true

    $nodePath = Join-Path $candidateRoot 'node.exe'
    $npmPath = Join-Path $candidateRoot 'npm.cmd'
    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
      continue
    }

    $nodeMajor = Get-NodeMajorVersion -NodePath $nodePath
    if ($null -ne $nodeMajor -and $nodeMajor -ge $minimumNodeMajor) {
      $env:Path = "$candidateRoot;$env:Path"
      return $candidateRoot
    }
  }

  return $null
}

$nodeRoot = Enable-NodeEnvironment
if ($nodeRoot) {
  $nodeVersion = & (Join-Path $nodeRoot 'node.exe') --version
  Write-Output "Node.js ready: $nodeVersion"
  return
}

$wingetCommand = Get-Command winget.exe -ErrorAction SilentlyContinue
$wingetPath = if ($wingetCommand) { $wingetCommand.Source } else { $null }
if (-not $wingetPath -and $env:LOCALAPPDATA) {
  $windowsAppsWinget = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
  if (Test-Path -LiteralPath $windowsAppsWinget -PathType Leaf) {
    $wingetPath = $windowsAppsWinget
  }
}

if (-not $wingetPath) {
  throw 'Node.js 18+ and npm are required, and winget was not found. Install Node.js LTS from https://nodejs.org/ and retry.'
}

Write-Output 'Node.js 18+ and npm were not found. Installing Node.js LTS with winget...'
& $wingetPath install `
  --id OpenJS.NodeJS.LTS `
  --exact `
  --source winget `
  --silent `
  --accept-package-agreements `
  --accept-source-agreements `
  --disable-interactivity

$wingetExitCode = $LASTEXITCODE
$nodeRoot = Enable-NodeEnvironment

if ($nodeRoot) {
  $nodeVersion = & (Join-Path $nodeRoot 'node.exe') --version
  Write-Output "Node.js ready after winget check: $nodeVersion"
  return
}

if ($wingetExitCode -ne 0) {
  throw "Node.js is registered with winget but node.exe and npm.cmd are unavailable. Winget exit code: $wingetExitCode. Restart Windows or repair the Node.js LTS installation."
}

throw 'Node.js was installed but node.exe and npm.cmd are unavailable. Open a new PowerShell window and retry.'
