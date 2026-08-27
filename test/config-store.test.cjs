const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { CONFIG_VERSION, ConfigStore, assertApiKey, assertTheme } = require('../src/config-store.cjs')

const NOW = new Date('2026-08-26T01:00:00.000Z')

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-config-'))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace)
  const codec = options.codec || {
    encrypt(value) {
      return Buffer.from(`protected:${value}`, 'utf8').toString('base64')
    },
    decrypt(value) {
      return Buffer.from(value, 'base64').toString('utf8').replace(/^protected:/u, '')
    },
  }
  return {
    root,
    workspace,
    filename: path.join(root, 'config.json'),
    store: new ConfigStore(path.join(root, 'config.json'), codec, { now: () => NOW }),
  }
}

function expectedPublic(overrides = {}) {
  return {
    configured: false,
    hasApiKey: false,
    workspace: '',
    theme: 'system',
    checkForUpdates: true,
    dataDirectory: '',
    permissionMode: 'workspace-write',
    workMode: 'normal',
    recentWorkspaces: [],
    startAtLogin: false,
    minimizeToTray: false,
    notifications: true,
    autoDownloadUpdates: true,
    updateChannel: 'stable',
    diagnosticMode: false,
    crashRecovery: true,
    pluginSafeMode: false,
    ...overrides,
  }
}

test('stores only an encrypted API key and restores runtime settings', (t) => {
  const { root, workspace, store } = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  store.save({ workspace, apiKey: 'sk-test-secret-value' })
  const persisted = fs.readFileSync(path.join(root, 'config.json'), 'utf8')

  assert.equal(persisted.includes('sk-test-secret-value'), false)
  assert.deepEqual(store.getPublicSettings(), expectedPublic({
    configured: true,
    hasApiKey: true,
    workspace,
    recentWorkspaces: [{ path: workspace, lastUsedAt: NOW.toISOString() }],
  }))
  assert.deepEqual(store.getRuntimeSettings(), {
    workspace,
    apiKey: 'sk-test-secret-value',
    dataDirectory: '',
    permissionMode: 'workspace-write',
    workMode: 'normal',
    diagnosticMode: false,
    crashRecovery: true,
  })
})

test('a new key replaces the old ciphertext, blank input never clears it, and clear is explicit', (t) => {
  const { root, workspace, filename, store } = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  store.save({ workspace, apiKey: 'sk-old-secret-value' })
  const oldCiphertext = JSON.parse(fs.readFileSync(filename, 'utf8')).encryptedApiKey
  store.saveApiKey('sk-new-secret-value')
  const newCiphertext = JSON.parse(fs.readFileSync(filename, 'utf8')).encryptedApiKey

  assert.notEqual(newCiphertext, oldCiphertext)
  assert.equal(store.getDecryptedApiKey(), 'sk-new-secret-value')
  assert.throws(() => store.saveApiKey(''), /请输入/u)
  assert.equal(store.getDecryptedApiKey(), 'sk-new-secret-value')

  assert.equal(store.clearApiKey().hasApiKey, false)
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).encryptedApiKey, undefined)
  assert.throws(() => store.getDecryptedApiKey(), (error) => error.code === 'API_KEY_MISSING')
})

test('decrypts a saved key without requiring a workspace and reports DPAPI failure', (t) => {
  const first = fixture()
  t.after(() => fs.rmSync(first.root, { recursive: true, force: true }))
  first.store.saveApiKey('sk-standalone-secret')
  assert.equal(first.store.getDecryptedApiKey(), 'sk-standalone-secret')

  const second = fixture({
    codec: {
      encrypt: () => 'ciphertext',
      decrypt: () => { throw new Error('DPAPI unavailable') },
    },
  })
  t.after(() => fs.rmSync(second.root, { recursive: true, force: true }))
  second.store.saveApiKey('sk-unreadable-secret')
  assert.throws(
    () => second.store.getDecryptedApiKey(),
    (error) => error.code === 'KEY_DECRYPT_FAILED' && !error.message.includes('sk-unreadable'),
  )
})

test('keeps the encrypted key when only the workspace changes', (t) => {
  const { root, workspace, store } = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const secondWorkspace = path.join(root, 'workspace-two')
  fs.mkdirSync(secondWorkspace)

  store.save({ workspace, apiKey: 'sk-test-secret-value' })
  store.save({ workspace: secondWorkspace })

  assert.equal(store.getRuntimeSettings().workspace, secondWorkspace)
  assert.equal(store.getRuntimeSettings().apiKey, 'sk-test-secret-value')
  assert.deepEqual(store.getRecentWorkspaces({ existingOnly: false }).map((entry) => entry.path), [
    secondWorkspace,
    workspace,
  ])
})

