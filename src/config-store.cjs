'use strict'

const fs = require('node:fs')
const path = require('node:path')

const {
  listRecentWorkspaces,
  normalizeRecentWorkspaces,
  recordRecentWorkspace,
} = require('./workspace-selection.cjs')

const CONFIG_VERSION = 3
const DEFAULT_THEME = 'system'
const DEFAULT_CHECK_FOR_UPDATES = true
const DEFAULT_PERMISSION_MODE = 'workspace-write'
const DEFAULT_UPDATE_CHANNEL = 'stable'
const DEFAULT_WORK_MODE = 'normal'
const SUPPORTED_THEMES = new Set(['system', 'light', 'dark'])
const SUPPORTED_PERMISSION_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const SUPPORTED_UPDATE_CHANNELS = new Set(['stable', 'preview'])
const SUPPORTED_SESSION_MODES = new Set(['normal', 'plan'])

const DEFAULT_PREFERENCES = Object.freeze({
  theme: DEFAULT_THEME,
  checkForUpdates: DEFAULT_CHECK_FOR_UPDATES,
  dataDirectory: '',
  permissionMode: DEFAULT_PERMISSION_MODE,
  workMode: DEFAULT_WORK_MODE,
  crashRecovery: true,
  pluginSafeMode: false,
  startAtLogin: false,
  minimizeToTray: false,
  notifications: true,
  autoDownloadUpdates: true,
  updateChannel: DEFAULT_UPDATE_CHANNEL,
  diagnosticMode: false,
})

function assertWorkspace(workspace) {
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new TypeError('请选择一个工作文件夹')
  }

  const resolved = path.resolve(workspace)
  let stat
  try {
    stat = fs.statSync(resolved)
  } catch {
    const error = new Error('所选工作文件夹不存在')
    error.code = 'WORKSPACE_INVALID'
    throw error
  }

  if (!stat.isDirectory()) {
    const error = new Error('所选路径不是文件夹')
    error.code = 'WORKSPACE_INVALID'
    throw error
  }
  return resolved
}

function assertApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('请输入 DeepSeek API Key')
  }
  const trimmed = apiKey.trim()
  if (!/^sk-[A-Za-z0-9._-]+$/u.test(trimmed) || trimmed.length > 512) {
    throw new Error('API Key 格式不正确，应以 sk- 开头，仅包含字母、数字、点、下划线或连字符')
  }
  return trimmed
}

function assertTheme(theme) {
  if (typeof theme !== 'string' || !SUPPORTED_THEMES.has(theme)) {
    throw new TypeError('主题设置无效')
  }
  return theme
}

function assertCheckForUpdates(value) {
  if (typeof value !== 'boolean') throw new TypeError('更新检查设置无效')
  return value
}

