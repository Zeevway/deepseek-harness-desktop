[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$Recursive,
  [switch]$ValidateOnly,
  [switch]$AllowFreshInstallDirectory
)

$ErrorActionPreference = 'Stop'

# GitHub-hosted pwsh sessions can pass a PowerShell 7 module path to
# Windows PowerShell. Load the matching built-in ACL cmdlets explicitly.
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class DshNativeFileInfo
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle handle,
        out BY_HANDLE_FILE_INFORMATION information);

    public static uint GetLinkCount(SafeFileHandle handle)
    {
        BY_HANDLE_FILE_INFORMATION information;
        if (!GetFileInformationByHandle(handle, out information))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return information.NumberOfLinks;
    }
}
'@

function Test-SamePath([string]$Left, [string]$Right) {
  return [String]::Equals(
    [IO.Path]::GetFullPath($Left),
    [IO.Path]::GetFullPath($Right),
    [StringComparison]::OrdinalIgnoreCase
  )
}

$fullPath = [IO.Path]::GetFullPath($Path)
$root = [IO.Path]::GetPathRoot($fullPath)
if (-not [IO.Path]::IsPathRooted($Path) -or
  $fullPath.StartsWith('\\', [StringComparison]::Ordinal) -or
  (Test-SamePath $fullPath $root)) {
  throw 'Installation directory must be a non-root local path.'
}

