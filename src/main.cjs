'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  safeStorage,
  session: electronSession,
  shell,
  Tray,
} = require('electron')

const { ConfigStore, assertTheme } = require('./config-store.cjs')
const {
  createDataBackup,
  getRestoreJournalPath,
  migrateDataDirectory,
  readBackupDataSettings,
  recoverInterruptedRestore,
  restoreDataBackup,
} = require('./data-management.cjs')
const { testDeepSeekApiKey } = require('./deepseek-api.cjs')
const {
  DesktopUpdateManager,
  resolveUpdateFeed,
} = require('./desktop-updater.cjs')
const { exportDiagnosticBundle, sanitizeDiagnosticValue } = require('./diagnostics.cjs')
const {
  ERROR_CODES,
  classifyError,
  sanitizedDetails,
} = require('./error-classifier.cjs')
const { callHarnessRpc, ensureWorkspace } = require('./harness-rpc.cjs')
const { HarnessNotificationMonitor } = require('./harness-notifications.cjs')
const { HarnessManager } = require('./harness-manager.cjs')
const { redactSensitiveText } = require('./log-redaction.cjs')
const {
  AWESOME_PLUGINS_URL,
  GITHUB_TOPIC_URL,
  PluginManager,
} = require('./plugin-manager.cjs')
const {
  createProgramRollbackJournal,
  getProgramRollbackJournalPath,
  markProgramRollbackState,
  readProgramRollbackJournal,
  recoverProgramRollback,
} = require('./program-rollback.cjs')
const { RotatingLog } = require('./rotating-log.cjs')
const { clearSessionPartitionData } = require('./site-data.cjs')
const { checkForHarnessUpdate } = require('./update-checker.cjs')
const { UpgradeSafety, readDataDirectoryBeforeMigration } = require('./upgrade-safety.cjs')
const {
  inspectWorkspace,
  isSameOrInside,
} = require('./workspace-selection.cjs')
const { createWindowsDriveTypeResolver } = require('./windows-drive-types.cjs')

let electronAutoUpdater = null
try {
  ;({ autoUpdater: electronAutoUpdater } = require('electron-updater'))
} catch {
  electronAutoUpdater = null
}

const APP_NAME = 'DeepSeek Harness 桌面版'
const APP_ID = 'com.deepseek.harness.desktop'
const UI_FILE = path.join(__dirname, 'ui', 'index.html')
const API_KEYS_URL = 'https://platform.deepseek.com/api_keys'
const OFFICIAL_REPOSITORY_URL = 'https://github.com/deepseek-ai/deepseek-harness'
const OFFICIAL_DOCS_URL = 'https://deepseek-harness.github.io/deepseek-harness/zh/guide/quickstart'
const QUIT_CLEANUP_TIMEOUT_MS = 12_000
const MAX_RENDERER_RECOVERY_ATTEMPTS = 1
const DATA_MARKER_NAME = '.deepseek-harness-desktop-data.json'
const DESKTOP_SESSION_PARTITION = 'persist:deepseek-harness-desktop'
const SETTINGS_SECTIONS = new Set([
  'api-key',
  'workspace',
  'permissions',
  'plugins',
  'updates',
  'appearance',
])
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'platform.deepseek.com',
  'github.com',
  'deepseek-harness.github.io',
])
const PREFERENCE_FIELDS = new Set([
  'theme',
  'checkForUpdates',
  'startAtLogin',
  'minimizeToTray',
  'notifications',
  'autoDownloadUpdates',
  'updateChannel',
  'diagnosticMode',
  'crashRecovery',
])

app.setName(APP_NAME)
app.setAppUserModelId(APP_ID)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('lang', 'zh-CN')

let mainWindow = null
let settingsWindow = null
let tray = null
let configStore = null
let configFile = ''
let harnessManager = null
let harnessNotificationMonitor = null
let pluginManager = null
let pluginManagerHome = ''
let desktopUpdateManager = null
let upgradeSafety = null
let rotatingLog = null
let harnessOrigin = null
let lastHarnessOrigin = null
let quitting = false
let exitCommitted = false
let quitTask = null
let defaultWorkspaceSuggestion = ''
let harnessStartGeneration = 0
let harnessStartSerial = Promise.resolve()
let maintenanceSerial = Promise.resolve()
let harnessUpdateCheckTask = null
let crashRecoveryAttempts = 0
let crashRecoveryTimer = null
let healthyResetTimer = null
let fullAccessApprovedOnce = false
const rendererRecoveryState = new WeakMap()
let runtimeState = {
  phase: 'setup',
  message: '等待设置',
  errorCode: '',
  errorCategory: '',
}
const windowsDriveType = createWindowsDriveTypeResolver({
  onError(error) {
    appendLifecycleLog(`could not inspect Windows drive types: ${error?.message || String(error)}`)
  },
})

function resolveAsset(name) {
  return path.join(app.getAppPath(), 'assets', name)
}

function resolveUnpacked(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', ...segments)
  }
  return path.join(app.getAppPath(), ...segments)
}

function resolveDshBin() {
  return resolveUnpacked('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function resolvePnpmBin() {
  return resolveUnpacked('node_modules', 'pnpm', 'bin', 'pnpm.mjs')
}

function resolveRunner() {
  return resolveUnpacked('src', 'harness-runner.mjs')
}

function readHarnessVersion() {
  try {
    const filename = path.join(path.dirname(resolveDshBin()), '..', 'package.json')
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (typeof manifest.version === 'string' && manifest.version) return manifest.version
  } catch (error) {
    appendLifecycleLog(`could not read Harness version: ${error?.message || String(error)}`)
  }
  return '未知'
}

function defaultWorkspace() {
  return path.join(app.getPath('documents'), 'DeepSeek 工作区')
}

function defaultDataDirectory() {
  return path.join(app.getPath('userData'), 'harness')
}

function createCodec() {
  if (!safeStorage.isEncryptionAvailable()) {
    const error = new Error('Windows DPAPI 当前不可用，无法安全保存 API Key')
    error.code = 'KEY_ENCRYPTION_UNAVAILABLE'
    throw error
  }
  return {
    encrypt(value) {
      return safeStorage.encryptString(value).toString('base64')
    },
    decrypt(value) {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    },
  }
}

function initializeLogger() {
  rotatingLog = new RotatingLog(path.join(app.getPath('logs'), 'desktop.log'), {
    maxBytes: 2 * 1024 * 1024,
    maxFiles: 5,
    syncWrites: false,
  })
}

function appendLifecycleLog(value) {
  const text = redactSensitiveText(value)
  try {
    rotatingLog?.append(`[${new Date().toISOString()}] ${text}`)
  } catch {
    // A logging failure must not prevent startup or recovery.
  }
}

function appendHarnessLog(value) {
  let diagnosticMode = false
  try {
    diagnosticMode = configStore?.getPublicSettings().diagnosticMode === true
  } catch {
    diagnosticMode = false
  }
  if (diagnosticMode) appendLifecycleLog(`[Harness] ${value}`)
}

function notifyUser(title, body) {
  try {
    const preferences = configStore?.getPublicSettings()
    if (preferences?.notifications === false || !Notification.isSupported()) return
    const notification = new Notification({ title, body, silent: false })
    notification.on('click', showMainWindow)
    notification.show()
    return notification
  } catch {
    // Notifications are optional.
    return undefined
  }
}

function stopHarnessNotifications() {
  try {
    harnessNotificationMonitor?.stop()
  } catch (error) {
    appendLifecycleLog(`could not stop Harness notifications: ${error?.message || String(error)}`)
  }
}

function startHarnessNotifications(baseUrl) {
  try {
    harnessNotificationMonitor?.start(baseUrl)
  } catch (error) {
    appendLifecycleLog(`could not start Harness notifications: ${error?.message || String(error)}`)
  }
}

function publishStatus(patch) {
  runtimeState = { ...runtimeState, ...patch }
  for (const window of [mainWindow, settingsWindow]) {
    if (!window || window.isDestroyed()) continue
    const webContents = window.webContents
    if (!webContents || webContents.isDestroyed()) continue
    if (typeof webContents.isCrashed === 'function' && webContents.isCrashed()) continue
    try {
      webContents.send('desktop:status', runtimeState)
    } catch (error) {
      appendLifecycleLog(`could not publish desktop status: ${error?.message || String(error)}`)
    }
  }
}

function errorPayload(error, fallbackMessage = '桌面操作失败') {
  const classified = classifyError(error, fallbackMessage)
  let code = typeof error?.code === 'string' && error.code
    ? error.code
    : classified.code
  let category = classified.category
  if (/^(?:UPDATE|INVALID_UPDATE)/u.test(code)) category = 'update'
  else if (/^(?:PLUGIN|NOT_A_HARNESS_PLUGIN|INVALID_PLUGIN)/u.test(code)) category = 'runtime'
  else if (/^(?:WORKSPACE|PERMISSION)/u.test(code)) category = 'workspace'
  else if (/^(?:API|KEY)/u.test(code)) category = 'api-key'
  else if (/^(?:DATA|DIAGNOSTIC)/u.test(code)) category = 'data'
  if (!code) code = ERROR_CODES.UNKNOWN
  return {
    name: error?.name || classified.name,
    code,
    category,
    message: redactSensitiveText(error?.message || classified.message || fallbackMessage),
    details: sanitizedDetails(error?.details || classified.details),
  }
}

function ownerWindow(event) {
  return BrowserWindow.fromWebContents(event.sender) || settingsWindow || mainWindow
}

function isTrustedLocalSender(event) {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || ![mainWindow, settingsWindow].includes(window)) return false
  if (event.senderFrame !== event.sender.mainFrame) return false
  const actual = event.senderFrame?.url
  if (typeof actual !== 'string') return false
  const expected = pathToFileURL(UI_FILE).href
  return actual === expected || actual.startsWith(`${expected}?`)
}

function assertTrustedLocalSender(event) {
  if (!isTrustedLocalSender(event)) {
    const error = new Error('已阻止来自非受信页面的桌面操作')
    error.code = 'UNTRUSTED_IPC_SENDER'
    throw error
  }
}

function registerIpcHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertTrustedLocalSender(event)
      return { __desktopIpc: true, ok: true, value: await handler(event, ...args) }
    } catch (error) {
      const payload = errorPayload(error)
      appendLifecycleLog(`${channel} failed [${payload.code}]: ${payload.message}`)
      return { __desktopIpc: true, ok: false, error: payload }
    }
  })
}

