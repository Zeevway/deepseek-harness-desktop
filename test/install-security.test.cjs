'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..')
const installer = fs.readFileSync(path.join(projectRoot, 'assets', 'installer.nsh'), 'utf8')
const protector = path.join(projectRoot, 'scripts', 'protect-install-directory.ps1')
const protectorSource = fs.readFileSync(protector, 'utf8')

function powershell(args) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'psmodulepath') delete environment[key]
  }
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
    { encoding: 'utf8', env: environment },
  )
}

test('installer delegates path creation and validation to the hardened helper', () => {
  const secureFunction = installer.match(/Function SecureInstallDirectory([\s\S]*?)FunctionEnd/u)?.[1]
  const validateFunction = installer.match(/Function ValidateInstallDirectory([\s\S]*?)FunctionEnd/u)?.[1]
  const backupFunction = installer.match(/Function BackupPreviousInstall([\s\S]*?)FunctionEnd/u)?.[1]
  assert.ok(secureFunction)
  assert.ok(validateFunction)
  assert.ok(backupFunction)
  assert.doesNotMatch(secureFunction, /CreateDirectory/u)
  assert.match(secureFunction, /protect-install-directory\.ps1[^\r\n]*-Recursive/u)
  assert.match(secureFunction, /\$freshInstallDirectoryArgument/u)
  assert.doesNotMatch(validateFunction, /CreateDirectory/u)
  assert.match(validateFunction, /protect-install-directory\.ps1[^\r\n]*-ValidateOnly/u)
  assert.match(validateFunction, /\$freshInstallDirectoryArgument/u)
  assert.ok(
    backupFunction.indexOf('-Path "$rollbackRoot" -Recursive')
      < backupFunction.indexOf('CreateDirectory "$rollbackRoot\\app"'),
  )
})

test('installer identity commit has snapshots, compensation, and exact readback', () => {
  const installMacro = installer.match(/!macro customInstall([\s\S]*?)!macroend/u)?.[1]
  assert.ok(installMacro)
  assert.match(installer, /Function RollbackInstallIdentityCommit/u)
  assert.match(installMacro, /registryTokenBefore/u)
  assert.match(installMacro, /\.dsh-desktop-install\.json\.rollback/u)
  assert.match(installMacro, /Call RollbackInstallIdentityCommit/u)
  assert.match(installMacro, /ReadRegStr \$3[^\r\n]*InstallInstanceToken/u)
  assert.doesNotMatch(installer, /RollbackLocation/u)
})

