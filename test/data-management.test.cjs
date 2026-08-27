'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  RESTORE_JOURNAL_VERSION,
  createDataBackup,
  getRestoreJournalPath,
  inventory,
  migrateDataDirectory,
  readBackupManifest,
  recoverInterruptedRestore,
  readBackupDataSettings,
  restoreDataBackup,
} = require('../src/data-management.cjs')

test('backs up config and Harness data, verifies integrity, and restores with rollback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-data-backup-'))
  const configFile = path.join(root, 'live', 'desktop-config.json')
  const dataDirectory = path.join(root, 'live', 'harness')
  const backupDirectory = path.join(root, 'backup')
  const rollbackDirectory = path.join(root, 'rollback')
  fs.mkdirSync(path.join(dataDirectory, 'nested'), { recursive: true })
  fs.writeFileSync(configFile, '{"version":3,"workspace":"","encryptedApiKey":"dpapi-ciphertext"}\n')
  fs.writeFileSync(path.join(dataDirectory, 'nested', 'session.db'), 'original-session')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const created = createDataBackup({
    destination: backupDirectory,
    configFile,
    dataDirectory,
    appVersion: '0.3.0',
    harnessVersion: '0.1.1-rc.2',
    now: new Date('2026-08-26T00:00:00.000Z'),
  })
  assert.equal(created.manifest.hasConfig, true)
  assert.equal(created.manifest.hasData, true)
  assert.equal(readBackupManifest(backupDirectory).manifest.files.length, 2)

  fs.writeFileSync(configFile, '{"version":3,"workspace":"","changed":true}\n')
  fs.writeFileSync(path.join(dataDirectory, 'nested', 'session.db'), 'changed-session')
  const restored = restoreDataBackup({
    backupDirectory,
    configFile,
    dataDirectory,
    rollbackDirectory,
  })

  assert.equal(restored.requiresRestart, true)
  assert.match(fs.readFileSync(configFile, 'utf8'), /dpapi-ciphertext/u)
  assert.equal(fs.readFileSync(path.join(dataDirectory, 'nested', 'session.db'), 'utf8'), 'original-session')
  assert.match(fs.readFileSync(path.join(rollbackDirectory, 'desktop-config.json'), 'utf8'), /changed/u)
})

test('reports a durable rollback backup before replacing restored targets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restore-callback-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const configFile = path.join(root, 'current', 'desktop-config.json')
  const dataDirectory = path.join(root, 'current', 'harness')
  const source = path.join(root, 'source')
  const rollbackDirectory = path.join(root, 'rollback')
  fs.mkdirSync(dataDirectory, { recursive: true })
  fs.writeFileSync(configFile, JSON.stringify({ version: 3, workspace: root }))
  fs.writeFileSync(path.join(dataDirectory, 'value.txt'), 'current')
  createDataBackup({
    destination: source,
    configFile,
    dataDirectory,
    appVersion: '0.2.0',
    harnessVersion: '0.1.0',
  })
  fs.writeFileSync(path.join(dataDirectory, 'value.txt'), 'changed')
  let observed = false

  restoreDataBackup({
    backupDirectory: source,
    configFile,
    dataDirectory,
    rollbackDirectory,
    appVersion: '0.3.0',
    harnessVersion: '0.1.1',
    onRollbackCreated: ({ backupDirectory }) => {
      observed = true
      assert.equal(backupDirectory, rollbackDirectory)
      assert.equal(fs.readFileSync(path.join(dataDirectory, 'value.txt'), 'utf8'), 'changed')
      assert.equal(fs.readFileSync(path.join(rollbackDirectory, 'harness-data', 'value.txt'), 'utf8'), 'changed')
    },
  })
  assert.equal(observed, true)
})