function parseExternalHttps(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

function isAllowedExternalUrl(value) {
  const url = parseExternalHttps(value)
  return Boolean(url && ALLOWED_EXTERNAL_HOSTS.has(url.hostname.toLowerCase()))
}

function isHarnessPage(value) {
  try {
    return Boolean(harnessOrigin && new URL(value).origin === harnessOrigin)
  } catch {
    return false
  }
}

function scheduleRendererRecovery(window, payload, reason) {
  let state = rendererRecoveryState.get(window)
  if (!state) {
    state = { attempts: 0, pending: false, suppressionLogged: false }
    rendererRecoveryState.set(window, state)
  }
  if (state.pending || state.attempts >= MAX_RENDERER_RECOVERY_ATTEMPTS) {
    if (!state.suppressionLogged) {
      state.suppressionLogged = true
      appendLifecycleLog('suppressed repeated renderer recovery for the same window')
    }
    return
  }

  state.attempts += 1
  publishStatus({
    phase: 'error',
    message: payload.message,
    errorCode: payload.code,
    errorCategory: payload.category,
  })
  if (reason === 'launch-failed') {
    appendLifecycleLog('renderer recovery skipped because the renderer could not launch')
    return
  }

  state.pending = true

  setTimeout(() => {
    const finish = () => {
      state.pending = false
    }
    try {
      if (quitting || window.isDestroyed()) {
        finish()
        return
      }
      const webContents = window.webContents
      if (!webContents || webContents.isDestroyed()) {
        finish()
        appendLifecycleLog('renderer recovery skipped because webContents was destroyed')
        return
      }
      void loadLocalPage(window, 'error', payload.message, '', payload).then(
        () => {
          appendLifecycleLog('renderer recovery page loaded')
          finish()
        },
        (error) => {
          appendLifecycleLog(`renderer recovery failed: ${error?.message || String(error)}`)
          finish()
        },
      )
    } catch (error) {
      appendLifecycleLog(`renderer recovery failed: ${error?.message || String(error)}`)
      finish()
    }
  }, 0)
}

async function openExternalFromPage(value, sourceUrl, owner) {
  const url = parseExternalHttps(value)
  if (!url) {
    appendLifecycleLog(`blocked non-HTTPS external navigation: ${String(value)}`)
    return false
  }
  if (isHarnessPage(sourceUrl)) {
    const answer = await dialog.showMessageBox(owner, {
      type: 'question',
      title: '打开外部网站',
      message: 'DeepSeek Harness 请求打开外部网站',
      detail: `${url.hostname}\n\n仅在你信任该目标时继续。`,
      buttons: ['取消', '继续打开'],
      cancelId: 0,
      defaultId: 0,
      noLink: true,
    })
    if (answer.response !== 1) return false
  } else if (!isAllowedExternalUrl(url.href)) {
    appendLifecycleLog(`blocked non-allowlisted UI link: ${url.href}`)
    return false
  }
  await shell.openExternal(url.href, { activate: true })
  return true
}

function secureWindow(window) {
  window.webContents.setWindowOpenHandler((details) => {
    void openExternalFromPage(details.url, window.webContents.getURL(), window)
    return { action: 'deny' }
  })
  const browserSession = window.webContents.session
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  if (typeof browserSession.setPermissionCheckHandler === 'function') {
    browserSession.setPermissionCheckHandler(() => false)
  }
  if (typeof browserSession.setDevicePermissionHandler === 'function') {
    browserSession.setDevicePermissionHandler(() => false)
  }
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())

  const guardNavigation = (event, url) => {
    const localUiUrl = pathToFileURL(UI_FILE).href
    const isLocalUi = url === localUiUrl || url.startsWith(`${localUiUrl}?`)
    if (isLocalUi || isHarnessPage(url)) return
    event.preventDefault()
    void openExternalFromPage(url, window.webContents.getURL(), window)
  }
  window.webContents.on('will-navigate', guardNavigation)
  window.webContents.on('will-redirect', guardNavigation)
  window.webContents.on('render-process-gone', (_event, details) => {
    if (quitting || window.isDestroyed() || window.webContents.isDestroyed()) return
    const error = new Error(`界面进程异常退出（${details.reason}）`)
    error.code = 'RENDERER_CRASHED'
    const payload = errorPayload(error)
    appendLifecycleLog(payload.message)
    if (window === mainWindow) {
      scheduleRendererRecovery(window, payload, details.reason)
    }
  })
}

function browserWindowOptions() {
  return {
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151817' : '#f7f8f6',
    icon: resolveAsset('icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webviewTag: false,
      partition: DESKTOP_SESSION_PARTITION,
    },
  }
}

function shouldMinimizeToTray() {
  try {
    return configStore?.getPublicSettings().minimizeToTray === true
  } catch {
    return false
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    ...browserWindowOptions(),
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    title: APP_NAME,
  })
  secureWindow(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (exitCommitted || quitting) return
    event.preventDefault()
    if (shouldMinimizeToTray()) {
      mainWindow.hide()
      return
    }
    void requestQuit()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  return mainWindow
}

function normalizeSettingsSection(section) {
  return SETTINGS_SECTIONS.has(section) ? section : 'api-key'
}

function loadLocalPage(window, mode, message = '', section = '', error = {}) {
  if (!window || window.isDestroyed()) return Promise.resolve()
  if (window === mainWindow) {
    if (harnessOrigin) lastHarnessOrigin = harnessOrigin
    harnessOrigin = null
  }
  return window.loadFile(UI_FILE, {
    query: {
      mode,
      message,
      section,
      category: error.category || '',
      code: error.code || '',
    },
  })
}

function openSettingsWindow(section = 'api-key') {
  const targetSection = normalizeSettingsSection(section)
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('desktop:navigate-section', targetSection)
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    ...browserWindowOptions(),
    width: 980,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    parent: mainWindow ?? undefined,
    title: `设置中心 - ${APP_NAME}`,
  })
  secureWindow(settingsWindow)
  settingsWindow.once('ready-to-show', () => settingsWindow?.show())
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
  void loadLocalPage(settingsWindow, 'settings', '', targetSection)
}

function showMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray() {
  if (tray || !shouldMinimizeToTray()) return
  tray = new Tray(resolveAsset('icon.png'))
  tray.setToolTip(APP_NAME)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DeepSeek Harness', click: showMainWindow },
    { label: '设置中心', click: () => openSettingsWindow('api-key') },
    { label: '重新启动 Harness', click: () => void startHarness() },
    { type: 'separator' },
    { label: '退出', click: () => void requestQuit() },
  ]))
  tray.on('double-click', showMainWindow)
}

function syncTray() {
  if (shouldMinimizeToTray()) {
    createTray()
  } else if (tray) {
    tray.destroy()
    tray = null
  }
}

function applyLoginPreference(settings) {
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.startAtLogin === true,
      path: process.execPath,
      args: [],
    })
  } catch (error) {
    appendLifecycleLog(`could not update login preference: ${error?.message || String(error)}`)
  }
}

function applyTheme(theme) {
  const normalized = assertTheme(theme)
  nativeTheme.themeSource = normalized
  return normalized
}

function saveAndApplyTheme(theme) {
  const saved = configStore.savePreferences({ theme: assertTheme(theme) })
  applyTheme(saved.theme)
  installMenu()
  publishStatus({
    theme: saved.theme,
    resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
  })
  return saved
}

