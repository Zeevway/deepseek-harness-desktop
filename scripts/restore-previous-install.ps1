[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$JournalPath,

  [Parameter(Mandatory = $true)]
  [string]$CurrentExecutable,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, [int]::MaxValue)]
  [int]$WaitProcessId,

  [Parameter(Mandatory = $true)]
  [string]$ReadyFile
)

$ErrorActionPreference = 'Stop'

function Test-SamePath([string]$Left, [string]$Right) {
  if ([String]::IsNullOrWhiteSpace($Left) -or [String]::IsNullOrWhiteSpace($Right)) {
    return $false
  }
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

function Test-Property([object]$Value, [string]$Name) {
  return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

function Assert-LeafExecutableName([string]$Name) {
  if ([String]::IsNullOrWhiteSpace($Name) -or
    [IO.Path]::GetFileName($Name) -cne $Name -or
    $Name.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
    [IO.Path]::GetExtension($Name) -ine '.exe') {
    throw 'The rollback manifest executableName must be one .exe leaf filename.'
  }
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

function Assert-BackupInventory([object]$Manifest, [string]$Root) {
  if (-not (Test-Property $Manifest 'files') -or
    -not (Test-Property $Manifest 'fileCount') -or
    -not (Test-Property $Manifest 'totalBytes')) {
    throw 'Rollback manifest does not contain a complete file inventory.'
  }
  $expected = @($Manifest.files | Sort-Object -Property path)
  $actual = @(Get-FileInventory $Root)
  if ($expected.Count -eq 0 -or
    [int]$Manifest.fileCount -ne $expected.Count -or
    $actual.Count -ne $expected.Count) {
    throw 'Rollback backup file count does not match its manifest.'
  }
  $totalBytes = [int64]0
  for ($index = 0; $index -lt $expected.Count; $index += 1) {
    $expectedFile = $expected[$index]
    $actualFile = $actual[$index]
    $relative = [string]$expectedFile.path
    if ([String]::IsNullOrWhiteSpace($relative) -or
      $relative.Contains('\') -or
      [IO.Path]::IsPathRooted($relative) -or
      $relative.Split('/') -contains '..' -or
      [string]$expectedFile.sha256 -notmatch '^[0-9a-f]{64}$') {
      throw 'Rollback manifest contains an invalid file inventory entry.'
    }
    if ($actualFile.path -cne $relative -or
      $actualFile.size -ne [int64]$expectedFile.size -or
      $actualFile.sha256 -cne [string]$expectedFile.sha256) {
      throw "Rollback backup integrity verification failed: $relative"
    }
    $totalBytes += [int64]$expectedFile.size
  }
  if ($totalBytes -ne [int64]$Manifest.totalBytes) {
    throw 'Rollback backup byte count does not match its manifest.'
  }
}

function Write-JsonAtomic([string]$Path, [object]$Value) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $directory = [IO.Path]::GetDirectoryName($fullPath)
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    throw "JSON directory does not exist: $directory"
  }

  $temporary = Join-Path $directory ".$([IO.Path]::GetFileName($fullPath)).$([Guid]::NewGuid().ToString('N')).tmp"
  $backup = "$fullPath.replace-backup"
  $json = $Value | ConvertTo-Json -Depth 12
  $encoding = [Text.UTF8Encoding]::new($false)
  $stream = $null
  $writer = $null
  try {
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $writer = [IO.StreamWriter]::new($stream, $encoding)
    $writer.Write($json)
    $writer.Write("`n")
    $writer.Flush()
    $stream.Flush($true)
    $writer.Dispose()
    $writer = $null
    $stream = $null

    if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
      [IO.File]::Replace($temporary, $fullPath, $backup, $true)
      Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    } else {
      [IO.File]::Move($temporary, $fullPath)
    }
  } finally {
    if ($writer) { $writer.Dispose() }
    if ($stream) { $stream.Dispose() }
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Assert-JournalBinding([object]$Journal) {
  foreach ($name in @(
    'version',
    'state',
    'dataChanged',
    'currentAppVersion',
    'previousAppVersion',
    'configFile',
    'dataDirectory',
    'programRoot',
    'script',
    'installDirectory',
    'currentExecutable',
    'previousExecutable'
  )) {
    if (-not (Test-Property $Journal $name)) {
      throw "Rollback journal is missing $name."
    }
  }
  if ([int]$Journal.version -ne 1 -or
    @('helper-launched', 'program-failed', 'program-restored') -notcontains [string]$Journal.state -or
    $Journal.dataChanged -isnot [bool]) {
    throw 'Rollback journal version, state, or dataChanged value is invalid.'
  }
  if ([String]::IsNullOrWhiteSpace([string]$Journal.currentAppVersion) -or
    [String]::IsNullOrWhiteSpace([string]$Journal.previousAppVersion)) {
    throw 'Rollback journal application versions are invalid.'
  }

  $journalConfig = Assert-GuardedLocalPath ([string]$Journal.configFile) 'Rollback journal configFile'
  $null = Assert-GuardedLocalPath ([string]$Journal.dataDirectory) 'Rollback journal dataDirectory'
  if ($Journal.dataChanged) {
    if (-not (Test-Property $Journal 'dataRollbackDirectory')) {
      throw 'Rollback journal is missing dataRollbackDirectory.'
    }
    $null = Assert-GuardedLocalPath ([string]$Journal.dataRollbackDirectory) 'Rollback journal dataRollbackDirectory'
  }
  $expectedJournal = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($journalConfig)) 'program-rollback-journal.json'))
  if (-not (Test-SamePath $JournalPath $expectedJournal) -or
    -not (Test-SamePath ([string]$Journal.programRoot) $backupRoot) -or
    -not (Test-SamePath ([string]$Journal.script) $PSCommandPath) -or
    -not (Test-SamePath ([string]$Journal.installDirectory) $installDir) -or
    -not (Test-SamePath ([string]$Journal.currentExecutable) $CurrentExecutable) -or
    -not (Test-SamePath ([string]$Journal.previousExecutable) $restoredExecutable) -or
    [string]$Journal.previousAppVersion -ne [string]$manifest.version) {
    throw 'Rollback journal does not match the helper arguments and guarded rollback manifest.'
  }
}

