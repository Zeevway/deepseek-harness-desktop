const query = new URLSearchParams(globalThis.location.search)
const requestedMode = query.get('mode') || 'setup'
const validSections = new Set(['api-key', 'workspace', 'permissions', 'plugins', 'updates', 'appearance'])
const wizardSections = ['api-key', 'workspace', 'permissions']
const initialSection = validSections.has(query.get('section')) ? query.get('section') : 'api-key'

const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => [...document.querySelectorAll(selector)]

const elements = {
  setupScreen: $('#setupScreen'), loadingScreen: $('#loadingScreen'), errorScreen: $('#errorScreen'),
  setupForm: $('#setupForm'), setupEyebrow: $('#setupEyebrow'), setupTitle: $('#setupTitle'), setupCopy: $('#setupCopy'),
  wizardSummary: $('#wizardSummary'), wizardStepText: $('#wizardStepText'), wizardTrackFill: $('#wizardTrackFill'),
  sectionNav: $('.section-nav'), sectionButtons: $$('[data-section]'), sectionPanels: $$('[data-section-panel]'),
  apiKey: $('#apiKey'), toggleKey: $('#toggleKey'), openApiKeys: $('#openApiKeys'), savedKey: $('#savedKey'),
  savedCredentialRow: $('#savedCredentialRow'), changeKeyButton: $('#changeKeyButton'), deleteKeyButton: $('#deleteKeyButton'),
  deleteKeyConfirm: $('#deleteKeyConfirm'), confirmDeleteKey: $('#confirmDeleteKey'), cancelDeleteKey: $('#cancelDeleteKey'),
  keyReplacementNotice: $('#keyReplacementNotice'), keyProgress: $('#keyProgress'), testConnection: $('#testConnection'),
  testExplanation: $('#testExplanation'), connectionStatus: $('#connectionStatus'),
  workspace: $('#workspace'), workspaceSummary: $('#workspaceSummary'), workspaceProgress: $('#workspaceProgress'),
  chooseWorkspace: $('#chooseWorkspace'), workspaceAssessment: $('#workspaceAssessment'),
  recentWorkspaceBlock: $('#recentWorkspaceBlock'), recentWorkspaceList: $('#recentWorkspaceList'),
  dataDirectory: $('#dataDirectory'), dataDirectorySummary: $('#dataDirectorySummary'),
  chooseDataDirectory: $('#chooseDataDirectory'), resetDataDirectory: $('#resetDataDirectory'),
  permissionProgress: $('#permissionProgress'), workModes: $$('[name="workMode"]'),
  permissionModes: $$('[name="permissionMode"]'), fullAccessConfirm: $('#fullAccessConfirm'),
  confirmFullAccess: $('#confirmFullAccess'), effectivePermission: $('#effectivePermission'),
  pluginViewButtons: $$('[data-plugin-view]'), pluginViewPanel: $('#pluginViewPanel'),
  pluginSearch: $('#pluginSearch'), refreshPlugins: $('#refreshPlugins'),
  pluginSafeMode: $('#pluginSafeMode'), pluginList: $('#pluginList'), pluginEmpty: $('#pluginEmpty'),
  installedPluginCount: $('#installedPluginCount'),
  desktopVersion: $('#desktopVersion'), harnessVersion: $('#harnessVersion'), desktopChannelLabel: $('#desktopChannelLabel'),
  updateChannel: $('#updateChannel'), checkForUpdates: $('#checkForUpdates'), autoDownloadUpdates: $('#autoDownloadUpdates'),
  checkUpdateButton: $('#checkUpdateButton'), updateStatus: $('#updateStatus'), updateHeadline: $('#updateHeadline'),
  updateDetail: $('#updateDetail'), updateProgress: $('#updateProgress'), downloadProgress: $('#downloadProgress'),
  downloadLabel: $('#downloadLabel'), downloadPercent: $('#downloadPercent'), downloadProgressBar: $('#downloadProgressBar'),
  updateActions: $('#updateActions'), downloadUpdateButton: $('#downloadUpdateButton'), restartInstallButton: $('#restartInstallButton'),
  postponeUpdateButton: $('#postponeUpdateButton'), rollbackUpdateButton: $('#rollbackUpdateButton'),
  themeButtons: $$('[data-theme-value]'), minimizeToTray: $('#minimizeToTray'), startAtLogin: $('#startAtLogin'),
  notifications: $('#notifications'), crashRecovery: $('#crashRecovery'), diagnosticMode: $('#diagnosticMode'),
  backupData: $('#backupData'), restoreData: $('#restoreData'), exportDiagnostics: $('#exportDiagnostics'), openLogs: $('#openLogs'),
  maintenanceStatus: $('#maintenanceStatus'), clearDataButton: $('#clearDataButton'), clearDataConfirm: $('#clearDataConfirm'),
  confirmClearData: $('#confirmClearData'), cancelClearData: $('#cancelClearData'),
  connectionActions: $('#connectionActions'), previousButton: $('#previousButton'), nextButton: $('#nextButton'),
  saveButton: $('#saveButton'), formError: $('#formError'), loadingMessage: $('#loadingMessage'), versionLabel: $('#versionLabel'),
  errorCategory: $('#errorCategory'), errorTitle: $('#errorTitle'), errorMessage: $('#errorMessage'), errorCode: $('#errorCode'),
  errorSteps: $('#errorSteps'), retryButton: $('#retryButton'), settingsButton: $('#settingsButton'),
  repairRuntimeButton: $('#repairRuntimeButton'), copyDiagnosticsButton: $('#copyDiagnosticsButton'),
  errorOpenLogsButton: $('#errorOpenLogsButton'), errorResetButton: $('#errorResetButton'),
  errorOperationStatus: $('#errorOperationStatus'),
}

let state = {}
let activeSection = initialSection
let verifiedKeyValue = null
let workspaceCheck = null
let workspaceAssessmentGeneration = 0
let pluginView = 'discover'
let pluginData = { discover: [], installed: [], discoveryError: '' }
let pluginsLoaded = false
let pluginsLoading = false
let currentErrorCategory = 'runtime'
const compactNavigation = globalThis.matchMedia('(max-width: 760px)')

function syncSectionTabOrientation() {
  elements.sectionNav.setAttribute('aria-orientation', compactNavigation.matches ? 'horizontal' : 'vertical')
}