test('persists all preferences without changing the encrypted key or workspace', (t) => {
  const { root, workspace, filename, store } = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataDirectory = path.join(root, 'harness-data')

  store.save({ workspace, apiKey: 'sk-test-secret-value' })
  const before = JSON.parse(fs.readFileSync(filename, 'utf8'))
  store.savePreferences({
    theme: 'dark',
    checkForUpdates: false,
    dataDirectory,
    permissionMode: 'full-access',
    workMode: 'plan',
    startAtLogin: true,
    minimizeToTray: true,
    notifications: false,
    autoDownloadUpdates: false,
    updateChannel: 'preview',
    diagnosticMode: true,
    crashRecovery: false,
    pluginSafeMode: true,
  })
  const after = JSON.parse(fs.readFileSync(filename, 'utf8'))

  assert.equal(after.encryptedApiKey, before.encryptedApiKey)
  assert.equal(after.workspace, workspace)
  assert.deepEqual(store.getPublicSettings(), expectedPublic({
    configured: true,
    hasApiKey: true,
    workspace,
    theme: 'dark',
    checkForUpdates: false,
    dataDirectory,
    permissionMode: 'full-access',
    workMode: 'plan',
    recentWorkspaces: [{ path: workspace, lastUsedAt: NOW.toISOString() }],
    startAtLogin: true,
    minimizeToTray: true,
    notifications: false,
    autoDownloadUpdates: false,
    updateChannel: 'preview',
    diagnosticMode: true,
    crashRecovery: false,
    pluginSafeMode: true,
  }))
})

test('saves connection and runtime settings atomically', (t) => {
  const { root, workspace, filename, store } = fixture()
  const dataDirectory = path.join(root, 'custom-data')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  store.save({ workspace, apiKey: 'sk-original-secret' })
  const before = fs.readFileSync(filename, 'utf8')

  assert.throws(() => store.save({
    workspace,
    apiKey: 'sk-should-not-be-saved',
    dataDirectory,
    permissionMode: 'invalid-mode',
    workMode: 'plan',
  }), /权限模式/u)
  assert.equal(fs.readFileSync(filename, 'utf8'), before)
  assert.equal(store.getDecryptedApiKey(), 'sk-original-secret')

  const saved = store.save({
    workspace,
    apiKey: 'sk-replacement-secret',
    dataDirectory,
    permissionMode: 'danger-full-access',
    workMode: 'plan',
  })
  assert.equal(saved.dataDirectory, dataDirectory)
  assert.equal(saved.permissionMode, 'full-access')
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).permissionMode, 'danger-full-access')
  assert.equal(saved.workMode, 'plan')
  assert.equal(store.getDecryptedApiKey(), 'sk-replacement-secret')
})

test('can save preferences before first-run connection setup', (t) => {
  const { root, store } = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  store.savePreferences({ theme: 'light', permissionMode: 'read-only' })

  assert.deepEqual(store.getPublicSettings(), expectedPublic({
    theme: 'light',
    permissionMode: 'read-only',
  }))
})

test('migrates v1 through every step after taking a byte-for-byte backup', (t) => {
  const { root, workspace, filename, store } = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const original = `${JSON.stringify({
    version: 1,
    workspace,
    encryptedApiKey: 'opaque-dpapi-ciphertext',
    theme: 'dark',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }, null, 2)}\n`
  fs.writeFileSync(filename, original, 'utf8')

  const settings = store.getPublicSettings()
  const migrated = JSON.parse(fs.readFileSync(filename, 'utf8'))

  assert.equal(migrated.version, CONFIG_VERSION)
  assert.equal(migrated.encryptedApiKey, 'opaque-dpapi-ciphertext')
  assert.equal(settings.permissionMode, 'workspace-write')
  assert.equal(settings.crashRecovery, true)
  assert.ok(store.lastMigrationBackup)
  assert.equal(fs.readFileSync(store.lastMigrationBackup, 'utf8'), original)
})

test('rejects malformed API keys and non-directory workspaces', (t) => {
  const { root, store } = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.throws(() => assertApiKey('not-a-key'), /sk-/u)
  assert.throws(() => assertTheme('midnight'), /主题/u)
  assert.throws(
    () => store.save({ workspace: path.join(root, 'missing'), apiKey: 'sk-test-secret-value' }),
    /不存在/u,
  )
})

test('quarantines a damaged document so setup can recover', (t) => {
  const { root, filename, store } = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(filename, '{not valid json', 'utf8')

  assert.throws(() => store.getPublicSettings(), /设置/u)
  const backup = store.quarantineInvalidDocument()

  assert.equal(fs.existsSync(filename), false)
  assert.equal(fs.readFileSync(backup, 'utf8'), '{not valid json')
  assert.deepEqual(store.getPublicSettings(), expectedPublic())
})

test('drops unknown legacy plaintext credential fields instead of preserving them', (t) => {
  const { root, workspace, filename, store } = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(filename, JSON.stringify({
    version: CONFIG_VERSION,
    workspace,
    apiKey: 'sk-OLD-PLAINTEXT',
    accessToken: 'legacy-token',
  }))

  store.saveApiKey('sk-new-protected-value')
  const persisted = fs.readFileSync(filename, 'utf8')

  assert.equal(persisted.includes('sk-OLD-PLAINTEXT'), false)
  assert.equal(persisted.includes('legacy-token'), false)
  assert.equal(store.getDecryptedApiKey(), 'sk-new-protected-value')
})