function assertBooleanPreference(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} 设置无效`)
  return value
}

function assertPermissionMode(value) {
  if (value === 'full-access') return 'danger-full-access'
  if (typeof value !== 'string' || !SUPPORTED_PERMISSION_MODES.has(value)) {
    throw new TypeError('权限模式设置无效')
  }
  return value
}

function assertUpdateChannel(value) {
  if (typeof value !== 'string' || !SUPPORTED_UPDATE_CHANNELS.has(value)) {
    throw new TypeError('更新通道设置无效')
  }
  return value
}

function assertWorkMode(value) {
  if (typeof value !== 'string' || !SUPPORTED_SESSION_MODES.has(value)) {
    throw new TypeError('默认会话模式设置无效')
  }
  return value
}

function assertDataDirectory(value) {
  if (value === '') return ''
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('Harness 数据目录设置无效')
  }
  const resolved = path.resolve(value)
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
    throw new TypeError('Harness 数据目录不是文件夹')
  }
  return resolved
}

function validIsoDate(value, fallback = new Date(0).toISOString()) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : fallback
}

function migrateV1ToV2(document) {
  const recentWorkspaces = document.workspace
    ? [{ path: path.resolve(document.workspace), lastUsedAt: validIsoDate(document.updatedAt) }]
    : []
  return {
    ...document,
    version: 2,
    dataDirectory: '',
    permissionMode: DEFAULT_PERMISSION_MODE,
    workMode: DEFAULT_WORK_MODE,
    recentWorkspaces,
  }
}

function migrateV2ToV3(document) {
  return {
    ...document,
    version: 3,
    startAtLogin: false,
    minimizeToTray: false,
    notifications: true,
    autoDownloadUpdates: true,
    updateChannel: DEFAULT_UPDATE_CHANNEL,
    diagnosticMode: false,
    workMode: document.workMode === 'plan' || document.defaultSessionMode === 'plan'
      ? 'plan'
      : DEFAULT_WORK_MODE,
    crashRecovery: true,
    pluginSafeMode: false,
  }
}

const CONFIG_MIGRATIONS = Object.freeze(new Map([
  [1, migrateV1ToV2],
  [2, migrateV2ToV3],
]))

function normalizeCurrentDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('设置文件内容无效')
  }
  if (document.version !== CONFIG_VERSION || typeof document.workspace !== 'string') {
    throw new Error('设置文件版本不受支持')
  }
  if (document.encryptedApiKey !== undefined && typeof document.encryptedApiKey !== 'string') {
    throw new Error('加密的 API Key 内容无效')
  }
  const normalized = {
    version: CONFIG_VERSION,
    workspace: document.workspace,
    theme: SUPPORTED_THEMES.has(document.theme) ? document.theme : DEFAULT_THEME,
    checkForUpdates: typeof document.checkForUpdates === 'boolean'
      ? document.checkForUpdates
      : DEFAULT_CHECK_FOR_UPDATES,
    dataDirectory: typeof document.dataDirectory === 'string' ? document.dataDirectory : '',
    permissionMode: document.permissionMode === 'full-access'
      ? 'danger-full-access'
      : (SUPPORTED_PERMISSION_MODES.has(document.permissionMode)
          ? document.permissionMode
          : DEFAULT_PERMISSION_MODE),
    workMode: document.workMode === 'plan' || document.defaultSessionMode === 'plan'
      ? 'plan'
      : DEFAULT_WORK_MODE,
    recentWorkspaces: normalizeRecentWorkspaces(document.recentWorkspaces),
    startAtLogin: typeof document.startAtLogin === 'boolean' ? document.startAtLogin : false,
    minimizeToTray: typeof document.minimizeToTray === 'boolean' ? document.minimizeToTray : false,
    notifications: typeof document.notifications === 'boolean' ? document.notifications : true,
    autoDownloadUpdates: typeof document.autoDownloadUpdates === 'boolean'
      ? document.autoDownloadUpdates
      : true,
    updateChannel: SUPPORTED_UPDATE_CHANNELS.has(document.updateChannel)
      ? document.updateChannel
      : DEFAULT_UPDATE_CHANNEL,
    diagnosticMode: typeof document.diagnosticMode === 'boolean' ? document.diagnosticMode : false,
    crashRecovery: typeof document.crashRecovery === 'boolean' ? document.crashRecovery : true,
    pluginSafeMode: typeof document.pluginSafeMode === 'boolean' ? document.pluginSafeMode : false,
  }
  if (typeof document.encryptedApiKey === 'string') normalized.encryptedApiKey = document.encryptedApiKey
  if (typeof document.apiKeyUpdatedAt === 'string') normalized.apiKeyUpdatedAt = document.apiKeyUpdatedAt
  if (typeof document.updatedAt === 'string') normalized.updatedAt = document.updatedAt
  return normalized
}

function mergePreferences(previous, preferences = {}) {
  return {
    theme: preferences.theme === undefined ? previous.theme : assertTheme(preferences.theme),
    checkForUpdates: preferences.checkForUpdates === undefined
      ? previous.checkForUpdates
      : assertCheckForUpdates(preferences.checkForUpdates),
    dataDirectory: preferences.dataDirectory === undefined
      ? previous.dataDirectory
      : assertDataDirectory(preferences.dataDirectory),
    permissionMode: preferences.permissionMode === undefined
      ? previous.permissionMode
      : assertPermissionMode(preferences.permissionMode),
    workMode: preferences.workMode === undefined && preferences.defaultSessionMode === undefined
      ? previous.workMode
      : assertWorkMode(preferences.workMode ?? preferences.defaultSessionMode),
    startAtLogin: preferences.startAtLogin === undefined
      ? previous.startAtLogin
      : assertBooleanPreference(preferences.startAtLogin, '开机启动'),
    minimizeToTray: preferences.minimizeToTray === undefined
      ? previous.minimizeToTray
      : assertBooleanPreference(preferences.minimizeToTray, '最小化到托盘'),
    notifications: preferences.notifications === undefined
      ? previous.notifications
      : assertBooleanPreference(preferences.notifications, '通知'),
    autoDownloadUpdates: preferences.autoDownloadUpdates === undefined
      ? previous.autoDownloadUpdates
      : assertBooleanPreference(preferences.autoDownloadUpdates, '自动下载更新'),
    updateChannel: preferences.updateChannel === undefined
      ? previous.updateChannel
      : assertUpdateChannel(preferences.updateChannel),
    diagnosticMode: preferences.diagnosticMode === undefined
      ? previous.diagnosticMode
      : assertBooleanPreference(preferences.diagnosticMode, '诊断模式'),
    crashRecovery: preferences.crashRecovery === undefined
      ? previous.crashRecovery
      : assertBooleanPreference(preferences.crashRecovery, '崩溃恢复'),
    pluginSafeMode: preferences.pluginSafeMode === undefined
      ? previous.pluginSafeMode
      : assertBooleanPreference(preferences.pluginSafeMode, '插件安全模式'),
  }
}

class ConfigStore {
  constructor(filename, codec, options = {}) {
    if (!codec || typeof codec.encrypt !== 'function' || typeof codec.decrypt !== 'function') {
      throw new TypeError('ConfigStore requires an encrypt/decrypt codec')
    }
    this.filename = filename
    this.codec = codec
    this.now = typeof options.now === 'function' ? options.now : () => new Date()
    this.lastMigrationBackup = null
  }

  readDocument() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filename, 'utf8'))
      if (!Number.isInteger(parsed?.version) || parsed.version < 1 || parsed.version > CONFIG_VERSION) {
        throw new Error('设置文件版本不受支持')
      }
      if (parsed.version === CONFIG_VERSION) {
        const normalized = normalizeCurrentDocument(parsed)
        if (JSON.stringify(normalized) !== JSON.stringify(parsed)) this.writeDocument(normalized)
        return normalized
      }

      const sourceVersion = parsed.version
      const backup = this.createMigrationBackup(sourceVersion)
      let migrated = parsed
      while (migrated.version < CONFIG_VERSION) {
        const migration = CONFIG_MIGRATIONS.get(migrated.version)
        if (!migration) throw new Error(`缺少设置迁移步骤：v${migrated.version}`)
        migrated = migration(migrated)
      }
      const normalized = normalizeCurrentDocument(migrated)
      this.writeDocument(normalized)
      this.lastMigrationBackup = backup
      return normalized
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      const wrapped = new Error(`无法读取桌面应用设置：${error.message}`)
      wrapped.code = 'CONFIG_INVALID'
      wrapped.cause = error
      throw wrapped
    }
  }

  createMigrationBackup(sourceVersion) {
    const timestamp = this.now().toISOString().replace(/[:.]/gu, '-')
    const base = `${this.filename}.pre-migration-v${sourceVersion}-to-v${CONFIG_VERSION}-${timestamp}-${process.pid}`
    let backup = `${base}.bak`
    let suffix = 0
    while (fs.existsSync(backup)) {
      suffix += 1
      backup = `${base}-${suffix}.bak`
    }
    fs.copyFileSync(this.filename, backup, fs.constants.COPYFILE_EXCL)
    const descriptor = fs.openSync(backup, 'r+')
    try {
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    try {
      fs.chmodSync(backup, 0o600)
    } catch {
      // Windows ACLs are inherited from the protected user-data directory.
    }
    return backup
  }

  getPublicSettings() {
    const document = this.readDocument()
    const settings = document || {
      version: CONFIG_VERSION,
      workspace: '',
      recentWorkspaces: [],
      ...DEFAULT_PREFERENCES,
    }
    return {
      configured: Boolean(settings.encryptedApiKey && settings.workspace),
      hasApiKey: Boolean(settings.encryptedApiKey),
      workspace: settings.workspace,
      theme: settings.theme,
      checkForUpdates: settings.checkForUpdates,
      dataDirectory: settings.dataDirectory,
      permissionMode: settings.permissionMode === 'danger-full-access'
        ? 'full-access'
        : settings.permissionMode,
      workMode: settings.workMode,
      recentWorkspaces: normalizeRecentWorkspaces(settings.recentWorkspaces),
      startAtLogin: settings.startAtLogin,
      minimizeToTray: settings.minimizeToTray,
      notifications: settings.notifications,
      autoDownloadUpdates: settings.autoDownloadUpdates,
      updateChannel: settings.updateChannel,
      diagnosticMode: settings.diagnosticMode,
      crashRecovery: settings.crashRecovery,
      pluginSafeMode: settings.pluginSafeMode,
    }
  }

  getRuntimeSettings(defaultDataDirectory = '') {
    const document = this.readDocument()
    if (!document || !document.encryptedApiKey) {
      const error = new Error('尚未完成 DeepSeek 连接设置')
      error.code = 'API_KEY_MISSING'
      throw error
    }
    let apiKey
    try {
      apiKey = this.codec.decrypt(document.encryptedApiKey)
    } catch (cause) {
      const error = new Error('无法解密已保存的 API Key，请重新填写')
      error.code = 'KEY_DECRYPT_FAILED'
      error.cause = cause
      throw error
    }
    return {
      workspace: assertWorkspace(document.workspace),
      apiKey,
      dataDirectory: document.dataDirectory || defaultDataDirectory,
      permissionMode: document.permissionMode,
      workMode: document.workMode,
      diagnosticMode: document.diagnosticMode,
      crashRecovery: document.crashRecovery,
    }
  }

  getDecryptedApiKey() {
    const document = this.readDocument()
    if (!document?.encryptedApiKey) {
      const error = new Error('尚未保存 DeepSeek API Key')
      error.code = 'API_KEY_MISSING'
      throw error
    }
    try {
      const apiKey = this.codec.decrypt(document.encryptedApiKey)
      if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('解密结果为空')
      return apiKey
    } catch (cause) {
      const error = new Error('无法解密已保存的 API Key，请重新填写')
      error.code = 'KEY_DECRYPT_FAILED'
      error.cause = cause
      throw error
    }
  }

  getRecentWorkspaces(options = { existingOnly: false }) {
    return listRecentWorkspaces(this.readDocument()?.recentWorkspaces, options)
  }

  quarantineInvalidDocument() {
    if (!fs.existsSync(this.filename)) return null
    const backup = `${this.filename}.invalid-${Date.now()}-${process.pid}`
    fs.renameSync(this.filename, backup)
    return backup
  }

  baseDocument(previous) {
    return previous || {
      version: CONFIG_VERSION,
      workspace: '',
      recentWorkspaces: [],
      ...DEFAULT_PREFERENCES,
    }
  }

  save(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('设置内容无效')
    }
    const previous = this.baseDocument(this.readDocument())
    const resolvedWorkspace = assertWorkspace(payload.workspace)
    const preferences = mergePreferences(previous, payload)
    let encryptedApiKey = previous.encryptedApiKey
    let apiKeyUpdatedAt = previous.apiKeyUpdatedAt
    if (payload.apiKey !== undefined) {
      encryptedApiKey = this.codec.encrypt(assertApiKey(payload.apiKey))
      apiKeyUpdatedAt = this.now().toISOString()
    }
    if (!encryptedApiKey) throw new Error('请输入并测试 DeepSeek API Key')

    const next = {
      ...previous,
      ...preferences,
      version: CONFIG_VERSION,
      workspace: resolvedWorkspace,
      encryptedApiKey,
      apiKeyUpdatedAt,
      recentWorkspaces: recordRecentWorkspace(previous.recentWorkspaces, resolvedWorkspace, this.now()),
      updatedAt: this.now().toISOString(),
    }
    this.writeDocument(next)
    return this.getPublicSettings()
  }

  saveApiKey(apiKey) {
    const previous = this.baseDocument(this.readDocument())
    const next = {
      ...previous,
      version: CONFIG_VERSION,
      encryptedApiKey: this.codec.encrypt(assertApiKey(apiKey)),
      apiKeyUpdatedAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    }
    this.writeDocument(next)
    return this.getPublicSettings()
  }

  clearApiKey() {
    const previous = this.readDocument()
    if (!previous) return this.getPublicSettings()
    const next = { ...previous, version: CONFIG_VERSION, updatedAt: this.now().toISOString() }
    delete next.encryptedApiKey
    delete next.apiKeyUpdatedAt
    this.writeDocument(next)
    return this.getPublicSettings()
  }

  saveWorkspace(workspace) {
    const previous = this.baseDocument(this.readDocument())
    const resolvedWorkspace = assertWorkspace(workspace)
    this.writeDocument({
      ...previous,
      version: CONFIG_VERSION,
      workspace: resolvedWorkspace,
      recentWorkspaces: recordRecentWorkspace(previous.recentWorkspaces, resolvedWorkspace, this.now()),
      updatedAt: this.now().toISOString(),
    })
    return this.getPublicSettings()
  }

  markWorkspaceUsed(workspace) {
    const previous = this.baseDocument(this.readDocument())
    const resolvedWorkspace = assertWorkspace(workspace)
    this.writeDocument({
      ...previous,
      version: CONFIG_VERSION,
      recentWorkspaces: recordRecentWorkspace(previous.recentWorkspaces, resolvedWorkspace, this.now()),
      updatedAt: this.now().toISOString(),
    })
    return this.getRecentWorkspaces({ existingOnly: false })
  }

  savePreferences(preferences = {}) {
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
      throw new TypeError('偏好设置内容无效')
    }
    const previous = this.baseDocument(this.readDocument())
    const next = {
      ...previous,
      ...mergePreferences(previous, preferences),
      version: CONFIG_VERSION,
      workspace: previous.workspace || '',
      updatedAt: this.now().toISOString(),
    }
    this.writeDocument(next)
    return this.getPublicSettings()
  }

  writeDocument(document) {
    const persistedDocument = normalizeCurrentDocument(document)
    const directory = path.dirname(this.filename)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.filename}.${process.pid}.${Date.now()}.tmp`
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600)
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(persistedDocument, null, 2)}\n`, 'utf8')
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }
      fs.renameSync(temporary, this.filename)
      try {
        fs.chmodSync(this.filename, 0o600)
      } catch {
        // Windows ACLs are inherited from the protected user-data directory.
      }
      if (process.platform !== 'win32') {
        try {
          const directoryDescriptor = fs.openSync(directory, 'r')
          try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
        } catch {
          // Some file systems do not permit opening directories for fsync.
        }
      }
    } finally {
      try {
        fs.unlinkSync(temporary)
      } catch (error) {
        if (error && error.code !== 'ENOENT') throw error
      }
    }
  }
}

module.exports = {
  CONFIG_MIGRATIONS,
  CONFIG_VERSION,
  DEFAULT_CHECK_FOR_UPDATES,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_WORK_MODE,
  DEFAULT_PREFERENCES,
  DEFAULT_THEME,
  DEFAULT_UPDATE_CHANNEL,
  ConfigStore,
  assertApiKey,
  assertDataDirectory,
  assertWorkMode,
  assertPermissionMode,
  assertTheme,
  assertUpdateChannel,
  assertWorkspace,
}