syncSectionTabOrientation()
compactNavigation.addEventListener('change', syncSectionTabOrientation)

function desktopMethod(name) {
  const method = globalThis.desktop?.[name]
  if (typeof method !== 'function') throw new Error(`当前桌面组件不支持 ${name}，请完成应用更新后重试。`)
  return method.bind(globalThis.desktop)
}

function showScreen(name) {
  elements.setupScreen.hidden = name !== 'setup'
  elements.loadingScreen.hidden = name !== 'loading'
  elements.errorScreen.hidden = name !== 'error'
}

function setFormError(message = '') {
  elements.formError.textContent = message
  elements.formError.hidden = message === ''
}

function setOperationStatus(message = '', failure = false) {
  elements.maintenanceStatus.textContent = message
  elements.maintenanceStatus.classList.toggle('failure', failure)
  elements.maintenanceStatus.hidden = message === ''
}

function focusPanel(section) {
  const heading = document.querySelector(`[data-section-panel="${section}"] .section-heading`)
  heading?.focus({ preventScroll: true })
  heading?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

function showSection(section, { focus = true } = {}) {
  activeSection = validSections.has(section) ? section : 'api-key'
  for (const button of elements.sectionButtons) {
    const active = button.dataset.section === activeSection
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', String(active))
    button.tabIndex = active ? 0 : -1
  }
  for (const panel of elements.sectionPanels) {
    const active = panel.dataset.sectionPanel === activeSection
    panel.classList.toggle('active', active)
    panel.hidden = !active
  }
  setFormError()
  updateActionBar()
  if (activeSection === 'plugins' && !pluginsLoaded && !pluginsLoading) void refreshPluginData()
  if (focus) requestAnimationFrame(() => focusPanel(activeSection))
}

function selectedValue(inputs) {
  return inputs.find((item) => item.checked)?.value
}

function setRadioValue(inputs, value, fallback) {
  const target = inputs.find((item) => item.value === value) || inputs.find((item) => item.value === fallback)
  if (target) target.checked = true
}

function hasUsableKey() {
  const candidate = elements.apiKey.value.trim()
  return candidate ? verifiedKeyValue === candidate : Boolean(state.hasApiKey)
}

function isFullAccessConfirmed() {
  return selectedValue(elements.permissionModes) !== 'full-access' || elements.confirmFullAccess.checked
}

function currentPermissionMode() {
  return selectedValue(elements.permissionModes) || 'workspace-write'
}

function workspaceAssessmentIsCurrent() {
  return workspaceCheck?.ok === true && workspaceCheck.permissionMode === currentPermissionMode()
}

function updateProgress() {
  const candidate = elements.apiKey.value.trim()
  const keyReady = hasUsableKey()
  elements.keyProgress.textContent = candidate
    ? (verifiedKeyValue === candidate ? '新 Key 已验证' : '新 Key 待测试')
    : (state.hasApiKey ? '已安全保存' : '等待设置')
  elements.keyProgress.closest('.section-nav-item')?.classList.toggle('complete', keyReady)

  const workspaceReady = Boolean(elements.workspace.value && workspaceAssessmentIsCurrent())
  elements.workspaceProgress.textContent = elements.workspace.value
    ? (workspaceReady ? '检查已通过' : '需要检查')
    : '等待选择'
  elements.workspaceProgress.closest('.section-nav-item')?.classList.toggle('complete', workspaceReady)

  const permissionsReady = isFullAccessConfirmed()
  elements.permissionProgress.textContent = permissionsReady ? '已选择' : '需要确认'
  elements.permissionProgress.closest('.section-nav-item')?.classList.toggle('complete', permissionsReady)
  elements.saveButton.disabled = !keyReady || !workspaceReady || !permissionsReady
}

function updateActionBar() {
  const wizardIndex = wizardSections.indexOf(activeSection)
  const isConfigurationSection = wizardIndex >= 0
  elements.connectionActions.hidden = !isConfigurationSection
  if (requestedMode === 'settings') {
    elements.wizardSummary.hidden = true
    elements.previousButton.hidden = true
    elements.nextButton.hidden = true
    elements.saveButton.hidden = !isConfigurationSection
    elements.saveButton.textContent = '保存连接与权限设置'
    return
  }
  elements.wizardSummary.hidden = false
  elements.previousButton.hidden = wizardIndex <= 0
  elements.nextButton.hidden = wizardIndex < 0 || wizardIndex === wizardSections.length - 1
  elements.saveButton.hidden = wizardIndex !== wizardSections.length - 1
  const visibleIndex = Math.max(0, wizardIndex)
  elements.wizardStepText.textContent = `第 ${visibleIndex + 1} 步，共 ${wizardSections.length} 步`
  elements.wizardTrackFill.style.width = `${((visibleIndex + 1) / wizardSections.length) * 100}%`
}

function setConnectionStatus(kind, message) {
  elements.connectionStatus.className = `connection-status ${kind}`.trim()
  elements.connectionStatus.querySelector('span:last-child').textContent = message
}

function applyTheme(theme) {
  const normalized = ['system', 'light', 'dark'].includes(theme) ? theme : 'system'
  document.documentElement.dataset.theme = normalized
  for (const button of elements.themeButtons) {
    const active = button.dataset.themeValue === normalized
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  }
}

function normalizeAssessment(result, path, requestedPermission = currentPermissionMode()) {
  const permissionMode = result?.permissionMode || requestedPermission
  if (!result || typeof result !== 'object') {
    return { ok: false, level: 'warning', title: '无法完成目录检查', message: '请重新选择文件夹或查看日志。', path, permissionMode }
  }
  const accessLabel = permissionMode === 'read-only'
    ? (result.readable === false ? '不可读' : '只读可用')
    : (result.writable === false ? '不可写' : '可写')
  return {
    ok: result.ok === true,
    level: result.level || (result.ok ? 'success' : 'warning'),
    title: result.title || (result.ok ? '目录检查已通过' : '此目录需要确认'),
    message: result.message || [result.driveType, result.freeSpaceLabel, accessLabel].filter(Boolean).join(' · '),
    path,
    permissionMode,
  }
}

function renderWorkspaceAssessment(assessment) {
  workspaceCheck = assessment
  const icon = elements.workspaceAssessment.querySelector('.state-icon')
  elements.workspaceAssessment.className = `assessment ${assessment?.level || 'neutral'}`
  icon.className = `state-icon ${assessment?.level || 'neutral'}`
  icon.textContent = assessment?.ok ? '✓' : (assessment?.level === 'danger' ? '!' : 'i')
  elements.workspaceAssessment.querySelector('strong').textContent = assessment?.title || '尚未检查'
  elements.workspaceAssessment.querySelector('p').textContent = assessment?.message || '选择文件夹后显示路径风险、磁盘类型、剩余空间和可写性。'
  updateProgress()
}

async function assessWorkspace(path) {
  const permissionMode = currentPermissionMode()
  const generation = ++workspaceAssessmentGeneration
  const accessLabel = permissionMode === 'read-only' ? '读取权限' : '写入权限'
  renderWorkspaceAssessment({
    ok: false,
    level: 'neutral',
    title: '正在检查目录',
    message: `正在检查路径风险、磁盘类型、剩余空间和${accessLabel}。`,
    path,
    permissionMode,
  })
  try {
    const result = await desktopMethod('inspectWorkspace')(path, permissionMode)
    if (generation !== workspaceAssessmentGeneration
      || elements.workspace.value !== path
      || currentPermissionMode() !== permissionMode) return
    renderWorkspaceAssessment(normalizeAssessment(result, path, permissionMode))
  } catch (error) {
    if (generation !== workspaceAssessmentGeneration
      || elements.workspace.value !== path
      || currentPermissionMode() !== permissionMode) return
    renderWorkspaceAssessment({
      ok: false,
      level: 'danger',
      title: '目录检查失败',
      message: error.message || '请重新选择文件夹。',
      path,
      permissionMode,
    })
  }
}

function setWorkspace(path, assessment = null) {
  if (!path) return
  workspaceAssessmentGeneration += 1
  elements.workspace.value = path
  elements.workspaceSummary.textContent = path
  setFormError()
  if (assessment && (!assessment.permissionMode || assessment.permissionMode === currentPermissionMode())) {
    renderWorkspaceAssessment(normalizeAssessment(assessment, path))
  }
  else void assessWorkspace(path)
}

function renderRecentWorkspaces(items) {
  const workspaces = Array.isArray(items) ? items.filter((item) => item?.path) : []
  elements.recentWorkspaceList.replaceChildren()
  elements.recentWorkspaceBlock.hidden = workspaces.length === 0
  for (const item of workspaces.slice(0, 5)) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'recent-row'
    const name = document.createElement('strong')
    name.textContent = item.name || item.path.split(/[\\/]/u).filter(Boolean).at(-1) || item.path
    const path = document.createElement('small')
    path.textContent = item.path
    const meta = document.createElement('span')
    meta.textContent = item.lastUsedLabel || '最近使用'
    button.append(name, path, meta)
    button.addEventListener('click', () => setWorkspace(item.path, item.assessment))
    elements.recentWorkspaceList.append(button)
  }
}

