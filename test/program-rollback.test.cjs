'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  createProgramRollbackJournal,
  markProgramRollbackState,
  readProgramRollbackJournal,
  recoverProgramRollback,
} = require('../src/program-rollback.cjs')

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-program-rollback-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const installDirectory = path.join(root, 'DeepSeek Harness Desktop')
  const programRoot = path.join(root, '.dsh-desktop-previous')
  const script = path.join(programRoot, 'restore-previous-install.ps1')
  const userData = path.join(root, 'user-data')
  const dataRollbackDirectory = path.join(userData, 'rollback-backups', 'before')
  fs.mkdirSync(programRoot, { recursive: true })
  fs.mkdirSync(installDirectory, { recursive: true })
  fs.writeFileSync(script, '# test')
  fs.writeFileSync(path.join(installDirectory, 'DeepSeek Harness Desktop.exe'), 'current')
  const journalFile = path.join(userData, 'program-rollback-journal.json')
  const options = {
    currentAppVersion: '0.3.0',
    previousAppVersion: '0.2.0',
    configFile: path.join(userData, 'desktop-config.json'),
    dataDirectory: path.join(userData, 'harness'),
    dataChanged: true,
    dataRollbackDirectory,
    programRoot,
    script,
    installDirectory,
    currentExecutable: path.join(installDirectory, 'DeepSeek Harness Desktop.exe'),
    previousExecutable: path.join(installDirectory, 'DeepSeek Harness Desktop.exe'),
    ...overrides,
  }
  return { root, userData, journalFile, options }
}

test('creates and durably advances only legal guarded states', (t) => {
  const { journalFile, options } = fixture(t)
  const created = createProgramRollbackJournal(journalFile, options)
  assert.equal(created.state, 'prepared')
  assert.equal(readProgramRollbackJournal(journalFile).currentAppVersion, '0.3.0')
  markProgramRollbackState(journalFile, 'data-backup-ready')
  markProgramRollbackState(journalFile, 'data-restored')
  assert.throws(() => markProgramRollbackState(journalFile, 'program-restored'), /不允许/u)
  assert.throws(() => markProgramRollbackState(journalFile, 'helper-launched', { configFile: 'x' }), /字段/u)
  assert.throws(() => createProgramRollbackJournal(journalFile, options), /尚未完成/u)
})

test('rejects same-version rollback and a data-state mismatch', (t) => {
  const sameVersion = fixture(t, { previousAppVersion: '0.3.0' })
  assert.throws(() => createProgramRollbackJournal(sameVersion.journalFile, sameVersion.options), /相同版本/u)

  const unchanged = fixture(t, { dataChanged: false, dataRollbackDirectory: undefined })
  createProgramRollbackJournal(unchanged.journalFile, unchanged.options)
  assert.throws(() => markProgramRollbackState(unchanged.journalFile, 'data-backup-ready'), /不一致/u)
})

test('restores current-version data after the program rollback helper fails', (t) => {
  const { userData, journalFile, options } = fixture(t)
  fs.mkdirSync(options.dataRollbackDirectory, { recursive: true })
  createProgramRollbackJournal(journalFile, options)
  markProgramRollbackState(journalFile, 'data-backup-ready')
  markProgramRollbackState(journalFile, 'data-restored')
  markProgramRollbackState(journalFile, 'helper-launched')
  markProgramRollbackState(journalFile, 'program-failed', { error: 'move failed' })
  const calls = []
  const result = recoverProgramRollback({
    journalFile,
    expectedConfigFile: options.configFile,
    expectedDataDirectory: options.dataDirectory,
    currentAppVersion: '0.3.0',
    harnessVersion: '0.1.1-rc.2',
    recoveryRollbackDirectory: path.join(userData, 'rollback-backups', 'recovery'),
    restoreDataBackup: (restoreOptions) => calls.push(restoreOptions),
  })
  assert.equal(result.recovered, true)
  assert.equal(calls[0].backupDirectory, options.dataRollbackDirectory)
  assert.equal(readProgramRollbackJournal(journalFile).state, 'data-recovered')
})

test('restores a distinct old data target before restoring current-version data', (t) => {
  const { userData, journalFile, options } = fixture(t)
  const secondaryDataDirectory = path.join(userData, 'old-custom-harness')
  const secondaryRollbackDirectory = path.join(userData, 'rollback-backups', 'old-target-before')
  fs.mkdirSync(options.dataRollbackDirectory, { recursive: true })
  fs.mkdirSync(secondaryRollbackDirectory, { recursive: true })
  createProgramRollbackJournal(journalFile, {
    ...options,
    secondaryDataDirectory,
    secondaryRollbackDirectory,
  })
  markProgramRollbackState(journalFile, 'data-backup-ready')
  markProgramRollbackState(journalFile, 'data-restored')
  markProgramRollbackState(journalFile, 'helper-launched')
  markProgramRollbackState(journalFile, 'program-failed')

  const calls = []
  recoverProgramRollback({
    journalFile,
    expectedConfigFile: options.configFile,
    expectedDataDirectory: options.dataDirectory,
    expectedSecondaryDataDirectory: secondaryDataDirectory,
    currentAppVersion: '0.3.0',
    harnessVersion: '0.1.1-rc.2',
    recoveryRollbackDirectory: path.join(userData, 'rollback-backups', 'recovery'),
    restoreDataBackup: (restoreOptions) => calls.push(restoreOptions),
  })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].backupDirectory, secondaryRollbackDirectory)
  assert.equal(calls[0].dataDirectory, secondaryDataDirectory)
  assert.equal(calls[1].backupDirectory, options.dataRollbackDirectory)
  assert.equal(calls[1].dataDirectory, options.dataDirectory)
})

