'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { UUID } = require('builder-util-runtime')
const manifest = require('../package.json')

const projectRoot = path.resolve(__dirname, '..')
const allowInstall = process.argv.includes('--allow-install')
const installerArgument = process.argv.find((argument) => argument.startsWith('--installer='))
const installer = path.resolve(
  installerArgument?.slice('--installer='.length)
    || path.join(
      projectRoot,
      'release',
      `DeepSeek-Harness-Desktop-Setup-${manifest.version}-x64.exe`,
    ),
)
const productName = manifest.build.productName
const executableName = `${manifest.build.win.executableName}.exe`
const shortcutName = `${manifest.build.nsis.shortcutName}.lnk`
const electronBuilderNamespace = UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')
const appGuid = UUID.v5(manifest.build.appId, electronBuilderNamespace)
const powerShell = path.join(
  process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const runId = `${Date.now()}-${crypto.randomUUID()}`
const reportRoot = path.join(projectRoot, 'test-results', 'nsis-smoke', `run-${runId}`)
const diagnosticLog = path.join(reportRoot, 'installer.log')
const reportFile = path.join(reportRoot, 'report.json')
const state = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  installer,
  stages: [],
}

function record(stage, details = {}) {
  state.stages.push({ stage, at: new Date().toISOString(), ...details })
  fs.mkdirSync(reportRoot, { recursive: true })
  fs.writeFileSync(reportFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function encodePowerShell(source) {
  const prelude = [
    "$ErrorActionPreference = 'Stop'",
    '$utf8 = [Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = $utf8',
    '[Console]::OutputEncoding = $utf8',
  ].join("\n")
  return Buffer.from(`${prelude}\n${source}`, 'utf16le').toString('base64')
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || projectRoot,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`${options.label || command} timed out after ${options.timeoutMs || 300_000} ms`))
    }, options.timeoutMs || 300_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(
        `${options.label || command} failed (code=${code}, signal=${signal || 'none'})\n${stdout}\n${stderr}`,
      ))
    })
  })
}

async function runPowerShell(source, environment = {}) {
  const result = await runProcess(
    powerShell,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(source)],
    { env: { ...process.env, ...environment }, label: 'PowerShell helper', timeoutMs: 60_000 },
  )
  return result.stdout.trim()
}

async function readKnownFolders() {
  const output = await runPowerShell(`
$result = [ordered]@{
  desktop = [Environment]::GetFolderPath('Desktop')
  programs = [Environment]::GetFolderPath('Programs')
  appData = [Environment]::GetFolderPath('ApplicationData')
  localAppData = [Environment]::GetFolderPath('LocalApplicationData')
}
[Console]::Out.Write(($result | ConvertTo-Json -Compress))
`)
  return JSON.parse(output)
}

async function readProductRegistrations() {
  const output = await runPowerShell(`
$rows = @(
  Get-ChildItem -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue |
    ForEach-Object {
      $item = Get-ItemProperty -LiteralPath $_.PSPath
      if ($item.DisplayName -and $item.DisplayName.StartsWith($env:DSH_SMOKE_PRODUCT, [StringComparison]::OrdinalIgnoreCase)) {
        [ordered]@{
          key = $_.PSChildName
          displayName = [string]$item.DisplayName
          displayVersion = [string]$item.DisplayVersion
          installLocation = [string]$item.InstallLocation
          uninstallString = [string]$item.UninstallString
        }
      }
    }
)
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($rows)))
`, { DSH_SMOKE_PRODUCT: productName })
  return JSON.parse(output || '[]')
}

async function readInstallerIdentities() {
  const output = await runPowerShell(`
$rows = @(
  foreach ($hive in @('HKCU', 'HKLM')) {
    $registryPath = "$($hive):\\Software\\$env:DSH_SMOKE_APP_GUID"
    if (Test-Path -LiteralPath $registryPath) {
      $item = Get-ItemProperty -LiteralPath $registryPath
      [ordered]@{
        hive = $hive
        installLocation = [string]$item.InstallLocation
        installInstanceToken = [string]$item.InstallInstanceToken
      }
    }
  }
)
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($rows)))
`, { DSH_SMOKE_APP_GUID: appGuid })
  return JSON.parse(output || '[]')
}