test('reads the original data target without migrating or rewriting backup config', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-target-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const configFile = path.join(root, 'desktop-config.json')
  const dataDirectory = path.join(root, 'harness')
  const customData = path.join(root, 'custom-harness')
  const backup = path.join(root, 'backup')
  fs.mkdirSync(dataDirectory)
  const sourceDocument = { version: 2, workspace: root, dataDirectory: customData }
  fs.writeFileSync(configFile, JSON.stringify(sourceDocument))
  createDataBackup({ destination: backup, configFile, dataDirectory })

  const settings = readBackupDataSettings(backup, path.join(root, 'default-harness'))
  assert.equal(settings.configVersion, 2)
  assert.equal(settings.dataDirectory, customData)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup, 'desktop-config.json'), 'utf8')), sourceDocument)
})

test('rejects a backup after any payload file is modified', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-data-integrity-'))
  const configFile = path.join(root, 'config.json')
  const backupDirectory = path.join(root, 'backup')
  fs.writeFileSync(configFile, '{"version":3,"workspace":""}\n')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  createDataBackup({ destination: backupDirectory, configFile })
  fs.appendFileSync(path.join(backupDirectory, 'desktop-config.json'), 'tampered')

  assert.throws(() => readBackupManifest(backupDirectory), /完整性/u)
})

test('does not allow a backup to be created inside its data source', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-data-overlap-'))
  const dataDirectory = path.join(root, 'data')
  fs.mkdirSync(dataDirectory)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.throws(
    () => createDataBackup({ destination: path.join(dataDirectory, 'backup'), dataDirectory }),
    /不能位于/u,
  )
})

test('migrates a data directory to a new verified target and retains the source', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-data-migrate-'))
  const source = path.join(root, 'source')
  const destination = path.join(root, 'destination')
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(source, 'session.db'), 'database')
  fs.writeFileSync(path.join(source, 'nested', 'state.json'), '{"ready":true}')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const result = migrateDataDirectory(source, destination)

  assert.equal(result.strategy, 'reject')
  assert.equal(result.filesCopied, 2)
  assert.equal(result.sourceRetained, true)
  assert.equal(fs.readFileSync(path.join(destination, 'session.db'), 'utf8'), 'database')
  assert.equal(fs.readFileSync(path.join(source, 'session.db'), 'utf8'), 'database')
  assert.throws(
    () => migrateDataDirectory(source, destination),
    (error) => error.code === 'DATA_MIGRATION_FAILED' && /已存在/u.test(error.message),
  )
})

test('merge only adds missing identical-safe files and rejects conflicts without changes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-data-merge-'))
  const source = path.join(root, 'source')
  const destination = path.join(root, 'destination')
  fs.mkdirSync(source)
  fs.mkdirSync(destination)
  fs.writeFileSync(path.join(source, 'same.db'), 'same')
  fs.writeFileSync(path.join(source, 'new.db'), 'new')
  fs.writeFileSync(path.join(destination, 'same.db'), 'same')
  fs.writeFileSync(path.join(destination, 'unrelated.db'), 'keep')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const result = migrateDataDirectory(source, destination, { strategy: 'merge' })
  assert.equal(result.filesCopied, 1)
  assert.equal(fs.readFileSync(path.join(destination, 'new.db'), 'utf8'), 'new')
  assert.equal(fs.readFileSync(path.join(destination, 'unrelated.db'), 'utf8'), 'keep')

  fs.writeFileSync(path.join(source, 'conflict.db'), 'source-version')
  fs.writeFileSync(path.join(destination, 'conflict.db'), 'destination-version')
  const before = fs.readdirSync(destination).sort()
  assert.throws(
    () => migrateDataDirectory(source, destination, { strategy: 'merge' }),
    (error) => error.code === 'DATA_MIGRATION_FAILED' && /内容不同/u.test(error.message),
  )
  assert.deepEqual(fs.readdirSync(destination).sort(), before)
  assert.equal(fs.readFileSync(path.join(destination, 'conflict.db'), 'utf8'), 'destination-version')
})

test('rejects data-directory migrations in either containment direction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-data-containment-'))
  const source = path.join(root, 'source')
  fs.mkdirSync(source)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.throws(
    () => migrateDataDirectory(source, path.join(source, 'child')),
    /互相包含/u,
  )
  assert.throws(
    () => migrateDataDirectory(source, root, { strategy: 'merge' }),
    /互相包含/u,
  )
})