function updatePermissionSummary() {
  const workMode = selectedValue(elements.workModes)
  const permissionMode = selectedValue(elements.permissionModes)
  const modeLabels = { normal: '普通模式', plan: 'Plan 模式' }
  const permissionLabels = { 'read-only': '只读', 'workspace-write': '工作区写入', 'full-access': 'Full Access' }
  elements.fullAccessConfirm.hidden = permissionMode !== 'full-access'
  if (permissionMode !== 'full-access') elements.confirmFullAccess.checked = false
  elements.effectivePermission.textContent = `${modeLabels[workMode]} · ${permissionLabels[permissionMode]}`
  updateProgress()
}

function pluginButton(label, action, id, style = 'tertiary', disabled = false) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `button button-${style} button-small`
  button.textContent = label
  button.dataset.pluginAction = action
  button.dataset.pluginId = id
  button.disabled = disabled
  return button
}

function renderPlugins() {
  const source = pluginView === 'installed' ? pluginData.installed : pluginData.discover
  const queryText = elements.pluginSearch.value.trim().toLocaleLowerCase('zh-CN')
  const items = source.filter((plugin) => !queryText || [plugin.name, plugin.author, plugin.description].some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(queryText)))
  const discoveryError = pluginView === 'discover' ? pluginData.discoveryError : ''
  elements.pluginList.replaceChildren()
  elements.pluginEmpty.hidden = items.length !== 0 && !discoveryError
  elements.pluginEmpty.classList.toggle('failure', Boolean(discoveryError))
  elements.pluginEmpty.textContent = discoveryError
    ? `插件发现失败：${discoveryError}。已安装插件仍可管理，请稍后重试。`
    : (queryText ? '没有找到符合搜索条件的插件。' : '没有找到符合条件的插件。')
  elements.installedPluginCount.textContent = String(pluginData.installed.length)

  for (const plugin of items) {
    const row = document.createElement('article')
    row.className = 'plugin-row'
    const main = document.createElement('div')
    main.className = 'plugin-main'
    const heading = document.createElement('div')
    heading.className = 'plugin-heading'
    const title = document.createElement('strong')
    title.textContent = plugin.name || plugin.id
    const version = document.createElement('span')
    version.textContent = `v${plugin.version || '未知'}`
    heading.append(title, version)
    const description = document.createElement('p')
    description.textContent = plugin.description || '暂无说明'
    const sourceLabel = document.createElement('small')
    sourceLabel.textContent = `来源：${plugin.source || plugin.author || '未知'} · ${plugin.compatible === false ? '与当前核心不兼容' : '兼容当前核心'}`
    const permissions = document.createElement('div')
    permissions.className = 'permission-tags'
    for (const permission of (plugin.permissions || ['未声明权限'])) {
      const tag = document.createElement('span')
      tag.textContent = permission
      permissions.append(tag)
    }
    main.append(heading, description, sourceLabel, permissions)

    const actions = document.createElement('div')
    actions.className = 'plugin-actions'
    if (!plugin.installed) {
      actions.append(pluginButton('安装', 'install', plugin.id, 'secondary', plugin.compatible === false))
    } else {
      if (plugin.updateAvailable) actions.append(pluginButton('更新', 'update', plugin.id, 'secondary'))
      actions.append(pluginButton(plugin.enabled === false ? '启用' : '停用', 'toggle', plugin.id))
      if (plugin.rollbackAvailable) actions.append(pluginButton('回滚', 'rollback', plugin.id))
      actions.append(pluginButton('卸载', 'uninstall', plugin.id, 'danger-quiet'))
    }
    row.append(main, actions)
    elements.pluginList.append(row)
  }
}