$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowedSids = @(
  $currentSid,
  [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
  [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'),
  [Security.Principal.SecurityIdentifier]::new(
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
  )
) | Select-Object -Unique
$allowed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($sid in $allowedSids) { $null = $allowed.Add($sid.Value) }

$controlMask = [Security.AccessControl.FileSystemRights]::Delete -bor
  [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [Security.AccessControl.FileSystemRights]::TakeOwnership
$rootControlMask = [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [Security.AccessControl.FileSystemRights]::TakeOwnership
$deleteChildMask = [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [Security.AccessControl.FileSystemRights]::TakeOwnership
$mutationMask = [Security.AccessControl.FileSystemRights]::Write -bor
  [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  $controlMask

function Test-RuleAppliesToObject([Security.AccessControl.FileSystemAccessRule]$Rule) {
  return ($Rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
}

function Assert-NoBroadAllow(
  [string]$Target,
  [Security.AccessControl.FileSystemRights]$Mask,
  [string]$Label
) {
  $acl = Get-Acl -LiteralPath $Target
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      -not (Test-RuleAppliesToObject $rule) -or
      $allowed.Contains($rule.IdentityReference.Value)) {
      continue
    }
    if (([int64]$rule.FileSystemRights -band [int64]$Mask) -ne 0) {
      throw "$Label grants mutation rights to $($rule.IdentityReference.Value): $Target"
    }
  }
}

function Assert-NoExplicitBroadAllow(
  [string]$Target,
  [Security.AccessControl.FileSystemRights]$Mask,
  [string]$Label
) {
  $acl = Get-Acl -LiteralPath $Target
  foreach ($rule in $acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      -not (Test-RuleAppliesToObject $rule) -or
      $allowed.Contains($rule.IdentityReference.Value)) {
      continue
    }
    if (([int64]$rule.FileSystemRights -band [int64]$Mask) -ne 0) {
      throw "$Label grants explicit mutation rights to $($rule.IdentityReference.Value): $Target"
    }
  }
}

function Assert-OrdinaryDirectory([string]$Target, [string]$Label) {
  $item = Get-Item -LiteralPath $Target -Force
  if (-not $item.PSIsContainer) {
    throw "$Label is not a directory: $Target"
  }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label contains a symbolic link or directory junction: $Target"
  }
}

function Assert-TrustedOwner([string]$Target, [string]$Label) {
  $acl = Get-Acl -LiteralPath $Target
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if (-not $allowed.Contains($owner)) {
    throw "$Label has an untrusted owner $owner`: $Target"
  }
}

function Assert-EmptyDirectory([string]$Target, [string]$Label) {
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries(
    $Target,
    '*',
    [IO.SearchOption]::TopDirectoryOnly
  )) {
    throw "$Label is not empty: $Target"
  }
}

function Test-FreshLeafNeedsProtection([bool]$TargetExists) {
  if (-not $AllowFreshInstallDirectory -or -not $TargetExists) {
    return $false
  }

  Assert-OrdinaryDirectory $fullPath 'Fresh installation directory'
  Assert-TrustedOwner $fullPath 'Fresh installation directory'
  Assert-EmptyDirectory $fullPath 'Fresh installation directory'
  $acl = Get-Acl -LiteralPath $fullPath
  if ($acl.AreAccessRulesProtected) {
    return $false
  }

  # A newly created NSIS leaf may inherit Modify from a normal data-volume root.
  # Explicit broad grants remain evidence of a pre-created or tampered directory.
  Assert-NoBroadAllow $fullPath $rootControlMask 'Fresh installation directory'
  Assert-NoExplicitBroadAllow $fullPath $mutationMask 'Fresh installation directory'
  return $true
}

function Assert-SafeAncestorChain(
  [bool]$TargetExists,
  [bool]$AllowInheritedBroadLeaf
) {
  $cursor = $fullPath
  $script:missingSegments = [Collections.Generic.List[string]]::new()
  while (-not (Test-Path -LiteralPath $cursor)) {
    if (Test-SamePath $cursor $root) {
      throw 'The installation volume root is unavailable.'
    }
    $script:missingSegments.Insert(0, [IO.Path]::GetFileName($cursor))
    $cursor = [IO.Path]::GetDirectoryName($cursor)
    if ([String]::IsNullOrWhiteSpace($cursor)) {
      throw 'The installation path has no existing local ancestor.'
    }
  }
  $script:nearestExisting = $cursor

  while ($true) {
    Assert-OrdinaryDirectory $cursor 'Installation path'
    Assert-TrustedOwner $cursor 'Installation path component'
    $mask = if (Test-SamePath $cursor $root) {
      $rootControlMask
    } elseif (Test-SamePath $cursor $fullPath) {
      $mutationMask
    } else {
      $controlMask
    }
    if (Test-SamePath $cursor $fullPath -and $AllowInheritedBroadLeaf) {
      Assert-NoBroadAllow $cursor $rootControlMask 'Fresh installation directory'
      Assert-NoExplicitBroadAllow $cursor $mutationMask 'Fresh installation directory'
    } else {
      Assert-NoBroadAllow $cursor $mask 'Installation path component'
    }
    if (Test-SamePath $cursor $root) { break }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    Assert-OrdinaryDirectory $parent 'Installation parent path'
    if (-not (Test-SamePath $parent $root)) {
      Assert-NoBroadAllow $parent $deleteChildMask 'Installation parent directory'
    }
    $cursor = $parent
  }
}

function New-ProtectedLeafDirectory([string]$Parent, [string]$Name) {
  $target = Join-Path $Parent $Name
  if (Test-Path -LiteralPath $target) {
    throw "Installation directory component appeared during protected creation: $target"
  }
  $staging = Join-Path $Parent ".dsh-protected-create-$([Guid]::NewGuid().ToString('N'))"
  $moved = $false
  try {
    $null = [IO.Directory]::CreateDirectory($staging)
    Assert-OrdinaryDirectory $staging 'Protected staging directory'
    Set-ProtectedAcl $staging $true
    Assert-ProtectedAcl $staging $true
    [IO.Directory]::Move($staging, $target)
    $moved = $true
  } finally {
    if (-not $moved -and (Test-Path -LiteralPath $staging -PathType Container)) {
      [IO.Directory]::Delete($staging, $true)
    }
  }
  Assert-OrdinaryDirectory $target 'New installation path component'
  Assert-ProtectedAcl $target $true
  return $target
}

function Test-CreateCapability([bool]$TargetExists) {
  if ($TargetExists) {
    $probe = Join-Path $fullPath ".dsh-security-probe-$([Guid]::NewGuid().ToString('N')).tmp"
    $stream = $null
    try {
      $stream = [IO.FileStream]::new(
        $probe,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
      )
    } finally {
      if ($stream) { $stream.Dispose() }
      Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    }
  } else {
    $parent = $script:nearestExisting
    $probe = Join-Path $parent ".dsh-security-probe-$([Guid]::NewGuid().ToString('N'))"
    try {
      $null = [IO.Directory]::CreateDirectory($probe)
      Assert-OrdinaryDirectory $probe 'Installation creation probe'
      Set-ProtectedAcl $probe $true
      Assert-ProtectedAcl $probe $true
    } finally {
      if (Test-Path -LiteralPath $probe -PathType Container) {
        [IO.Directory]::Delete($probe, $false)
      }
    }
  }
}

function Set-ProtectedAcl([string]$Target, [bool]$Directory) {
  $security = if ($Directory) {
    [Security.AccessControl.DirectorySecurity]::new()
  } else {
    [Security.AccessControl.FileSecurity]::new()
  }
  $security.SetOwner($currentSid)
  $security.SetAccessRuleProtection($true, $false)
  $inheritance = if ($Directory) {
    [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    [Security.AccessControl.InheritanceFlags]::None
  }
  foreach ($sid in $allowedSids) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $null = $security.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Target -AclObject $security
}

function Assert-ProtectedAcl([string]$Target, [bool]$Directory) {
  $acl = Get-Acl -LiteralPath $Target
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne $currentSid.Value) {
    throw "Protected object has an unexpected owner: $Target"
  }
  if (-not $acl.AreAccessRulesProtected) {
    throw "Protected object still inherits permissions: $Target"
  }

  $granted = @{}
  foreach ($sid in $allowedSids) { $granted[$sid.Value] = [int64]0 }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    $identity = $rule.IdentityReference.Value
    if ($rule.IsInherited -or
      $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      -not $allowed.Contains($identity)) {
      throw "Protected object retains an unexpected access rule for $identity`: $Target"
    }
    if ($Directory) {
      $requiredInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
      if (($rule.InheritanceFlags -band $requiredInheritance) -ne $requiredInheritance) {
        throw "Protected directory rule does not inherit to all children: $Target"
      }
    } elseif ($rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None) {
      throw "Protected file has an inheritable access rule: $Target"
    }
    $granted[$identity] = [int64]$granted[$identity] -bor [int64]$rule.FileSystemRights
  }
  $fullControl = [int64][Security.AccessControl.FileSystemRights]::FullControl
  foreach ($sid in $allowedSids) {
    if (([int64]$granted[$sid.Value] -band $fullControl) -ne $fullControl) {
      throw "Protected object does not grant required full control to $($sid.Value): $Target"
    }
  }
}

function Assert-OrdinarySingleLinkFile([string]$Filename) {
  $item = Get-Item -LiteralPath $Filename -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Installation content contains a file reparse point: $Filename"
  }
  $stream = [IO.File]::Open(
    $Filename,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
  )
  try {
    if ([DshNativeFileInfo]::GetLinkCount($stream.SafeFileHandle) -ne 1) {
      throw "Installation content contains an NTFS hard link: $Filename"
    }
  } finally {
    $stream.Dispose()
  }
}