function Update-Journal([string]$State, [string]$ErrorMessage = '') {
  $journal = Get-Content -LiteralPath $JournalPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-JournalBinding $journal
  $journal.state = $State
  $journal.updatedAt = [DateTime]::UtcNow.ToString('o')
  $journal.error = $ErrorMessage
  Write-JsonAtomic $JournalPath $journal
}

function Restore-RegistrySnapshot([hashtable]$Snapshot) {
  Set-ItemProperty -LiteralPath $Snapshot.installPath -Name InstallLocation -Value $Snapshot.installLocation
  Set-ItemProperty -LiteralPath $Snapshot.uninstallPath -Name DisplayVersion -Value $Snapshot.displayVersion
  Set-ItemProperty -LiteralPath $Snapshot.uninstallPath -Name DisplayName -Value $Snapshot.displayName
}

function Start-CurrentProgramIfAvailable {
  $alreadyRunning = @(
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
      try { $_.Path -and (Test-SamePath $_.Path $CurrentExecutable) } catch { $false }
    }
  )
  if ($alreadyRunning.Count -eq 0 -and (Test-Path -LiteralPath $CurrentExecutable -PathType Leaf)) {
    Start-Process -FilePath $CurrentExecutable
  }
}

function Get-InstallDirectoryProcesses {
  return @(
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object {
        try {
          $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith(
            "$($installDir.TrimEnd('\'))\",
            [StringComparison]::OrdinalIgnoreCase
          )
        } catch {
          $false
        }
      }
  )
}

$backupRoot = Assert-GuardedLocalPath $PSScriptRoot 'Rollback root'
if ([IO.Path]::GetFileName($backupRoot) -cne '.dsh-desktop-previous') {
  throw 'Restore script must remain inside .dsh-desktop-previous.'
}
if (-not (Test-SamePath $PSCommandPath (Join-Path $backupRoot 'restore-previous-install.ps1'))) {
  throw 'Unexpected rollback helper filename.'
}

$manifestPath = [IO.Path]::GetFullPath((Join-Path $backupRoot 'previous-install.json'))
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw 'The guarded rollback manifest is missing.'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($name in @(
  'schemaVersion',
  'state',
  'version',
  'productName',
  'installMode',
  'installRegistryKey',
  'uninstallRegistryKey',
  'installDir',
  'backupDir',
  'executableName',
  'fileCount',
  'totalBytes',
  'files'
)) {
  if (-not (Test-Property $manifest $name)) {
    throw "Rollback manifest is missing $name."
  }
}
if ([int]$manifest.schemaVersion -ne 2 -or
  @('pending-health-check', 'healthy') -notcontains [string]$manifest.state) {
  throw 'Rollback manifest schema or state is invalid for restoration.'
}
if ([String]::IsNullOrWhiteSpace([string]$manifest.version) -or
  [String]::IsNullOrWhiteSpace([string]$manifest.productName)) {
  throw 'Rollback manifest version or product name is invalid.'
}
Assert-LeafExecutableName ([string]$manifest.executableName)