function normalizePluginData(result) {
  if (Array.isArray(result)) {
    return { discover: result, installed: result.filter((item) => item.installed), discoveryError: '' }
  }
  return {
    discover: Array.isArray(result?.discover) ? result.discover : [],
    installed: Array.isArray(result?.installed) ? result.installed : [],
    discoveryError: typeof result?.discoveryError === 'string' ? result.discoveryError : '',
  }
}

async function refreshPluginData() {
  if (pluginsLoading) return
  pluginsLoading = true
  elements.refreshPlugins.disabled = true
  elements.refreshPlugins.textContent = '正在刷新…'
  try {
    pluginData = normalizePluginData(await desktopMethod('listPlugins')())
    pluginsLoaded = true
    renderPlugins()
  } catch (error) {
    pluginData = { discover: [], installed: [], discoveryError: error.message || '插件列表加载失败。' }
    renderPlugins()
  } finally {
    pluginsLoading = false
    elements.refreshPlugins.disabled = false
    elements.refreshPlugins.textContent = '刷新'
  }
}

function renderUpdateResult(result) {
  const update = result || state.updateInfo || state.updateState
  elements.updateStatus.className = 'update-status'
  elements.updateActions.hidden = true
  elements.downloadUpdateButton.hidden = true
  elements.restartInstallButton.hidden = true
  elements.rollbackUpdateButton.hidden = !Boolean(update?.rollbackAvailable)
  elements.downloadProgress.hidden = true

  if (!update) {
    elements.updateHeadline.textContent = '尚未检查'
    elements.updateDetail.textContent = '检查后会显示兼容性、更新内容和安装选项。'
    return
  }
  if (update.error) {
    elements.updateStatus.classList.add('failure')
    elements.updateHeadline.textContent = '暂时无法检查更新'
    elements.updateDetail.textContent = update.message || update.error
    return
  }
  if (update.phase === 'unconfigured' || update.configured === false) {
    elements.updateHeadline.textContent = '尚未配置桌面版更新源'
    elements.updateDetail.textContent = update.message || '需要由发行者配置 HTTPS 或 GitHub Releases 更新源。仍可使用完整安装包手动覆盖升级。'
    elements.updateActions.hidden = !update.rollbackAvailable
    return
  }
  if (update.phase === 'downloading') {
    renderDownloadProgress(update.progress || 0, update)
    return
  }
  if (update.phase === 'downloaded' || update.downloaded) {
    elements.updateStatus.classList.add('available')
    elements.updateHeadline.textContent = `桌面版 ${update.latestDesktopVersion || update.latestVersion} 已准备好`
    elements.updateDetail.textContent = '关闭正在运行的任务后，可重启应用完成安装。升级前会自动备份。'
    elements.updateActions.hidden = false
    elements.downloadUpdateButton.hidden = true
    elements.restartInstallButton.hidden = false
    return
  }
  if (update.updateAvailable) {
    elements.updateStatus.classList.add('available')
    const version = update.latestDesktopVersion || update.latestVersion
    elements.updateHeadline.textContent = `发现桌面版 ${version}`
    elements.updateDetail.textContent = update.releaseSummary || `包含 Harness ${update.latestHarnessVersion || '兼容版本'}，已通过兼容性检查。`
    elements.updateActions.hidden = false
    elements.downloadUpdateButton.hidden = false
    return
  }
  elements.updateHeadline.textContent = '当前已是最新兼容版本'
  const checkedAt = update.checkedAt ? new Date(update.checkedAt).toLocaleString('zh-CN') : '刚刚'
  elements.updateDetail.textContent = `桌面版 ${state.appVersion || update.currentVersion || '未知'} · 检查时间 ${checkedAt}`
  elements.updateActions.hidden = !update.rollbackAvailable
}

function renderDownloadProgress(percent, detail = {}) {
  const normalized = Math.max(0, Math.min(100, Number(percent) || 0))
  elements.downloadProgress.hidden = false
  elements.downloadProgressBar.value = normalized
  elements.downloadProgressBar.textContent = `${Math.round(normalized)}%`
  elements.downloadPercent.textContent = `${Math.round(normalized)}%`
  elements.downloadLabel.textContent = detail.bytesPerSecondLabel ? `正在下载 · ${detail.bytesPerSecondLabel}` : '正在下载更新包'
  elements.updateHeadline.textContent = '正在下载更新'
  elements.updateDetail.textContent = '下载完成后可选择稍后安装或立即重启。'
  elements.updateActions.hidden = false
  elements.downloadUpdateButton.hidden = true
}

function renderVersions() {
  elements.desktopVersion.textContent = state.appVersion || '未知'
  elements.harnessVersion.textContent = state.harnessVersion || '未知'
  const channel = state.updateChannel || 'stable'
  elements.updateChannel.value = channel
  elements.desktopChannelLabel.textContent = channel === 'preview' ? '预览渠道' : '稳定渠道'
  elements.versionLabel.textContent = `桌面版 ${state.appVersion || '未知'} · Harness ${state.harnessVersion || '未知'}`
}

async function savePreferences(patch) {
  if (typeof globalThis.desktop?.setPreferences === 'function') return globalThis.desktop.setPreferences(patch)
  if (Object.keys(patch).length === 1 && 'checkForUpdates' in patch && typeof globalThis.desktop?.setUpdatePreference === 'function') {
    return globalThis.desktop.setUpdatePreference(patch.checkForUpdates)
  }
  throw new Error('当前桌面组件不支持这项偏好，请完成应用更新后重试。')
}

function applyPreferenceState(nextState) {
  state = { ...state, ...(nextState || {}) }
  elements.checkForUpdates.checked = state.checkForUpdates !== false
  elements.autoDownloadUpdates.checked = state.autoDownloadUpdates === true
  elements.minimizeToTray.checked = state.minimizeToTray === true
  elements.startAtLogin.checked = state.startAtLogin === true
  elements.notifications.checked = state.notifications !== false
  elements.crashRecovery.checked = state.crashRecovery !== false
  elements.diagnosticMode.checked = state.diagnosticMode === true
  elements.pluginSafeMode.checked = state.pluginSafeMode === true
  elements.updateChannel.value = state.updateChannel || 'stable'
  elements.desktopChannelLabel.textContent = elements.updateChannel.value === 'preview' ? '预览渠道' : '稳定渠道'
}