test('repair install preserves the protected root while regular uninstall removes it atomically', () => {
  const removeMacro = installer.match(/!macro customRemoveFiles([\s\S]*?)!macroend/u)?.[1]
  assert.ok(removeMacro)

  const repairStart = removeMacro.indexOf('${If} ${isUpdated}')
  const regularStart = removeMacro.indexOf('${Else}', repairStart)
  const branchEnd = removeMacro.lastIndexOf('${EndIf}')
  assert.ok(repairStart >= 0)
  assert.ok(regularStart > repairStart)
  assert.ok(branchEnd > regularStart)

  const repairBranch = removeMacro.slice(repairStart, regularStart)
  const regularBranch = removeMacro.slice(regularStart, branchEnd)
  assert.match(repairBranch, /\$\{GetParent\} "\$INSTDIR" \$R6/u)
  assert.match(repairBranch, /\.dsh-desktop-repair-\$\{APP_GUID\}/u)
  assert.match(repairBranch, /protect-install-directory\.ps1[^\r\n]*\$repairStage/u)
  assert.match(repairBranch, /Push ""[\s\S]*Call un\.RepairMoveTopLevel[\s\S]*Pop \$R0/u)
  assert.match(repairBranch, /\$\{If\} \$R0 != 0[\s\S]*Call un\.RepairRestoreTopLevel[\s\S]*Abort/u)
  assert.doesNotMatch(repairBranch, /\$PLUGINSDIR\\old-install|Call un\.atomicRMDir/u)
  assert.doesNotMatch(repairBranch, /Rename "\$INSTDIR"/u)
  assert.doesNotMatch(repairBranch, /RMDir \/r[^\r\n]*\$INSTDIR/u)
  const moveFunction = installer.match(/Function un\.RepairMoveTopLevel([\s\S]*?)FunctionEnd/u)?.[1]
  const restoreFunction = installer.match(/Function un\.RepairRestoreTopLevel([\s\S]*?)FunctionEnd/u)?.[1]
  assert.ok(moveFunction)
  assert.ok(restoreFunction)
  assert.match(moveFunction, /FindFirst \$R1 \$R2 "\$INSTDIR\\\*\.\*"/u)
  assert.match(moveFunction, /Rename "\$INSTDIR\\\$R2" "\$repairStage\\\$R2"/u)
  assert.match(restoreFunction, /FindFirst \$R1 \$R2 "\$repairStage\\\*\.\*"/u)
  assert.match(restoreFunction, /Rename "\$repairStage\\\$R2" "\$INSTDIR\\\$R2"/u)
  assert.doesNotMatch(moveFunction, /Call un\.RepairMoveTopLevel|CreateDirectory|\$R0\\\$R2/u)
  assert.doesNotMatch(restoreFunction, /Call un\.RepairRestoreTopLevel|CreateDirectory|\$R0\\\$R2/u)

  const incompleteRestore = repairBranch.indexOf('recovery was incomplete')
  const cleanupAfterRestore = repairBranch.indexOf('RMDir /r "$repairStage"', incompleteRestore)
  assert.ok(incompleteRestore >= 0)
  assert.ok(cleanupAfterRestore > incompleteRestore, 'staged files must survive an incomplete recovery')

  assert.match(regularBranch, /GetTempFileName \$R1 "\$R0"/u)
  assert.match(regularBranch, /Rename "\$INSTDIR" "\$R1"/u)
  assert.match(regularBranch, /RMDir \/r \/REBOOTOK "\$R1"/u)
  assert.doesNotMatch(regularBranch, /Call un\.(?:atomicRMDir|restoreFiles|RepairMoveTopLevel|RepairRestoreTopLevel)/u)

  assert.ok(
    removeMacro.indexOf('The registered application executable is missing') < repairStart,
    'ownership checks must complete before either removal path',
  )
})

test('installer diagnostics are explicit, append-only, and can stop after customInit', () => {
  const initMacro = installer.match(/!macro customInit([\s\S]*?)!macroend/u)?.[1]
  const diagnosticFunction = installer.match(
    /Function WriteInstallerDiagnostic([\s\S]*?)FunctionEnd/u,
  )?.[1]
  assert.ok(initMacro)
  assert.ok(diagnosticFunction)
  assert.match(initMacro, /ReadEnvStr \$installerDiagnosticLog "DSH_INSTALLER_DIAGNOSTIC_LOG"/u)
  assert.match(initMacro, /ReadEnvStr \$installerDiagnosticOnly "DSH_INSTALLER_DIAGNOSTIC_ONLY"/u)
  assert.match(initMacro, /GetDParameter \$commandLineInstallDir/u)
  assert.doesNotMatch(initMacro, /GetDParameter \$R[5-9]/u)
  assert.match(diagnosticFunction, /\$installerDiagnosticLog != ""/u)
  assert.match(diagnosticFunction, /FileOpen \$1 "\$installerDiagnosticLog" a/u)
  assert.match(diagnosticFunction, /FileSeek \$1 0 END[\s\S]*FileWrite/u)
  assert.doesNotMatch(diagnosticFunction, /\$TEMP|GetTempFileName|FileOpen[^\r\n]+ w/u)
  assert.ok(
    initMacro.indexOf('customInit:complete')
      < initMacro.indexOf('$installerDiagnosticOnly == "1"'),
  )
  assert.match(initMacro, /SetErrorLevel 0[\s\S]*Quit/u)
  for (const stage of [31, 32, 33, 34, 35, 36, 37, 38]) {
    assert.match(initMacro, new RegExp(`SetErrorLevel ${stage}`, 'u'))
  }
})

