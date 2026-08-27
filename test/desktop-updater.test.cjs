const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  DesktopUpdateManager,
  normalizeFeedUrl,
  resolveUpdateFeed,
} = require('../src/desktop-updater.cjs')

class FakeUpdater extends EventEmitter {
  constructor() {
    super()
    this.feed = null
    this.downloadCalls = 0
    this.installCalls = 0
  }

  setFeedURL(feed) {
    this.feed = feed
  }

  async checkForUpdates() {
    this.emit('update-available', { version: '0.4.0' })
    return { updateInfo: { version: '0.4.0' } }
  }

  async downloadUpdate() {
    this.downloadCalls += 1
    this.emit('download-progress', { percent: 42, transferred: 42, total: 100, bytesPerSecond: 10 })
    this.emit('update-downloaded', { version: '0.4.0' })
  }

  quitAndInstall() {
    this.installCalls += 1
  }
}

test('only accepts HTTPS update feeds', () => {
  assert.equal(normalizeFeedUrl('https://updates.example.com/releases/'), 'https://updates.example.com/releases')
  assert.throws(() => normalizeFeedUrl('http://updates.example.com'), /HTTPS/u)
  assert.throws(() => normalizeFeedUrl('file:///tmp/releases'), /HTTPS/u)
})

test('packaged builds only trust their bundled feed configuration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-feed-'))
  fs.writeFileSync(path.join(root, 'update-feed.json'), JSON.stringify({ url: 'https://updates.example.com' }))
  assert.equal(resolveUpdateFeed({ isPackaged: true, resourcesPath: root, developmentUrl: 'https://evil.example' }).url, 'https://updates.example.com')

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-empty-'))
  assert.equal(resolveUpdateFeed({ isPackaged: true, resourcesPath: empty, developmentUrl: 'https://dev.example' }).url, '')
})

test('reports an unconfigured updater without pretending to check', async () => {
  const manager = new DesktopUpdateManager({ currentVersion: '0.3.0' })
  const state = await manager.check()
  assert.equal(state.status, 'unconfigured')
  assert.equal(state.configured, false)
})

test('uses electron-builder embedded update configuration when present', async () => {
  const updater = new FakeUpdater()
  const manager = new DesktopUpdateManager({
    autoUpdater: updater,
    hasEmbeddedConfig: true,
    currentVersion: '0.3.0',
  })
  assert.equal(manager.getState().configured, true)
  await manager.check()
  assert.equal(manager.getState().availableVersion, '0.4.0')
  assert.equal(updater.feed, null)
})

test('checks, downloads, reports progress, postpones and installs', async () => {
  const updater = new FakeUpdater()
  const manager = new DesktopUpdateManager({
    autoUpdater: updater,
    feedUrl: 'https://updates.example.com/releases',
    currentVersion: '0.3.0',
    channel: 'preview',
  })

  const checked = await manager.check()
  assert.equal(checked.status, 'available')
  assert.equal(checked.availableVersion, '0.4.0')
  assert.equal(updater.feed.channel, 'preview')

  await manager.download()
  assert.equal(manager.getState().status, 'downloaded')
  assert.equal(manager.getState().progress.percent, 100)
  assert.equal(manager.postpone().status, 'postponed')
  assert.equal(manager.install(), true)
  assert.equal(updater.installCalls, 1)
})