function configureSetupMode() {
  if (requestedMode === 'settings') {
    elements.setupEyebrow.textContent = '桌面应用设置'
    elements.setupTitle.textContent = '设置中心'
    elements.setupCopy.textContent = '管理连接、权限、插件、版本、本机行为和数据。'
  } else {
    for (const item of $$('.settings-only')) item.hidden = true
  }

  if (state.hasApiKey) {
    elements.savedCredentialRow.hidden = false
    elements.savedKey.hidden = false
    elements.apiKey.placeholder = '留空表示继续使用已保存的 Key'
    setConnectionStatus('', '已保存 Key；可直接测试或输入新 Key 替换')
  }

  const workspace = state.workspace || state.defaultWorkspace || ''
  elements.workspace.value = workspace
  elements.workspaceSummary.textContent = workspace || '尚未选择'
  elements.dataDirectory.value = state.dataDirectory || state.defaultDataDirectory || ''
  elements.dataDirectorySummary.textContent = state.dataDirectory || '默认 Windows AppData'
  setRadioValue(elements.workModes, state.workMode, 'normal')
  setRadioValue(elements.permissionModes, state.permissionMode, 'workspace-write')
  elements.confirmFullAccess.checked = false
  updatePermissionSummary()
  applyPreferenceState(state)
  applyTheme(state.theme)
  renderVersions()
  renderUpdateResult(state.updateState || state.updateInfo)
  renderRecentWorkspaces(state.recentWorkspaces)
  if (state.plugins) {
    pluginData = normalizePluginData(state.plugins)
    pluginsLoaded = true
    renderPlugins()
  }
  if (workspace) {
    if (state.workspaceAssessment) renderWorkspaceAssessment(normalizeAssessment(state.workspaceAssessment, workspace))
    else void assessWorkspace(workspace)
  } else {
    renderWorkspaceAssessment(null)
  }
  updateProgress()
  showSection(initialSection, { focus: false })
}

const errorDefinitions = {
  'api-key': {
    label: 'API Key 问题', title: '无法通过 DeepSeek 身份验证', section: 'api-key', button: '检查 API Key',
    steps: ['在 API Key 板块输入有效的 sk- Key。', '点击“测试连接”，确认请求真实通过。', '如 Key 已撤销，请在 DeepSeek 控制台创建并替换。'],
  },
  network: {
    label: '网络连接问题', title: '无法连接 DeepSeek 服务', section: 'api-key', button: '检查连接设置',
    steps: ['确认电脑能够访问 DeepSeek API。', '检查系统代理、防火墙和企业网络策略。', '网络恢复后重新启动；Key 不会在重试中被修改。'],
  },
  workspace: {
    label: '工作区问题', title: '工作区无法正常使用', section: 'workspace', button: '选择工作区',
    steps: ['选择仍然存在且当前账户可读写的项目文件夹。', '避免磁盘根目录、Windows 目录或只读网络目录。', '确认磁盘有足够空间后重新启动。'],
  },
  runtime: {
    label: '运行环境问题', title: 'Harness 本地服务启动失败', section: 'appearance', button: '打开维护工具', repair: true,
    steps: ['先点击“重新启动”。', '如问题持续，点击“修复运行环境”验证并恢复内置文件。', '导出脱敏诊断包后再寻求支持。'],
  },
  update: {
    label: '版本更新问题', title: '更新未能完成', section: 'updates', button: '打开版本更新',
    steps: ['检查网络和磁盘剩余空间。', '重新下载完整更新包。', '新版本无法启动时选择“恢复上一版”。'],
  },
}

function inferErrorCategory(message) {
  const explicit = query.get('category') || state.errorCategory
  if (errorDefinitions[explicit]) return explicit
  const value = String(message || '').toLocaleLowerCase('zh-CN')
  if (/api|key|401|403|密钥|认证/u.test(value)) return 'api-key'
  if (/network|fetch|timeout|dns|proxy|网络|连接/u.test(value)) return 'network'
  if (/workspace|directory|folder|permission|工作区|目录|权限/u.test(value)) return 'workspace'
  if (/update|upgrade|version|更新|升级|版本/u.test(value)) return 'update'
  return 'runtime'
}

function renderError(message) {
  currentErrorCategory = inferErrorCategory(message)
  const definition = errorDefinitions[currentErrorCategory]
  elements.errorCategory.textContent = definition.label
  elements.errorTitle.textContent = definition.title
  elements.errorMessage.textContent = message || '桌面应用没有提供更多错误信息。'
  elements.errorCode.textContent = query.get('code') ? `错误代码：${query.get('code')}` : ''
  elements.errorSteps.replaceChildren()
  for (const step of definition.steps) {
    const item = document.createElement('li')
    item.textContent = step
    elements.errorSteps.append(item)
  }
  elements.settingsButton.textContent = definition.button
  elements.repairRuntimeButton.hidden = !definition.repair
}

async function initialize() {
  if (!globalThis.desktop) {
    showScreen('error')
    state = {}
    renderError('桌面应用桥接没有加载，请重新启动应用。')
    return
  }

  state = await desktopMethod('getState')()
  renderVersions()
  applyTheme(state.theme)
  if (requestedMode === 'loading') {
    showScreen('loading')
    elements.loadingMessage.textContent = state.message || '正在启动本地服务…'
  } else if (requestedMode === 'error') {
    showScreen('error')
    renderError(query.get('message') || state.message || '未知启动错误')
  } else {
    showScreen('setup')
    configureSetupMode()
    setFormError(query.get('message') || '')
  }

  globalThis.desktop.onStatus?.((next) => {
    state = { ...state, ...next }
    if (next.theme) applyTheme(next.theme)
    if (next.updateState || next.updateInfo) renderUpdateResult(next.updateState || next.updateInfo)
    else if (typeof next.updateProgress === 'number') renderDownloadProgress(next.updateProgress, next)
    if (requestedMode === 'loading') elements.loadingMessage.textContent = next.message || '正在启动本地服务…'
  })
  globalThis.desktop.onNavigateSection?.((section) => {
    if (requestedMode === 'settings') showSection(section)
  })
}

