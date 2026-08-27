'use strict'

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const semver = require('semver')

const { compareSemver, parseSemver } = require('./update-checker.cjs')

const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size=30'
const GITHUB_TOPIC_URL = 'https://github.com/topics/dsh-plugin'
const AWESOME_PLUGINS_URL = 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin'
const PLUGIN_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u
const MAX_OUTPUT_LENGTH = 32_768
const PLUGIN_TRANSACTION_VERSION = 1
const PLUGIN_TRANSACTION_FILE = 'desktop-plugin-transaction.json'
const SNAPSHOT_MANIFEST_FILE = 'transaction-snapshot.json'
const SNAPSHOT_FILES = Object.freeze(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'])
const TRANSACTION_PHASES = new Set(['prepared', 'running', 'commit-ready', 'committed'])

class PluginManagerError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message)
    this.name = 'PluginManagerError'
    this.code = code
    this.details = details
    if (cause !== undefined) this.cause = cause
  }
}

function pluginError(code, message, details, cause) {
  return new PluginManagerError(code, message, details, cause)
}

function assertPluginName(name) {
  if (typeof name !== 'string' || !PLUGIN_NAME_PATTERN.test(name.trim())) {
    throw pluginError('INVALID_PLUGIN_NAME', '插件名称无效，只能安装 npm 软件包。')
  }
  return name.trim()
}

function assertExactVersion(version) {
  try {
    parseSemver(version)
  } catch (cause) {
    throw pluginError('INVALID_PLUGIN_VERSION', '插件必须使用明确的版本号。', { version }, cause)
  }
  return version
}

function registryPackageUrl(name) {
  return `https://registry.npmjs.org/${encodeURIComponent(name)}`
}

function normalizeRepository(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/^git\+/u, '')
    .replace(/^git:\/\/github\.com\//u, 'https://github.com/')
    .replace(/\.git$/u, '')
}

function inferCapabilities(manifest) {
  const text = [
    manifest.name,
    manifest.description,
    ...(Array.isArray(manifest.keywords) ? manifest.keywords : []),
    ...Object.keys(manifest.dependencies || {}),
  ].join(' ').toLowerCase()
  const capabilities = ['在 Harness 进程中运行']
  if (/file|filesystem|workspace|glob|search|editor|skill/u.test(text)) capabilities.push('可能读取或修改文件')
  if (/shell|bash|pwsh|powershell|terminal|command|process|execa|spawn/u.test(text)) capabilities.push('可能执行本机命令')
  if (/http|web|browser|fetch|axios|undici|socket|mcp|api/u.test(text)) capabilities.push('可能访问网络')
  if (manifest.dsh?.bundle?.patch) capabilities.push('修改 Harness 配置层')
  return capabilities
}

function publicManifest(manifest, source = 'npm', harnessVersion = '') {
  const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {}
  const installScripts = ['preinstall', 'install', 'postinstall', 'prepare'].filter((name) => scripts[name])
  const compatibility = manifest.peerDependencies?.['@deepseek-ai/dsh'] || ''
  let compatibilityState = 'unknown'
  if (compatibility && semver.valid(harnessVersion)) {
    compatibilityState = semver.satisfies(harnessVersion, compatibility, { includePrerelease: true })
      ? 'compatible'
      : 'incompatible'
  }
  const integrity = manifest.dist?.integrity || manifest.dist?.shasum || ''
  return {
    name: manifest.name,
    version: manifest.version,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    license: typeof manifest.license === 'string' ? manifest.license : '未声明',
    homepage: typeof manifest.homepage === 'string' ? manifest.homepage : '',
    repository: normalizeRepository(manifest.repository),
    source,
    integrity,
    compatibility,
    compatibilityState,
    capabilities: inferCapabilities(manifest),
    installScripts,
    scriptsBlocked: installScripts.length > 0,
    isHarnessBundle: Boolean(manifest.dsh?.bundle?.patch),
    risk: installScripts.length > 0 ? 'high' : 'review',
  }
}

