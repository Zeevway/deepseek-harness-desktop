const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')
}

test('settings center exposes the six standalone sections without duplicate ids', () => {
  const html = read('src/ui/index.html')

  for (const section of ['api-key', 'workspace', 'permissions', 'plugins', 'updates', 'appearance']) {
    assert.match(html, new RegExp(`data-section-panel="${section}"`, 'u'))
    assert.match(html, new RegExp(`role="tabpanel" aria-labelledby="tab-${section}"`, 'u'))
  }

  const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1])
  assert.equal(new Set(ids).size, ids.length)
  assert.match(html, /社区发行版/u)
})

test('first-use wizard has ordered navigation, status and focus semantics', () => {
  const html = read('src/ui/index.html')
  const script = read('src/ui/app.js')

  assert.deepEqual(
    [...html.matchAll(/data-wizard-step="(\d)"/gu)].map((match) => match[1]),
    ['1', '2', '3'],
  )
  assert.match(html, /id="previousButton"[^>]*>上一步/u)
  assert.match(html, /id="nextButton"[^>]*>下一步/u)
  assert.match(html, /完成设置并开始使用/u)
  assert.match(html, /role="tablist" aria-orientation="vertical"/u)
  assert.match(script, /focusPanel/u)
  assert.match(script, /compactNavigation\.matches \? 'horizontal' : 'vertical'/u)
  assert.match(script, /compactNavigation\.matches \? 'ArrowLeft' : 'ArrowUp'/u)
  assert.match(script, /compactNavigation\.matches \? 'ArrowRight' : 'ArrowDown'/u)
  assert.match(script, /Home.*End/u)
})

test('API key workflow tests saved and replacement keys without silently overwriting', () => {
  const html = read('src/ui/index.html')
  const script = read('src/ui/app.js')

  assert.match(html, /输入新 Key 并保存时，旧 Key 会被替换且无法恢复/u)
  assert.match(html, /连接测试不会修改已保存的 Key/u)
  assert.match(html, /id="testConnection"[^>]*>测试连接/u)
  assert.match(html, /id="deleteKeyButton"[^>]*>删除/u)
  assert.match(script, /desktopMethod\('testSavedApiKey'\)/u)
  assert.match(script, /desktopMethod\('testApiKey'\)\(apiKey\)/u)
  assert.match(script, /desktopMethod\('deleteApiKey'\)/u)
  assert.match(script, /verifiedKeyValue === candidate/u)
  assert.match(script, /candidate \? '设置已保存；新 Key 已替换旧 Key' : '设置已保存；已保存的 Key 未变更'/u)
  assert.match(html, /Windows DPAPI/u)
})

test('workspace UI distinguishes program, data and project paths and gates preflight', () => {
  const html = read('src/ui/index.html')
  const script = read('src/ui/app.js')

  for (const copy of ['程序', 'Harness 数据', '工作区', 'Windows AppData', '恢复默认', '最近工作区']) {
    assert.match(html, new RegExp(copy, 'u'))
  }
  assert.match(html, /D:\\DeepSeek Harness Desktop/u)
  assert.match(html, /磁盘类型、剩余空间和可写性/u)
  assert.match(script, /desktopMethod\('inspectWorkspace'\)\(path, permissionMode\)/u)
  assert.match(script, /desktopMethod\('chooseDataDirectory'\)/u)
  assert.match(script, /workspaceCheck\?\.ok === true && workspaceCheck\.permissionMode === currentPermissionMode\(\)/u)
  assert.match(script, /workspaceAssessmentGeneration \+= 1[\s\S]*workspaceCheck = null[\s\S]*assessWorkspace\(elements\.workspace\.value\)/u)
  assert.match(script, /recentWorkspaces/u)
})

test('mode and permission selection requires explicit Full Access confirmation', () => {
  const html = read('src/ui/index.html')
  const script = read('src/ui/app.js')

  for (const value of ['normal', 'plan', 'read-only', 'workspace-write', 'full-access']) {
    assert.match(html, new RegExp(`value="${value}"`, 'u'))
  }
  assert.match(html, /Full Access 不会逐项请求批准/u)
  assert.match(html, /本次确认不会保存/u)
  assert.match(html, /当前将生效/u)
  assert.match(script, /permissionMode[^\n]+full-access/u)
  assert.match(script, /confirmFullAccess\.checked/u)
  assert.match(script, /confirmFullAccess\.checked = false/u)
})

test('plugin manager exposes discovery, provenance, permissions and lifecycle actions', () => {
  const html = read('src/ui/index.html')
  const script = read('src/ui/app.js')

  assert.match(html, /data-plugin-view="discover"/u)
  assert.match(html, /data-plugin-view="installed"/u)
  assert.match(html, /id="plugin-tab-discover"[\s\S]*aria-controls="pluginViewPanel"/u)
  assert.match(html, /id="plugin-tab-installed"[\s\S]*tabindex="-1"/u)
  assert.match(html, /id="pluginViewPanel" role="tabpanel" aria-labelledby="plugin-tab-discover"/u)
  assert.match(script, /activatePluginView/u)
  assert.match(script, /ArrowLeft.*ArrowRight.*Home.*End/u)
  assert.match(script, /item\.tabIndex = active \? 0 : -1/u)
  assert.match(html, /插件安全模式/u)
  assert.match(script, /来源：/u)
  assert.match(script, /plugin\.permissions/u)
  assert.match(script, /activeSection === 'plugins' && !pluginsLoaded && !pluginsLoading/u)
  assert.match(script, /pluginsLoaded = true/u)
  assert.match(script, /pluginData\.discoveryError/u)
  assert.match(script, /插件发现失败：\$\{discoveryError\}/u)
  for (const method of ['listPlugins', 'installPlugin', 'updatePlugin', 'setPluginEnabled', 'uninstallPlugin', 'rollbackPlugin', 'setPluginSafeMode']) {
    assert.match(script, new RegExp(`['"]${method}['"]`, 'u'))
  }
  assert.match(html, /社区主题/u)
  assert.doesNotMatch(html, /官方推荐主题/u)
})