function writeDataMarker(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const filename = path.join(directory, DATA_MARKER_NAME)
  if (fs.existsSync(filename)) return
  fs.writeFileSync(filename, `${JSON.stringify({
    appId: APP_ID,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function isManagedDataDirectory(directory) {
  const resolved = path.resolve(directory)
  if (resolved === path.resolve(defaultDataDirectory())) return true
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(resolved, DATA_MARKER_NAME), 'utf8'))
    return marker?.appId === APP_ID
  } catch {
    return false
  }
}

function effectiveDataDirectory(settings = configStore.getPublicSettings()) {
  return path.resolve(settings.dataDirectory || defaultDataDirectory())
}

function samePath(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
}

function mapWorkspaceAssessment(result) {
  const messages = Array.isArray(result?.risks)
    ? result.risks.map((entry) => entry.message).filter(Boolean)
    : []
  const level = result?.ok
    ? (result.riskLevel === 'low' ? 'success' : (result.riskLevel === 'critical' ? 'danger' : 'warning'))
    : 'danger'
  return {
    ...result,
    level,
    title: result?.ok
      ? (messages.length ? '目录可用，但需要确认风险' : '目录检查已通过')
      : '目录不可用',
    message: messages.join('；') || (result?.ok
      ? (result.requiresWriteAccess === false
          ? '目录存在且当前账户可读取；只读模式不会写入工作区。'
          : '目录存在且当前账户可写。')
      : '请重新选择可用目录。'),
  }
}

function inspectWorkspaceForPermission(workspace, permissionMode) {
  const normalizedPermission = permissionMode === 'read-only'
    ? 'read-only'
    : (permissionMode === 'full-access' || permissionMode === 'danger-full-access'
        ? 'full-access'
        : 'workspace-write')
  return {
    ...inspectWorkspace(workspace, {
      requireWritable: normalizedPermission !== 'read-only',
      driveType: windowsDriveType,
    }),
    permissionMode: normalizedPermission,
  }
}

async function confirmWorkspaceRisks(event, assessment) {
  if (!assessment.requiresConfirmation) return true
  const answer = await dialog.showMessageBox(ownerWindow(event), {
    type: assessment.riskLevel === 'critical' ? 'warning' : 'question',
    title: '确认工作区范围',
    message: '所选工作区会扩大或改变 Harness 的文件访问范围',
    detail: assessment.risks.map((entry) => `• ${entry.message}`).join('\n'),
    buttons: ['返回修改', '仍然使用'],
    cancelId: 0,
    defaultId: 0,
    noLink: true,
  })
  return answer.response === 1
}

async function confirmFullAccess(owner, reason) {
  const answer = await dialog.showMessageBox(owner || mainWindow, {
    type: 'warning',
    title: '确认 Full Access',
    message: 'Full Access 会关闭沙箱和逐项批准',
    detail: `${reason}\n\nHarness 可以访问或修改工作区外文件，也可以执行本机命令。只应在你明确需要并信任当前任务时启用。`,
    buttons: ['取消', '本次允许 Full Access'],
    cancelId: 0,
    defaultId: 0,
    noLink: true,
  })
  return answer.response === 1
}

function validateDataDirectory(targetValue, workspace, currentDirectory) {
  const target = path.resolve(targetValue || defaultDataDirectory())
  const defaultDirectory = path.resolve(defaultDataDirectory())
  if (isSameOrInside(target, workspace) || isSameOrInside(workspace, target)) {
    const error = new Error('Harness 数据目录与工作区不能互相包含')
    error.code = 'DATA_MIGRATION_FAILED'
    throw error
  }
  const root = path.parse(target).root
  if (target === root) {
    const error = new Error('不能把磁盘根目录用作 Harness 数据目录')
    error.code = 'DATA_MIGRATION_FAILED'
    throw error
  }
  const protectedRoots = [
    process.env.WINDIR,
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ].filter(Boolean).map((entry) => path.resolve(entry))
  if (target !== defaultDirectory && protectedRoots.some((entry) => isSameOrInside(target, entry))) {
    const error = new Error('不能把 Windows 或 Program Files 目录用作 Harness 数据目录')
    error.code = 'DATA_MIGRATION_FAILED'
    throw error
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  const stat = fs.statSync(target)
  if (!stat.isDirectory()) throw new Error('Harness 数据路径不是文件夹')
  const probe = path.join(target, `.dsh-data-write-test-${process.pid}-${Date.now()}`)
  try {
    fs.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 })
  } finally {
    try { fs.unlinkSync(probe) } catch {}
  }
  if (!samePath(currentDirectory, target)) {
    const entries = fs.readdirSync(target)
    if (entries.length > 0) {
      const error = new Error('新的 Harness 数据目录必须为空，避免覆盖其他文件')
      error.code = 'DATA_MIGRATION_FAILED'
      throw error
    }
  }
  return target
}

function createUpgradeSafety(appVersion = app.getVersion(), harnessVersion = readHarnessVersion()) {
  return new UpgradeSafety({
    stateFile: path.join(app.getPath('userData'), 'upgrade-state.json'),
    backupRoot: path.join(app.getPath('userData'), 'upgrade-backups'),
    configFile,
    appVersion,
    harnessVersion,
  })
}

function getPluginManager(dataDirectory = effectiveDataDirectory()) {
  const resolved = path.resolve(dataDirectory)
  if (pluginManager && pluginManagerHome === resolved) return pluginManager
  pluginManagerHome = resolved
  pluginManager = new PluginManager({
    dshHome: resolved,
    dshBin: resolveDshBin(),
    executable: process.execPath,
    pnpmBin: resolvePnpmBin(),
    fetchImpl: (...args) => net.fetch(...args),
    logger: appendLifecycleLog,
    harnessVersion: readHarnessVersion(),
  })
  return pluginManager
}

function mapPlugin(plugin, installedByName = new Map()) {
  const installed = installedByName.get(plugin.name)
  const merged = installed ? { ...plugin, ...installed } : plugin
  return {
    id: merged.name,
    name: merged.name,
    version: merged.version || '',
    author: merged.author || merged.publisher?.username || '',
    description: merged.description || '',
    permissions: Array.isArray(merged.capabilities) ? merged.capabilities : [],
    compatible: merged.compatibilityState !== 'incompatible',
    compatibility: merged.compatibility || '',
    source: merged.repository || merged.source || 'npm',
    integrity: merged.integrity || '',
    installScripts: Array.isArray(merged.installScripts) ? merged.installScripts : [],
    scriptsBlocked: merged.scriptsBlocked === true,
    installed: Boolean(installed || merged.installed),
    enabled: merged.enabled !== false,
    updateAvailable: merged.updateAvailable === true,
    rollbackAvailable: merged.rollbackAvailable === true,
    latestVersion: merged.latestVersion || '',
  }
}

async function listPlugins() {
  const manager = getPluginManager()
  const installed = await manager.listWithUpdates()
  const installedByName = new Map(installed.map((item) => [item.name, item]))
  let discovered = []
  let discoveryError = ''
  try {
    discovered = (await manager.discover()).items
  } catch (error) {
    discoveryError = error.message
    appendLifecycleLog(`plugin discovery failed: ${error.message}`)
  }
  return {
    discover: discovered.map((item) => mapPlugin(item, installedByName)),
    installed: installed.map((item) => mapPlugin(item)),
    communityLinks: [GITHUB_TOPIC_URL, AWESOME_PLUGINS_URL],
    discoveryError,
  }
}

async function confirmPluginReview(event, metadata, action) {
  const lines = [
    `软件包：${metadata.name}@${metadata.version}`,
    `来源：${metadata.repository || 'npm registry'}`,
    `兼容性：${metadata.compatibilityState === 'compatible' ? '兼容' : (metadata.compatibilityState === 'incompatible' ? '不兼容' : '未声明')}`,
    `完整性：${metadata.integrity || 'Registry 未提供'}`,
    `静态权限提示：${metadata.capabilities.join('；') || '未声明'}`,
    `安装脚本：${metadata.installScripts.length ? `${metadata.installScripts.join('、')}（已阻止执行）` : '无'}`,
    '',
    '权限标签仅来自静态推断，不构成沙箱或授权隔离。',
    '插件可能读取 API Key、会话和已授权文件，也可能直接联网。',
  ]
  const answer = await dialog.showMessageBox(ownerWindow(event), {
    type: 'warning',
    title: action === 'update' ? '确认更新插件' : '确认安装插件',
    message: '第三方插件会在 Harness 进程中运行',
    detail: lines.join('\n'),
    buttons: ['取消', action === 'update' ? '确认更新' : '确认安装'],
    cancelId: 0,
    defaultId: 0,
    noLink: true,
  })
  return answer.response === 1
}

function previousInstallInfo() {
  if (!app.isPackaged) return null
  try {
    const installDirectory = path.dirname(process.execPath)
    const root = path.join(path.dirname(installDirectory), '.dsh-desktop-previous')
    const script = path.join(root, 'restore-previous-install.ps1')
    const manifestFile = path.join(root, 'previous-install.json')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/u, ''))
    const executableName = manifest.executableName
    if (typeof executableName !== 'string'
      || path.basename(executableName) !== executableName
      || path.extname(executableName).toLowerCase() !== '.exe'
      || !['pending-health-check', 'healthy'].includes(manifest.state)
      || String(manifest.version || '') === app.getVersion()) {
      return null
    }
    const backupDirectory = path.resolve(manifest.backupDir)
    const expectedBackup = path.join(root, 'app')
    const backupExecutable = path.join(backupDirectory, executableName)
    if (!samePath(manifest.installDir, installDirectory)
      || !samePath(backupDirectory, expectedBackup)
      || !fs.existsSync(script)
      || !fs.lstatSync(script).isFile()
      || fs.lstatSync(script).isSymbolicLink()
      || !fs.existsSync(backupExecutable)
      || !fs.lstatSync(backupExecutable).isFile()
      || fs.lstatSync(backupExecutable).isSymbolicLink()) {
      return null
    }
    return {
      root,
      script,
      manifest,
      installDirectory,
      backupExecutable,
      previousExecutable: path.join(installDirectory, executableName),
    }
  } catch {
    return null
  }
}

function programRollbackJournalFile() {
  return getProgramRollbackJournalPath(app.getPath('userData'))
}

function programRollbackRecoveryDirectory(label = 'Recovery') {
  return path.join(
    app.getPath('userData'),
    'rollback-backups',
    `${label}-${Date.now()}-${process.pid}`,
  )
}

function recoverCurrentProgramData(journalFile = programRollbackJournalFile()) {
  const journal = readProgramRollbackJournal(journalFile)
  const expectedTargets = trustedProgramRollbackTargets(journal)
  return recoverProgramRollback({
    journalFile,
    expectedConfigFile: configFile,
    ...expectedTargets,
    currentAppVersion: app.getVersion(),
    harnessVersion: readHarnessVersion(),
    recoveryRollbackDirectory: programRollbackRecoveryDirectory('Program-Rollback-Recovery'),
    restoreDataBackup,
  })
}

function trustedProgramRollbackTargets(journal) {
  if (!journal || !journal.dataChanged || journal.state === 'prepared'
    || ['program-restored', 'data-recovered'].includes(journal.state)) {
    return {}
  }
  const currentSnapshot = readBackupDataSettings(
    journal.dataRollbackDirectory,
    defaultDataDirectory(),
  )
  const expectedTargets = { expectedDataDirectory: currentSnapshot.dataDirectory }
  if (!journal.secondaryDataDirectory) return expectedTargets

  const status = upgradeSafety?.getStatus()
  if (!status?.rollbackAvailable
    || !status.rollback?.backupDirectory
    || String(status.rollback.previousAppVersion || '') !== journal.previousAppVersion) {
    throw new Error('找不到可验证原数据目标的升级前快照，已停止程序回滚恢复')
  }
  const previousSnapshot = readBackupDataSettings(
    status.rollback.backupDirectory,
    defaultDataDirectory(),
  )
  expectedTargets.expectedSecondaryDataDirectory = previousSnapshot.dataDirectory
  return expectedTargets
}

async function spawnProgramRollbackHelper(previous, journalFile) {
  const powershell = path.join(
    process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const readyFile = path.join(
    path.dirname(journalFile),
    `program-rollback-helper-${process.pid}-${Date.now()}.json`,
  )
  try { fs.rmSync(readyFile, { force: true }) } catch {}
  const helper = childProcess.spawn(powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    previous.script,
    '-JournalPath',
    journalFile,
    '-CurrentExecutable',
    process.execPath,
    '-WaitProcessId',
    String(process.pid),
    '-ReadyFile',
    readyFile,
  ], {
    cwd: app.getPath('userData'),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      helper.removeListener('spawn', onSpawn)
      reject(error)
    }
    const onSpawn = () => {
      helper.removeListener('error', onError)
      resolve(helper)
    }
    helper.once('error', onError)
    helper.once('spawn', onSpawn)
  })

  const deadline = Date.now() + 45_000
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(readyFile)) {
        const ready = JSON.parse(fs.readFileSync(readyFile, 'utf8').replace(/^\uFEFF/u, ''))
        if (ready.schemaVersion !== 1
          || ready.processId !== helper.pid
          || ready.waitProcessId !== process.pid
          || !samePath(ready.journalPath, journalFile)) {
          throw new Error('程序回滚帮助进程返回了无效的就绪凭据')
        }
        return helper
      }
      if (helper.exitCode !== null || helper.signalCode !== null) {
        throw new Error(`程序回滚帮助进程过早退出（${helper.exitCode ?? helper.signalCode ?? '未知'}）`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('程序回滚帮助进程就绪超时')
  } catch (error) {
    error.rollbackHelper = helper
    throw error
  } finally {
    try { fs.rmSync(readyFile, { force: true }) } catch {}
  }
}

function waitForProgramRollbackHelperExit(helper, timeoutMs) {
  if (helper.exitCode !== null || helper.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let completed = false
    const finish = (exited) => {
      if (completed) return
      completed = true
      clearTimeout(timer)
      helper.removeListener('exit', onExit)
      helper.removeListener('close', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(helper.exitCode !== null || helper.signalCode !== null), timeoutMs)
    helper.once('exit', onExit)
    helper.once('close', onExit)
  })
}

async function stopProgramRollbackHelper(helper) {
  if (!helper || helper.exitCode !== null || helper.signalCode !== null) return
  try { helper.kill() } catch {}
  if (await waitForProgramRollbackHelperExit(helper, 5_000)) return
  if (process.platform === 'win32') {
    const killer = childProcess.spawn('taskkill', ['/PID', String(helper.pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    let killerError = null
    try {
      await new Promise((resolve, reject) => {
        killer.once('error', reject)
        killer.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`taskkill 退出代码 ${code}`))))
      })
    } catch (error) {
      killerError = error
    }
    if (await waitForProgramRollbackHelperExit(helper, 5_000)) return
    if (killerError) throw killerError
  }
  throw new Error('程序回滚帮助进程停止超时')
}

function prepareManualUpgradeSnapshot() {
  const previous = previousInstallInfo()
  if (!previous || previous.manifest.state !== 'pending-health-check') return null
  const dataDirectory = readDataDirectoryBeforeMigration(configFile, defaultDataDirectory())
  if (fs.existsSync(dataDirectory)
    && !samePath(dataDirectory, defaultDataDirectory())
    && !isManagedDataDirectory(dataDirectory)) {
    throw new Error('升级前自定义 Harness 数据目录缺少桌面版标记，已停止设置迁移')
  }
  return upgradeSafety.prepare(dataDirectory, {
    previousAppVersion: String(previous.manifest.version || ''),
    previousHarnessVersion: upgradeSafety.getStatus().lastSuccessfulHarnessVersion,
  })
}

function interruptedRestoreExpectedTargets(journalFile) {
  const fallbackDataDirectory = defaultDataDirectory()
  if (!fs.existsSync(journalFile)) {
    return { configFile, dataDirectory: fallbackDataDirectory }
  }
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8').replace(/^\uFEFF/u, ''))
  if (!/^\d+-\d+$/u.test(String(journal?.token || '')) || !Array.isArray(journal.entries)) {
    return { configFile, dataDirectory: fallbackDataDirectory }
  }

  const activeProgramRollback = readProgramRollbackJournal(programRollbackJournalFile())
  const trustedProgramTargets = trustedProgramRollbackTargets(activeProgramRollback)
  if (trustedProgramTargets.expectedSecondaryDataDirectory
    && samePath(activeProgramRollback.configFile, configFile)
    && samePath(journal.dataDirectory, trustedProgramTargets.expectedSecondaryDataDirectory)) {
    return { configFile, dataDirectory: trustedProgramTargets.expectedSecondaryDataDirectory }
  }

  const configEntry = journal.entries.find((entry) => entry?.kind === 'config')
  if (configEntry?.hadPrevious !== true) {
    return { configFile, dataDirectory: fallbackDataDirectory }
  }
  const previousConfig = `${configFile}.restore-previous-${journal.token}`
  const sourceConfig = fs.existsSync(previousConfig) ? previousConfig : configFile
  return {
    configFile,
    dataDirectory: readDataDirectoryBeforeMigration(sourceConfig, fallbackDataDirectory),
  }
}

function markPreviousInstallHealthy() {
  const previous = previousInstallInfo()
  if (!previous || previous.manifest.state !== 'pending-health-check') return false
  const manifestFile = path.join(previous.root, 'previous-install.json')
  const next = {
    ...previous.manifest,
    state: 'healthy',
    healthyAt: new Date().toISOString(),
    healthyAppVersion: app.getVersion(),
    healthyHarnessVersion: readHarnessVersion(),
  }
  const temporary = `${manifestFile}.${process.pid}.${Date.now()}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, manifestFile)
    return true
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}