async function readShortcut(shortcut) {
  if (!fs.existsSync(shortcut)) return null
  const output = await runPowerShell(`
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($env:DSH_SMOKE_SHORTCUT)
$result = [ordered]@{ target = [string]$link.TargetPath; arguments = [string]$link.Arguments }
[Console]::Out.Write(($result | ConvertTo-Json -Compress))
`, { DSH_SMOKE_SHORTCUT: shortcut })
  return JSON.parse(output)
}

function samePath(left, right) {
  return path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US')
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}

function readInstallMarker(installDirectory) {
  const markerFile = path.join(installDirectory, '.dsh-desktop-install.json')
  const stat = fs.lstatSync(markerFile)
  assert.equal(stat.isFile(), true, 'install marker must be a regular file')
  assert.equal(stat.isSymbolicLink(), false, 'install marker cannot be a symbolic link')
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  assert.equal(marker.appId, manifest.build.appId)
  assert.match(
    marker.installInstance,
    /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu,
  )
  return marker
}

function assertIsolatedInstallDirectory(installDirectory, localAppData) {
  const resolved = path.resolve(installDirectory)
  assert.equal(path.dirname(resolved), path.resolve(localAppData), 'smoke install target left LocalAppData')
  assert.equal(
    path.basename(resolved),
    `DeepSeek Harness Desktop NSIS Smoke ${runId}`,
    'smoke install target lost its unique run identity',
  )
  return resolved
}

function assertNoLinks(filename) {
  const stat = fs.lstatSync(filename)
  assert.equal(stat.isSymbolicLink(), false, `refusing to clean a linked path: ${filename}`)
  if (!stat.isDirectory()) return
  for (const entry of fs.readdirSync(filename)) assertNoLinks(path.join(filename, entry))
}

async function removeOwnedRegistryEntries(installDirectory) {
  await runPowerShell(`
$target = [IO.Path]::GetFullPath($env:DSH_SMOKE_INSTALL_DIR)
$identityKey = "HKCU:\\Software\\$env:DSH_SMOKE_APP_GUID"
$uninstallKey = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$env:DSH_SMOKE_APP_GUID"
if (Test-Path -LiteralPath $identityKey) {
  $item = Get-ItemProperty -LiteralPath $identityKey
  if ([String]::IsNullOrWhiteSpace([string]$item.InstallLocation) -or
    -not [String]::Equals(
      [IO.Path]::GetFullPath([string]$item.InstallLocation),
      $target,
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Registry cleanup target does not belong to this smoke run: $identityKey"
  }
}
if (Test-Path -LiteralPath $uninstallKey) {
  $item = Get-ItemProperty -LiteralPath $uninstallKey
  $command = [string]$item.UninstallString
  $uninstaller = if ($command.StartsWith('"')) {
    $end = $command.IndexOf('"', 1)
    if ($end -le 1) { '' } else { $command.Substring(1, $end - 1) }
  } else {
    ($command -split '\\s+', 2)[0]
  }
  $expectedUninstaller = Join-Path $target $env:DSH_SMOKE_UNINSTALLER
  if ([String]::IsNullOrWhiteSpace($uninstaller) -or
    -not [String]::Equals(
      [IO.Path]::GetFullPath($uninstaller),
      [IO.Path]::GetFullPath($expectedUninstaller),
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Uninstall registry cleanup target does not belong to this smoke run: $uninstallKey"
  }
}
if (Test-Path -LiteralPath $uninstallKey) { Remove-Item -LiteralPath $uninstallKey -Recurse -Force }
if (Test-Path -LiteralPath $identityKey) { Remove-Item -LiteralPath $identityKey -Recurse -Force }
`, {
    DSH_SMOKE_APP_GUID: appGuid,
    DSH_SMOKE_INSTALL_DIR: installDirectory,
    DSH_SMOKE_UNINSTALLER: `Uninstall ${executableName}`,
  })
}

