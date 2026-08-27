const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main.cjs'), 'utf8')

function section(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.notEqual(from, -1, `missing section start: ${start}`)
  assert.notEqual(to, -1, `missing section end: ${end}`)
  return source.slice(from, to)
}

test('Electron windows deny request, check, and device permissions', () => {
  assert.match(source, /setPermissionRequestHandler/u)
  assert.match(source, /setPermissionCheckHandler/u)
  assert.match(source, /setDevicePermissionHandler/u)
})

test('Electron disables hardware acceleration before waiting for app readiness', () => {
  const disabledAt = source.indexOf('app.disableHardwareAcceleration()')
  const readyAt = source.indexOf('app.whenReady()')
  assert.notEqual(disabledAt, -1)
  assert.notEqual(readyAt, -1)
  assert.ok(disabledAt < readyAt)
})

test('workspace access is revalidated in the main process for the selected permission mode', () => {
  const inspector = section('function inspectWorkspaceForPermission(', 'async function confirmWorkspaceRisks(')
  const save = section('async function saveConnectionSettings(', 'function registerIpc(')
  const startup = section('async function runHarnessStart(', 'function startHarness(')

  assert.match(inspector, /permissionMode === 'read-only'[\s\S]*requireWritable: normalizedPermission !== 'read-only'/u)
  assert.match(inspector, /permissionMode === 'danger-full-access'/u)
  assert.match(source, /createWindowsDriveTypeResolver/u)
  assert.match(inspector, /driveType: windowsDriveType/u)
  assert.match(save, /requestedPermission[\s\S]*inspectWorkspaceForPermission\(payload\.workspace, requestedPermission\)[\s\S]*if \(!assessment\.ok\)/u)
  assert.match(startup, /getRuntimeSettings[\s\S]*inspectWorkspaceForPermission\(settings\.workspace, settings\.permissionMode\)[\s\S]*if \(!workspaceAssessment\.ok\)[\s\S]*harnessManager\.start/u)
  assert.match(source, /desktop:inspect-workspace[\s\S]*inspectWorkspaceForPermission\(workspace, effectivePermission\)/u)
})

test('a replacement API key is validated before any persisted or runtime state changes', () => {
  const save = section('async function saveConnectionSettings(', 'function registerIpc(')
  const validationAt = save.indexOf('await testDeepSeekApiKey(candidateKey')
  const stopAt = save.indexOf('await stopHarnessForOperation()')
  const migrateAt = save.indexOf('migrateDataDirectory(')
  const persistAt = save.indexOf('configStore.save({')

  assert.notEqual(validationAt, -1)
  assert.ok(validationAt < stopAt)
  assert.ok(validationAt < migrateAt)
  assert.ok(validationAt < persistAt)
  assert.match(save.slice(validationAt, stopAt), /if \(!result\.ok\)[\s\S]*throw error/u)
  assert.match(save.slice(persistAt), /apiKey: candidateKey/u)
})