function mapDesktopUpdateState(value = desktopUpdateManager?.getState()) {
  const state = value || {
    configured: false,
    status: 'unconfigured',
    currentVersion: app.getVersion(),
  }
  const progress = state.progress && typeof state.progress === 'object'
    ? Number(state.progress.percent) || 0
    : Number(state.progress) || 0
  return {
    phase: state.status,
    configured: state.configured === true,
    currentVersion: state.currentVersion || app.getVersion(),
    latestDesktopVersion: state.downloadedVersion || state.availableVersion || '',
    latestVersion: state.downloadedVersion || state.availableVersion || '',
    updateAvailable: ['available', 'downloading', 'downloaded', 'postponed'].includes(state.status),
    downloaded: state.status === 'downloaded' || state.status === 'postponed',
    progress,
    bytesPerSecond: state.progress?.bytesPerSecond || 0,
    error: state.error?.message || '',
    message: state.error?.message || (state.status === 'unconfigured'
      ? '此安装包尚未配置 HTTPS 更新发布源。'
      : ''),
    checkedAt: ['available', 'current'].includes(state.status) ? new Date().toISOString() : '',
    channel: state.channel || 'stable',
    rollbackAvailable: Boolean(previousInstallInfo()),
  }
}

function initializeDesktopUpdater(settings) {
  let feed = { url: '' }
  try {
    feed = resolveUpdateFeed({
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      developmentUrl: process.env.DSH_DESKTOP_UPDATE_URL || '',
    })
  } catch (error) {
    appendLifecycleLog(`invalid desktop update feed: ${error.message}`)
  }
  const embeddedConfig = app.isPackaged
    && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))
  desktopUpdateManager = new DesktopUpdateManager({
    autoUpdater: electronAutoUpdater,
    feedUrl: feed.url || '',
    hasEmbeddedConfig: embeddedConfig,
    currentVersion: app.getVersion(),
    channel: settings.updateChannel || 'stable',
    autoDownload: settings.autoDownloadUpdates === true,
    logger: appendLifecycleLog,
  })
  desktopUpdateManager.on('state', (next) => {
    const updateState = mapDesktopUpdateState(next)
    publishStatus({
      updateState,
      updateProgress: updateState.progress,
    })
    if (next.status === 'downloaded') {
      notifyUser('桌面更新已下载', `版本 ${next.downloadedVersion || next.availableVersion} 已准备好安装。`)
    }
  })
}

function runHarnessUpdateCheck() {
  if (harnessUpdateCheckTask) return harnessUpdateCheckTask
  harnessUpdateCheckTask = checkForHarnessUpdate(readHarnessVersion(), {
    fetchImpl: (...args) => net.fetch(...args),
  })
    .then((result) => {
      publishStatus({ harnessUpdateInfo: result })
      return result
    })
    .finally(() => {
      harnessUpdateCheckTask = null
    })
  return harnessUpdateCheckTask
}

function runExclusive(task) {
  const result = maintenanceSerial.catch(() => {}).then(task)
  maintenanceSerial = result.catch(() => {})
  return result
}

function startWasCancelled(generation) {
  return quitting
    || generation !== harnessStartGeneration
    || !mainWindow
    || mainWindow.isDestroyed()
}

async function stopHarnessForOperation() {
  harnessStartGeneration += 1
  stopHarnessNotifications()
  await harnessManager?.stop()
  await harnessStartSerial.catch(() => {})
  await harnessManager?.stop()
}

async function clearCurrentHarnessSiteData() {
  const dedicatedSession = mainWindow?.webContents?.session
    || settingsWindow?.webContents?.session
    || electronSession.fromPartition(DESKTOP_SESSION_PARTITION)
  const sessions = new Set([dedicatedSession, electronSession.defaultSession].filter(Boolean))
  await Promise.all([...sessions].map((targetSession) => clearSessionPartitionData(targetSession)))
  return { clearedPartitions: sessions.size }
}

async function runHarnessStart(generation) {
  if (startWasCancelled(generation)) return
  publishStatus({
    phase: 'loading',
    message: '正在启动 DeepSeek Harness…',
    errorCode: '',
    errorCategory: '',
  })
  await loadLocalPage(mainWindow, 'loading')
  if (startWasCancelled(generation)) return

  try {
    const settings = configStore.getRuntimeSettings(defaultDataDirectory())
    const workspaceAssessment = inspectWorkspaceForPermission(settings.workspace, settings.permissionMode)
    if (!workspaceAssessment.ok) {
      const error = new Error(workspaceAssessment.risks?.at(-1)?.message || '工作区不可用')
      error.code = workspaceAssessment.errorCode || 'WORKSPACE_INVALID'
      error.details = workspaceAssessment
      throw error
    }
    if (settings.permissionMode === 'danger-full-access') {
      let approved = fullAccessApprovedOnce
      fullAccessApprovedOnce = false
      if (!approved) {
        approved = await confirmFullAccess(mainWindow, '每次启动 Full Access 会话都需要重新确认，本次确认不会保存。')
      }
      if (!approved) {
        const error = new Error('本次未启用 Full Access，请在“模式与权限”中改用只读或工作区写入')
        error.code = 'PERMISSION_CONFIRMATION_REQUIRED'
        throw error
      }
    }

    stopHarnessNotifications()
    await harnessManager.stop()
    if (startWasCancelled(generation)) return
    fs.mkdirSync(settings.dataDirectory, { recursive: true, mode: 0o700 })
    if (path.resolve(settings.dataDirectory) === path.resolve(defaultDataDirectory())) {
      writeDataMarker(settings.dataDirectory)
    }
    rotatingLog?.setSecrets([settings.apiKey])

    const manager = getPluginManager(settings.dataDirectory)
    if (configStore.getPublicSettings().pluginSafeMode
      && !fs.existsSync(manager.safeModeFile)) {
      manager.enterSafeMode()
    }

    upgradeSafety.prepare(settings.dataDirectory)
    const url = await harnessManager.start({
      executable: process.execPath,
      dshBin: resolveDshBin(),
      dshHome: settings.dataDirectory,
      workspace: settings.workspace,
      apiKey: settings.apiKey,
      permissionMode: settings.permissionMode,
      host: '127.0.0.1',
      port: 0,
    })
    if (startWasCancelled(generation)) {
      await harnessManager.stop()
      return
    }
    await ensureWorkspace(url, settings.workspace, { workMode: settings.workMode })
    if (startWasCancelled(generation)) {
      await harnessManager.stop()
      return
    }
    startHarnessNotifications(url)
    harnessOrigin = new URL(url).origin
    lastHarnessOrigin = harnessOrigin
    await mainWindow.loadURL(url)
    if (startWasCancelled(generation)) {
      stopHarnessNotifications()
      await harnessManager.stop()
      return
    }
    configStore.markWorkspaceUsed(settings.workspace)
    publishStatus({
      phase: 'ready',
      message: 'DeepSeek Harness 已就绪',
      errorCode: '',
      errorCategory: '',
    })
    clearTimeout(healthyResetTimer)
    healthyResetTimer = setTimeout(() => {
      if (generation !== harnessStartGeneration
        || runtimeState.phase !== 'ready'
        || harnessManager.state !== 'running') return
      crashRecoveryAttempts = 0
      try {
        upgradeSafety.markHealthy()
        if (markPreviousInstallHealthy()) {
          appendLifecycleLog('The previous program backup was marked healthy and remains available for rollback.')
        }
        publishStatus({ updateState: mapDesktopUpdateState() })
      } catch (error) {
        appendLifecycleLog(`could not commit healthy startup: ${error.message}`)
      }
    }, 30_000)
    appendLifecycleLog(`Harness ready at loopback origin with permission mode ${settings.permissionMode}`)
  } catch (error) {
    stopHarnessNotifications()
    try {
      await harnessManager.stop()
    } catch (stopError) {
      appendLifecycleLog(`startup cleanup failed: ${stopError?.message || String(stopError)}`)
    }
    try {
      upgradeSafety?.markFailed(error)
    } catch (stateError) {
      appendLifecycleLog(`could not record failed upgrade start: ${stateError.message}`)
    }
    if (startWasCancelled(generation)) return
    const payload = errorPayload(error, 'DeepSeek Harness 启动失败')
    appendLifecycleLog(`startup failed [${payload.code}]: ${payload.message}`)
    publishStatus({
      phase: 'error',
      message: payload.message,
      errorCode: payload.code,
      errorCategory: payload.category,
    })
    await loadLocalPage(mainWindow, 'error', payload.message, '', payload)
  }
}