$installDir = Assert-GuardedLocalPath ([string]$manifest.installDir) 'Install directory'
$backupDir = Assert-GuardedLocalPath ([string]$manifest.backupDir) 'Backup directory'
$expectedBackupDir = [IO.Path]::GetFullPath((Join-Path $backupRoot 'app'))
if (-not (Test-SamePath $backupDir $expectedBackupDir) -or
  -not (Test-SamePath ([IO.Path]::GetDirectoryName($installDir)) ([IO.Path]::GetDirectoryName($backupRoot))) -or
  (Test-SamePath $installDir $backupRoot)) {
  throw 'Rollback manifest installDir, backupDir, and programRoot relationships are invalid.'
}

$restoredExecutable = [IO.Path]::GetFullPath((Join-Path $installDir ([string]$manifest.executableName)))
$expectedExecutable = Assert-GuardedLocalPath (Join-Path $backupDir ([string]$manifest.executableName)) 'Previous executable'
if (-not (Test-Path -LiteralPath $expectedExecutable -PathType Leaf)) {
  throw "The previous executable is missing: $expectedExecutable"
}

$CurrentExecutable = Assert-GuardedLocalPath $CurrentExecutable 'CurrentExecutable'
if (-not (Test-SamePath ([IO.Path]::GetDirectoryName($CurrentExecutable)) $installDir) -or
  [IO.Path]::GetExtension($CurrentExecutable) -ine '.exe' -or
  -not (Test-Path -LiteralPath $CurrentExecutable -PathType Leaf)) {
  throw 'CurrentExecutable must be an existing .exe directly inside the guarded install directory.'
}

$JournalPath = Assert-GuardedLocalPath $JournalPath 'JournalPath'
if ([IO.Path]::GetFileName($JournalPath) -cne 'program-rollback-journal.json' -or
  -not (Test-Path -LiteralPath $JournalPath -PathType Leaf)) {
  throw 'JournalPath must name the existing guarded program rollback journal.'
}
$ReadyFile = Assert-GuardedLocalPath $ReadyFile 'ReadyFile'
if (-not (Test-SamePath ([IO.Path]::GetDirectoryName($ReadyFile)) ([IO.Path]::GetDirectoryName($JournalPath))) -or
  [IO.Path]::GetExtension($ReadyFile) -ine '.json' -or
  (Test-SamePath $ReadyFile $JournalPath) -or
  (Test-Path -LiteralPath $ReadyFile)) {
  throw 'ReadyFile must be a new JSON file beside JournalPath.'
}
$journal = Get-Content -LiteralPath $JournalPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-JournalBinding $journal
Assert-BackupInventory $manifest $backupDir

if ([string]$manifest.installMode -eq 'all') {
  $registryHive = 'HKEY_LOCAL_MACHINE'
} elseif ([string]$manifest.installMode -eq 'CurrentUser') {
  $registryHive = 'HKEY_CURRENT_USER'
} else {
  throw 'Rollback manifest installMode is invalid.'
}
$installRegistryKey = [string]$manifest.installRegistryKey
$uninstallRegistryKey = [string]$manifest.uninstallRegistryKey
if ($installRegistryKey -notmatch '^Software/[A-Za-z0-9-]+$' -or
  $uninstallRegistryKey -notmatch '^Software/Microsoft/Windows/CurrentVersion/Uninstall/[A-Za-z0-9-]+$') {
  throw 'Rollback manifest registry keys are invalid.'
}
$installRegistryPath = "Registry::$registryHive\$($installRegistryKey.Replace('/', '\'))"
$uninstallRegistryPath = "Registry::$registryHive\$($uninstallRegistryKey.Replace('/', '\'))"
if (-not (Test-Path -LiteralPath $installRegistryPath) -or
  -not (Test-Path -LiteralPath $uninstallRegistryPath)) {
  throw 'The existing application registry entries were not found.'
}
$registrySnapshot = @{
  installPath = $installRegistryPath
  uninstallPath = $uninstallRegistryPath
  installLocation = Get-ItemPropertyValue -LiteralPath $installRegistryPath -Name InstallLocation
  displayVersion = Get-ItemPropertyValue -LiteralPath $uninstallRegistryPath -Name DisplayVersion
  displayName = Get-ItemPropertyValue -LiteralPath $uninstallRegistryPath -Name DisplayName
}