test('rejects a self-consistent backup whose Harness payload is a file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-data-type-'))
  const source = path.join(root, 'source')
  const backup = path.join(root, 'backup')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'session.db'), 'data')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  createDataBackup({ destination: backup, dataDirectory: source })
  fs.rmSync(path.join(backup, 'harness-data'), { recursive: true, force: true })
  fs.writeFileSync(path.join(backup, 'harness-data'), 'not-a-directory')
  const manifestFile = path.join(backup, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  manifest.files = inventory(backup).filter((entry) => entry.path !== 'manifest.json')
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

  assert.throws(() => readBackupManifest(backup), /不是文件夹/u)
})

test('uses a durable journal to roll back an interrupted two-target restore', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restore-journal-'))
  const config = path.join(root, 'config.json')
  const data = path.join(root, 'data')
  const token = '123-456'
  const journalFile = getRestoreJournalPath(config)
  fs.writeFileSync(config, 'new-config')
  fs.writeFileSync(`${config}.restore-previous-${token}`, 'old-config')
  fs.mkdirSync(data)
  fs.writeFileSync(path.join(data, 'session.db'), 'old-data')
  fs.mkdirSync(`${data}.restore-stage-${token}`)
  fs.writeFileSync(path.join(`${data}.restore-stage-${token}`, 'session.db'), 'new-data')
  fs.writeFileSync(journalFile, JSON.stringify({
    version: RESTORE_JOURNAL_VERSION,
    token,
    phase: 'swapping',
    configFile: config,
    dataDirectory: data,
    entries: [
      {
        kind: 'config',
        target: config,
        previous: `${config}.restore-previous-${token}`,
        staged: `${config}.restore-stage-${token}`,
        hadPrevious: true,
        hasReplacement: true,
        state: 'target-installed',
      },
      {
        kind: 'data',
        target: data,
        previous: `${data}.restore-previous-${token}`,
        staged: `${data}.restore-stage-${token}`,
        hadPrevious: true,
        hasReplacement: true,
        state: 'pending',
      },
    ],
  }))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const result = recoverInterruptedRestore(journalFile, {
    configFile: config,
    dataDirectory: data,
  })

  assert.deepEqual(result, { recovered: true, action: 'rollback' })
  assert.equal(fs.readFileSync(config, 'utf8'), 'old-config')
  assert.equal(fs.readFileSync(path.join(data, 'session.db'), 'utf8'), 'old-data')
  assert.equal(fs.existsSync(`${data}.restore-stage-${token}`), false)
  assert.equal(fs.existsSync(journalFile), false)
})

test('removes a committed journal before best-effort deletion of the original config', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restore-commit-cleanup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const config = path.join(root, 'desktop-config.json')
  const data = path.join(root, 'data')
  const token = '321-654'
  const previousConfig = `${config}.restore-previous-${token}`
  const previousData = `${data}.restore-previous-${token}`
  const journalFile = getRestoreJournalPath(config)
  fs.writeFileSync(config, JSON.stringify({ version: 3, workspace: '', dataDirectory: data }))
  fs.writeFileSync(previousConfig, JSON.stringify({ version: 3, workspace: '', dataDirectory: data }))
  fs.mkdirSync(data)
  fs.mkdirSync(previousData)
  fs.writeFileSync(journalFile, JSON.stringify({
    version: RESTORE_JOURNAL_VERSION,
    token,
    phase: 'committed',
    configFile: config,
    dataDirectory: data,
    entries: [
      {
        kind: 'config', target: config, previous: previousConfig,
        staged: `${config}.restore-stage-${token}`, hadPrevious: true,
        hasReplacement: true, state: 'target-installed',
      },
      {
        kind: 'data', target: data, previous: previousData,
        staged: `${data}.restore-stage-${token}`, hadPrevious: true,
        hasReplacement: true, state: 'target-installed',
      },
    ],
  }))

  const originalRmSync = fs.rmSync
  const rmMock = t.mock.method(fs, 'rmSync', (target, options) => {
    if (path.resolve(target) === path.resolve(previousConfig)) throw new Error('simulated post-commit lock')
    return originalRmSync(target, options)
  })
  let result
  try {
    result = recoverInterruptedRestore(journalFile, { configFile: config, dataDirectory: data })
  } finally {
    rmMock.mock.restore()
  }

  assert.deepEqual(result, { recovered: true, action: 'commit-cleanup' })
  assert.equal(fs.existsSync(journalFile), false)
  assert.equal(fs.existsSync(previousConfig), true)
  assert.equal(fs.existsSync(previousData), false)
})

