$ErrorActionPreference = 'Stop'

$distributionRoot = (Resolve-Path (Join-Path $PSScriptRoot 'codex-live-web')).Path
$pluginParent = Join-Path $env:USERPROFILE 'plugins'
$pluginTarget = Join-Path $pluginParent 'codex-live-web'

function Copy-DirectoryContents {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string[]]$ExcludeNames = @()
  )

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    if ($ExcludeNames -notcontains $_.Name) {
      $target = Join-Path $Destination $_.Name
      if ($_.PSIsContainer) {
        Copy-DirectoryContents -Source $_.FullName -Destination $target
      } else {
        Copy-Item -LiteralPath $_.FullName -Destination $target -Force
      }
    }
  }
}

function Remove-LegacyNestedCopies {
  param([Parameter(Mandatory = $true)][string]$Destination)

  $legacyMarkers = [ordered]@{
    '.codex-plugin' = 'plugin.json'
    'lib' = 'events.mjs'
    'public' = 'index.html'
    'scripts' = 'start.ps1'
    'skills' = 'codex-live-web\SKILL.md'
    'test' = 'events.test.mjs'
  }

  foreach ($directoryName in $legacyMarkers.Keys) {
    $legacyDirectory = Join-Path (Join-Path $Destination $directoryName) $directoryName
    $markerPath = Join-Path $legacyDirectory $legacyMarkers[$directoryName]
    if (Test-Path -LiteralPath $markerPath) {
      Remove-Item -LiteralPath $legacyDirectory -Recurse -Force
      Write-Output "Removed legacy nested directory: $legacyDirectory"
    }
  }
}

function Find-CodexCommand {
  foreach ($commandName in @('codex.cmd', 'codex.exe', 'codex')) {
    $command = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
  }

  if ($env:APPDATA) {
    $npmCodexCommand = Join-Path $env:APPDATA 'npm\codex.cmd'
    if (Test-Path -LiteralPath $npmCodexCommand -PathType Leaf) {
      return $npmCodexCommand
    }
  }

  $extensionsRoot = Join-Path $env:USERPROFILE '.vscode\extensions'
  if (-not (Test-Path -LiteralPath $extensionsRoot)) { return $null }

  $candidate = Get-ChildItem -LiteralPath $extensionsRoot -Directory -Filter 'openai.chatgpt-*' -ErrorAction SilentlyContinue |
    ForEach-Object {
      $binRoot = Join-Path $_.FullName 'bin'
      if (Test-Path -LiteralPath $binRoot) {
        Get-ChildItem -LiteralPath $binRoot -Recurse -Filter 'codex.exe' -File -ErrorAction SilentlyContinue
      }
    } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($candidate) { return $candidate.FullName }
  return $null
}

Remove-LegacyNestedCopies -Destination $pluginTarget
Copy-DirectoryContents -Source $distributionRoot -Destination $pluginTarget -ExcludeNames @('native', 'node_modules', '.logs', '.codex-live-web.pid', 'test')

$nativeExecutable = Join-Path $pluginTarget 'bin\CodexLiveWeb.exe'
if (Test-Path -LiteralPath $nativeExecutable -PathType Leaf) {
  Write-Output "Native viewer ready: $nativeExecutable"
} else {
  $ensureNodeScript = Join-Path $pluginTarget 'scripts\ensure-node.ps1'
  & $ensureNodeScript
  Write-Warning 'Native viewer was not included. The Node.js prototype will be used.'
}

$codexCommand = Find-CodexCommand
$registered = $false
if ($codexCommand) {
  try {
    & $codexCommand plugin add codex-live-web@personal
    if ($LASTEXITCODE -eq 0) {
      $registered = $true
      Write-Output "Codex plugin registered with: $codexCommand"
    } else {
      Write-Warning "The viewer was installed, but Codex plugin registration failed with exit code $LASTEXITCODE."
    }
  } catch {
    Write-Warning "The viewer was installed, but Codex plugin registration failed: $($_.Exception.Message)"
  }
} else {
  Write-Warning 'Codex CLI was not found. Plugin registration was skipped; standalone viewer mode is ready.'
}

Write-Output "Installed source: $pluginTarget"
Write-Output "Start viewer: & '$pluginTarget\scripts\start.ps1'"
if ($registered) {
  Write-Output 'Next: start a new Codex thread and ask to open Codex Live Web.'
}