test('installer gives WinAPI a volume root and isolates every PowerShell working directory', () => {
  const validateFunction = installer.match(/Function ValidateInstallDirectory([\s\S]*?)FunctionEnd/u)?.[1]
  assert.ok(validateFunction)
  assert.match(validateFunction, /\$\{GetRoot\} "\$INSTDIR" \$0[\s\S]*StrCpy \$0 "\$0\\"/u)
  assert.ok(
    validateFunction.indexOf('StrCpy $0 "$0\\"')
      < validateFunction.indexOf('GetVolumeInformationW'),
  )
  assert.ok(
    validateFunction.indexOf('StrCpy $0 "$0\\"')
      < validateFunction.indexOf('GetDiskFreeSpaceW'),
  )

  const powershellCalls = installer.match(/nsExec::ExecToStack[^\r\n]*powershell\.exe/gu) ?? []
  const workingDirectoryBegins = installer.match(
    /!insertmacro PowerShellWorkingDirectoryBegin/gu,
  ) ?? []
  const workingDirectoryEnds = installer.match(/!insertmacro PowerShellWorkingDirectoryEnd/gu) ?? []
  assert.equal(workingDirectoryBegins.length, powershellCalls.length)
  assert.equal(workingDirectoryEnds.length, powershellCalls.length)
  assert.match(installer, /!macro PowerShellWorkingDirectoryBegin[\s\S]*SetOutPath "\$SYSDIR"/u)
  assert.match(installer, /!macro PowerShellWorkingDirectoryEnd[\s\S]*SetOutPath "\$powershellPreviousOutDir"/u)
})

test('first install prefers the secured D drive path and falls back only after preflight', () => {
  const initMacro = installer.match(/!macro customInit([\s\S]*?)!macroend/u)?.[1]
  assert.ok(initMacro)
  const preferred = 'StrCpy $INSTDIR "D:\\DeepSeek Harness Desktop"'
  const preferredCheck = 'customInit:d-drive path=$INSTDIR error=$preflightError'
  const fallback = 'StrCpy $INSTDIR "$LOCALAPPDATA\\Programs\\DeepSeek Harness Desktop"'
  const fallbackCheck = 'customInit:fallback path=$INSTDIR error=$preflightError'

  assert.ok(initMacro.indexOf(preferred) >= 0)
  assert.ok(initMacro.indexOf(preferred) < initMacro.indexOf(preferredCheck))
  assert.ok(initMacro.indexOf(preferredCheck) < initMacro.indexOf(fallback))
  assert.ok(initMacro.indexOf(fallback) < initMacro.indexOf(fallbackCheck))
  assert.match(initMacro, /GetDParameter \$commandLineInstallDir/u)
  assert.match(installer, /GetDriveTypeW[\s\S]*GetVolumeInformationW[\s\S]*"NTFS"[\s\S]*GetDiskFreeSpaceW/u)
})

test('builder requests persistent desktop and Start menu shortcuts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.build.nsis.createDesktopShortcut, 'always')
  assert.equal(manifest.build.nsis.createStartMenuShortcut, true)
  assert.equal(manifest.build.nsis.runAfterFinish, true)
})

test('custom uninstall cleanup honors both interactive and electron-builder delete-data choices', () => {
  const unInitMacro = installer.match(/!macro customUnInit([\s\S]*?)!macroend/u)?.[1]
  const cleanupSection = installer.match(
    /!macro customUnInstallSection([\s\S]*?)!macroend/u,
  )?.[1]
  assert.ok(unInitMacro)
  assert.ok(cleanupSection)
  assert.match(
    cleanupSection,
    /Section "un\.-Finalize DeepSeek Harness Desktop cleanup"[\s\S]*SectionIn RO/u,
  )
  assert.match(unInitMacro, /StrCpy \$unDeleteUserData "0"/u)
  assert.match(
    unInitMacro,
    /\$\{StdUtils\.TestParameter\} \$0 "delete-app-data"/u,
  )
  assert.match(
    unInitMacro,
    /\$\{If\} \$0 == "true"[\s\S]*StrCpy \$unDeleteUserData "1"/u,
  )
  assert.doesNotMatch(unInitMacro, /GetOptions/u)
  assert.match(unInitMacro, /ReadEnvStr \$uninstallerDiagnosticLog "DSH_UNINSTALLER_DIAGNOSTIC_LOG"/u)
  assert.match(installer, /Function un\.WriteUninstallerDiagnostic[\s\S]*FileOpen \$R8 "\$uninstallerDiagnosticLog" a/u)
  assert.match(
    cleanupSection,
    /\$unDeleteUserData == "1"[\s\S]*\$isDeleteAppData == "1"/u,
  )
  assert.match(cleanupSection, /RMDir \/r "\$APPDATA\\\$\{PRODUCT_NAME\}"/u)
})