test('does not partially recover when a declared old-target backup is missing', (t) => {
  const { userData, journalFile, options } = fixture(t)
  fs.mkdirSync(options.dataRollbackDirectory, { recursive: true })
  createProgramRollbackJournal(journalFile, {
    ...options,
    secondaryDataDirectory: path.join(userData, 'old-custom-harness'),
    secondaryRollbackDirectory: path.join(userData, 'rollback-backups', 'missing-old-target'),
  })
  markProgramRollbackState(journalFile, 'data-backup-ready')
  markProgramRollbackState(journalFile, 'data-restored')
  markProgramRollbackState(journalFile, 'helper-launched')
  markProgramRollbackState(journalFile, 'program-failed')

  assert.throws(() => recoverProgramRollback({
    journalFile,
    expectedConfigFile: options.configFile,
    expectedDataDirectory: options.dataDirectory,
    expectedSecondaryDataDirectory: path.join(userData, 'old-custom-harness'),
    currentAppVersion: '0.3.0',
    harnessVersion: '0.1.1-rc.2',
    recoveryRollbackDirectory: path.join(userData, 'rollback-backups', 'recovery'),
    restoreDataBackup: () => assert.fail('no restore may start with a missing secondary backup'),
  }), /原数据目标/u)
})

test('rejects a journal redirected to another local user directory before restoring', (t) => {
  const { userData, journalFile, options } = fixture(t)
  const unrelated = path.join(userData, 'unrelated-user-files')
  fs.mkdirSync(options.dataRollbackDirectory, { recursive: true })
  fs.mkdirSync(unrelated, { recursive: true })
  const sentinel = path.join(unrelated, 'sentinel.txt')
  fs.writeFileSync(sentinel, 'must-survive')
  createProgramRollbackJournal(journalFile, options)
  markProgramRollbackState(journalFile, 'data-backup-ready')
  const document = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
  document.dataDirectory = unrelated
  fs.writeFileSync(journalFile, JSON.stringify(document))

  assert.throws(() => recoverProgramRollback({
    journalFile,
    expectedConfigFile: options.configFile,
    expectedDataDirectory: options.dataDirectory,
    currentAppVersion: '0.3.0',
    recoveryRollbackDirectory: path.join(userData, 'rollback-backups', 'recovery'),
    restoreDataBackup: () => assert.fail('a mismatched target must fail before restore'),
  }), /可信快照/u)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must-survive')
})

test('closes a failed helper transaction that never changed app data', (t) => {
  const { userData, journalFile, options } = fixture(t, {
    dataChanged: false,
    dataRollbackDirectory: undefined,
  })
  createProgramRollbackJournal(journalFile, options)
  markProgramRollbackState(journalFile, 'data-unchanged')
  markProgramRollbackState(journalFile, 'helper-launched')
  markProgramRollbackState(journalFile, 'program-failed')
  const result = recoverProgramRollback({
    journalFile,
    expectedConfigFile: options.configFile,
    expectedDataDirectory: options.dataDirectory,
    currentAppVersion: '0.3.0',
    recoveryRollbackDirectory: path.join(userData, 'rollback-backups', 'unused'),
    restoreDataBackup: () => assert.fail('no data restore should run'),
  })
  assert.equal(result.action, 'no-data-change')
  assert.equal(readProgramRollbackJournal(journalFile).state, 'data-recovered')
})

test('recovers data when the helper handoff was interrupted before it reported failure', (t) => {
  const { userData, journalFile, options } = fixture(t)
  fs.mkdirSync(options.dataRollbackDirectory, { recursive: true })
  createProgramRollbackJournal(journalFile, options)
  markProgramRollbackState(journalFile, 'data-backup-ready')
  markProgramRollbackState(journalFile, 'data-restored')
  markProgramRollbackState(journalFile, 'helper-launched')
  let restored = false
  recoverProgramRollback({
    journalFile,
    expectedConfigFile: options.configFile,
    expectedDataDirectory: options.dataDirectory,
    currentAppVersion: '0.3.0',
    recoveryRollbackDirectory: path.join(userData, 'rollback-backups', 'interrupted'),
    restoreDataBackup: () => { restored = true },
  })
  assert.equal(restored, true)
  assert.equal(readProgramRollbackJournal(journalFile).state, 'data-recovered')
})

