[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [Parameter(Mandatory = $true)][string]$RollbackRoot,
  [Parameter(Mandatory = $true)][string]$AppId
)

$ErrorActionPreference = 'Stop'

function Test-SamePath([string]$Left, [string]$Right) {
  return [String]::Equals(
    [IO.Path]::GetFullPath($Left),
    [IO.Path]::GetFullPath($Right),
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Assert-LocalNonRoot([string]$Value, [string]$Label) {
  if ([String]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) {
    throw "$Label must be absolute."
  }
  $full = [IO.Path]::GetFullPath($Value)
  if ($full.StartsWith('\\', [StringComparison]::Ordinal) -or
    (Test-SamePath $full ([IO.Path]::GetPathRoot($full)))) {
    throw "$Label cannot be a network path or drive root."
  }
  return $full
}

function Assert-InstallMarker([string]$Directory) {
  $markerPath = Join-Path $Directory '.dsh-desktop-install.json'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw "Installation marker is missing from $Directory."
  }
  $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$marker.appId -cne $AppId) {
    throw "Installation marker is invalid in $Directory."
  }
}

$install = Assert-LocalNonRoot $InstallDirectory 'InstallDirectory'
$rollback = Assert-LocalNonRoot $RollbackRoot 'RollbackRoot'
$expectedRollback = Join-Path ([IO.Path]::GetDirectoryName($install)) '.dsh-desktop-previous'
if (-not (Test-SamePath $rollback $expectedRollback) -or
  [IO.Path]::GetFileName($rollback) -cne '.dsh-desktop-previous') {
  throw 'RollbackRoot is not the guarded sibling of InstallDirectory.'
}
if (-not (Test-Path -LiteralPath $rollback -PathType Container)) { return }

$manifestPath = Join-Path $rollback 'previous-install.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([int]$manifest.schemaVersion -ne 2 -or
  @('healthy', 'restored') -notcontains [string]$manifest.state -or
  -not (Test-SamePath ([string]$manifest.installDir) $install) -or
  -not (Test-SamePath ([string]$manifest.backupDir) (Join-Path $rollback 'app'))) {
  Write-Output 'Active or invalid rollback backup was preserved.'
  return
}

if ([string]$manifest.state -eq 'healthy') {
  Assert-InstallMarker ([string]$manifest.backupDir)
}

if ($manifest.PSObject.Properties.Name -contains 'failedInstallDir' -and
  -not [String]::IsNullOrWhiteSpace([string]$manifest.failedInstallDir)) {
  $failed = Assert-LocalNonRoot ([string]$manifest.failedInstallDir) 'failedInstallDir'
  if (-not (Test-SamePath ([IO.Path]::GetDirectoryName($failed)) ([IO.Path]::GetDirectoryName($install))) -or
    [IO.Path]::GetFileName($failed) -notlike '.dsh-desktop-failed-*') {
    throw 'failedInstallDir is outside the guarded installation parent.'
  }
  if (Test-Path -LiteralPath $failed -PathType Container) {
    Assert-InstallMarker $failed
    Remove-Item -LiteralPath $failed -Recurse -Force
  }
}

Remove-Item -LiteralPath $rollback -Recurse -Force
Write-Output 'Completed installation remnants removed.'
