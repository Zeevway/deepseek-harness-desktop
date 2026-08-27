'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { createDataBackup, restoreDataBackup } = require('./data-management.cjs')

const STATE_FORMAT_VERSION = 1

function exists(filename) {
  try {
    fs.accessSync(filename)
    return true
  } catch {
    return false
  }
}

function safeSegment(value) {
  return String(value || 'unknown').replace(/[^0-9A-Za-z._-]/gu, '_').slice(0, 80) || 'unknown'
}

function writeJsonAtomic(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, filename)
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function readDataDirectoryBeforeMigration(configFileValue, defaultDataDirectoryValue) {
  const configFile = path.resolve(configFileValue)
  const fallback = path.resolve(defaultDataDirectoryValue)
  let document
  try {
    document = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/u, ''))
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return fallback
    throw error
  }
  if (document?.dataDirectory === undefined || document.dataDirectory === '') return fallback
  if (typeof document.dataDirectory !== 'string' || !path.isAbsolute(document.dataDirectory)) {
    throw new Error('迁移前设置中的 Harness 数据目录无效')
  }
  const resolved = path.resolve(document.dataDirectory)
  if (resolved === path.parse(resolved).root) {
    throw new Error('迁移前设置不能把磁盘根目录用作 Harness 数据目录')
  }
  return resolved
}

class UpgradeSafety {
  constructor(options = {}) {
    this.stateFile = path.resolve(options.stateFile || '')
    this.backupRoot = path.resolve(options.backupRoot || '')
    this.configFile = path.resolve(options.configFile || '')
    this.appVersion = String(options.appVersion || '')
    this.harnessVersion = String(options.harnessVersion || '')
    this.now = typeof options.now === 'function' ? options.now : () => new Date()
  }

  readState() {
    try {
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      if (state?.formatVersion !== STATE_FORMAT_VERSION) return { formatVersion: STATE_FORMAT_VERSION, history: [] }
      return { ...state, history: Array.isArray(state.history) ? state.history : [] }
    } catch (error) {
      if (error?.code === 'ENOENT') return { formatVersion: STATE_FORMAT_VERSION, history: [] }
      const backup = `${this.stateFile}.invalid-${Date.now()}`
      fs.renameSync(this.stateFile, backup)
      return { formatVersion: STATE_FORMAT_VERSION, history: [], invalidStateBackup: backup }
    }
  }

  writeState(state) {
    writeJsonAtomic(this.stateFile, { ...state, formatVersion: STATE_FORMAT_VERSION })
  }

  getStatus() {
    const state = this.readState()
    const rollback = state.pending || state.lastUpgrade
    return {
      pending: state.pending || null,
      lastSuccessfulAppVersion: state.lastSuccessfulAppVersion || '',
      lastSuccessfulHarnessVersion: state.lastSuccessfulHarnessVersion || '',
      rollbackAvailable: Boolean(rollback?.backupDirectory && exists(rollback.backupDirectory)),
      rollback: rollback || null,
    }
  }

  prepare(dataDirectory, options = {}) {
    const state = this.readState()
    if (state.pending && state.pending.targetAppVersion === this.appVersion) {
      if (!exists(state.pending.backupDirectory)) {
        if (!options.previousAppVersion) {
          throw new Error('升级前数据快照丢失，已停止启动以避免覆盖可回滚状态')
        }
      } else {
        const pending = state.pending.targetHarnessVersion === this.harnessVersion
          ? state.pending
          : {
              ...state.pending,
              targetHarnessVersion: this.harnessVersion,
              targetHarnessVersionConfirmedAt: this.now().toISOString(),
            }
        if (pending !== state.pending) this.writeState({ ...state, pending })
        return { created: false, pending }
      }
    }
    if (state.pending && state.pending.targetAppVersion !== this.appVersion
      && exists(state.pending.backupDirectory)) {
      if (options.previousAppVersion) {
        throw new Error('检测到尚未完成的其它桌面版本升级，已保留其数据快照')
      }
      return { created: false, pending: state.pending, awaitingTarget: true }
    }
    if (state.lastSuccessfulAppVersion === this.appVersion) {
      return { created: false, pending: null }
    }

    const hasConfig = exists(this.configFile)
    const hasData = exists(dataDirectory)
    const timestamp = this.now().toISOString().replace(/[:.]/gu, '-')
    const previousAppVersion = String(options.previousAppVersion || state.lastSuccessfulAppVersion || '')
    const previousHarnessVersion = String(options.previousHarnessVersion || state.lastSuccessfulHarnessVersion || '')
    const previous = safeSegment(previousHarnessVersion || 'pre-0.3')
    const target = safeSegment(this.harnessVersion)
    const destination = path.join(this.backupRoot, `Upgrade-${previous}-to-${target}-${timestamp}`)
    const backup = createDataBackup({
      destination,
      configFile: this.configFile,
      dataDirectory,
      appVersion: state.lastSuccessfulAppVersion || 'unknown',
      harnessVersion: state.lastSuccessfulHarnessVersion || 'unknown',
      now: this.now(),
    })
    const pending = {
      backupDirectory: backup.destination,
      previousAppVersion,
      previousHarnessVersion,
      targetAppVersion: this.appVersion,
      targetHarnessVersion: this.harnessVersion,
      createdAt: this.now().toISOString(),
      emptyInstall: !hasConfig && !hasData,
    }
    this.writeState({ ...state, pending })
    return { created: true, pending }
  }

  markHealthy() {
    const state = this.readState()
    if (state.pending && state.pending.targetAppVersion !== this.appVersion) {
      return this.getStatus()
    }
    const pending = state.pending || null
    const history = pending && pending.backupDirectory
      ? [pending, ...state.history.filter((entry) => entry.backupDirectory !== pending.backupDirectory)].slice(0, 10)
      : state.history
    this.writeState({
      ...state,
      pending: null,
      lastUpgrade: pending && pending.backupDirectory ? pending : state.lastUpgrade,
      history,
      lastSuccessfulAppVersion: this.appVersion,
      lastSuccessfulHarnessVersion: this.harnessVersion,
      lastHealthyAt: this.now().toISOString(),
    })
    return this.getStatus()
  }

  markFailed(error) {
    const state = this.readState()
    if (!state.pending || state.pending.targetAppVersion !== this.appVersion) return this.getStatus()
    this.writeState({
      ...state,
      pending: {
        ...state.pending,
        failedAt: this.now().toISOString(),
        failureCode: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
      },
    })
    return this.getStatus()
  }

  restoreLatest(dataDirectory, options = {}) {
    const status = this.getStatus()
    const backupDirectory = status.rollback?.backupDirectory
    if (!backupDirectory || !exists(backupDirectory)) throw new Error('没有可恢复的升级前数据备份')
    return restoreDataBackup({
      backupDirectory,
      configFile: this.configFile,
      dataDirectory,
      rollbackDirectory: options.rollbackDirectory,
      onRollbackCreated: options.onRollbackCreated,
      appVersion: this.appVersion,
      harnessVersion: this.harnessVersion,
      now: this.now(),
    })
  }
}

module.exports = {
  STATE_FORMAT_VERSION,
  UpgradeSafety,
  readDataDirectoryBeforeMigration,
  safeSegment,
  writeJsonAtomic,
}
