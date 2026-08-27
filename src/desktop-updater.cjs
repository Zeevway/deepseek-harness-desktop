'use strict'

const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

const UPDATE_CHANNELS = new Set(['stable', 'preview'])

class DesktopUpdateError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message)
    this.name = 'DesktopUpdateError'
    this.code = code
    this.details = details
    if (cause !== undefined) this.cause = cause
  }
}

function updateError(code, message, details, cause) {
  return new DesktopUpdateError(code, message, details, cause)
}

function normalizeChannel(channel) {
  if (typeof channel !== 'string' || !UPDATE_CHANNELS.has(channel)) {
    throw updateError('INVALID_UPDATE_CHANNEL', '更新通道无效。')
  }
  return channel
}

function normalizeFeedUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  let url
  try {
    url = new URL(value.trim())
  } catch (cause) {
    throw updateError('INVALID_UPDATE_FEED', '桌面版更新地址无效。', {}, cause)
  }
  if (url.protocol !== 'https:') {
    throw updateError('INVALID_UPDATE_FEED', '桌面版更新必须使用 HTTPS 地址。')
  }
  url.hash = ''
  return url.href.replace(/\/$/u, '')
}

function readUpdateFeed(filename) {
  if (!filename || !fs.existsSync(filename)) return { url: '' }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch (cause) {
    throw updateError('INVALID_UPDATE_FEED', '桌面版更新配置无法读取。', { filename }, cause)
  }
  return {
    url: normalizeFeedUrl(parsed?.url || ''),
    provider: 'generic',
  }
}

function resolveUpdateFeed(options = {}) {
  const resourcesPath = options.resourcesPath || process.resourcesPath
  const packagedFilename = resourcesPath ? path.join(resourcesPath, 'update-feed.json') : ''
  const packaged = readUpdateFeed(packagedFilename)
  if (packaged.url) return packaged

  if (options.isPackaged !== true) {
    return { url: normalizeFeedUrl(options.developmentUrl || ''), provider: 'generic' }
  }
  return { url: '', provider: 'generic' }
}

function friendlyUpdaterError(error) {
  const raw = error instanceof Error ? error.message : String(error || '')
  if (/net::|ENOTFOUND|ECONN|network|fetch/u.test(raw)) {
    return updateError('UPDATE_NETWORK_ERROR', '无法连接桌面版更新服务，请检查网络或代理。', {}, error)
  }
  if (/sha512|checksum|integrity|signature/u.test(raw)) {
    return updateError('UPDATE_INTEGRITY_ERROR', '更新文件校验失败，已停止安装。', {}, error)
  }
  return updateError('UPDATE_FAILED', '桌面版更新失败，请稍后重试。', {}, error)
}

class DesktopUpdateManager extends EventEmitter {
  constructor(options = {}) {
    super()
    this.autoUpdater = options.autoUpdater || null
    this.feedUrl = normalizeFeedUrl(options.feedUrl || '')
    this.hasEmbeddedConfig = options.hasEmbeddedConfig === true
    this.currentVersion = options.currentVersion || ''
    this.channel = normalizeChannel(options.channel || 'stable')
    this.autoDownload = options.autoDownload === true
    this.logger = options.logger || (() => {})
    this.checkTask = null
    this.downloadTask = null
    this.state = {
      configured: Boolean((this.feedUrl || this.hasEmbeddedConfig) && this.autoUpdater),
      status: (this.feedUrl || this.hasEmbeddedConfig) && this.autoUpdater ? 'idle' : 'unconfigured',
      currentVersion: this.currentVersion,
      availableVersion: '',
      downloadedVersion: '',
      channel: this.channel,
      autoDownload: this.autoDownload,
      progress: null,
      error: null,
    }
    this.bindUpdater()
    this.applyConfiguration()
  }