test('preserves old-version data only after the helper handoff', (t) => {
  const { userData, journalFile, options } = fixture(t)
  createProgramRollbackJournal(journalFile, options)
  fs.mkdirSync(options.dataRollbackDirectory, { recursive: true })
  markProgramRollbackState(journalFile, 'data-backup-ready')
  markProgramRollbackState(journalFile, 'data-restored')
  markProgramRollbackState(journalFile, 'helper-launched')
  const result = recoverProgramRollback({
    journalFile,
    expectedConfigFile: options.configFile,
    currentAppVersion: '0.2.0',
    recoveryRollbackDirectory: path.join(userData, 'rollback-backups', 'unused'),
    restoreDataBackup: () => assert.fail('old version data must remain active'),
  })
  assert.equal(result.action, 'program-restored')
  assert.equal(readProgramRollbackJournal(journalFile).state, 'program-restored')
})

test('blocks an unknown executable version while a rollback is active', (t) => {
  const { userData, journalFile, options } = fixture(t)
  createProgramRollbackJournal(journalFile, options)
  assert.throws(() => recoverProgramRollback({
    journalFile,
    expectedConfigFile: options.configFile,
    currentAppVersion: '9.9.9',
    recoveryRollbackDirectory: path.join(userData, 'rollback-backups', 'unused'),
    restoreDataBackup: () => {},
  }), (error) => error.code === 'PROGRAM_ROLLBACK_VERSION_MISMATCH')
})

test('treats a prepared transaction without its planned backup as unchanged', (t) => {
  const { userData, journalFile, options } = fixture(t)
  createProgramRollbackJournal(journalFile, options)
  const result = recoverProgramRollback({
    journalFile,
    expectedConfigFile: options.configFile,
    currentAppVersion: '0.3.0',
    recoveryRollbackDirectory: path.join(userData, 'rollback-backups', 'unused'),
    restoreDataBackup: () => assert.fail('restore cannot start before the backup exists'),
  })
  assert.equal(result.action, 'no-data-change')
  assert.equal(readProgramRollbackJournal(journalFile).state, 'data-recovered')
})

test('never restores a leftover snapshot path while the journal is still prepared', (t) => {
  const { userData, journalFile, options } = fixture(t)
  createProgramRollbackJournal(journalFile, options)
  fs.mkdirSync(options.dataRollbackDirectory, { recursive: true })
  fs.writeFileSync(path.join(options.dataRollbackDirectory, 'partial-file'), 'incomplete')
  const result = recoverProgramRollback({
    journalFile,
    expectedConfigFile: options.configFile,
    currentAppVersion: '0.3.0',
    recoveryRollbackDirectory: path.join(userData, 'rollback-backups', 'unused'),
    restoreDataBackup: () => assert.fail('prepared data was never swapped and must not be restored'),
  })
  assert.equal(result.action, 'no-data-change')
  assert.equal(readProgramRollbackJournal(journalFile).state, 'data-recovered')
})

test('rejects unguarded program and rollback paths', (t) => {
  const { journalFile, options } = fixture(t)
  const wrongRoot = path.join(options.installDirectory, '.dsh-desktop-previous')
  fs.mkdirSync(wrongRoot, { recursive: true })
  fs.writeFileSync(path.join(wrongRoot, 'restore-previous-install.ps1'), '# test')
  assert.throws(() => createProgramRollbackJournal(journalFile, {
    ...options,
    programRoot: wrongRoot,
    script: path.join(wrongRoot, 'restore-previous-install.ps1'),
  }), /路径关系/u)
  assert.throws(() => createProgramRollbackJournal(journalFile, {
    ...options,
    dataRollbackDirectory: path.join(options.installDirectory, 'outside'),
  }), /路径关系/u)
  assert.throws(() => createProgramRollbackJournal(journalFile, {
    ...options,
    secondaryDataDirectory: path.join(options.userData || path.dirname(options.configFile), 'other'),
    secondaryRollbackDirectory: path.join(options.installDirectory, 'outside-secondary'),
  }), /路径关系/u)
  const protectedRoot = process.env.WINDIR || process.env.SystemRoot
  if (protectedRoot) {
    assert.throws(() => createProgramRollbackJournal(journalFile, {
      ...options,
      secondaryDataDirectory: path.join(protectedRoot, 'Temp', 'dsh-rollback-target'),
      secondaryRollbackDirectory: path.join(path.dirname(options.configFile), 'rollback-backups', 'secondary'),
    }), /受保护目录/u)
  }
})

test('reads a UTF-8 BOM journal and binds recovery to the expected config', (t) => {
  const { userData, journalFile, options } = fixture(t)
  createProgramRollbackJournal(journalFile, options)
  const source = fs.readFileSync(journalFile)
  fs.writeFileSync(journalFile, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), source]))
  assert.equal(readProgramRollbackJournal(journalFile).state, 'prepared')
  assert.throws(() => recoverProgramRollback({
    journalFile,
    expectedConfigFile: path.join(userData, 'other-config.json'),
    currentAppVersion: '0.3.0',
    recoveryRollbackDirectory: path.join(userData, 'rollback-backups', 'unused'),
    restoreDataBackup: () => {},
  }), /不匹配/u)
})
