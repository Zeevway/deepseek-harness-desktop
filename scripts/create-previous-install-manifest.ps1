[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$ProductName,
  [Parameter(Mandatory = $true)][string]$InstallMode,
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [Parameter(Mandatory = $true)][string]$BackupDirectory,
  [Parameter(Mandatory = $true)][string]$ExecutableName,
  [Parameter(Mandatory = $true)][string]$AppGuid,
  [Parameter(Mandatory = $true)][string]$UninstallAppKey
)

$ErrorActionPreference = 'Stop'

function Test-SamePath([string]$Left, [string]$Right) {
  return [String]::Equals(
    [IO.Path]::GetFullPath($Left),
    [IO.Path]::GetFullPath($Right),
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Assert-GuardedLocalPath([string]$Path, [string]$Label) {
  if ([String]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
    throw "$Label must be an absolute path."
  }
  $fullPath = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($fullPath)
  if ($fullPath.StartsWith('\\', [StringComparison]::Ordinal) -or (Test-SamePath $fullPath $root)) {
    throw "$Label cannot be a network path or drive root."
  }
  $cursor = $fullPath
  while (-not [String]::IsNullOrWhiteSpace($cursor) -and -not (Test-SamePath $cursor $root)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label cannot use a symbolic link or directory junction."
      }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ([String]::IsNullOrWhiteSpace($parent) -or (Test-SamePath $parent $cursor)) { break }
    $cursor = $parent
  }
  return $fullPath
}

function Get-FileInventory([string]$Root) {
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $prefix = "$fullRoot\"
  foreach ($directory in [IO.Directory]::EnumerateDirectories($fullRoot, '*', [IO.SearchOption]::AllDirectories)) {
    $item = Get-Item -LiteralPath $directory -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Program backup contains a directory reparse point: $directory"
    }
  }
  return @(
    [IO.Directory]::EnumerateFiles($fullRoot, '*', [IO.SearchOption]::AllDirectories) |
      ForEach-Object {
        $filename = [IO.Path]::GetFullPath($_)
        $item = Get-Item -LiteralPath $filename -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
          throw "Program backup contains a file reparse point: $filename"
        }
        if (-not $filename.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
          throw "Program file escaped its guarded root: $filename"
        }
        [pscustomobject][ordered]@{
          path = $filename.Substring($prefix.Length).Replace('\', '/')
          size = [int64]$item.Length
          sha256 = (Get-FileHash -LiteralPath $filename -Algorithm SHA256).Hash.ToLowerInvariant()
        }
      } |
      Sort-Object -Property path
  )
}

$output = [IO.Path]::GetFullPath($OutputPath)
$rollbackRoot = Assert-GuardedLocalPath ([IO.Path]::GetDirectoryName($output)) 'Rollback root'
$install = Assert-GuardedLocalPath $InstallDirectory 'Install directory'
$backup = Assert-GuardedLocalPath $BackupDirectory 'Backup directory'
$expectedBackup = [IO.Path]::GetFullPath((Join-Path $rollbackRoot 'app'))

if ([IO.Path]::GetFileName($rollbackRoot) -ne '.dsh-desktop-previous') {
  throw 'The manifest must be created inside .dsh-desktop-previous.'
}
if ([IO.Path]::GetFileName($output) -ne 'previous-install.json') {
  throw 'Unexpected rollback manifest filename.'
}
if (-not [String]::Equals($backup, $expectedBackup, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The backup directory is outside the guarded rollback root.'
}
if (-not [String]::Equals(
  [IO.Path]::GetDirectoryName($install),
  [IO.Path]::GetDirectoryName($rollbackRoot),
  [StringComparison]::OrdinalIgnoreCase
)) {
  throw 'The install directory is not a sibling of the rollback root.'
}
if ([IO.Path]::GetFileName($ExecutableName) -ne $ExecutableName -or $ExecutableName -notlike '*.exe') {
  throw 'The previous executable name is invalid.'
}
if ($InstallMode -notin @('all', 'CurrentUser')) {
  throw 'The install mode is invalid.'
}
if ($AppGuid -notmatch '^[A-Za-z0-9-]+$' -or $UninstallAppKey -notmatch '^[A-Za-z0-9-]+$') {
  throw 'The application registry identifier is invalid.'
}
if (-not (Test-Path -LiteralPath (Join-Path $backup $ExecutableName) -PathType Leaf)) {
  throw 'The previous executable is missing from the rollback backup.'
}

$sourceInventory = Get-FileInventory $install
$backupInventory = Get-FileInventory $backup
if ($sourceInventory.Count -eq 0 -or $sourceInventory.Count -ne $backupInventory.Count) {
  throw 'The rollback backup file count does not match the installed program.'
}
for ($index = 0; $index -lt $sourceInventory.Count; $index += 1) {
  $sourceFile = $sourceInventory[$index]
  $backupFile = $backupInventory[$index]
  if ($sourceFile.path -cne $backupFile.path -or
    $sourceFile.size -ne $backupFile.size -or
    $sourceFile.sha256 -cne $backupFile.sha256) {
    throw "The rollback backup does not match the installed program: $($sourceFile.path)"
  }
}
$totalBytes = [int64]0
foreach ($file in $backupInventory) { $totalBytes += [int64]$file.size }

$manifest = [ordered]@{
  schemaVersion = 2
  state = 'pending-health-check'
  version = $Version
  productName = $ProductName
  installMode = $InstallMode
  installRegistryKey = "Software/$AppGuid"
  uninstallRegistryKey = "Software/Microsoft/Windows/CurrentVersion/Uninstall/$UninstallAppKey"
  installDir = $install
  backupDir = $backup
  executableName = $ExecutableName
  fileCount = $backupInventory.Count
  totalBytes = $totalBytes
  files = $backupInventory
  createdAt = [DateTime]::UtcNow.ToString('o')
}

$temporary = "$output.tmp"
$encoding = [Text.UTF8Encoding]::new($false)
$stream = $null
$writer = $null
try {
  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "$output.replace-backup" -Force -ErrorAction SilentlyContinue
  $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $writer = [IO.StreamWriter]::new($stream, $encoding)
  $writer.Write(($manifest | ConvertTo-Json -Depth 8))
  $writer.Write("`n")
  $writer.Flush()
  $stream.Flush($true)
  $writer.Dispose()
  $writer = $null
  $stream = $null

  if (Test-Path -LiteralPath $output -PathType Leaf) {
    [IO.File]::Replace($temporary, $output, "$output.replace-backup", $true)
    Remove-Item -LiteralPath "$output.replace-backup" -Force -ErrorAction SilentlyContinue
  } else {
    [IO.File]::Move($temporary, $output)
  }
} finally {
  if ($writer) { $writer.Dispose() }
  if ($stream) { $stream.Dispose() }
  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}

Write-Output $output