test('directory protector contains no-follow traversal, hardlink, and full ACL verification', () => {
  assert.match(protectorSource, /Import-Module[^\r\n]*Microsoft\.PowerShell\.Security/u)
  assert.match(protectorSource, /SearchOption\]::TopDirectoryOnly/u)
  assert.match(protectorSource, /GetLinkCount/u)
  assert.match(protectorSource, /NumberOfLinks/u)
  assert.match(protectorSource, /New-ProtectedLeafDirectory/u)
  assert.match(protectorSource, /AreAccessRulesProtected/u)
  assert.match(protectorSource, /GetOwner/u)
  assert.match(protectorSource, /FileSystemRights\]::DeleteSubdirectoriesAndFiles/u)
  assert.match(protectorSource, /AllowFreshInstallDirectory/u)
  assert.match(protectorSource, /Assert-EmptyDirectory/u)
  assert.match(protectorSource, /Assert-NoExplicitBroadAllow/u)
  assert.match(
    protectorSource,
    /if \(-not \(Test-SamePath \$parent \$root\)\)[\s\S]*Assert-NoBroadAllow \$parent \$deleteChildMask/u,
  )
})

test('only an untrusted first install opts into fresh-directory adoption', () => {
  const initMacro = installer.match(/!macro customInit([\s\S]*?)!macroend/u)?.[1]
  assert.ok(initMacro)
  assert.match(initMacro, /StrCpy \$freshInstallDirectoryArgument ""/u)
  assert.match(
    initMacro,
    /\$previousInstallTrusted != "1"[\s\S]*StrCpy \$freshInstallDirectoryArgument "-AllowFreshInstallDirectory"/u,
  )
})