  bindUpdater() {
    if (!this.autoUpdater || typeof this.autoUpdater.on !== 'function') return
    this.autoUpdater.on('checking-for-update', () => this.setState({ status: 'checking', error: null }))
    this.autoUpdater.on('update-available', (info) => {
      this.setState({ status: 'available', availableVersion: info?.version || '', error: null })
      if (this.autoDownload) void this.download().catch(() => {})
    })
    this.autoUpdater.on('update-not-available', (info) => {
      this.setState({ status: 'current', availableVersion: info?.version || this.currentVersion, error: null })
    })
    this.autoUpdater.on('download-progress', (progress) => {
      this.setState({
        status: 'downloading',
        progress: {
          percent: Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0,
          transferred: Number(progress?.transferred) || 0,
          total: Number(progress?.total) || 0,
          bytesPerSecond: Number(progress?.bytesPerSecond) || 0,
        },
      })
    })
    this.autoUpdater.on('update-downloaded', (info) => {
      this.setState({
        status: 'downloaded',
        downloadedVersion: info?.version || this.state.availableVersion,
        progress: { percent: 100, transferred: this.state.progress?.total || 0, total: this.state.progress?.total || 0, bytesPerSecond: 0 },
        error: null,
      })
    })
    this.autoUpdater.on('error', (error) => {
      const normalized = friendlyUpdaterError(error)
      this.logger(`desktop update failed: ${error instanceof Error ? error.message : String(error)}`)
      this.setState({ status: 'error', error: { code: normalized.code, message: normalized.message } })
    })
  }

  applyConfiguration() {
    if (!this.autoUpdater || (!this.feedUrl && !this.hasEmbeddedConfig)) return
    this.autoUpdater.autoDownload = false
    this.autoUpdater.autoInstallOnAppQuit = false
    this.autoUpdater.allowPrerelease = this.channel === 'preview'
    this.autoUpdater.channel = this.channel === 'preview' ? 'preview' : 'latest'
    if (this.feedUrl) {
      this.autoUpdater.setFeedURL({ provider: 'generic', url: this.feedUrl, channel: this.autoUpdater.channel })
    }
  }

  setState(patch) {
    this.state = { ...this.state, ...patch }
    const snapshot = this.getState()
    this.emit('state', snapshot)
    return snapshot
  }

  getState() {
    return JSON.parse(JSON.stringify(this.state))
  }

  configure(preferences = {}) {
    if (preferences.channel !== undefined) this.channel = normalizeChannel(preferences.channel)
    if (preferences.autoDownload !== undefined) {
      if (typeof preferences.autoDownload !== 'boolean') throw new TypeError('自动下载更新设置无效。')
      this.autoDownload = preferences.autoDownload
    }
    this.applyConfiguration()
    return this.setState({ channel: this.channel, autoDownload: this.autoDownload })
  }

  check() {
    if (!this.autoUpdater || (!this.feedUrl && !this.hasEmbeddedConfig)) {
      return Promise.resolve(this.setState({ status: 'unconfigured', configured: false }))
    }
    if (this.checkTask) return this.checkTask
    this.setState({ status: 'checking', error: null })
    this.checkTask = Promise.resolve()
      .then(() => this.autoUpdater.checkForUpdates())
      .then((result) => {
        const version = result?.updateInfo?.version
        if (typeof version === 'string' && version && this.state.status === 'checking') {
          const available = version !== this.currentVersion
          this.setState({ status: available ? 'available' : 'current', availableVersion: version })
        }
        return this.getState()
      })
      .catch((error) => {
        const normalized = friendlyUpdaterError(error)
        this.setState({ status: 'error', error: { code: normalized.code, message: normalized.message } })
        throw normalized
      })
      .finally(() => { this.checkTask = null })
    return this.checkTask
  }

  download() {
    if (!this.autoUpdater || (!this.feedUrl && !this.hasEmbeddedConfig)) {
      return Promise.reject(updateError('UPDATE_FEED_UNCONFIGURED', '尚未配置桌面版更新发布源。'))
    }
    if (this.downloadTask) return this.downloadTask
    this.setState({ status: 'downloading', error: null })
    this.downloadTask = Promise.resolve()
      .then(() => this.autoUpdater.downloadUpdate())
      .then(() => this.getState())
      .catch((error) => {
        const normalized = friendlyUpdaterError(error)
        this.setState({ status: 'error', error: { code: normalized.code, message: normalized.message } })
        throw normalized
      })
      .finally(() => { this.downloadTask = null })
    return this.downloadTask
  }

  postpone() {
    if (this.state.status === 'downloaded') return this.setState({ status: 'postponed' })
    return this.getState()
  }

  install() {
    if (!this.autoUpdater || !this.state.downloadedVersion) {
      throw updateError('UPDATE_NOT_DOWNLOADED', '更新尚未下载完成。')
    }
    this.setState({ status: 'installing' })
    this.autoUpdater.quitAndInstall(false, true)
    return true
  }
}

module.exports = {
  DesktopUpdateError,
  DesktopUpdateManager,
  UPDATE_CHANNELS,
  friendlyUpdaterError,
  normalizeChannel,
  normalizeFeedUrl,
  readUpdateFeed,
  resolveUpdateFeed,
}