async function cleanupOwnedRemnants(installDirectory, shortcuts, localAppData) {
  const ownedInstallDirectory = assertIsolatedInstallDirectory(installDirectory, localAppData)
  const expectedExecutable = path.join(ownedInstallDirectory, executableName)
  const registrations = await readProductRegistrations()
  const identities = await readInstallerIdentities()
  for (const entry of identities) {
    assert.equal(
      samePath(entry.installLocation, ownedInstallDirectory),
      true,
      'refusing to clean registry state owned by another installation',
    )
  }
  const expectedUninstaller = path.join(ownedInstallDirectory, `Uninstall ${executableName}`)
  for (const entry of registrations) {
    const match = entry.uninstallString.match(/^"([^"]+)"|^(\S+)/u)
    assert.equal(
      match && samePath(match[1] || match[2], expectedUninstaller),
      true,
      'refusing to clean an uninstall registration owned by another installation',
    )
  }
  const ownedShortcuts = []
  for (const shortcut of shortcuts) {
    const link = await readShortcut(shortcut)
    if (!link) continue
    assert.equal(samePath(link.target, expectedExecutable), true, 'refusing to clean another shortcut')
    ownedShortcuts.push(shortcut)
  }
  if (fs.existsSync(ownedInstallDirectory)) {
    const marker = path.join(ownedInstallDirectory, '.dsh-desktop-install.json')
    if (fs.existsSync(marker)) readInstallMarker(ownedInstallDirectory)
    assertNoLinks(ownedInstallDirectory)
    fs.rmSync(ownedInstallDirectory, { recursive: true })
  }
  for (const shortcut of ownedShortcuts) fs.unlinkSync(shortcut)
  await removeOwnedRegistryEntries(ownedInstallDirectory)
  assert.deepEqual(await readProductRegistrations(), [], 'owned uninstall registration cleanup failed')
  assert.deepEqual(await readInstallerIdentities(), [], 'owned installer identity cleanup failed')
}

async function waitForMissing(filename, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!fs.existsSync(filename)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`path still exists after uninstall: ${filename}`)
}

async function waitForRegistryCleanup(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await readProductRegistrations()).length === 0
      && (await readInstallerIdentities()).length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('installer registry state still exists after uninstall')
}