test('system notification copy matches the implemented completion, approval, update and recovery events', () => {
  const html = read('src/ui/index.html')

  for (const message of ['本轮处理完成', '需要批准', '更新就绪', '恢复异常']) {
    assert.match(html, new RegExp(message, 'u'))
  }
  assert.doesNotMatch(html, /任务已完成/u)
})

test('official and community links are fixed HTTPS destinations', () => {
  const html = read('src/ui/index.html')

  for (const url of [
    'https://github.com/deepseek-ai/deepseek-harness',
    'https://github.com/deepseek-ai/deepseek-harness/tags',
    'https://github.com/topics/dsh-plugin',
    'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin',
  ]) {
    assert.equal(html.includes(`href="${url}"`), true)
  }
  assert.equal(html.includes('target="_blank" rel="noopener noreferrer"'), true)
})

test('update center separates desktop and core versions and offers recovery controls', () => {
  const html = read('src/ui/index.html')
  const script = read('src/ui/app.js')

  assert.match(html, /桌面应用/u)
  assert.match(html, /内置 Harness 核心/u)
  assert.match(html, /value="stable"/u)
  assert.match(html, /value="preview"/u)
  assert.match(html, /正在下载/u)
  assert.match(html, /稍后提醒/u)
  assert.match(html, /重启并安装/u)
  assert.match(html, /恢复上一版/u)
  assert.match(html, /健康检查失败时保留恢复快照，可在此手动恢复上一版/u)
  assert.doesNotMatch(html, /健康检查失败时恢复上一版/u)
  for (const method of ['checkAppUpdate', 'downloadUpdate', 'installDownloadedUpdate', 'postponeUpdate', 'rollbackUpdate']) {
    assert.match(script, new RegExp(method, 'u'))
  }
  assert.match(script, /elements\.downloadUpdateButton\.hidden = true/u)
  assert.match(script, /else if \(typeof next\.updateProgress === 'number'\)/u)
  assert.match(script, /result\?\.canceled\) elements\.rollbackUpdateButton\.disabled = false/u)
})

test('appearance, startup and maintenance preferences use the agreed field names', () => {
  const html = read('src/ui/index.html')
  const script = read('src/ui/app.js')

  for (const theme of ['system', 'light', 'dark']) {
    assert.match(html, new RegExp(`data-theme-value="${theme}"`, 'u'))
  }
  for (const field of ['dataDirectory', 'startAtLogin', 'minimizeToTray', 'notifications', 'autoDownloadUpdates', 'updateChannel', 'diagnosticMode', 'crashRecovery']) {
    assert.match(html, new RegExp(`id="${field}"`, 'u'))
    assert.match(script, new RegExp(field, 'u'))
  }
  for (const method of ['backupData', 'restoreData', 'exportDiagnostics', 'openLogs', 'clearUserData']) {
    assert.match(script, new RegExp(`['"]${method}['"]`, 'u'))
  }
  assert.match(html, /卸载程序会询问“保留数据”或“同时删除数据”/u)
})

test('error page classifies failures and exposes narrow recovery actions', () => {
  const html = read('src/ui/index.html')
  const script = read('src/ui/app.js')

  for (const category of ['api-key', 'network', 'workspace', 'runtime', 'update']) {
    assert.match(script, new RegExp(`(?:'${category}'|${category}):`, 'u'))
  }
  assert.match(html, /复制诊断信息/u)
  assert.match(html, /打开日志/u)
  assert.match(html, /修复运行环境/u)
  assert.match(html, /重置启动状态/u)
  for (const method of ['copyDiagnostics', 'repairRuntime', 'resetRuntimeState']) {
    assert.match(script, new RegExp(`['"]${method}['"]`, 'u'))
  }
})

test('responsive and accessibility CSS covers narrow, scaled and high-contrast layouts', () => {
  const html = read('src/ui/index.html')
  const css = read('src/ui/styles.css')
  const capture = read('scripts/capture-ui.cjs')

  assert.match(html, /class="skip-link"/u)
  assert.match(html, /aria-live="polite"/u)
  assert.match(css, /min-width:\s*320px/u)
  assert.match(css, /@media \(max-width: 760px\)/u)
  assert.match(css, /@media \(max-width: 520px\)/u)
  assert.match(css, /@media \(forced-colors: active\)/u)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u)
  assert.doesNotMatch(css, /font-size:\s*[^;]*(?:vw|cqw)/u)
  assert.doesNotMatch(css, /letter-spacing:\s*-/u)
  assert.match(capture, /capture\(send, 360, 720[\s\S]*deviceScaleFactor: 2/u)
  assert.match(capture, /name: 'forced-colors'[\s\S]*value: forcedColors \? 'active' : 'none'/u)
  assert.match(capture, /pixel size mismatch/u)
  assert.match(capture, /has horizontal overflow/u)
  assert.match(capture, /screenshot is unexpectedly small and may be blank/u)
  assert.match(capture, /navigationOrientation/u)
  assert.match(capture, /compact navigation orientation is not horizontal/u)
  assert.match(capture, /no visible next-step control/u)
  assert.match(capture, /if \(!packagedExecutable\) launchArguments\.push\('--no-sandbox', projectRoot\)/u)
})