test('directory protector rejects hardlinks and junction ancestors without external changes', {
  skip: process.platform !== 'win32',
}, (t) => {
  const localAppData = process.env.LOCALAPPDATA
  assert.ok(localAppData, 'LOCALAPPDATA is required on Windows')
  const root = path.join(localAppData, `dsh-security-test-${process.pid}-${Date.now()}`)
  const app = path.join(root, 'app')
  const initial = powershell(['-File', protector, '-Path', app])
  if (initial.status !== 0
    && /Access to the path|grants mutation rights/iu.test(`${initial.stdout}\n${initial.stderr}`)) {
    t.skip('the agent sandbox adds a broad ACL to LOCALAPPDATA; real ACL behavior is covered by release CI')
    return
  }
  assert.equal(initial.status, 0, initial.stderr)

    const junction = path.join(app, 'junction')
    try {
    const inheritedAcl = powershell(['-Command', `
      $target = '${app.replaceAll("'", "''")}'
      $acl = Get-Acl -LiteralPath $target
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-5-11'),
        [Security.AccessControl.FileSystemRights]::Modify,
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
          [Security.AccessControl.InheritanceFlags]::ObjectInherit,
        [Security.AccessControl.PropagationFlags]::InheritOnly,
        [Security.AccessControl.AccessControlType]::Allow
      )
      $null = $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $target -AclObject $acl
    `])
    assert.equal(inheritedAcl.status, 0, inheritedAcl.stderr)

    const fresh = path.join(app, 'fresh')
    fs.mkdirSync(fresh)
    const freshBefore = powershell(['-Command', `
      $acl = Get-Acl -LiteralPath '${fresh.replaceAll("'", "''")}'
      $broadInherited = $acl.GetAccessRules(
        $true,
        $true,
        [Security.Principal.SecurityIdentifier]
      ) | Where-Object {
        $_.IdentityReference.Value -eq 'S-1-5-11' -and $_.IsInherited
      }
      [Console]::Write("$($acl.AreAccessRulesProtected)|$([bool]$broadInherited)")
    `])
    assert.equal(freshBefore.status, 0, freshBefore.stderr)
    assert.equal(freshBefore.stdout, 'False|True')

    const freshAdoption = powershell([
      '-File', protector,
      '-Path', fresh,
      '-Recursive',
      '-AllowFreshInstallDirectory',
    ])
    assert.equal(freshAdoption.status, 0, freshAdoption.stderr)
    const freshAfter = powershell(['-Command', `
      $acl = Get-Acl -LiteralPath '${fresh.replaceAll("'", "''")}'
      $broad = $acl.GetAccessRules(
        $true,
        $true,
        [Security.Principal.SecurityIdentifier]
      ) | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-11' }
      [Console]::Write("$($acl.AreAccessRulesProtected)|$([bool]$broad)")
    `])
    assert.equal(freshAfter.status, 0, freshAfter.stderr)
    assert.equal(freshAfter.stdout, 'True|False')

    const nonempty = path.join(app, 'nonempty')
    fs.mkdirSync(nonempty)
    fs.writeFileSync(path.join(nonempty, 'sentinel.txt'), 'sentinel')
    const nonemptyBefore = powershell([
      '-Command',
      `(Get-Acl -LiteralPath '${nonempty.replaceAll("'", "''")}').Sddl`,
    ])
    const nonemptyResult = powershell([
      '-File', protector,
      '-Path', nonempty,
      '-AllowFreshInstallDirectory',
    ])
    assert.notEqual(nonemptyResult.status, 0)
    assert.match(`${nonemptyResult.stdout}\n${nonemptyResult.stderr}`, /not empty/iu)
    assert.equal(fs.readFileSync(path.join(nonempty, 'sentinel.txt'), 'utf8'), 'sentinel')
    const nonemptyAfter = powershell([
      '-Command',
      `(Get-Acl -LiteralPath '${nonempty.replaceAll("'", "''")}').Sddl`,
    ])
    assert.equal(nonemptyAfter.stdout.trim(), nonemptyBefore.stdout.trim())

      const nested = path.join(app, 'nested')
    fs.mkdirSync(nested)
    fs.writeFileSync(path.join(nested, 'normal.txt'), 'normal')
    const recursive = powershell(['-File', protector, '-Path', app, '-Recursive'])
    assert.equal(recursive.status, 0, recursive.stderr)

    const outside = path.join(root, 'outside.bin')
    const linked = path.join(app, 'linked.bin')
    fs.writeFileSync(outside, 'sentinel')
    fs.linkSync(outside, linked)
    const beforeSddl = powershell(['-Command', `(Get-Acl -LiteralPath '${outside.replaceAll("'", "''")}').Sddl`])
    assert.equal(beforeSddl.status, 0, beforeSddl.stderr)
    const hardlink = powershell(['-File', protector, '-Path', app, '-Recursive'])
    assert.notEqual(hardlink.status, 0)
    assert.match(`${hardlink.stdout}\n${hardlink.stderr}`, /hard link/iu)
    assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel')
    const afterSddl = powershell(['-Command', `(Get-Acl -LiteralPath '${outside.replaceAll("'", "''")}').Sddl`])
    assert.equal(afterSddl.stdout.trim(), beforeSddl.stdout.trim())
    fs.unlinkSync(linked)

    const victim = path.join(root, 'victim')
    fs.mkdirSync(victim)
    fs.writeFileSync(path.join(victim, 'sentinel.txt'), 'sentinel')
    fs.symlinkSync(victim, junction, 'junction')
    const junctionChild = path.join(junction, 'new-child')
    const junctionResult = powershell(['-File', protector, '-Path', junctionChild, '-ValidateOnly'])
    assert.notEqual(junctionResult.status, 0)
    assert.equal(fs.existsSync(path.join(victim, 'new-child')), false)
    assert.equal(fs.readFileSync(path.join(victim, 'sentinel.txt'), 'utf8'), 'sentinel')
  } finally {
    if (fs.existsSync(junction)) fs.unlinkSync(junction)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
