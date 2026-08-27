const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { UpgradeSafety, readDataDirectoryBeforeMigration } = require('../src/upgrade-safety.cjs')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upgrade-'))
  const configFile = path.join(root, 'user-data', 'desktop-config.json')
  const dataDirectory = path.join(root, 'user-data', 'harness')
  fs.mkdirSync(dataDirectory, { recursive: true })
  fs.writeFileSync(configFile, JSON.stringify({ version: 3, workspace: '', encryptedApiKey: 'cipher' }))
  fs.writeFileSync(path.join(dataDirectory, 'session.jsonl'), '{"old":true}\n')
  const manager = new UpgradeSafety({
    stateFile: path.join(root, 'user-data', 'runtime-state.json'),
    backupRoot: path.join(root, 'user-data', 'backups'),
    configFile,
    appVersion: '0.3.0',
    harnessVersion: '0.1.1-rc.2',
    now: () => new Date('2026-08-26T00:00:00.000Z'),
  })
  return { root, configFile, dataDirectory, manager }
}

test('creates one integrity-checked snapshot before a new version starts', () => {
  const { manager, dataDirectory } = fixture()
  const first = manager.prepare(dataDirectory)
  const second = manager.prepare(dataDirectory)
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.pending.backupDirectory, first.pending.backupDirectory)
  assert.equal(fs.existsSync(path.join(first.pending.backupDirectory, 'manifest.json')), true)
})

test('only commits versions after health succeeds and keeps rollback available', () => {
  const { manager, dataDirectory } = fixture()
  manager.prepare(dataDirectory)
  assert.equal(manager.getStatus().lastSuccessfulHarnessVersion, '')
  const status = manager.markHealthy()
  assert.equal(status.lastSuccessfulHarnessVersion, '0.1.1-rc.2')
  assert.equal(status.rollbackAvailable, true)
  assert.equal(manager.prepare(dataDirectory).pending, null)
})

test('keeps the pending snapshot when startup fails', () => {
  const { manager, dataDirectory } = fixture()
  manager.prepare(dataDirectory)
  manager.markFailed(Object.assign(new Error('migration failed'), { code: 'RUNTIME_START_FAILED' }))
  const status = manager.getStatus()
  assert.equal(status.pending.failureCode, 'RUNTIME_START_FAILED')
  assert.equal(status.rollbackAvailable, true)
})

test('reuses the pre-install snapshot when the packaged Harness version changes', () => {
  const { root, configFile, dataDirectory, manager } = fixture()
  const prepared = manager.prepare(dataDirectory, {
    previousAppVersion: '0.2.0',
    previousHarnessVersion: '0.1.0',
  })
  const nextProcess = new UpgradeSafety({
    stateFile: manager.stateFile,
    backupRoot: manager.backupRoot,
    configFile,
    appVersion: '0.3.0',
    harnessVersion: '0.1.2',
    now: manager.now,
  })
  const reused = nextProcess.prepare(dataDirectory)
  assert.equal(reused.created, false)
  assert.equal(reused.pending.backupDirectory, prepared.pending.backupDirectory)
  assert.equal(reused.pending.targetHarnessVersion, '0.1.2')
  assert.equal(fs.readdirSync(path.join(root, 'user-data', 'backups')).length, 1)
})

test('creates a valid rollback snapshot even when config and data are absent', () => {
  const { root, manager } = fixture()
  fs.rmSync(path.join(root, 'user-data', 'desktop-config.json'))
  fs.rmSync(path.join(root, 'user-data', 'harness'), { recursive: true })
  const prepared = manager.prepare(path.join(root, 'user-data', 'harness'), {
    previousAppVersion: '0.2.0',
  })
  assert.equal(prepared.pending.emptyInstall, true)
  assert.equal(fs.existsSync(path.join(prepared.pending.backupDirectory, 'manifest.json')), true)
  assert.equal(manager.getStatus().rollbackAvailable, true)
})

test('does not replace a missing pending snapshot after the target app starts', () => {
  const { dataDirectory, manager } = fixture()
  const prepared = manager.prepare(dataDirectory, { previousAppVersion: '0.2.0' })
  fs.rmSync(prepared.pending.backupDirectory, { recursive: true })
  assert.throws(() => manager.prepare(dataDirectory), /快照丢失/u)
})

test('keeps a staged future snapshot while the current app remains running', () => {
  const { configFile, dataDirectory, manager } = fixture()
  manager.markHealthy()
  const future = new UpgradeSafety({
    stateFile: manager.stateFile,
    backupRoot: manager.backupRoot,
    configFile,
    appVersion: '0.4.0',
    harnessVersion: '0.2.0',
    now: manager.now,
  })
  const staged = future.prepare(dataDirectory, {
    previousAppVersion: '0.3.0',
    previousHarnessVersion: '0.1.1-rc.2',
  })
  const current = manager.prepare(dataDirectory)
  assert.equal(current.awaitingTarget, true)
  assert.equal(current.pending.backupDirectory, staged.pending.backupDirectory)
  manager.markFailed(new Error('current runtime error'))
  manager.markHealthy()
  assert.equal(manager.readState().pending.targetAppVersion, '0.4.0')
})

test('reads the pre-migration data target without rewriting an old config', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pre-migration-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const configFile = path.join(root, 'desktop-config.json')
  const customData = path.join(root, 'custom-harness')
  const source = `${JSON.stringify({ version: 2, workspace: 'C:\\workspace', dataDirectory: customData })}\n`
  fs.writeFileSync(configFile, source)

  assert.equal(readDataDirectoryBeforeMigration(configFile, path.join(root, 'default')), customData)
  assert.equal(fs.readFileSync(configFile, 'utf8'), source)
})

test('uses the default target for pre-migration configs that have no dataDirectory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pre-migration-default-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const configFile = path.join(root, 'desktop-config.json')
  const fallback = path.join(root, 'harness')
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, workspace: 'C:\\workspace' }))
  assert.equal(readDataDirectoryBeforeMigration(configFile, fallback), fallback)
})