test('Harness notifications use the official event bridge and follow process lifecycle', () => {
  const startup = section('async function runHarnessStart(', 'function startHarness(')
  const events = section('function installHarnessEventHandlers(', 'async function boot(')
  const boot = section('async function boot(', 'const hasSingleInstanceLock')

  assert.match(source, /app\.setAppUserModelId\(APP_ID\)/u)
  assert.match(source, /new HarnessNotificationMonitor/u)
  assert.match(boot, /callHarnessRpc\(baseUrl, 'session\.list'/u)
  assert.match(boot, /callHarnessRpc\(baseUrl, 'session\.history'/u)
  assert.match(startup, /startHarnessNotifications\(url\)/u)
  assert.match(startup, /catch \(error\) \{[\s\S]*stopHarnessNotifications\(\)/u)
  assert.match(events, /harnessManager\.on\('exit'[\s\S]*stopHarnessNotifications\(\)/u)
  assert.match(source, /notification\.on\('click', showMainWindow\)/u)
})

test('status publication tolerates destroyed and temporarily unavailable renderers', () => {
  const publish = section('function publishStatus(', 'function errorPayload(')
  assert.match(publish, /webContents\.isDestroyed\(\)/u)
  assert.match(publish, /webContents\.isCrashed\(\)/u)
  assert.match(publish, /try \{[\s\S]*webContents\.send\('desktop:status', runtimeState\)[\s\S]*catch \(error\)/u)
})

test('renderer crash recovery is deduplicated, bounded, and checks webContents before reload', () => {
  const recovery = section('function scheduleRendererRecovery(', 'async function openExternalFromPage(')
  const secure = section('function secureWindow(', 'function browserWindowOptions(')
  assert.match(source, /const MAX_RENDERER_RECOVERY_ATTEMPTS = 1/u)
  assert.match(recovery, /rendererRecoveryState\.get\(window\)/u)
  assert.match(recovery, /state\.pending \|\| state\.attempts >= MAX_RENDERER_RECOVERY_ATTEMPTS/u)
  assert.match(recovery, /reason === 'launch-failed'[\s\S]*renderer recovery skipped/u)
  assert.match(recovery, /setTimeout\([\s\S]*webContents\.isDestroyed\(\)[\s\S]*loadLocalPage\([\s\S]*\.then\([\s\S]*\(error\) =>/u)
  assert.doesNotMatch(recovery, /\.finally\(/u)
  assert.match(secure, /render-process-gone[\s\S]*scheduleRendererRecovery\(window, payload, details\.reason\)/u)
  assert.doesNotMatch(secure, /render-process-gone[\s\S]*void loadLocalPage\(window/u)
})

test('online Harness checks use Electron networking and plugin review states the real boundary', () => {
  const updateCheck = section('function runHarnessUpdateCheck()', 'function runExclusive(')
  assert.match(updateCheck, /checkForHarnessUpdate[\s\S]*fetchImpl:[^\n]*net\.fetch/u)
  assert.match(source, /权限标签仅来自静态推断，不构成沙箱或授权隔离/u)
  assert.match(source, /插件可能读取 API Key、会话和已授权文件，也可能直接联网/u)
})

test('destructive stopped-Harness operations restart a still-configured runtime on failure', () => {
  const handlers = [
    section("registerIpcHandler('desktop:delete-api-key'", "registerIpcHandler('desktop:save-settings'"),
    section("registerIpcHandler('desktop:restore-data'", "registerIpcHandler('desktop:export-diagnostics'"),
    section("registerIpcHandler('desktop:clear-user-data'", "registerIpcHandler('desktop:repair-runtime'"),
    section("registerIpcHandler('desktop:reset-runtime-state'", 'function installMenu()'),
  ]

  for (const handler of handlers) {
    assert.match(handler, /catch \(error\)[\s\S]*restartConfiguredHarnessAfterFailure\(\)[\s\S]*throw error/u)
  }
})

test('program rollback journals data before restore and requires a ready helper handshake', () => {
  assert.match(source, /createProgramRollbackJournal\(journalFile,[\s\S]*?createDataBackup\([\s\S]*?markProgramRollbackState\(journalFile, 'data-backup-ready'\)[\s\S]*?restoreDataBackup\(/u)
  assert.match(source, /markProgramRollbackState\(journalFile, 'helper-launched'\)[\s\S]*?spawnProgramRollbackHelper\(previous, journalFile\)/u)
  for (const argument of ["'-JournalPath'", "'-CurrentExecutable'", "'-WaitProcessId'", "'-ReadyFile'"]) {
    assert.match(source, new RegExp(argument, 'u'))
  }
  assert.match(source, /ready\.processId !== helper\.pid/u)
  assert.match(source, /cwd: app\.getPath\('userData'\)/u)
  assert.match(source, /Date\.now\(\) \+ 45_000/u)
  assert.match(source, /recoverCurrentProgramData\(\)[\s\S]*?new ConfigStore/u)
  assert.match(source, /createUpgradeSafety\(\)[\s\S]*?prepareManualUpgradeSnapshot\(\)[\s\S]*?new ConfigStore/u)
  assert.match(source, /secondaryDataDirectory:[^\n]*rollbackDataDirectory[\s\S]*?secondaryRollbackDirectory/u)
  assert.match(source, /recoverInterruptedRestore\([\s\S]*?interruptedRestoreExpectedTargets\(/u)
  assert.match(source, /readBackupDataSettings\([\s\S]*?expectedDataDirectory[\s\S]*?expectedSecondaryDataDirectory/u)
  assert.match(source, /const restoredData = restoreDataBackup\([\s\S]*?restoredData\.journalFile[\s\S]*?markProgramRollbackState\(journalFile, 'data-restored'\)/u)
})

test('rollback helper stop rechecks the process after taskkill races', () => {
  const stopHelper = section('async function stopProgramRollbackHelper(', 'function prepareManualUpgradeSnapshot(')
  assert.match(stopHelper, /catch \(error\)[\s\S]*killerError = error[\s\S]*waitForProgramRollbackHelperExit\(helper, 5_000\)[\s\S]*if \(killerError\) throw killerError/u)
})