function startHarness() {
  const generation = ++harnessStartGeneration
  const task = harnessStartSerial
    .catch(() => {})
    .then(() => runHarnessStart(generation))
  harnessStartSerial = task
  return task
}

async function stopHarnessForQuit() {
  stopHarnessNotifications()
  let stopError = null
  try {
    await harnessManager?.stop()
  } catch (error) {
    stopError = error
    appendLifecycleLog(`initial shutdown failed: ${error?.message || String(error)}`)
  }
  await harnessStartSerial.catch(() => {})
  try {
    await harnessManager?.stop()
    stopError = null
  } catch (error) {
    stopError = error
    appendLifecycleLog(`final shutdown failed: ${error?.message || String(error)}`)
  }
  if (stopError) appendLifecycleLog('Desktop is exiting after Harness shutdown retries failed.')
}

function requestQuit() {
  if (quitTask) return quitTask
  quitting = true
  harnessStartGeneration += 1
  clearTimeout(crashRecoveryTimer)
  clearTimeout(healthyResetTimer)
  stopHarnessNotifications()
  for (const window of [mainWindow, settingsWindow]) {
    if (window && !window.isDestroyed()) window.hide()
  }

  let timeout
  const cleanupTimeout = new Promise((resolve) => {
    timeout = setTimeout(() => {
      appendLifecycleLog(`Harness shutdown exceeded ${QUIT_CLEANUP_TIMEOUT_MS} ms; forcing desktop exit.`)
      resolve()
    }, QUIT_CLEANUP_TIMEOUT_MS)
  })
  quitTask = Promise.race([
    stopHarnessForQuit(),
    cleanupTimeout,
  ]).catch((error) => {
    appendLifecycleLog(`desktop shutdown failed: ${error?.message || String(error)}`)
  }).finally(() => {
    clearTimeout(timeout)
    tray?.destroy()
    tray = null
    exitCommitted = true
    app.exit(0)
  })
  return quitTask
}

async function restartAfterOperation() {
  if (!quitting) void startHarness()
}

function restartConfiguredHarnessAfterFailure() {
  if (quitting) return false
  try {
    if (configStore?.getPublicSettings().configured) {
      void restartAfterOperation()
      return true
    }
  } catch (error) {
    appendLifecycleLog(`could not determine whether Harness should restart: ${error?.message || String(error)}`)
  }
  return false
}

function getPublicState() {
  let settings
  try {
    settings = configStore.getPublicSettings()
  } catch (error) {
    const payload = errorPayload(error)
    runtimeState = {
      ...runtimeState,
      phase: 'error',
      message: payload.message,
      errorCode: payload.code,
      errorCategory: payload.category,
    }
    settings = {
      configured: false,
      hasApiKey: false,
      workspace: '',
      recentWorkspaces: [],
      theme: 'system',
      checkForUpdates: true,
      dataDirectory: '',
      permissionMode: 'workspace-write',
      workMode: 'normal',
      startAtLogin: false,
      minimizeToTray: false,
      notifications: true,
      autoDownloadUpdates: true,
      updateChannel: 'stable',
      diagnosticMode: false,
      crashRecovery: true,
      pluginSafeMode: false,
    }
  }
  const workspaceAssessment = settings.workspace
    ? mapWorkspaceAssessment(inspectWorkspaceForPermission(settings.workspace, settings.permissionMode))
    : null
  return {
    ...runtimeState,
    ...settings,
    recentWorkspaces: (settings.recentWorkspaces || []).map((entry) => ({
      ...entry,
      name: path.basename(entry.path),
      lastUsedLabel: Number.isFinite(Date.parse(entry.lastUsedAt))
        ? new Date(entry.lastUsedAt).toLocaleDateString('zh-CN')
        : '最近使用',
    })),
    workspaceAssessment,
    defaultWorkspace: defaultWorkspaceSuggestion,
    defaultDataDirectory: defaultDataDirectory(),
    appVersion: app.getVersion(),
    harnessVersion: readHarnessVersion(),
    resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    updateState: mapDesktopUpdateState(),
  }
}

async function saveConnectionSettings(event, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('设置内容无效')
  }
  const current = configStore.getPublicSettings()
  const candidateKey = typeof payload.apiKey === 'string' && payload.apiKey.trim()
    ? payload.apiKey.trim()
    : undefined
  if (!current.hasApiKey && !candidateKey) {
    const error = new Error('请填写并测试 DeepSeek API Key')
    error.code = 'API_KEY_MISSING'
    throw error
  }
  if (candidateKey) {
    const result = await testDeepSeekApiKey(candidateKey, { fetchImpl: (...args) => net.fetch(...args) })
    if (!result.ok) {
      const error = new Error(result.message)
      error.code = result.code === 'KEY_REJECTED' ? 'API_KEY_INVALID' : result.code
      throw error
    }
  }

  const requestedPermission = payload.permissionMode || current.permissionMode || 'workspace-write'
  const assessment = inspectWorkspaceForPermission(payload.workspace, requestedPermission)
  if (!assessment.ok) {
    const error = new Error(assessment.risks?.at(-1)?.message || '工作区不可用')
    error.code = assessment.errorCode || 'WORKSPACE_INVALID'
    error.details = assessment
    throw error
  }
  if (!await confirmWorkspaceRisks(event, assessment)) {
    const error = new Error('已取消使用该工作区')
    error.code = 'WORKSPACE_CONFIRMATION_REQUIRED'
    throw error
  }

  if (requestedPermission === 'full-access') {
    if (!await confirmFullAccess(ownerWindow(event), '保存后将立即以 Full Access 重新启动 Harness。')) {
      const error = new Error('已取消启用 Full Access')
      error.code = 'PERMISSION_CONFIRMATION_REQUIRED'
      throw error
    }
    fullAccessApprovedOnce = true
  }

  const currentData = effectiveDataDirectory(current)
  const requestedData = payload.dataDirectory === undefined
    ? currentData
    : payload.dataDirectory
  const targetData = validateDataDirectory(requestedData, assessment.path, currentData)
  const persistedData = targetData === path.resolve(defaultDataDirectory()) ? '' : targetData

  return runExclusive(async () => {
    await stopHarnessForOperation()
    let saved
    try {
      if (!samePath(currentData, targetData)) {
        if (fs.existsSync(currentData)) {
          migrateDataDirectory(currentData, targetData, { strategy: 'merge' })
        }
        writeDataMarker(targetData)
      }
      saved = configStore.save({
        workspace: assessment.path,
        apiKey: candidateKey,
        dataDirectory: persistedData,
        workMode: payload.workMode || current.workMode || 'normal',
        permissionMode: requestedPermission,
      })
      pluginManager = null
      pluginManagerHome = ''
      appendLifecycleLog(candidateKey
        ? 'API Key was validated and atomically replaced.'
        : 'Connection settings were updated without changing the saved API Key.')
    } catch (error) {
      fullAccessApprovedOnce = false
      if (current.configured) void restartAfterOperation()
      throw error
    }
    void restartAfterOperation()
    return saved
  })
}