for (const button of elements.sectionButtons) {
  button.addEventListener('click', () => showSection(button.dataset.section))
  button.addEventListener('keydown', (event) => {
    const previousKey = compactNavigation.matches ? 'ArrowLeft' : 'ArrowUp'
    const nextKey = compactNavigation.matches ? 'ArrowRight' : 'ArrowDown'
    if (![previousKey, nextKey, 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const visible = elements.sectionButtons.filter((item) => !item.hidden)
    let index = visible.indexOf(button)
    if (event.key === 'Home') index = 0
    else if (event.key === 'End') index = visible.length - 1
    else index = (index + (event.key === nextKey ? 1 : -1) + visible.length) % visible.length
    visible[index].focus()
    showSection(visible[index].dataset.section, { focus: false })
  })
}

elements.previousButton.addEventListener('click', () => {
  const index = wizardSections.indexOf(activeSection)
  if (index > 0) showSection(wizardSections[index - 1])
})

elements.nextButton.addEventListener('click', () => {
  const index = wizardSections.indexOf(activeSection)
  if (index < 0 || !validateSection(activeSection)) return
  showSection(wizardSections[index + 1])
})

function validateSection(section) {
  setFormError()
  if (section === 'api-key' && !hasUsableKey()) {
    setFormError(elements.apiKey.value.trim() ? '请先测试新 API Key，连接通过后才能继续。' : '请填写 API Key 并测试连接。')
    elements.apiKey.focus()
    return false
  }
  if (section === 'workspace' && !elements.workspace.value) {
    setFormError('请选择默认工作区。')
    elements.chooseWorkspace.focus()
    return false
  }
  if (section === 'workspace' && !workspaceAssessmentIsCurrent()) {
    setFormError('工作区预检尚未通过，请根据检查结果更换或修复目录。')
    elements.workspaceAssessment.scrollIntoView({ block: 'center' })
    return false
  }
  if (section === 'permissions' && !isFullAccessConfirmed()) {
    setFormError('启用 Full Access 前需要明确确认风险。')
    elements.confirmFullAccess.focus()
    return false
  }
  return true
}

elements.toggleKey.addEventListener('click', () => {
  const visible = elements.apiKey.type === 'text'
  elements.apiKey.type = visible ? 'password' : 'text'
  elements.toggleKey.textContent = visible ? '显示' : '隐藏'
  elements.toggleKey.setAttribute('aria-label', visible ? '显示 API Key' : '隐藏 API Key')
})

elements.apiKey.addEventListener('input', () => {
  const candidate = elements.apiKey.value.trim()
  if (verifiedKeyValue !== candidate) verifiedKeyValue = null
  elements.keyReplacementNotice.hidden = !(candidate && state.hasApiKey)
  elements.testExplanation.textContent = candidate
    ? '测试新 Key；通过后保存才会替换旧 Key。'
    : (state.hasApiKey ? '输入框为空，将测试已加密保存的 Key。' : '测试会请求 DeepSeek 接口，不会保存输入内容。')
  setConnectionStatus('', candidate ? '新 Key 修改后需要重新测试' : (state.hasApiKey ? '将继续使用已保存的 Key' : '尚未测试'))
  setFormError()
  updateProgress()
})

elements.changeKeyButton.addEventListener('click', () => {
  elements.apiKey.focus()
  elements.apiKey.scrollIntoView({ block: 'center' })
})
elements.deleteKeyButton.addEventListener('click', () => {
  elements.deleteKeyConfirm.hidden = false
  elements.confirmDeleteKey.focus()
})
elements.cancelDeleteKey.addEventListener('click', () => {
  elements.deleteKeyConfirm.hidden = true
  elements.deleteKeyButton.focus()
})
elements.confirmDeleteKey.addEventListener('click', async () => {
  elements.confirmDeleteKey.disabled = true
  try {
    await desktopMethod('deleteApiKey')()
    state.hasApiKey = false
    verifiedKeyValue = null
    elements.savedCredentialRow.hidden = true
    elements.savedKey.hidden = true
    elements.deleteKeyConfirm.hidden = true
    elements.apiKey.placeholder = '请输入 sk- 开头的 Key'
    setConnectionStatus('', '已删除 Key，请输入并测试新的 Key')
    elements.apiKey.focus()
    updateProgress()
  } catch (error) {
    setFormError(error.message || 'API Key 删除失败。')
  } finally {
    elements.confirmDeleteKey.disabled = false
  }
})

elements.openApiKeys.addEventListener('click', () => void desktopMethod('openApiKeys')())
elements.testConnection.addEventListener('click', async () => {
  const apiKey = elements.apiKey.value.trim()
  if (!apiKey && !state.hasApiKey) {
    setConnectionStatus('failure', '请先输入 API Key')
    elements.apiKey.focus()
    return
  }
  elements.testConnection.disabled = true
  setFormError()
  setConnectionStatus('testing', apiKey ? '正在验证新的 API Key…' : '正在验证已保存的 API Key…')
  try {
    const result = apiKey
      ? await desktopMethod('testApiKey')(apiKey)
      : await desktopMethod('testSavedApiKey')()
    if (result?.ok) verifiedKeyValue = apiKey || '__saved__'
    else verifiedKeyValue = null
    setConnectionStatus(result?.ok ? 'success' : 'failure', result?.message || (result?.ok ? '连接测试通过' : '连接测试失败'))
  } catch (error) {
    verifiedKeyValue = null
    setConnectionStatus('failure', error.message || '连接测试失败')
  } finally {
    elements.testConnection.disabled = false
    updateProgress()
  }
})

elements.chooseWorkspace.addEventListener('click', async () => {
  try {
    const selected = await desktopMethod('chooseWorkspace')(currentPermissionMode())
    if (selected) setWorkspace(typeof selected === 'string' ? selected : selected.path, selected.assessment)
  } catch (error) {
    setFormError(error.message || '无法选择工作区。')
  }
})
elements.chooseDataDirectory.addEventListener('click', async () => {
  try {
    const selected = await desktopMethod('chooseDataDirectory')()
    const path = typeof selected === 'string' ? selected : selected?.path
    if (path) {
      elements.dataDirectory.value = path
      elements.dataDirectorySummary.textContent = path
      setFormError()
    }
  } catch (error) {
    setFormError(error.message || '无法选择 Harness 数据目录。')
  }
})
elements.resetDataDirectory.addEventListener('click', () => {
  elements.dataDirectory.value = state.defaultDataDirectory || ''
  elements.dataDirectorySummary.textContent = '默认 Windows AppData'
})

for (const input of elements.workModes) input.addEventListener('change', updatePermissionSummary)
for (const input of elements.permissionModes) {
  input.addEventListener('change', () => {
    workspaceAssessmentGeneration += 1
    workspaceCheck = null
    updatePermissionSummary()
    if (elements.workspace.value) void assessWorkspace(elements.workspace.value)
  })
}
elements.confirmFullAccess.addEventListener('change', updateProgress)

elements.setupForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  for (const section of wizardSections) {
    if (!validateSection(section)) {
      showSection(section)
      return
    }
  }
  elements.saveButton.disabled = true
  const previousLabel = elements.saveButton.textContent
  elements.saveButton.textContent = '正在保存…'
  try {
    const candidate = elements.apiKey.value.trim()
    const saved = await desktopMethod('saveSettings')({
      apiKey: candidate || undefined,
      workspace: elements.workspace.value,
      dataDirectory: elements.dataDirectory.value || undefined,
      workMode: selectedValue(elements.workModes),
      permissionMode: selectedValue(elements.permissionModes),
    })
    state = { ...state, ...saved, hasApiKey: true }
    if (candidate) {
      elements.apiKey.value = ''
      verifiedKeyValue = null
      elements.keyReplacementNotice.hidden = true
      elements.savedCredentialRow.hidden = false
      elements.savedKey.hidden = false
    }
    if (requestedMode !== 'settings') {
      showScreen('loading')
      elements.loadingMessage.textContent = '设置已保存，正在启动 DeepSeek Harness…'
    } else {
      setConnectionStatus(
        'success',
        candidate ? '设置已保存；新 Key 已替换旧 Key' : '设置已保存；已保存的 Key 未变更',
      )
      elements.saveButton.textContent = '已保存'
      setTimeout(() => { elements.saveButton.textContent = previousLabel }, 1400)
    }
  } catch (error) {
    setFormError(error.message || '设置保存失败')
    elements.saveButton.textContent = previousLabel
  } finally {
    updateProgress()
  }
})