$targetExists = Test-Path -LiteralPath $fullPath -PathType Container
$freshLeafNeedsProtection = Test-FreshLeafNeedsProtection $targetExists
Assert-SafeAncestorChain $targetExists $freshLeafNeedsProtection
Test-CreateCapability $targetExists
if ($ValidateOnly) {
  Write-Output $fullPath
  exit 0
}

if (-not $targetExists) {
  $creationParent = $script:nearestExisting
  foreach ($segment in $script:missingSegments) {
    $creationParent = New-ProtectedLeafDirectory $creationParent $segment
  }
}
if ($freshLeafNeedsProtection) {
  Assert-OrdinaryDirectory $fullPath 'Fresh installation directory'
  Assert-TrustedOwner $fullPath 'Fresh installation directory'
  Assert-EmptyDirectory $fullPath 'Fresh installation directory'
}
Assert-SafeAncestorChain $true $freshLeafNeedsProtection
Set-ProtectedAcl $fullPath $true
Assert-ProtectedAcl $fullPath $true
if ($freshLeafNeedsProtection) {
  Assert-OrdinaryDirectory $fullPath 'Protected fresh installation directory'
  Assert-EmptyDirectory $fullPath 'Protected fresh installation directory'
}

if ($Recursive) {
  $directories = [Collections.Generic.List[string]]::new()
  $files = [Collections.Generic.List[string]]::new()
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($fullPath)

  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    foreach ($directory in [IO.Directory]::EnumerateDirectories(
      $current,
      '*',
      [IO.SearchOption]::TopDirectoryOnly
    )) {
      Assert-OrdinaryDirectory $directory 'Installation content'
      $directories.Add([IO.Path]::GetFullPath($directory))
      $pending.Push($directory)
    }
    foreach ($filename in [IO.Directory]::EnumerateFiles(
      $current,
      '*',
      [IO.SearchOption]::TopDirectoryOnly
    )) {
      Assert-OrdinarySingleLinkFile $filename
      $files.Add([IO.Path]::GetFullPath($filename))
    }
  }

  foreach ($directory in $directories) {
    Assert-OrdinaryDirectory $directory 'Installation content'
    Set-ProtectedAcl $directory $true
  }
  foreach ($filename in $files) {
    $stream = [IO.File]::Open(
      $filename,
      [IO.FileMode]::Open,
      [IO.FileAccess]::Read,
      [IO.FileShare]::ReadWrite
    )
    try {
      if ([DshNativeFileInfo]::GetLinkCount($stream.SafeFileHandle) -ne 1) {
        throw "Installation content became an NTFS hard link: $filename"
      }
      Set-ProtectedAcl $filename $false
    } finally {
      $stream.Dispose()
    }
  }

  foreach ($directory in $directories) {
    Assert-OrdinaryDirectory $directory 'Protected installation content'
    Assert-ProtectedAcl $directory $true
  }
  foreach ($filename in $files) {
    Assert-OrdinarySingleLinkFile $filename
    Assert-ProtectedAcl $filename $false
  }
}

Write-Output $fullPath
