const { contextBridge, ipcRenderer } = require('electron')

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args)
  if (!response || response.__desktopIpc !== true) return response
  if (response.ok) return response.value
  const error = new Error(response.error?.message || '桌面操作失败')
  error.name = response.error?.name || 'DesktopError'
  error.code = response.error?.code || 'UNKNOWN'
  error.category = response.error?.category || 'unknown'
  error.details = response.error?.details || {}
  throw error
}

if (globalThis.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('desktop', Object.freeze({
    getState: () => invoke('desktop:get-state'),
    chooseWorkspace: (permissionMode) => invoke('desktop:choose-workspace', permissionMode),
    inspectWorkspace: (workspace, permissionMode) => invoke('desktop:inspect-workspace', workspace, permissionMode),
    chooseDataDirectory: () => invoke('desktop:choose-data-directory'),
    testApiKey: (apiKey) => invoke('desktop:test-api-key', apiKey),
    testSavedApiKey: () => invoke('desktop:test-saved-api-key'),
    deleteApiKey: () => invoke('desktop:delete-api-key'),
    saveSettings: (settings) => invoke('desktop:save-settings', settings),
    setPreferences: (preferences) => invoke('desktop:set-preferences', preferences),
    retryStart: () => invoke('desktop:retry-start'),
    openApiKeys: () => invoke('desktop:open-api-keys'),
    openSettings: () => invoke('desktop:open-settings'),
    openSettingsSection: (section) => invoke('desktop:open-settings-section', section),
    setTheme: (theme) => invoke('desktop:set-theme', theme),
    setUpdatePreference: (enabled) => invoke('desktop:set-update-preference', enabled),
    checkHarnessUpdate: () => invoke('desktop:check-harness-update'),
    checkAppUpdate: () => invoke('desktop:check-app-update'),
    downloadUpdate: () => invoke('desktop:download-update'),
    installDownloadedUpdate: () => invoke('desktop:install-downloaded-update'),
    postponeUpdate: () => invoke('desktop:postpone-update'),
    rollbackUpdate: () => invoke('desktop:rollback-update'),
    listPlugins: () => invoke('desktop:list-plugins'),
    installPlugin: (id) => invoke('desktop:install-plugin', id),
    updatePlugin: (id) => invoke('desktop:update-plugin', id),
    setPluginEnabled: (id, enabled) => invoke('desktop:set-plugin-enabled', id, enabled),
    uninstallPlugin: (id) => invoke('desktop:uninstall-plugin', id),
    rollbackPlugin: (id) => invoke('desktop:rollback-plugin', id),
    setPluginSafeMode: (enabled) => invoke('desktop:set-plugin-safe-mode', enabled),
    backupData: () => invoke('desktop:backup-data'),
    restoreData: () => invoke('desktop:restore-data'),
    exportDiagnostics: () => invoke('desktop:export-diagnostics'),
    openLogs: () => invoke('desktop:open-logs'),
    clearUserData: () => invoke('desktop:clear-user-data'),
    repairRuntime: () => invoke('desktop:repair-runtime'),
    copyDiagnostics: (context) => invoke('desktop:copy-diagnostics', context),
    resetRuntimeState: () => invoke('desktop:reset-runtime-state'),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('desktop:status', listener)
      return () => ipcRenderer.removeListener('desktop:status', listener)
    },
    onNavigateSection: (callback) => {
      const listener = (_event, section) => callback(section)
      ipcRenderer.on('desktop:navigate-section', listener)
      return () => ipcRenderer.removeListener('desktop:navigate-section', listener)
    },
  }))
}