test('rejects a restore journal redirected to an arbitrary target without deleting its sentinel', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restore-journal-tamper-'))
  const config = path.join(root, 'desktop-config.json')
  const data = path.join(root, 'data')
  const victim = path.join(root, 'unrelated', 'sentinel.txt')
  const token = '200-300'
  fs.mkdirSync(path.dirname(victim), { recursive: true })
  fs.mkdirSync(data)
  fs.writeFileSync(config, 'current-config')
  fs.writeFileSync(victim, 'must-survive')
  const journalFile = getRestoreJournalPath(config)
  const document = {
    version: RESTORE_JOURNAL_VERSION,
    token,
    phase: 'swapping',
    configFile: victim,
    dataDirectory: data,
    entries: [
      {
        kind: 'config',
        target: victim,
        previous: `${victim}.restore-previous-${token}`,
        staged: `${victim}.restore-stage-${token}`,
        hadPrevious: false,
        hasReplacement: false,
        state: 'target-installed',
      },
      {
        kind: 'data',
        target: data,
        previous: `${data}.restore-previous-${token}`,
        staged: `${data}.restore-stage-${token}`,
        hadPrevious: false,
        hasReplacement: false,
        state: 'rolled-back',
      },
    ],
  }
  fs.writeFileSync(journalFile, JSON.stringify(document))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.throws(
    () => recoverInterruptedRestore(journalFile, { configFile: config, dataDirectory: data }),
    (error) => error.code === 'DATA_RESTORE_FAILED' && /绑定/u.test(error.message),
  )
  assert.equal(fs.readFileSync(victim, 'utf8'), 'must-survive')
  assert.equal(fs.existsSync(journalFile), true)

  document.configFile = config
  fs.writeFileSync(journalFile, JSON.stringify(document))
  assert.throws(
    () => recoverInterruptedRestore(journalFile, { configFile: config, dataDirectory: data }),
    (error) => error.code === 'DATA_RESTORE_FAILED' && /预期目标/u.test(error.message),
  )
  assert.equal(fs.readFileSync(victim, 'utf8'), 'must-survive')
  assert.equal(fs.existsSync(journalFile), true)
})

test('rejects a restore journal bound to a drive root without deleting a sentinel', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restore-journal-root-'))
  const config = path.join(root, 'desktop-config.json')
  const sentinel = path.join(root, 'sentinel.txt')
  const driveRoot = path.parse(root).root
  const token = '201-301'
  fs.writeFileSync(config, 'current-config')
  fs.writeFileSync(sentinel, 'must-survive')
  const journalFile = getRestoreJournalPath(config)
  fs.writeFileSync(journalFile, JSON.stringify({
    version: RESTORE_JOURNAL_VERSION,
    token,
    phase: 'committed',
    configFile: config,
    dataDirectory: driveRoot,
    entries: [
      {
        kind: 'config',
        target: config,
        previous: `${config}.restore-previous-${token}`,
        staged: `${config}.restore-stage-${token}`,
        hadPrevious: true,
        hasReplacement: true,
        state: 'target-installed',
      },
      {
        kind: 'data',
        target: driveRoot,
        previous: `${driveRoot}.restore-previous-${token}`,
        staged: `${driveRoot}.restore-stage-${token}`,
        hadPrevious: true,
        hasReplacement: true,
        state: 'target-installed',
      },
    ],
  }))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.throws(
    () => recoverInterruptedRestore(journalFile, { configFile: config, dataDirectory: driveRoot }),
    (error) => error.code === 'DATA_RESTORE_FAILED' && /根目录/u.test(error.message),
  )
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must-survive')
  assert.equal(fs.existsSync(journalFile), true)
})