function activatePluginView(button, { focus = false } = {}) {
  pluginView = button.dataset.pluginView
  for (const item of elements.pluginViewButtons) {
    const active = item === button
    item.classList.toggle('active', active)
    item.setAttribute('aria-selected', String(active))
    item.tabIndex = active ? 0 : -1
  }
  elements.pluginViewPanel.setAttribute('aria-labelledby', button.id)
  if (focus) button.focus()
  renderPlugins()
}

for (const button of elements.pluginViewButtons) {
  button.addEventListener('click', () => activatePluginView(button))
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    let index = elements.pluginViewButtons.indexOf(button)
    if (event.key === 'Home') index = 0
    else if (event.key === 'End') index = elements.pluginViewButtons.length - 1
    else index = (
      index + (event.key === 'ArrowRight' ? 1 : -1) + elements.pluginViewButtons.length
    ) % elements.pluginViewButtons.length
    activatePluginView(elements.pluginViewButtons[index], { focus: true })
  })
}
elements.pluginSearch.addEventListener('input', renderPlugins)
elements.refreshPlugins.addEventListener('click', () => void refreshPluginData())
elements.pluginSafeMode.addEventListener('change', async () => {
  const enabled = elements.pluginSafeMode.checked
  elements.pluginSafeMode.disabled = true
  try {
    const saved = await desktopMethod('setPluginSafeMode')(enabled)
    state = { ...state, ...(saved || {}), pluginSafeMode: enabled }
  } catch (error) {
    elements.pluginSafeMode.checked = !enabled
    elements.pluginEmpty.textContent = error.message || '安全模式设置失败。'
    elements.pluginEmpty.hidden = false
  } finally {
    elements.pluginSafeMode.disabled = false
  }
})
elements.pluginList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-plugin-action]')
  if (!button) return
  const { pluginAction: action, pluginId: id } = button.dataset
  const plugin = pluginData.installed.find((item) => item.id === id) || pluginData.discover.find((item) => item.id === id)
  const methods = { install: 'installPlugin', update: 'updatePlugin', toggle: 'setPluginEnabled', uninstall: 'uninstallPlugin', rollback: 'rollbackPlugin' }
  button.disabled = true
  const oldLabel = button.textContent
  button.textContent = '处理中…'
  try {
    const args = action === 'toggle' ? [id, plugin?.enabled === false] : [id]
    await desktopMethod(methods[action])(...args)
    await refreshPluginData()
  } catch (error) {
    button.disabled = false
    button.textContent = oldLabel
    elements.pluginEmpty.textContent = error.message || '插件操作失败。'
    elements.pluginEmpty.hidden = false
  }
})

for (const button of elements.themeButtons) {
  button.addEventListener('click', async () => {
    const previousTheme = state.theme || 'system'
    const nextTheme = button.dataset.themeValue
    applyTheme(nextTheme)
    try {
      const saved = await desktopMethod('setTheme')(nextTheme)
      state = { ...state, ...(saved || {}), theme: nextTheme }
      applyTheme(state.theme)
    } catch (error) {
      applyTheme(previousTheme)
      setOperationStatus(error.message || '主题保存失败。', true)
    }
  })
}

const preferenceInputs = [elements.minimizeToTray, elements.startAtLogin, elements.notifications, elements.crashRecovery, elements.diagnosticMode, elements.autoDownloadUpdates]
for (const input of preferenceInputs) {
  input.addEventListener('change', async () => {
    const enabled = input.checked
    input.disabled = true
    try {
      applyPreferenceState(await savePreferences({ [input.id]: enabled }))
    } catch (error) {
      input.checked = !enabled
      setOperationStatus(error.message || '偏好保存失败。', true)
    } finally {
      input.disabled = false
    }
  })
}
elements.checkForUpdates.addEventListener('change', async () => {
  const enabled = elements.checkForUpdates.checked
  elements.checkForUpdates.disabled = true
  try {
    applyPreferenceState(await savePreferences({ checkForUpdates: enabled }))
  } catch (error) {
    elements.checkForUpdates.checked = !enabled
    renderUpdateResult({ error: error.message || '更新设置保存失败。' })
  } finally {
    elements.checkForUpdates.disabled = false
  }
})
elements.updateChannel.addEventListener('change', async () => {
  const previous = state.updateChannel || 'stable'
  const next = elements.updateChannel.value
  elements.updateChannel.disabled = true
  try {
    applyPreferenceState(await savePreferences({ updateChannel: next }))
    state.updateChannel = next
  } catch (error) {
    elements.updateChannel.value = previous
    renderUpdateResult({ error: error.message || '更新渠道保存失败。' })
  } finally {
    elements.updateChannel.disabled = false
  }
})