function readJson(filename, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

function writeJsonAtomic(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, filename)
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
    try {
      fs.unlinkSync(temporary)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function lstatIfPresent(filename) {
  try {
    return fs.lstatSync(filename)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function removePathNoFollow(filename) {
  const stat = lstatIfPresent(filename)
  if (!stat) return
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.rmSync(filename, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    return
  }
  fs.unlinkSync(filename)
}

function copyFileAtomic(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.restore.tmp`
  try {
    fs.copyFileSync(source, temporary)
    const targetStat = lstatIfPresent(target)
    if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink())) {
      removePathNoFollow(target)
    }
    fs.renameSync(temporary, target)
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function safePackagePath(root, packageName) {
  const segments = packageName.split('/')
  const candidate = path.resolve(root, 'node_modules', ...segments, 'package.json')
  const expectedRoot = `${path.resolve(root, 'node_modules')}${path.sep}`
  if (!candidate.startsWith(expectedRoot)) {
    throw pluginError('INVALID_PLUGIN_NAME', '插件路径无效。')
  }
  return candidate
}

function sanitizedEnvironment(overrides = {}) {
  const source = process.env
  const allowed = [
    'ALLUSERSPROFILE', 'APPDATA', 'CommonProgramFiles', 'CommonProgramFiles(x86)',
    'CommonProgramW6432', 'COMPUTERNAME', 'ComSpec', 'HOMEDRIVE', 'HOMEPATH',
    'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'Path', 'PATHEXT',
    'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'ProgramData', 'ProgramFiles',
    'ProgramFiles(x86)', 'ProgramW6432', 'PSModulePath', 'PUBLIC', 'SystemDrive',
    'SystemRoot', 'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'windir',
  ]
  const result = {}
  for (const key of allowed) {
    if (typeof source[key] === 'string') result[key] = source[key]
  }
  return { ...result, ...overrides }
}

function createPnpmShim(directory, executable, pnpmBin) {
  fs.mkdirSync(directory, { recursive: true })
  const filename = path.join(directory, 'pnpm.cmd')
  const quote = (value) => String(value).replaceAll('%', '%%').replaceAll('"', '""')
  const contents = [
    '@echo off',
    'setlocal',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"${quote(executable)}" "${quote(pnpmBin)}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n')
  fs.writeFileSync(filename, contents, { encoding: 'utf8', mode: 0o700 })
  return filename
}

function runProcess(spawnImpl, executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl(executable, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (cause) {
      reject(pluginError('PLUGIN_COMMAND_FAILED', '无法启动插件管理程序。', {}, cause))
      return
    }

    let stdout = ''
    let stderr = ''
    const append = (value, chunk) => `${value}${String(chunk)}`.slice(-MAX_OUTPUT_LENGTH)
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk) })
    child.once('error', (cause) => reject(pluginError('PLUGIN_COMMAND_FAILED', '插件管理程序启动失败。', {}, cause)))
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(pluginError(
        'PLUGIN_COMMAND_FAILED',
        '插件操作失败，原有配置已保留。',
        { exitCode: code, signal, output: stderr.trim() || stdout.trim() },
      ))
    })
  })
}

class PluginManager {
  constructor(options = {}) {
    this.dshHome = path.resolve(options.dshHome || '')
    this.dshBin = path.resolve(options.dshBin || '')
    this.executable = path.resolve(options.executable || '')
    this.pnpmBin = path.resolve(options.pnpmBin || '')
    this.fetch = options.fetchImpl ?? globalThis.fetch
    this.spawn = options.spawn ?? childProcess.spawn
    this.logger = options.logger ?? (() => {})
    this.profile = options.profile || 'web'
    this.harnessVersion = options.harnessVersion || ''
    this.profileDir = path.join(this.dshHome, 'profiles', this.profile)
    this.historyFile = path.join(this.dshHome, 'desktop-plugin-history.json')
    this.safeModeFile = path.join(this.dshHome, 'desktop-plugin-safe-mode.json')
    this.backupRoot = path.join(this.dshHome, 'desktop-plugin-backups')
    this.transactionFile = path.join(this.dshHome, PLUGIN_TRANSACTION_FILE)
    this.recoverInterruptedTransaction()
  }

  async requestJson(url, timeoutMs = 15_000) {
    if (typeof this.fetch !== 'function') {
      throw pluginError('NETWORK_UNAVAILABLE', '当前环境无法访问插件目录。')
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'DeepSeek-Harness-Desktop' },
        signal: controller.signal,
      })
      if (!response?.ok || typeof response.json !== 'function') {
        throw pluginError('PLUGIN_REGISTRY_ERROR', '插件目录暂时不可用。', { status: response?.status })
      }
      return await response.json()
    } catch (error) {
      if (error instanceof PluginManagerError) throw error
      if (error?.name === 'AbortError') throw pluginError('PLUGIN_REGISTRY_TIMEOUT', '查询插件目录超时。')
      throw pluginError('PLUGIN_REGISTRY_ERROR', '无法连接插件目录。', {}, error)
    } finally {
      clearTimeout(timeout)
    }
  }

  async discover() {
    const document = await this.requestJson(NPM_SEARCH_URL)
    const objects = Array.isArray(document?.objects) ? document.objects : []
    return {
      items: objects
        .map((entry) => entry?.package)
        .filter((manifest) => manifest?.name && manifest?.version)
        .map((manifest) => publicManifest(manifest, 'npm-search', this.harnessVersion)),
      communityLinks: [GITHUB_TOPIC_URL, AWESOME_PLUGINS_URL],
    }
  }

  async inspect(name, version) {
    const normalizedName = assertPluginName(name)
    const document = await this.requestJson(registryPackageUrl(normalizedName))
    const selectedVersion = version || document?.['dist-tags']?.latest
    assertExactVersion(selectedVersion)
    const manifest = document?.versions?.[selectedVersion]
    if (!manifest || manifest.name !== normalizedName) {
      throw pluginError('PLUGIN_VERSION_NOT_FOUND', '找不到指定的插件版本。', { name: normalizedName, version: selectedVersion })
    }
    return publicManifest(manifest, 'npm', this.harnessVersion)
  }

  listInstalled() {
    const profile = readJson(path.join(this.profileDir, 'package.json'), { dependencies: {}, dsh: { profile: { bundles: [] } } })
    const dependencies = profile?.dependencies && typeof profile.dependencies === 'object' ? profile.dependencies : {}
    const bundles = new Set(Array.isArray(profile?.dsh?.profile?.bundles) ? profile.dsh.profile.bundles : [])
    const history = readJson(this.historyFile, [])
    return Object.entries(dependencies).map(([name, requestedVersion]) => {
      let manifest = null
      try {
        manifest = readJson(safePackagePath(this.profileDir, name))
      } catch (error) {
        this.logger(`could not read plugin ${name}: ${error.message}`)
      }
      return {
        ...(manifest ? publicManifest(manifest, 'installed', this.harnessVersion) : {
          name,
          version: String(requestedVersion).replace(/^[~^]/u, ''),
          description: '',
          license: '未知',
          repository: '',
          source: 'installed',
          integrity: '',
          compatibility: '',
          compatibilityState: 'unknown',
          capabilities: ['插件文件不完整'],
          installScripts: [],
          scriptsBlocked: false,
          isHarnessBundle: bundles.has(name),
          risk: 'high',
        }),
        requestedVersion,
        enabled: bundles.has(name),
        broken: !manifest,
        installed: true,
        rollbackAvailable: Array.isArray(history) && history.some((entry) => entry.name === name),
      }
    })
  }

  async listWithUpdates() {
    const installed = this.listInstalled()
    return Promise.all(installed.map(async (plugin) => {
      try {
        const latest = await this.inspect(plugin.name)
        return {
          ...plugin,
          latestVersion: latest.version,
          updateAvailable: compareSemver(plugin.version, latest.version) < 0,
        }
      } catch (error) {
        return { ...plugin, latestVersion: '', updateAvailable: false, updateError: error.message }
      }
    }))
  }

  snapshot(name, action) {
    const normalizedName = assertPluginName(name)
    if (!['install', 'update', 'uninstall'].includes(action)) {
      throw pluginError('PLUGIN_TRANSACTION_INVALID', '插件事务类型无效。', { action })
    }
    const installed = this.listInstalled().find((item) => item.name === normalizedName)
    const id = `${Date.now()}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
    const directory = path.join(this.backupRoot, id)
    fs.mkdirSync(this.backupRoot, { recursive: true })
    const backupRootStat = lstatIfPresent(this.backupRoot)
    if (!backupRootStat?.isDirectory() || backupRootStat.isSymbolicLink()) {
      throw pluginError('PLUGIN_TRANSACTION_INVALID', '插件事务目录不是本机普通目录，已停止操作。')
    }
    fs.mkdirSync(directory)
    const files = {}
    try {
      for (const filename of SNAPSHOT_FILES) {
        const source = path.join(this.profileDir, filename)
        const stat = lstatIfPresent(source)
        files[filename] = Boolean(stat)
        if (!stat) continue
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw pluginError('PLUGIN_TRANSACTION_INVALID', `插件配置文件不是普通文件：${filename}`)
        }
        fs.copyFileSync(source, path.join(directory, filename))
      }
      const nodeModules = path.join(this.profileDir, 'node_modules')
      const nodeModulesStat = lstatIfPresent(nodeModules)
      if (nodeModulesStat && (!nodeModulesStat.isDirectory() || nodeModulesStat.isSymbolicLink())) {
        throw pluginError('PLUGIN_TRANSACTION_INVALID', '插件 node_modules 不是本机普通目录，已停止操作。')
      }
      const snapshot = {
        version: PLUGIN_TRANSACTION_VERSION,
        id,
        directory,
        action,
        name: normalizedName,
        previousVersion: installed?.version || null,
        previousEnabled: installed?.enabled ?? false,
        files,
        nodeModulesExisted: Boolean(nodeModulesStat),
        createdAt: new Date().toISOString(),
      }
      writeJsonAtomic(path.join(directory, SNAPSHOT_MANIFEST_FILE), this.serializeTransaction(snapshot, 'prepared'))
      return snapshot
    } catch (error) {
      try { removePathNoFollow(directory) } catch {}
      throw error
    }
  }

  recordHistory(entry) {
    const history = readJson(this.historyFile, [])
    const stored = {
      id: entry.id,
      directory: entry.directory,
      action: entry.action,
      name: entry.name,
      previousVersion: entry.previousVersion,
      previousEnabled: entry.previousEnabled,
      createdAt: entry.createdAt,
    }
    const previous = Array.isArray(history) ? history.filter((item) => item?.id !== entry.id) : []
    const next = [stored, ...previous].slice(0, 50)
    writeJsonAtomic(this.historyFile, next)
  }

  serializeTransaction(snapshot, phase) {
    return {
      version: PLUGIN_TRANSACTION_VERSION,
      id: snapshot.id,
      action: snapshot.action,
      name: snapshot.name,
      previousVersion: snapshot.previousVersion,
      previousEnabled: snapshot.previousEnabled,
      files: snapshot.files,
      nodeModulesExisted: snapshot.nodeModulesExisted,
      createdAt: snapshot.createdAt,
      phase,
    }
  }

  validateTransaction(document) {
    try {
      if (!document || document.version !== PLUGIN_TRANSACTION_VERSION) throw new Error('unsupported version')
      if (!/^\d{10,}-\d+-[a-f0-9]{12}$/u.test(document.id || '')) throw new Error('invalid id')
      if (!['install', 'update', 'uninstall'].includes(document.action)) throw new Error('invalid action')
      if (!TRANSACTION_PHASES.has(document.phase)) throw new Error('invalid phase')
      const name = assertPluginName(document.name)
      if (document.previousVersion !== null && typeof document.previousVersion !== 'string') {
        throw new Error('invalid previous version')
      }
      if (typeof document.previousEnabled !== 'boolean') throw new Error('invalid enabled state')
      if (typeof document.nodeModulesExisted !== 'boolean') throw new Error('invalid node_modules state')
      if (!document.files || typeof document.files !== 'object' || Array.isArray(document.files)) {
        throw new Error('invalid file state')
      }
      for (const filename of SNAPSHOT_FILES) {
        if (typeof document.files[filename] !== 'boolean') throw new Error(`invalid state for ${filename}`)
      }
      const backupRootStat = lstatIfPresent(this.backupRoot)
      if (!backupRootStat?.isDirectory() || backupRootStat.isSymbolicLink()) {
        throw new Error('snapshot root is unavailable')
      }
      const directory = path.join(this.backupRoot, document.id)
      const stat = lstatIfPresent(directory)
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error('snapshot directory is unavailable')
      const manifestFile = path.join(directory, SNAPSHOT_MANIFEST_FILE)
      const manifestStat = lstatIfPresent(manifestFile)
      if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) throw new Error('snapshot manifest is unavailable')
      const manifest = readJson(manifestFile)
      const expectedManifest = this.serializeTransaction(document, 'prepared')
      if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) throw new Error('snapshot manifest mismatch')
      return { ...document, name, directory }
    } catch (cause) {
      if (cause instanceof PluginManagerError && cause.code !== 'INVALID_PLUGIN_NAME') throw cause
      throw pluginError('PLUGIN_TRANSACTION_INVALID', '检测到无效的插件事务记录，未修改插件文件。', {}, cause)
    }
  }

  readTransaction() {
    let document
    try {
      document = readJson(this.transactionFile)
    } catch (cause) {
      throw pluginError('PLUGIN_TRANSACTION_INVALID', '无法读取插件事务记录，未修改插件文件。', {}, cause)
    }
    return document ? this.validateTransaction(document) : null
  }

  writeTransaction(snapshot, phase) {
    writeJsonAtomic(this.transactionFile, this.serializeTransaction(snapshot, phase))
    snapshot.phase = phase
    return snapshot
  }

  removeTransactionFile() {
    try {
      fs.unlinkSync(this.transactionFile)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  beginTransaction(name, action) {
    this.recoverInterruptedTransaction()
    const snapshot = this.snapshot(name, action)
    try {
      this.writeTransaction(snapshot, 'prepared')
      if (snapshot.nodeModulesExisted) {
        fs.renameSync(
          path.join(this.profileDir, 'node_modules'),
          path.join(snapshot.directory, 'node_modules'),
        )
      }
      this.writeTransaction(snapshot, 'running')
      return snapshot
    } catch (error) {
      try {
        this.restoreSnapshot(snapshot)
        this.removeTransactionFile()
        try { removePathNoFollow(snapshot.directory) } catch {}
      } catch (rollbackCause) {
        throw pluginError(
          'PLUGIN_ROLLBACK_FAILED',
          '无法准备插件事务，自动恢复也未完成；下次打开插件管理时会重试。',
          { action, name: snapshot.name, originalError: error.message },
          rollbackCause,
        )
      }
      throw error
    }
  }

  restoreSnapshot(snapshot) {
    for (const filename of SNAPSHOT_FILES) {
      if (!snapshot.files[filename]) continue
      const backup = path.join(snapshot.directory, filename)
      const stat = lstatIfPresent(backup)
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
        throw pluginError('PLUGIN_ROLLBACK_FAILED', `插件事务缺少可恢复的 ${filename}。`)
      }
    }

    const nodeModules = path.join(this.profileDir, 'node_modules')
    const stagedNodeModules = path.join(snapshot.directory, 'node_modules')
    const discardedNodeModules = path.join(snapshot.directory, 'discarded-node_modules')
    const stagedStat = lstatIfPresent(stagedNodeModules)
    if (stagedStat && (!stagedStat.isDirectory() || stagedStat.isSymbolicLink())) {
      throw pluginError('PLUGIN_ROLLBACK_FAILED', '插件事务中的 node_modules 快照无效。')
    }

    if (stagedStat) {
      removePathNoFollow(discardedNodeModules)
      if (lstatIfPresent(nodeModules)) fs.renameSync(nodeModules, discardedNodeModules)
      fs.mkdirSync(this.profileDir, { recursive: true })
      fs.renameSync(stagedNodeModules, nodeModules)
    } else if (!snapshot.nodeModulesExisted && lstatIfPresent(nodeModules)) {
      removePathNoFollow(discardedNodeModules)
      fs.renameSync(nodeModules, discardedNodeModules)
    } else if (snapshot.nodeModulesExisted && !lstatIfPresent(nodeModules)) {
      throw pluginError('PLUGIN_ROLLBACK_FAILED', '原插件 node_modules 快照已丢失，无法自动恢复。')
    }

    for (const filename of SNAPSHOT_FILES) {
      const backup = path.join(snapshot.directory, filename)
      const target = path.join(this.profileDir, filename)
      if (snapshot.files[filename]) copyFileAtomic(backup, target)
      else removePathNoFollow(target)
    }
  }

  rollbackTransaction(snapshot, originalError) {
    try {
      this.restoreSnapshot(snapshot)
      this.removeTransactionFile()
    } catch (rollbackCause) {
      throw pluginError(
        'PLUGIN_ROLLBACK_FAILED',
        '插件操作失败，且自动回滚未完成；下次打开插件管理时会重试。',
        {
          action: snapshot.action,
          name: snapshot.name,
          originalCode: originalError?.code,
          originalError: originalError?.message,
        },
        rollbackCause,
      )
    }
    try { removePathNoFollow(snapshot.directory) } catch (cleanupError) {
      this.logger(`could not remove failed plugin snapshot ${snapshot.id}: ${cleanupError.message}`)
    }
    throw originalError
  }

  completeCommittedTransaction(snapshot) {
    this.recordHistory(snapshot)
    this.writeTransaction(snapshot, 'committed')
    removePathNoFollow(path.join(snapshot.directory, 'node_modules'))
    removePathNoFollow(path.join(snapshot.directory, 'discarded-node_modules'))
    this.removeTransactionFile()
  }

  recoverInterruptedTransaction() {
    const snapshot = this.readTransaction()
    if (!snapshot) return { recovered: false }
    if (snapshot.phase === 'commit-ready' || snapshot.phase === 'committed') {
      this.completeCommittedTransaction(snapshot)
      return { recovered: true, action: 'committed', name: snapshot.name }
    }
    this.restoreSnapshot(snapshot)
    this.removeTransactionFile()
    try { removePathNoFollow(snapshot.directory) } catch (cleanupError) {
      this.logger(`could not remove recovered plugin snapshot ${snapshot.id}: ${cleanupError.message}`)
    }
    return { recovered: true, action: 'rolled-back', name: snapshot.name }
  }

  commandEnvironment() {
    const shimDir = path.join(this.dshHome, 'desktop-tools')
    createPnpmShim(shimDir, this.executable, this.pnpmBin)
    const existingPath = process.env.Path || process.env.PATH || ''
    return sanitizedEnvironment({
      CI: 'true',
      DSH_HOME: this.dshHome,
      ELECTRON_RUN_AS_NODE: '1',
      Path: `${shimDir}${path.delimiter}${existingPath}`,
      PATH: `${shimDir}${path.delimiter}${existingPath}`,
    })
  }

  async runDshPlugin(args) {
    fs.mkdirSync(this.dshHome, { recursive: true })
    return runProcess(this.spawn, this.executable, [
      this.dshBin,
      'plugin',
      '--profile',
      this.profile,
      ...args,
    ], {
      cwd: this.dshHome,
      env: this.commandEnvironment(),
    })
  }

  assertInstallAllowed(metadata, options) {
    if (options.acceptRisk !== true) {
      throw pluginError('PLUGIN_REVIEW_REQUIRED', '安装前必须确认插件来源、权限和风险。', { plugin: metadata })
    }
    if (!metadata.isHarnessBundle) {
      throw pluginError('NOT_A_HARNESS_PLUGIN', '该软件包没有声明 Harness 插件配置层，已停止安装。', { plugin: metadata })
    }
    if (metadata.compatibilityState === 'incompatible') {
      throw pluginError('PLUGIN_INCOMPATIBLE', '该插件不兼容当前内置 Harness 版本。', { plugin: metadata })
    }
  }

  async runTransactionalCommand(name, action, args, verifyResult) {
    const snapshot = this.beginTransaction(name, action)
    try {
      await this.runDshPlugin(args)
      if (typeof verifyResult === 'function') verifyResult()
    } catch (error) {
      return this.rollbackTransaction(snapshot, error)
    }
    try {
      this.writeTransaction(snapshot, 'commit-ready')
    } catch (error) {
      return this.rollbackTransaction(snapshot, error)
    }
    try {
      this.completeCommittedTransaction(snapshot)
    } catch (cause) {
      throw pluginError(
        'PLUGIN_COMMIT_INCOMPLETE',
        '插件操作已经完成，但事务清理尚未结束；下次打开插件管理时会自动完成。',
        { action, name: snapshot.name },
        cause,
      )
    }
  }

  async installMetadata(metadata, action, options) {
    this.assertInstallAllowed(metadata, options)
    await this.runTransactionalCommand(metadata.name, action, [
      'add',
      `${metadata.name}@${metadata.version}`,
      '--save-exact',
      '--ignore-scripts',
      '--no-frozen-lockfile',
      '--reporter=append-only',
    ], () => {
      const installed = this.listInstalled().find((item) => item.name === metadata.name)
      if (!installed || installed.broken || installed.version !== metadata.version || !installed.isHarnessBundle) {
        throw pluginError(
          'PLUGIN_RESULT_INVALID',
          '插件管理程序未生成完整的目标版本，原有插件状态已恢复。',
          { name: metadata.name, expectedVersion: metadata.version, actualVersion: installed?.version },
        )
      }
    })
    return this.listInstalled().find((item) => item.name === metadata.name)
  }

  async install(name, version, options = {}) {
    const metadata = await this.inspect(name, version)
    const action = this.listInstalled().some((item) => item.name === metadata.name) ? 'update' : 'install'
    return this.installMetadata(metadata, action, options)
  }

  async update(name, options = {}) {
    const metadata = await this.inspect(name)
    return this.installMetadata(metadata, 'update', options)
  }

  async uninstall(name) {
    const normalizedName = assertPluginName(name)
    const installed = this.listInstalled().find((item) => item.name === normalizedName)
    if (!installed) throw pluginError('PLUGIN_NOT_INSTALLED', '插件尚未安装。')
    await this.runTransactionalCommand(
      normalizedName,
      'uninstall',
      ['remove', normalizedName, '--ignore-scripts', '--reporter=append-only'],
      () => {
        if (this.listInstalled().some((item) => item.name === normalizedName)
          || lstatIfPresent(safePackagePath(this.profileDir, normalizedName))) {
          throw pluginError(
            'PLUGIN_RESULT_INVALID',
            '插件管理程序未完整移除目标插件，原有插件状态已恢复。',
            { name: normalizedName },
          )
        }
      },
    )
    return { ok: true, name: normalizedName }
  }

  setEnabled(name, enabled) {
    const normalizedName = assertPluginName(name)
    const manifestFile = path.join(this.profileDir, 'package.json')
    const manifest = readJson(manifestFile)
    if (!manifest?.dependencies?.[normalizedName]) throw pluginError('PLUGIN_NOT_INSTALLED', '插件尚未安装。')
    if (enabled) {
      const installedManifest = readJson(safePackagePath(this.profileDir, normalizedName))
      if (!installedManifest?.dsh?.bundle?.patch) {
        throw pluginError('NOT_A_HARNESS_PLUGIN', '该软件包没有可启用的 Harness 插件配置层。')
      }
    }
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? [...manifest.dsh.profile.bundles] : []
    const currentlyEnabled = bundles.includes(normalizedName)
    if (enabled && !currentlyEnabled) bundles.push(normalizedName)
    if (!enabled && currentlyEnabled) bundles.splice(bundles.indexOf(normalizedName), 1)
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    writeJsonAtomic(manifestFile, manifest)
    return this.listInstalled().find((item) => item.name === normalizedName)
  }

  enable(name) {
    return this.setEnabled(name, true)
  }

  disable(name) {
    return this.setEnabled(name, false)
  }

  enterSafeMode() {
    const manifestFile = path.join(this.profileDir, 'package.json')
    const manifest = readJson(manifestFile)
    if (!manifest) return { disabled: [] }
    const thirdParty = new Set(Object.keys(manifest.dependencies || {}))
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
    const disabled = bundles.filter((name) => thirdParty.has(name))
    writeJsonAtomic(this.safeModeFile, { disabled, createdAt: new Date().toISOString() })
    manifest.dsh = {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles: bundles.filter((name) => !thirdParty.has(name)) },
    }
    writeJsonAtomic(manifestFile, manifest)
    return { disabled }
  }

  exitSafeMode() {
    const manifestFile = path.join(this.profileDir, 'package.json')
    const manifest = readJson(manifestFile)
    const safeMode = readJson(this.safeModeFile, { disabled: [] })
    if (!manifest) return { restored: [] }
    const dependencies = new Set(Object.keys(manifest.dependencies || {}))
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? [...manifest.dsh.profile.bundles] : []
    const restored = []
    for (const name of Array.isArray(safeMode?.disabled) ? safeMode.disabled : []) {
      if (!dependencies.has(name) || bundles.includes(name)) continue
      const installed = readJson(safePackagePath(this.profileDir, name))
      if (!installed?.dsh?.bundle?.patch) continue
      bundles.push(name)
      restored.push(name)
    }
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    writeJsonAtomic(manifestFile, manifest)
    try {
      fs.unlinkSync(this.safeModeFile)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return { restored }
  }

  async rollback(name) {
    const normalizedName = assertPluginName(name)
    const history = readJson(this.historyFile, [])
    const previous = Array.isArray(history) ? history.find((entry) => entry.name === normalizedName) : null
    if (!previous) throw pluginError('PLUGIN_ROLLBACK_UNAVAILABLE', '没有可恢复的插件版本。')
    if (!previous.previousVersion) return this.uninstall(normalizedName)
    const restored = await this.install(normalizedName, previous.previousVersion, { acceptRisk: true })
    if (!previous.previousEnabled) this.disable(normalizedName)
    return restored
  }
}

module.exports = {
  AWESOME_PLUGINS_URL,
  GITHUB_TOPIC_URL,
  NPM_SEARCH_URL,
  PluginManager,
  PluginManagerError,
  assertExactVersion,
  assertPluginName,
  createPnpmShim,
  inferCapabilities,
  publicManifest,
  sanitizedEnvironment,
}