test('rejects a restore target through a junction without deleting its sentinel', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restore-journal-junction-'))
  const config = path.join(root, 'desktop-config.json')
  const realData = path.join(root, 'real-data')
  const linkedData = path.join(root, 'linked-data')
  const sentinel = path.join(realData, 'sentinel.txt')
  const token = '202-302'
  fs.mkdirSync(realData)
  fs.writeFileSync(config, 'current-config')
  fs.writeFileSync(sentinel, 'must-survive')
  try {
    fs.symlinkSync(realData, linkedData, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true })
    t.skip(`links are unavailable: ${error.code}`)
    return
  }
  const journalFile = getRestoreJournalPath(config)
  fs.writeFileSync(journalFile, JSON.stringify({
    version: RESTORE_JOURNAL_VERSION,
    token,
    phase: 'committed',
    configFile: config,
    dataDirectory: linkedData,
    entries: [
      {
        kind: 'config',
        target: config,
        previous: `${config}.restore-previous-${token}`,
        staged: `${config}.restore-stage-${token}`,
        hadPrevious: true,
        hasReplacement: true,
        state: 'target-installed',
      },
      {
        kind: 'data',
        target: linkedData,
        previous: `${linkedData}.restore-previous-${token}`,
        staged: `${linkedData}.restore-stage-${token}`,
        hadPrevious: true,
        hasReplacement: true,
        state: 'target-installed',
      },
    ],
  }))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.throws(
    () => recoverInterruptedRestore(journalFile, { configFile: config, dataDirectory: linkedData }),
    (error) => error.code === 'DATA_RESTORE_FAILED' && /链接|联接点/u.test(error.message),
  )
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must-survive')
  assert.equal(fs.existsSync(linkedData), true)
  assert.equal(fs.existsSync(journalFile), true)
})

test('rejects network and Windows protected restore targets without touching local data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restore-journal-protected-'))
  const config = path.join(root, 'desktop-config.json')
  const sentinel = path.join(root, 'sentinel.txt')
  const journalFile = getRestoreJournalPath(config)
  fs.writeFileSync(config, 'current-config')
  fs.writeFileSync(sentinel, 'must-survive')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const cases = [
    {
      label: 'network',
      target: process.platform === 'win32' ? '\\\\server\\share\\dsh-data' : '//server/share/dsh-data',
      message: /网络路径/u,
    },
  ]
  const protectedTarget = process.env.WINDIR || process.env.SystemRoot || process.env.ProgramFiles
  if (protectedTarget) {
    cases.push({ label: 'protected', target: protectedTarget, message: /受保护目录/u })
  }

  for (const [index, item] of cases.entries()) {
    const token = `30${index}-40${index}`
    fs.writeFileSync(journalFile, JSON.stringify({
      version: RESTORE_JOURNAL_VERSION,
      token,
      phase: 'committed',
      configFile: config,
      dataDirectory: item.target,
      entries: [
        {
          kind: 'config',
          target: config,
          previous: `${config}.restore-previous-${token}`,
          staged: `${config}.restore-stage-${token}`,
          hadPrevious: true,
          hasReplacement: true,
          state: 'target-installed',
        },
        {
          kind: 'data',
          target: item.target,
          previous: `${item.target}.restore-previous-${token}`,
          staged: `${item.target}.restore-stage-${token}`,
          hadPrevious: true,
          hasReplacement: true,
          state: 'target-installed',
        },
      ],
    }))
    assert.throws(
      () => recoverInterruptedRestore(journalFile, { configFile: config, dataDirectory: item.target }),
      (error) => error.code === 'DATA_RESTORE_FAILED' && item.message.test(error.message),
      item.label,
    )
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must-survive')
    assert.equal(fs.existsSync(journalFile), true)
  }
})

test('resolves a junction parent before checking migration containment', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-data-junction-'))
  const source = path.join(root, 'source')
  const junction = path.join(root, 'junction')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'session.db'), 'data')
  try {
    fs.symlinkSync(source, junction, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true })
    t.skip(`links are unavailable: ${error.code}`)
    return
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.throws(
    () => migrateDataDirectory(source, path.join(junction, 'nested-target')),
    /互相包含/u,
  )
})