$waitProcess = Get-Process -Id $WaitProcessId -ErrorAction SilentlyContinue
if ($waitProcess) {
  $waitProcessPath = $null
  try { $waitProcessPath = [IO.Path]::GetFullPath($waitProcess.Path) } catch {
    throw 'The process selected for rollback could not be identified safely.'
  }
  if (-not (Test-SamePath $waitProcessPath $CurrentExecutable)) {
    throw 'WaitProcessId does not belong to CurrentExecutable.'
  }
}

Write-JsonAtomic $ReadyFile ([ordered]@{
  schemaVersion = 1
  processId = $PID
  waitProcessId = $WaitProcessId
  readyAt = [DateTime]::UtcNow.ToString('o')
  journalPath = $JournalPath
})

$originalManifest = $manifest
$failedDir = $null
$movedCurrent = $false
$installedPrevious = $false
$registryChanged = $false
$manifestChanged = $false
try {
  if ($waitProcess -and -not $waitProcess.WaitForExit(15000)) {
    throw 'The current application did not exit within 15 seconds.'
  }
  $processDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $running = @(Get-InstallDirectoryProcesses)
    if ($running.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $processDeadline)
  if ($running.Count -gt 0) {
    throw 'DeepSeek Harness Desktop child processes did not exit within 10 seconds.'
  }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $failedDir = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($installDir)) ".dsh-desktop-failed-$timestamp"))
  if (Test-Path -LiteralPath $failedDir) {
    throw "Recovery target already exists: $failedDir"
  }

  Move-Item -LiteralPath $installDir -Destination $failedDir
  $movedCurrent = $true
  Move-Item -LiteralPath $backupDir -Destination $installDir
  $installedPrevious = $true
  if (-not (Test-Path -LiteralPath $restoredExecutable -PathType Leaf)) {
    throw 'The restored executable was not present after the directory swap.'
  }

  Set-ItemProperty -LiteralPath $installRegistryPath -Name InstallLocation -Value $installDir
  $registryChanged = $true
  Set-ItemProperty -LiteralPath $uninstallRegistryPath -Name DisplayVersion -Value ([string]$manifest.version)
  Set-ItemProperty -LiteralPath $uninstallRegistryPath -Name DisplayName -Value "$([string]$manifest.productName) $([string]$manifest.version)"

  $completedManifest = $manifest.PSObject.Copy()
  $completedManifest.state = 'restored'
  $completedManifest | Add-Member -NotePropertyName restoredAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
  $completedManifest | Add-Member -NotePropertyName failedInstallDir -NotePropertyValue $failedDir -Force
  $completedManifest | Add-Member -NotePropertyName registryRestored -NotePropertyValue $true -Force
  Write-JsonAtomic $manifestPath $completedManifest
  $manifestChanged = $true
} catch {
  $failure = $_
  $recoveryErrors = @()
  try {
    if ($installedPrevious -and (Test-Path -LiteralPath $installDir) -and -not (Test-Path -LiteralPath $backupDir)) {
      Move-Item -LiteralPath $installDir -Destination $backupDir
    }
  } catch {
    $recoveryErrors += "could not return the previous program to backup: $($_.Exception.Message)"
  }
  try {
    if ($movedCurrent -and $failedDir -and -not (Test-Path -LiteralPath $installDir) -and (Test-Path -LiteralPath $failedDir)) {
      Move-Item -LiteralPath $failedDir -Destination $installDir
    }
  } catch {
    $recoveryErrors += "could not restore the current program directory: $($_.Exception.Message)"
  }
  try {
    if ($registryChanged) { Restore-RegistrySnapshot $registrySnapshot }
  } catch {
    $recoveryErrors += "could not restore registry metadata: $($_.Exception.Message)"
  }
  try {
    if ($manifestChanged) { Write-JsonAtomic $manifestPath $originalManifest }
  } catch {
    $recoveryErrors += "could not restore the rollback manifest: $($_.Exception.Message)"
  }

  $failureMessage = $failure.Exception.Message
  if ($recoveryErrors.Count -gt 0) {
    $failureMessage = "$failureMessage; $($recoveryErrors -join '; ')"
  }
  try { Update-Journal 'program-failed' $failureMessage } catch { Write-Warning $_.Exception.Message }
  try { Start-CurrentProgramIfAvailable } catch { Write-Warning $_.Exception.Message }
  throw $failure
}

try { Update-Journal 'program-restored' } catch {
  Write-Warning "The previous program was restored, but the rollback journal could not be finalized: $($_.Exception.Message)"
}
try { Start-Process -FilePath $restoredExecutable } catch {
  Write-Warning "The previous program was restored but could not be started automatically: $($_.Exception.Message)"
}
Write-Host "Previous version $($manifest.version) restored to $installDir."
Write-Host "The replaced version was preserved at $failedDir."