elements.checkUpdateButton.addEventListener('click', async () => {
  elements.checkUpdateButton.disabled = true
  elements.checkUpdateButton.textContent = '正在检查…'
  elements.updateHeadline.textContent = '正在检查桌面版和内置核心'
  elements.updateDetail.textContent = '正在读取当前渠道的兼容版本清单。'
  try {
    const result = typeof globalThis.desktop?.checkAppUpdate === 'function'
      ? await globalThis.desktop.checkAppUpdate()
      : await desktopMethod('checkHarnessUpdate')()
    state.updateState = result
    renderUpdateResult(result)
  } catch (error) {
    renderUpdateResult({ error: error.message || '请检查网络后重试。' })
  } finally {
    elements.checkUpdateButton.disabled = false
    elements.checkUpdateButton.textContent = '立即检查'
  }
})
elements.downloadUpdateButton.addEventListener('click', async () => {
  elements.downloadUpdateButton.disabled = true
  try {
    const result = await desktopMethod('downloadUpdate')()
    renderUpdateResult(result || { phase: 'downloading', progress: 0 })
  } catch (error) {
    renderUpdateResult({ error: error.message || '更新下载失败。' })
  } finally {
    elements.downloadUpdateButton.disabled = false
  }
})
elements.restartInstallButton.addEventListener('click', () => void desktopMethod('installDownloadedUpdate')())
elements.postponeUpdateButton.addEventListener('click', async () => {
  try {
    await desktopMethod('postponeUpdate')()
    elements.updateActions.hidden = true
    elements.updateHeadline.textContent = '已稍后提醒'
    elements.updateDetail.textContent = '更新保留在本机，下次启动时再次提醒。'
  } catch (error) {
    renderUpdateResult({ error: error.message || '无法稍后处理更新。' })
  }
})
elements.rollbackUpdateButton.addEventListener('click', async () => {
  elements.rollbackUpdateButton.disabled = true
  try {
    const result = await desktopMethod('rollbackUpdate')()
    if (result?.canceled) elements.rollbackUpdateButton.disabled = false
  } catch (error) {
    renderUpdateResult({ error: error.message || '无法恢复上一版。' })
    elements.rollbackUpdateButton.disabled = false
  }
})

async function runMaintenance(button, method, progressLabel) {
  button.disabled = true
  setOperationStatus(`${progressLabel}…`)
  try {
    const result = await desktopMethod(method)()
    setOperationStatus(result?.message || `${progressLabel}完成${result?.path ? `：${result.path}` : ''}`)
  } catch (error) {
    setOperationStatus(error.message || `${progressLabel}失败。`, true)
  } finally {
    button.disabled = false
  }
}
elements.backupData.addEventListener('click', () => void runMaintenance(elements.backupData, 'backupData', '正在备份'))
elements.restoreData.addEventListener('click', () => void runMaintenance(elements.restoreData, 'restoreData', '正在恢复'))
elements.exportDiagnostics.addEventListener('click', () => void runMaintenance(elements.exportDiagnostics, 'exportDiagnostics', '正在导出脱敏诊断包'))
elements.openLogs.addEventListener('click', () => void runMaintenance(elements.openLogs, 'openLogs', '正在打开日志'))
elements.clearDataButton.addEventListener('click', () => { elements.clearDataConfirm.hidden = false; elements.confirmClearData.focus() })
elements.cancelClearData.addEventListener('click', () => { elements.clearDataConfirm.hidden = true; elements.clearDataButton.focus() })
elements.confirmClearData.addEventListener('click', async () => {
  elements.confirmClearData.disabled = true
  try {
    await desktopMethod('clearUserData')()
    elements.clearDataConfirm.hidden = true
    setOperationStatus('本机数据已清除，应用将重新进入首次设置。')
  } catch (error) {
    setOperationStatus(error.message || '清除数据失败。', true)
    elements.confirmClearData.disabled = false
  }
})

elements.retryButton.addEventListener('click', async () => {
  elements.retryButton.disabled = true
  showScreen('loading')
  elements.loadingMessage.textContent = '正在重新启动…'
  await desktopMethod('retryStart')()
})
elements.settingsButton.addEventListener('click', () => void desktopMethod('openSettingsSection')(errorDefinitions[currentErrorCategory].section))
elements.repairRuntimeButton.addEventListener('click', async () => {
  elements.repairRuntimeButton.disabled = true
  elements.errorOperationStatus.textContent = '正在验证并修复运行环境…'
  try {
    const result = await desktopMethod('repairRuntime')()
    elements.errorOperationStatus.textContent = result?.message || '修复完成，请重新启动。'
  } catch (error) {
    elements.errorOperationStatus.textContent = error.message || '运行环境修复失败。'
  } finally {
    elements.repairRuntimeButton.disabled = false
  }
})
elements.copyDiagnosticsButton.addEventListener('click', async () => {
  try {
    await desktopMethod('copyDiagnostics')({ category: currentErrorCategory, code: query.get('code') || undefined })
    elements.errorOperationStatus.textContent = '已复制脱敏诊断信息。'
  } catch (error) {
    elements.errorOperationStatus.textContent = error.message || '复制诊断信息失败。'
  }
})
elements.errorOpenLogsButton.addEventListener('click', async () => {
  try { await desktopMethod('openLogs')() } catch (error) { elements.errorOperationStatus.textContent = error.message || '无法打开日志。' }
})
elements.errorResetButton.addEventListener('click', async () => {
  try {
    await desktopMethod('resetRuntimeState')()
    elements.errorOperationStatus.textContent = '启动状态已重置，请重新启动。'
  } catch (error) {
    elements.errorOperationStatus.textContent = error.message || '重置失败。'
  }
})

void initialize().catch((error) => {
  showScreen('error')
  state = {}
  renderError(error.message || '界面初始化失败')
})