function registerIpc() {
  registerIpcHandler('desktop:get-state', () => getPublicState())

  registerIpcHandler('desktop:choose-workspace', async (event, permissionMode) => {
    const currentSettings = configStore.getPublicSettings()
    const current = currentSettings.workspace
      || defaultWorkspaceSuggestion
      || app.getPath('documents')
    const result = await dialog.showOpenDialog(ownerWindow(event), {
      title: '选择 DeepSeek 工作区',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '使用这个文件夹',
    })
    if (result.canceled) return null
    const selected = result.filePaths[0]
    return {
      path: selected,
      assessment: mapWorkspaceAssessment(inspectWorkspaceForPermission(
        selected,
        permissionMode || currentSettings.permissionMode,
      )),
    }
  })

  registerIpcHandler('desktop:inspect-workspace', (_event, workspace, permissionMode) => {
    const effectivePermission = permissionMode || configStore.getPublicSettings().permissionMode
    return mapWorkspaceAssessment(inspectWorkspaceForPermission(workspace, effectivePermission))
  })

  registerIpcHandler('desktop:choose-data-directory', async (event) => {
    const current = effectiveDataDirectory()
    const result = await dialog.showOpenDialog(ownerWindow(event), {
      title: '选择 Harness 数据目录',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '使用这个文件夹',
    })
    return result.canceled ? null : { path: result.filePaths[0] }
  })

  registerIpcHandler('desktop:test-api-key', async (_event, apiKey) => (
    testDeepSeekApiKey(apiKey, { fetchImpl: (...args) => net.fetch(...args) })
  ))

  registerIpcHandler('desktop:test-saved-api-key', async () => {
    const apiKey = configStore.getDecryptedApiKey()
    return testDeepSeekApiKey(apiKey, { fetchImpl: (...args) => net.fetch(...args) })
  })

  registerIpcHandler('desktop:delete-api-key', () => runExclusive(async () => {
    await stopHarnessForOperation()
    try {
      await clearCurrentHarnessSiteData()
      const saved = configStore.clearApiKey()
      rotatingLog?.setSecrets([])
      publishStatus({ phase: 'setup', message: 'API Key 已删除，请填写新的 Key' })
      if (mainWindow && !mainWindow.isDestroyed()) {
        await loadLocalPage(mainWindow, 'setup', 'API Key 已删除，请填写并测试新的 Key。')
      }
      return saved
    } catch (error) {
      restartConfiguredHarnessAfterFailure()
      throw error
    }
  }))

  registerIpcHandler('desktop:save-settings', saveConnectionSettings)

  registerIpcHandler('desktop:set-preferences', (_event, preferences) => {
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
      throw new TypeError('偏好设置内容无效')
    }
    for (const field of Object.keys(preferences)) {
      if (!PREFERENCE_FIELDS.has(field)) throw new TypeError(`不允许通过偏好入口修改 ${field}`)
    }
    const saved = configStore.savePreferences(preferences)
    if (preferences.theme !== undefined) applyTheme(saved.theme)
    applyLoginPreference(saved)
    syncTray()
    desktopUpdateManager?.configure({
      channel: saved.updateChannel,
      autoDownload: saved.autoDownloadUpdates,
    })
    installMenu()
    publishStatus({
      ...saved,
      resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      updateState: mapDesktopUpdateState(),
    })
    if (saved.checkForUpdates && preferences.checkForUpdates === true) {
      void desktopUpdateManager?.check().catch(() => {})
    }
    return saved
  })

  registerIpcHandler('desktop:retry-start', () => {
    void startHarness()
    return true
  })

  registerIpcHandler('desktop:open-api-keys', async () => {
    await shell.openExternal(API_KEYS_URL)
    return true
  })
  registerIpcHandler('desktop:open-settings', () => {
    openSettingsWindow('api-key')
    return true
  })
  registerIpcHandler('desktop:open-settings-section', (_event, section) => {
    openSettingsWindow(normalizeSettingsSection(section))
    return true
  })
  registerIpcHandler('desktop:set-theme', (_event, theme) => saveAndApplyTheme(theme))
  registerIpcHandler('desktop:set-update-preference', (_event, enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('更新检查设置无效')
    const saved = configStore.savePreferences({ checkForUpdates: enabled })
    if (enabled) void desktopUpdateManager?.check().catch(() => {})
    return saved
  })
  registerIpcHandler('desktop:check-harness-update', () => runHarnessUpdateCheck())

  registerIpcHandler('desktop:check-app-update', async () => {
    const [desktopState, harnessInfo] = await Promise.all([
      desktopUpdateManager.check(),
      runHarnessUpdateCheck().catch(() => null),
    ])
    return {
      ...mapDesktopUpdateState(desktopState),
      latestHarnessVersion: harnessInfo?.latestVersion || readHarnessVersion(),
      harnessUpdateAvailable: harnessInfo?.updateAvailable === true,
      releaseSummary: harnessInfo?.updateAvailable
        ? `官方 Harness 最新版本为 ${harnessInfo.latestVersion}；桌面版只通过完整安装包升级核心。`
        : '',
    }
  })
  registerIpcHandler('desktop:download-update', async () => (
    mapDesktopUpdateState(await desktopUpdateManager.download())
  ))
  registerIpcHandler('desktop:postpone-update', () => (
    mapDesktopUpdateState(desktopUpdateManager.postpone())
  ))
  registerIpcHandler('desktop:install-downloaded-update', () => runExclusive(async () => {
    const state = desktopUpdateManager.getState()
    if (!state.downloadedVersion) throw new Error('更新尚未下载完成')
    const settings = configStore.getPublicSettings()
    const targetSafety = createUpgradeSafety(state.downloadedVersion, readHarnessVersion())
    await stopHarnessForOperation()
    try {
      targetSafety.prepare(effectiveDataDirectory(settings), {
        previousAppVersion: app.getVersion(),
        previousHarnessVersion: readHarnessVersion(),
      })
    } catch (error) {
      void restartAfterOperation()
      throw error
    }
    quitting = true
    for (const window of [mainWindow, settingsWindow]) window?.hide()
    try {
      exitCommitted = true
      desktopUpdateManager.install()
    } catch (error) {
      exitCommitted = false
      quitting = false
      void restartAfterOperation()
      throw error
    }
    return true
  }))

  registerIpcHandler('desktop:rollback-update', (event) => runExclusive(async () => {
    const previous = previousInstallInfo()
    if (!previous) throw new Error('没有可恢复的上一版完整安装')
    const answer = await dialog.showMessageBox(ownerWindow(event), {
      type: 'warning',
      title: '恢复上一版',
      message: `将恢复桌面版 ${previous.manifest.version || '上一版本'}`,
      detail: '应用会先恢复升级前数据，再替换完整程序目录并自动重新打开。当前版本会保留在失败版本目录中。',
      buttons: ['取消', '恢复上一版'],
      cancelId: 0,
      defaultId: 0,
      noLink: true,
    })
    if (answer.response !== 1) return { canceled: true }

    await stopHarnessForOperation()
    const dataDirectory = effectiveDataDirectory()
    const status = upgradeSafety.getStatus()
    if (!samePath(dataDirectory, defaultDataDirectory()) && !isManagedDataDirectory(dataDirectory)) {
      restartConfiguredHarnessAfterFailure()
      throw new Error('自定义 Harness 数据目录缺少桌面版标记，已停止程序回滚')
    }
    if (!status.rollbackAvailable
      || !status.rollback?.backupDirectory
      || String(status.rollback.previousAppVersion || '') !== String(previous.manifest.version || '')) {
      restartConfiguredHarnessAfterFailure()
      throw new Error('找不到与上一版程序匹配的升级前数据快照，已停止程序回滚')
    }
    const rollbackSettings = readBackupDataSettings(
      status.rollback.backupDirectory,
      defaultDataDirectory(),
    )
    const rollbackDataDirectory = rollbackSettings.dataDirectory
    if (!samePath(rollbackDataDirectory, defaultDataDirectory())
      && fs.existsSync(rollbackDataDirectory)
      && !isManagedDataDirectory(rollbackDataDirectory)) {
      restartConfiguredHarnessAfterFailure()
      throw new Error('上一版自定义数据目录缺少桌面版标记，已停止程序回滚')
    }
    if (rollbackSettings.workspace
      && (isSameOrInside(rollbackDataDirectory, rollbackSettings.workspace)
        || isSameOrInside(rollbackSettings.workspace, rollbackDataDirectory))) {
      restartConfiguredHarnessAfterFailure()
      throw new Error('上一版数据目录与工作区重叠，已停止程序回滚')
    }
    const journalFile = programRollbackJournalFile()
    const rollbackDirectory = programRollbackRecoveryDirectory('Before-App-Rollback')
    const distinctRollbackDataTarget = !samePath(rollbackDataDirectory, dataDirectory)
    const secondaryRollbackDirectory = distinctRollbackDataTarget
      ? programRollbackRecoveryDirectory('Old-Target-Before-App-Rollback')
      : null
    let journalCreated = false
    let helper = null
    try {
      createProgramRollbackJournal(journalFile, {
        currentAppVersion: app.getVersion(),
        previousAppVersion: String(previous.manifest.version || ''),
        configFile,
        dataDirectory,
        dataChanged: true,
        dataRollbackDirectory: rollbackDirectory,
        secondaryDataDirectory: distinctRollbackDataTarget ? rollbackDataDirectory : null,
        secondaryRollbackDirectory,
        programRoot: previous.root,
        script: previous.script,
        installDirectory: previous.installDirectory,
        currentExecutable: process.execPath,
        previousExecutable: previous.previousExecutable,
      })
      journalCreated = true

      createDataBackup({
        destination: rollbackDirectory,
        configFile,
        dataDirectory,
        appVersion: app.getVersion(),
        harnessVersion: readHarnessVersion(),
      })
      markProgramRollbackState(journalFile, 'data-backup-ready')
      const restoredData = restoreDataBackup({
        backupDirectory: status.rollback.backupDirectory,
        configFile,
        dataDirectory: rollbackDataDirectory,
        rollbackDirectory: secondaryRollbackDirectory
          || programRollbackRecoveryDirectory('Old-Target-Before-App-Rollback'),
        appVersion: app.getVersion(),
        harnessVersion: readHarnessVersion(),
      })
      if (restoredData.journalFile || restoredData.cleanupWarnings.length > 0) {
        throw new Error('上一版数据已恢复，但事务清理未完成；已停止程序交接并恢复当前版本')
      }
      markProgramRollbackState(journalFile, 'data-restored')
      markProgramRollbackState(journalFile, 'helper-launched')
      try {
        helper = await spawnProgramRollbackHelper(previous, journalFile)
      } catch (spawnError) {
        helper = spawnError.rollbackHelper || helper
        throw spawnError
      }
      helper.unref()
    } catch (error) {
      try {
        await stopProgramRollbackHelper(helper)
      } catch (stopError) {
        error.code = 'PROGRAM_ROLLBACK_HANDOFF_ACTIVE'
        error.details = { stopError: stopError.message }
        appendLifecycleLog(`program rollback helper could not be stopped: ${stopError.message}`)
        const payload = errorPayload(error)
        publishStatus({ phase: 'error', message: payload.message, errorCode: payload.code, errorCategory: payload.category })
        if (mainWindow && !mainWindow.isDestroyed()) await loadLocalPage(mainWindow, 'error', payload.message, '', payload)
        throw error
      }
      if (journalCreated) {
        try {
          const journal = readProgramRollbackJournal(journalFile)
          if (journal && ['data-restored', 'data-unchanged', 'helper-launched'].includes(journal.state)) {
            try { markProgramRollbackState(journalFile, 'program-failed', { error: error.message }) } catch {}
          }
          const recovered = recoverCurrentProgramData(journalFile)
          appendLifecycleLog(`program rollback was canceled and current data recovered (${recovered.action})`)
          configStore = new ConfigStore(configFile, createCodec())
        } catch (recoveryError) {
          appendLifecycleLog(`program rollback recovery failed: ${recoveryError.message}`)
          error.code = 'PROGRAM_ROLLBACK_RECOVERY_FAILED'
          error.details = { recoveryError: recoveryError.message }
          const payload = errorPayload(error)
          publishStatus({ phase: 'error', message: payload.message, errorCode: payload.code, errorCategory: payload.category })
          if (mainWindow && !mainWindow.isDestroyed()) await loadLocalPage(mainWindow, 'error', payload.message, '', payload)
          throw error
        }
      }
      restartConfiguredHarnessAfterFailure()
      throw error
    }
    void requestQuit()
    return { restoring: true }
  }))

  registerIpcHandler('desktop:list-plugins', () => listPlugins())
  registerIpcHandler('desktop:install-plugin', async (event, id) => {
    const manager = getPluginManager()
    const metadata = await manager.inspect(id)
    if (!await confirmPluginReview(event, metadata, 'install')) return { canceled: true }
    return runExclusive(async () => {
      await stopHarnessForOperation()
      try {
        const result = await manager.install(metadata.name, metadata.version, { acceptRisk: true })
        void restartAfterOperation()
        return mapPlugin(result)
      } catch (error) {
        void restartAfterOperation()
        throw error
      }
    })
  })
  registerIpcHandler('desktop:update-plugin', async (event, id) => {
    const manager = getPluginManager()
    const metadata = await manager.inspect(id)
    if (!await confirmPluginReview(event, metadata, 'update')) return { canceled: true }
    return runExclusive(async () => {
      await stopHarnessForOperation()
      try {
        const result = await manager.install(metadata.name, metadata.version, { acceptRisk: true })
        void restartAfterOperation()
        return mapPlugin(result)
      } catch (error) {
        void restartAfterOperation()
        throw error
      }
    })
  })
  registerIpcHandler('desktop:set-plugin-enabled', (_event, id, enabled) => runExclusive(async () => {
    if (typeof enabled !== 'boolean') throw new TypeError('插件启用状态无效')
    await stopHarnessForOperation()
    try {
      const result = getPluginManager().setEnabled(id, enabled)
      void restartAfterOperation()
      return mapPlugin(result)
    } catch (error) {
      void restartAfterOperation()
      throw error
    }
  }))
  registerIpcHandler('desktop:uninstall-plugin', async (event, id) => {
    const answer = await dialog.showMessageBox(ownerWindow(event), {
      type: 'warning',
      title: '卸载插件',
      message: `确认卸载 ${id}？`,
      detail: '卸载前会保留插件配置快照，可从插件列表尝试回滚。',
      buttons: ['取消', '卸载'],
      cancelId: 0,
      defaultId: 0,
      noLink: true,
    })
    if (answer.response !== 1) return { canceled: true }
    return runExclusive(async () => {
      await stopHarnessForOperation()
      try {
        const result = await getPluginManager().uninstall(id)
        void restartAfterOperation()
        return result
      } catch (error) {
        void restartAfterOperation()
        throw error
      }
    })
  })
  registerIpcHandler('desktop:rollback-plugin', async (event, id) => {
    const answer = await dialog.showMessageBox(ownerWindow(event), {
      type: 'question',
      title: '回滚插件',
      message: `恢复 ${id} 的上一个状态？`,
      buttons: ['取消', '恢复'],
      cancelId: 0,
      defaultId: 0,
      noLink: true,
    })
    if (answer.response !== 1) return { canceled: true }
    return runExclusive(async () => {
      await stopHarnessForOperation()
      try {
        const result = await getPluginManager().rollback(id)
        void restartAfterOperation()
        return result?.name ? mapPlugin(result) : result
      } catch (error) {
        void restartAfterOperation()
        throw error
      }
    })
  })
  registerIpcHandler('desktop:set-plugin-safe-mode', (_event, enabled) => runExclusive(async () => {
    if (typeof enabled !== 'boolean') throw new TypeError('插件安全模式设置无效')
    await stopHarnessForOperation()
    try {
      const manager = getPluginManager()
      const result = enabled ? manager.enterSafeMode() : manager.exitSafeMode()
      const saved = configStore.savePreferences({ pluginSafeMode: enabled })
      void restartAfterOperation()
      return { ...saved, pluginSafeModeResult: result }
    } catch (error) {
      void restartAfterOperation()
      throw error
    }
  }))

  registerIpcHandler('desktop:backup-data', async (event) => {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    const selection = await dialog.showSaveDialog(ownerWindow(event), {
      title: '选择备份目录',
      defaultPath: path.join(app.getPath('documents'), `DeepSeek-Harness-Backup-${stamp}`),
      buttonLabel: '创建备份',
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    if (selection.canceled || !selection.filePath) return { canceled: true }
    return runExclusive(async () => {
      const shouldRestart = configStore.getPublicSettings().configured
      await stopHarnessForOperation()
      try {
        const result = createDataBackup({
          destination: selection.filePath,
          configFile,
          dataDirectory: effectiveDataDirectory(),
          appVersion: app.getVersion(),
          harnessVersion: readHarnessVersion(),
        })
        if (shouldRestart) void restartAfterOperation()
        return {
          path: result.destination,
          message: `备份已创建：${result.destination}。会话数据未额外加密，请妥善保管。`,
        }
      } catch (error) {
        if (shouldRestart) void restartAfterOperation()
        throw error
      }
    })
  })

  registerIpcHandler('desktop:restore-data', async (event) => {
    const selection = await dialog.showOpenDialog(ownerWindow(event), {
      title: '选择 DeepSeek Harness 备份目录',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory'],
      buttonLabel: '选择备份',
    })
    if (selection.canceled) return { canceled: true }
    const answer = await dialog.showMessageBox(ownerWindow(event), {
      type: 'warning',
      title: '恢复本机数据',
      message: '恢复会替换当前设置和 Harness 数据',
      detail: '恢复前会自动创建一份回滚备份。工作区文件不会被修改。',
      buttons: ['取消', '开始恢复'],
      cancelId: 0,
      defaultId: 0,
      noLink: true,
    })
    if (answer.response !== 1) return { canceled: true }
    return runExclusive(async () => {
      await stopHarnessForOperation()
      try {
        const currentData = effectiveDataDirectory()
        const result = restoreDataBackup({
          backupDirectory: selection.filePaths[0],
          configFile,
          dataDirectory: currentData,
          rollbackDirectory: path.join(
            app.getPath('userData'),
            'restore-rollbacks',
            `Before-Restore-${Date.now()}`,
          ),
          appVersion: app.getVersion(),
          harnessVersion: readHarnessVersion(),
        })
        configStore = new ConfigStore(configFile, createCodec())
        try {
          configStore.savePreferences({
            dataDirectory: currentData === path.resolve(defaultDataDirectory()) ? '' : currentData,
          })
        } catch (error) {
          appendLifecycleLog(`could not align restored data directory: ${error.message}`)
        }
        let keyWarning = ''
        try {
          if (configStore.getPublicSettings().hasApiKey) configStore.getDecryptedApiKey()
        } catch {
          keyWarning = '；备份中的 API Key 无法由当前 Windows 账户解密，请重新填写'
        }
        await clearCurrentHarnessSiteData()
        setTimeout(() => {
          app.relaunch()
          void requestQuit()
        }, 600)
        return {
          path: result.backupDirectory,
          message: `数据已恢复，应用将重新启动${keyWarning}`,
        }
      } catch (error) {
        restartConfiguredHarnessAfterFailure()
        throw error
      }
    })
  })

  registerIpcHandler('desktop:export-diagnostics', async (event) => {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    const selection = await dialog.showSaveDialog(ownerWindow(event), {
      title: '导出脱敏诊断包',
      defaultPath: path.join(app.getPath('documents'), `DeepSeek-Harness-Diagnostics-${stamp}`),
      buttonLabel: '导出',
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    if (selection.canceled || !selection.filePath) return { canceled: true }
    let secrets = []
    try { secrets = [configStore.getDecryptedApiKey()] } catch {}
    const result = exportDiagnosticBundle({
      destination: selection.filePath,
      configFile,
      logFiles: rotatingLog?.listFiles() || [],
      secrets,
      privateRoots: [app.getPath('home')],
      metadata: {
        appVersion: app.getVersion(),
        harnessVersion: readHarnessVersion(),
        runtime: runtimeState,
        update: mapDesktopUpdateState(),
      },
    })
    return { path: result.destination, message: `脱敏诊断包已导出：${result.destination}` }
  })

  registerIpcHandler('desktop:open-logs', async () => {
    const directory = app.getPath('logs')
    fs.mkdirSync(directory, { recursive: true })
    const failure = await shell.openPath(directory)
    if (failure) throw new Error(failure)
    return { path: directory, message: '日志目录已打开' }
  })

  registerIpcHandler('desktop:clear-user-data', async (event) => {
    const publicSettings = configStore.getPublicSettings()
    const workspace = publicSettings.workspace
    const dataDirectory = effectiveDataDirectory(publicSettings)
    const answer = await dialog.showMessageBox(ownerWindow(event), {
      type: 'warning',
      title: '再次确认清除本机数据',
      message: '将删除 API Key、会话、插件、应用日志和内部状态',
      detail: `不会删除工作区：${workspace || '未设置'}\n\nHarness 数据：${dataDirectory}`,
      buttons: ['取消', '永久清除本机数据'],
      cancelId: 0,
      defaultId: 0,
      noLink: true,
    })
    if (answer.response !== 1) return { canceled: true }
    return runExclusive(async () => {
      await stopHarnessForOperation()
      try {
        await clearCurrentHarnessSiteData()
        if (workspace && (isSameOrInside(dataDirectory, workspace) || isSameOrInside(workspace, dataDirectory))) {
          throw new Error('数据目录与工作区重叠，为避免误删已停止自动清理')
        }
        if (fs.existsSync(dataDirectory)) {
          if (!isManagedDataDirectory(dataDirectory)) {
            throw new Error('自定义数据目录缺少桌面版标记，为避免误删请手动处理该目录')
          }
          fs.rmSync(dataDirectory, { recursive: true, force: true })
        }
        for (const filename of rotatingLog?.listFiles() || []) {
          try { fs.rmSync(filename, { force: true }) } catch {}
        }
        for (const target of [
          configFile,
          path.join(app.getPath('userData'), 'upgrade-state.json'),
          path.join(app.getPath('userData'), 'upgrade-backups'),
          path.join(app.getPath('userData'), 'restore-rollbacks'),
          path.join(app.getPath('userData'), 'rollback-backups'),
          path.join(app.getPath('userData'), 'repair-backups'),
        ]) {
          fs.rmSync(target, { recursive: true, force: true })
        }
        setTimeout(() => {
          app.relaunch()
          void requestQuit()
        }, 600)
        return { message: '本机数据已清除，应用将重新进入首次设置' }
      } catch (error) {
        restartConfiguredHarnessAfterFailure()
        throw error
      }
    })
  })

  registerIpcHandler('desktop:repair-runtime', () => runExclusive(async () => {
    await stopHarnessForOperation()
    const required = [resolveDshBin(), resolveRunner(), resolvePnpmBin()]
    const missing = required.filter((filename) => !fs.existsSync(filename))
    if (missing.length) {
      const error = new Error('内置运行文件不完整，请重新运行完整安装包进行修复')
      error.code = 'RUNTIME_START_FAILED'
      error.details = { missing: missing.map((filename) => path.basename(filename)) }
      throw error
    }
    const manager = getPluginManager()
    const profileManifest = path.join(manager.profileDir, 'package.json')
    if (fs.existsSync(profileManifest)) {
      try {
        JSON.parse(fs.readFileSync(profileManifest, 'utf8'))
      } catch {
        const backupRoot = path.join(app.getPath('userData'), 'repair-backups')
        fs.mkdirSync(backupRoot, { recursive: true })
        const destination = path.join(backupRoot, `web-profile-${Date.now()}`)
        fs.renameSync(manager.profileDir, destination)
        appendLifecycleLog(`corrupt web profile moved to ${destination}`)
      }
    }
    void restartAfterOperation()
    return { message: '内置运行文件已验证，Harness 正在重新启动' }
  }))

  registerIpcHandler('desktop:copy-diagnostics', (_event, context) => {
    const report = sanitizeDiagnosticValue({
      createdAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      harnessVersion: readHarnessVersion(),
      platform: `${process.platform}/${process.arch}`,
      runtime: runtimeState,
      context: context && typeof context === 'object' ? context : {},
      update: mapDesktopUpdateState(),
    })
    clipboard.writeText(JSON.stringify(report, null, 2))
    return true
  })

  registerIpcHandler('desktop:reset-runtime-state', () => runExclusive(async () => {
    await stopHarnessForOperation()
    try {
      await clearCurrentHarnessSiteData()
      crashRecoveryAttempts = 0
      void restartAfterOperation()
      return { message: '运行状态已重置，Harness 正在重新启动' }
    } catch (error) {
      restartConfiguredHarnessAfterFailure()
      throw error
    }
  }))
}

function installMenu() {
  let currentTheme = 'system'
  try {
    currentTheme = configStore?.getPublicSettings().theme || 'system'
  } catch {}
  const template = [
    {
      label: '应用',
      submenu: [
        {
          label: 'API Key 与使用指引…',
          accelerator: 'CmdOrCtrl+,',
          click: () => openSettingsWindow('api-key'),
        },
        { label: '工作区设置…', click: () => openSettingsWindow('workspace') },
        { label: '模式与权限…', click: () => openSettingsWindow('permissions') },
        { label: '发现插件…', click: () => openSettingsWindow('plugins') },
        { label: '版本更新…', click: () => openSettingsWindow('updates') },
        { label: '外观与维护…', click: () => openSettingsWindow('appearance') },
        { type: 'separator' },
        { label: '重新启动 DeepSeek Harness', click: () => void startHarness() },
        { type: 'separator' },
        { label: '退出', click: () => void requestQuit() },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '查看',
      submenu: [
        { label: '重新加载界面', role: 'reload' },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '实际大小', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: '跟随系统主题',
          type: 'radio',
          checked: currentTheme === 'system',
          click: () => saveAndApplyTheme('system'),
        },
        {
          label: '浅色主题',
          type: 'radio',
          checked: currentTheme === 'light',
          click: () => saveAndApplyTheme('light'),
        },
        {
          label: '深色主题',
          type: 'radio',
          checked: currentTheme === 'dark',
          click: () => saveAndApplyTheme('dark'),
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: 'DeepSeek Harness 文档', click: () => void shell.openExternal(OFFICIAL_DOCS_URL) },
        { label: '官方 GitHub 仓库', click: () => void shell.openExternal(OFFICIAL_REPOSITORY_URL) },
        { label: '插件社区主题', click: () => void shell.openExternal(GITHUB_TOPIC_URL) },
        { type: 'separator' },
        { label: '打开日志目录', click: () => void shell.openPath(app.getPath('logs')) },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function installHarnessEventHandlers() {
  harnessManager.on('log', appendHarnessLog)
  harnessManager.on('stop-error', (error) => {
    appendLifecycleLog(`Harness stop failed: ${error?.message || String(error)}`)
  })
  harnessManager.on('exit', ({ code, signal, expected }) => {
    stopHarnessNotifications()
    if (expected || quitting || runtimeState.phase !== 'ready') return
    const detail = signal ? `信号 ${signal}` : `退出代码 ${code ?? '未知'}`
    const error = new Error(`DeepSeek Harness 意外停止（${detail}）`)
    error.code = 'RUNTIME_START_FAILED'
    appendLifecycleLog(error.message)
    clearTimeout(healthyResetTimer)
    try { upgradeSafety?.markFailed(error) } catch {}

    let preferences
    try { preferences = configStore.getPublicSettings() } catch { preferences = {} }
    if (preferences.crashRecovery !== false && crashRecoveryAttempts < 2) {
      crashRecoveryAttempts += 1
      publishStatus({
        phase: 'recovering',
        message: `Harness 意外停止，正在自动恢复（${crashRecoveryAttempts}/2）…`,
      })
      notifyUser('Harness 正在恢复', `检测到 ${detail}，桌面版将自动重启本地服务。`)
      if (crashRecoveryAttempts === 2 && preferences.pluginSafeMode !== true) {
        try {
          getPluginManager().enterSafeMode()
          configStore.savePreferences({ pluginSafeMode: true })
          publishStatus({ pluginSafeMode: true })
          appendLifecycleLog('Plugin safe mode was enabled after repeated crashes.')
        } catch (safeModeError) {
          appendLifecycleLog(`could not enable plugin safe mode: ${safeModeError.message}`)
        }
      }
      clearTimeout(crashRecoveryTimer)
      crashRecoveryTimer = setTimeout(() => void startHarness(), 1_500)
      return
    }

    const payload = errorPayload(error)
    publishStatus({
      phase: 'error',
      message: payload.message,
      errorCode: payload.code,
      errorCategory: payload.category,
    })
    notifyUser('Harness 已停止', '自动恢复未成功，请打开桌面版查看修复选项。')
    if (mainWindow && !mainWindow.isDestroyed()) {
      void loadLocalPage(mainWindow, 'error', payload.message, '', payload)
    }
  })
}

async function boot() {
  initializeLogger()
  appendLifecycleLog(`Starting ${APP_NAME} ${app.getVersion()} on ${process.arch}`)
  configFile = path.join(app.getPath('userData'), 'desktop-config.json')
  upgradeSafety = createUpgradeSafety()
  const restoreJournalFile = getRestoreJournalPath(configFile)
  const recovery = recoverInterruptedRestore(
    restoreJournalFile,
    interruptedRestoreExpectedTargets(restoreJournalFile),
  )
  if (recovery.recovered) {
    appendLifecycleLog(`Recovered an interrupted data restore (${recovery.action}).`)
  }
  const programRecovery = recoverCurrentProgramData()
  if (programRecovery.recovered || programRecovery.action === 'no-data-change') {
    appendLifecycleLog(`Recovered an interrupted program rollback (${programRecovery.action}).`)
  }
  const preMigrationSnapshot = prepareManualUpgradeSnapshot()
  if (preMigrationSnapshot?.created) {
    appendLifecycleLog('Created a pre-migration snapshot for a manual desktop upgrade.')
  }
  configStore = new ConfigStore(configFile, createCodec())

  let settings
  let setupMessage = ''
  try {
    settings = configStore.getPublicSettings()
  } catch (error) {
    try {
      const backup = configStore.quarantineInvalidDocument()
      appendLifecycleLog(`invalid desktop config moved to ${backup}`)
      settings = configStore.getPublicSettings()
      setupMessage = '检测到设置文件损坏，已安全备份。请重新输入 API Key。'
    } catch {
      throw error
    }
  }

  applyTheme(settings.theme || 'system')
  applyLoginPreference(settings)
  harnessManager = new HarnessManager({
    runnerPath: resolveRunner(),
    startupTimeoutMs: 45_000,
  })
  harnessNotificationMonitor = new HarnessNotificationMonitor({
    notify: notifyUser,
    logger: appendLifecycleLog,
    listSessions: (baseUrl) => callHarnessRpc(baseUrl, 'session.list', {}, {
      fetchImpl: (...args) => net.fetch(...args),
    }),
    loadHistory: ({ baseUrl, ...payload }) => callHarnessRpc(baseUrl, 'session.history', payload, {
      fetchImpl: (...args) => net.fetch(...args),
    }),
  })
  installHarnessEventHandlers()
  initializeDesktopUpdater(settings)
  registerIpc()
  installMenu()
  createMainWindow()
  syncTray()

  if (settings.checkForUpdates) {
    void desktopUpdateManager.check().catch((error) => {
      appendLifecycleLog(`automatic desktop update check failed: ${error.message}`)
    })
  }

  if (!settings.configured) {
    defaultWorkspaceSuggestion = defaultWorkspace()
    try {
      fs.mkdirSync(defaultWorkspaceSuggestion, { recursive: true })
    } catch (error) {
      appendLifecycleLog(`default workspace could not be created: ${error.message}`)
      defaultWorkspaceSuggestion = ''
      if (!setupMessage) setupMessage = '无法自动创建默认工作区，请手动选择一个文件夹。'
    }
    publishStatus({
      phase: 'setup',
      message: setupMessage || '完成一次连接设置即可开始使用',
    })
    await loadLocalPage(mainWindow, 'setup', setupMessage)
    return
  }
  defaultWorkspaceSuggestion = settings.workspace
  void startHarness()
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)
  app.whenReady().then(boot).catch((error) => {
    const payload = errorPayload(error, '桌面应用启动失败')
    appendLifecycleLog(`desktop boot failed [${payload.code}]: ${payload.message}`)
    console.error(error)
    dialog.showErrorBox(APP_NAME, payload.message)
    app.quit()
  })
}

app.on('activate', () => {
  if (mainWindow) {
    showMainWindow()
    return
  }
  if (!configStore) return
  createMainWindow()
  const settings = configStore.getPublicSettings()
  if (settings.configured) void startHarness()
  else void loadLocalPage(mainWindow, 'setup')
})

app.on('window-all-closed', () => {
  if (shouldMinimizeToTray()) return
  void requestQuit()
})

app.on('before-quit', (event) => {
  if (exitCommitted || !harnessManager) return
  event.preventDefault()
  void requestQuit()
})