function selectDataProbe(appData) {
  const directory = path.resolve(appData, productName)
  const relative = path.relative(path.resolve(appData), directory)
  assert.equal(
    relative && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`),
    true,
    'Electron userData path escaped the current-user AppData directory',
  )
  assert.equal(
    fs.existsSync(directory),
    false,
    `the real Electron userData directory already exists; refusing to touch it: ${directory}`,
  )
  return directory
}

async function installOrRepair(installDirectory, label) {
  await runProcess(installer, ['/S', '/currentuser', `/D=${installDirectory}`], {
    env: {
      ...process.env,
      DSH_INSTALLER_DIAGNOSTIC_LOG: diagnosticLog,
    },
    label,
  })
}

async function validateInstalledState(installDirectory, shortcuts) {
  const executable = path.join(installDirectory, executableName)
  const uninstaller = path.join(installDirectory, `Uninstall ${executableName}`)
  const appAsar = path.join(installDirectory, 'resources', 'app.asar')
  for (const filename of [executable, uninstaller, appAsar]) {
    assert.equal(fs.lstatSync(filename).isFile(), true, `installed file is missing: ${filename}`)
  }

  const registrations = await readProductRegistrations()
  assert.equal(registrations.length, 1, 'exactly one uninstall registration is required')
  assert.equal(registrations[0].displayVersion, manifest.version)
  assert.equal(
    registrations[0].uninstallString.toLocaleLowerCase('en-US')
      .includes(uninstaller.toLocaleLowerCase('en-US')),
    true,
    'uninstall registration points to a different executable',
  )

  const identities = await readInstallerIdentities()
  assert.equal(identities.length, 1, 'exactly one installer identity is required')
  assert.equal(identities[0].hive, 'HKCU')
  assert.equal(samePath(identities[0].installLocation, installDirectory), true)
  const marker = readInstallMarker(installDirectory)
  assert.equal(identities[0].installInstanceToken, marker.installInstance)

  for (const shortcut of shortcuts) {
    const link = await readShortcut(shortcut)
    assert.ok(link, `shortcut is missing: ${shortcut}`)
    assert.equal(samePath(link.target, executable), true, `shortcut target is wrong: ${shortcut}`)
  }

  return {
    executable,
    uninstaller,
    appAsar,
    marker,
    registration: registrations[0],
    identity: identities[0],
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('NSIS smoke requires Windows')
  if (!allowInstall) {
    throw new Error('NSIS smoke changes the current-user install registry; rerun with --allow-install')
  }
  assert.equal(fs.lstatSync(installer).isFile(), true, `installer is missing: ${installer}`)

  fs.mkdirSync(reportRoot, { recursive: true })
  const folders = await readKnownFolders()
  for (const [name, value] of Object.entries(folders)) {
    assert.equal(typeof value, 'string', `${name} known folder is missing`)
    assert.notEqual(value.trim(), '', `${name} known folder is empty`)
  }

  const installDirectory = path.join(
    folders.localAppData,
    `DeepSeek Harness Desktop NSIS Smoke ${runId}`,
  )
  const shortcuts = [
    path.join(folders.desktop, shortcutName),
    path.join(folders.programs, shortcutName),
  ]
  state.installDirectory = installDirectory
  state.shortcuts = shortcuts
  record('preflight-started')

  assert.equal(fs.existsSync(installDirectory), false, 'isolated install target already exists')
  assert.deepEqual(
    await readProductRegistrations(),
    [],
    'an existing product installation is registered; refusing to overwrite it',
  )
  assert.deepEqual(
    await readInstallerIdentities(),
    [],
    'an existing installer identity registry key remains; refusing to overwrite it',
  )
  for (const shortcut of shortcuts) {
    assert.equal(fs.existsSync(shortcut), false, `an existing product shortcut would be overwritten: ${shortcut}`)
  }
  record('preflight-complete')

  let installedState
  let installAttempted = false
  let dataProbe
  let dataProbeDirectory
  let boundaryCanary
  let boundaryCanaryDirectory
  let cleanUninstallComplete = false
  try {
    installAttempted = true
    await installOrRepair(installDirectory, 'silent NSIS install')
    installedState = await validateInstalledState(installDirectory, shortcuts)
    record('install-verified', {
      installInstance: installedState.marker.installInstance,
      appAsarSha256: sha256(installedState.appAsar),
    })

    const expectedAsarHash = sha256(installedState.appAsar)
    const damagedAsar = `${installedState.appAsar}.smoke-damaged`
    fs.renameSync(installedState.appAsar, damagedAsar)
    await installOrRepair(installDirectory, 'same-version NSIS repair')
    const repairedState = await validateInstalledState(installDirectory, shortcuts)
    assert.equal(sha256(repairedState.appAsar), expectedAsarHash, 'repair did not restore app.asar')
    assert.equal(fs.existsSync(damagedAsar), false, 'repair left the damaged payload behind')
    assert.equal(
      repairedState.marker.installInstance,
      installedState.marker.installInstance,
      'repair changed the installation identity token',
    )
    installedState = repairedState
    record('repair-verified', { appAsarSha256: expectedAsarHash })

    dataProbeDirectory = selectDataProbe(folders.appData)
    fs.mkdirSync(dataProbeDirectory)
    dataProbe = path.join(dataProbeDirectory, `nsis-smoke-${runId}.json`)
    fs.writeFileSync(dataProbe, `${JSON.stringify({ runId, purpose: 'uninstall-preserve-check' })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    boundaryCanaryDirectory = path.resolve(
      folders.appData,
      `DeepSeek Harness Desktop NSIS Boundary ${runId}`,
    )
    const boundaryRelative = path.relative(path.resolve(folders.appData), boundaryCanaryDirectory)
    assert.equal(
      boundaryRelative && !path.isAbsolute(boundaryRelative)
        && !boundaryRelative.startsWith(`..${path.sep}`),
      true,
      'uninstall boundary canary escaped the current-user AppData directory',
    )
    assert.equal(
      fs.existsSync(boundaryCanaryDirectory),
      false,
      'isolated uninstall boundary canary already exists',
    )
    fs.mkdirSync(boundaryCanaryDirectory)
    boundaryCanary = path.join(boundaryCanaryDirectory, 'must-survive.json')
    fs.writeFileSync(
      boundaryCanary,
      `${JSON.stringify({ runId, purpose: 'uninstall-boundary-check' })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    )

    await runProcess(installedState.uninstaller, ['/S', '/currentuser'], {
      env: { ...process.env, DSH_UNINSTALLER_DIAGNOSTIC_LOG: diagnosticLog },
      label: 'silent NSIS uninstall',
    })
    await waitForMissing(installDirectory)
    await waitForRegistryCleanup()
    for (const shortcut of shortcuts) {
      assert.equal(fs.existsSync(shortcut), false, `shortcut was not removed: ${shortcut}`)
    }
    assert.equal(fs.readFileSync(dataProbe, 'utf8').includes(runId), true, 'uninstall removed kept data')
    assert.equal(fs.readFileSync(boundaryCanary, 'utf8').includes(runId), true, 'uninstall crossed its data boundary')
    record('uninstall-verified', { userDataPreserved: true })

    await installOrRepair(installDirectory, 'silent NSIS reinstall for delete-data coverage')
    installedState = await validateInstalledState(installDirectory, shortcuts)
    record('delete-data-install-verified', {
      installInstance: installedState.marker.installInstance,
    })
    await runProcess(installedState.uninstaller, ['/S', '/currentuser', '--delete-app-data'], {
      env: { ...process.env, DSH_UNINSTALLER_DIAGNOSTIC_LOG: diagnosticLog },
      label: 'silent NSIS uninstall with user-data deletion',
    })
    await waitForMissing(installDirectory)
    await waitForMissing(dataProbeDirectory)
    await waitForRegistryCleanup()
    assert.equal(
      fs.readFileSync(boundaryCanary, 'utf8').includes(runId),
      true,
      'delete-data uninstall crossed its data boundary',
    )
    for (const shortcut of shortcuts) {
      assert.equal(fs.existsSync(shortcut), false, `delete-data uninstall left a shortcut: ${shortcut}`)
    }
    cleanUninstallComplete = true
    record('uninstall-delete-data-verified', { userDataRemoved: true })
  } finally {
    const cleanupUninstaller = installedState?.uninstaller
      || path.join(installDirectory, `Uninstall ${executableName}`)
    if (!cleanUninstallComplete && installAttempted && fs.existsSync(cleanupUninstaller)) {
      try {
        readInstallMarker(installDirectory)
        await runProcess(cleanupUninstaller, ['/S', '/currentuser'], {
          env: { ...process.env, DSH_UNINSTALLER_DIAGNOSTIC_LOG: diagnosticLog },
          label: 'NSIS smoke cleanup uninstall',
        })
        await waitForMissing(installDirectory)
        record('cleanup-uninstall-complete')
      } catch (error) {
        record('cleanup-uninstall-failed', { error: error.message })
      }
    }
    if (!cleanUninstallComplete && installAttempted) {
      try {
        await cleanupOwnedRemnants(installDirectory, shortcuts, folders.localAppData)
        record('cleanup-owned-remnants-complete')
      } catch (error) {
        record('cleanup-owned-remnants-failed', { error: error.message })
      }
    }
    if (dataProbe && fs.existsSync(dataProbe)) fs.unlinkSync(dataProbe)
    if (dataProbeDirectory && fs.existsSync(dataProbeDirectory)
      && fs.readdirSync(dataProbeDirectory).length === 0) {
      fs.rmdirSync(dataProbeDirectory)
    }
    if (boundaryCanary && fs.existsSync(boundaryCanary)) fs.unlinkSync(boundaryCanary)
    if (boundaryCanaryDirectory && fs.existsSync(boundaryCanaryDirectory)
      && fs.readdirSync(boundaryCanaryDirectory).length === 0) {
      fs.rmdirSync(boundaryCanaryDirectory)
    }
  }

  state.completedAt = new Date().toISOString()
  state.ok = true
  record('complete')
  console.log(`NSIS install/repair/uninstall smoke passed: ${reportFile}`)
}

main().catch((error) => {
  state.completedAt = new Date().toISOString()
  state.ok = false
  state.error = error.stack || error.message
  record('failed')
  console.error(error)
  process.exitCode = 1
})
