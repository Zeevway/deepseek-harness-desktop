'use strict'

const fs = require('node:fs')
const path = require('node:path')

const PROGRAM_ROLLBACK_JOURNAL_VERSION = 1
const ACTIVE_STATES = new Set([
  'prepared',
  'data-backup-ready',
  'data-restored',
  'data-unchanged',
  'helper-launched',
  'program-failed',
])
const STATES = new Set([...ACTIVE_STATES, 'program-restored', 'data-recovered'])
const TRANSITIONS = new Map([
  ['prepared', new Set(['data-backup-ready', 'data-unchanged', 'data-recovered'])],
  ['data-backup-ready', new Set(['data-restored', 'program-failed', 'data-recovered'])],
  ['data-restored', new Set(['helper-launched', 'program-failed', 'data-recovered'])],
  ['data-unchanged', new Set(['helper-launched', 'program-failed', 'data-recovered'])],
  ['helper-launched', new Set(['program-restored', 'program-failed'])],
  ['program-failed', new Set(['program-restored', 'data-recovered'])],
  ['program-restored', new Set()],
  ['data-recovered', new Set()],
])
const PATCH_FIELDS = new Set(['error', 'recoveryRollbackDirectory'])

function exists(filename) {
  try {
    fs.accessSync(filename)
    return true
  } catch {
    return false
  }
}

function samePath(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function assertGuardedLocalPath(filenameValue, field) {
  const filename = path.resolve(filenameValue)
  if (filename.startsWith('\\\\') || samePath(filename, path.parse(filename).root)) {
    throw new Error(`程序回滚日志中的 ${field} 不能是网络路径或磁盘根目录`)
  }
  const protectedRoots = [
    process.env.WINDIR,
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ].filter((value) => typeof value === 'string' && value && path.isAbsolute(value))
  if (protectedRoots.some((root) => isSameOrInside(filename, root))) {
    throw new Error(`程序回滚日志中的 ${field} 不能位于 Windows 或 Program Files 受保护目录`)
  }
  let cursor = filename
  while (!samePath(cursor, path.parse(cursor).root)) {
    if (exists(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`程序回滚日志中的 ${field} 不能经过符号链接或目录联接点`)
    }
    cursor = path.dirname(cursor)
  }
  return filename
}

function getProgramRollbackJournalPath(userDataDirectory) {
  return path.join(path.resolve(userDataDirectory), 'program-rollback-journal.json')
}

function writeDurableJson(filenameValue, document) {
  const filename = path.resolve(filenameValue)
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, filename)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}

function requireAbsolutePath(document, field) {
  if (typeof document[field] !== 'string' || !path.isAbsolute(document[field])) {
    throw new Error(`程序回滚日志中的 ${field} 路径无效`)
  }
  return assertGuardedLocalPath(document[field], field)
}

function validateLeafFile(filename, field, expectedName = '') {
  if ((expectedName && path.basename(filename) !== expectedName)
    || path.basename(filename) === '.'
    || path.basename(filename) === '..') {
    throw new Error(`程序回滚日志中的 ${field} 文件名无效`)
  }
  if (exists(filename)) {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`程序回滚日志中的 ${field} 不是普通文件`)
    }
  }
}

function validateProgramRollbackJournal(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || document.version !== PROGRAM_ROLLBACK_JOURNAL_VERSION
    || !STATES.has(document.state)
    || typeof document.dataChanged !== 'boolean'
    || typeof document.currentAppVersion !== 'string'
    || typeof document.previousAppVersion !== 'string') {
    throw new Error('程序回滚日志格式无效')
  }

  const normalized = { ...document }
  for (const field of [
    'configFile',
    'dataDirectory',
    'programRoot',
    'script',
    'installDirectory',
    'currentExecutable',
    'previousExecutable',
  ]) {
    normalized[field] = requireAbsolutePath(document, field)
  }
  if (document.dataChanged) {
    normalized.dataRollbackDirectory = requireAbsolutePath(document, 'dataRollbackDirectory')
  } else if (document.dataRollbackDirectory !== null) {
    throw new Error('未修改数据的程序回滚日志不能声明数据回滚目录')
  }
  const hasSecondaryDataDirectory = document.secondaryDataDirectory !== null
    && document.secondaryDataDirectory !== undefined
  const hasSecondaryRollbackDirectory = document.secondaryRollbackDirectory !== null
    && document.secondaryRollbackDirectory !== undefined
  if (hasSecondaryDataDirectory !== hasSecondaryRollbackDirectory || (!document.dataChanged && hasSecondaryDataDirectory)) {
    throw new Error('程序回滚日志中的第二数据目标声明无效')
  }
  if (hasSecondaryDataDirectory) {
    normalized.secondaryDataDirectory = requireAbsolutePath(document, 'secondaryDataDirectory')
    normalized.secondaryRollbackDirectory = requireAbsolutePath(document, 'secondaryRollbackDirectory')
    if (samePath(normalized.secondaryDataDirectory, normalized.dataDirectory)) {
      throw new Error('程序回滚日志中的第二数据目标不能与当前数据目录相同')
    }
  } else {
    normalized.secondaryDataDirectory = null
    normalized.secondaryRollbackDirectory = null
  }
  if (document.recoveryRollbackDirectory !== undefined) {
    normalized.recoveryRollbackDirectory = requireAbsolutePath(document, 'recoveryRollbackDirectory')
  }

  const expectedRoot = path.join(path.dirname(normalized.installDirectory), '.dsh-desktop-previous')
  const rollbackRoot = path.join(path.dirname(normalized.configFile), 'rollback-backups')
  if (!samePath(normalized.programRoot, expectedRoot)
    || !samePath(path.dirname(normalized.script), normalized.programRoot)
    || !samePath(path.dirname(normalized.currentExecutable), normalized.installDirectory)
    || !samePath(path.dirname(normalized.previousExecutable), normalized.installDirectory)
    || (normalized.dataRollbackDirectory
      && !isSameOrInside(normalized.dataRollbackDirectory, rollbackRoot))
    || (normalized.secondaryRollbackDirectory
      && !isSameOrInside(normalized.secondaryRollbackDirectory, rollbackRoot))
    || (normalized.recoveryRollbackDirectory
      && !isSameOrInside(normalized.recoveryRollbackDirectory, rollbackRoot))) {
    throw new Error('程序回滚日志中的程序或数据路径关系无效')
  }
  validateLeafFile(normalized.script, 'script', 'restore-previous-install.ps1')
  validateLeafFile(normalized.currentExecutable, 'currentExecutable')
  validateLeafFile(normalized.previousExecutable, 'previousExecutable')
  if (path.extname(normalized.currentExecutable).toLowerCase() !== '.exe'
    || path.extname(normalized.previousExecutable).toLowerCase() !== '.exe') {
    throw new Error('程序回滚日志中的可执行文件名无效')
  }
  return normalized
}

function readProgramRollbackJournal(filenameValue) {
  const filename = path.resolve(filenameValue)
  if (!exists(filename)) return null
  const source = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/u, '')
  const journal = validateProgramRollbackJournal(JSON.parse(source))
  if (!samePath(filename, getProgramRollbackJournalPath(path.dirname(journal.configFile)))) {
    throw new Error('程序回滚日志不在受保护的用户数据目录中')
  }
  return journal
}

function createProgramRollbackJournal(filenameValue, options) {
  const filename = path.resolve(filenameValue)
  const existing = readProgramRollbackJournal(filename)
  if (existing && ACTIVE_STATES.has(existing.state)) {
    throw new Error('上一次程序回滚尚未完成，请先重新打开应用完成恢复')
  }
  const now = new Date().toISOString()
  const dataChanged = options.dataChanged === true
  if (String(options.currentAppVersion || '') === String(options.previousAppVersion || '')) {
    throw new Error('相同版本的覆盖安装不能使用程序回滚；请重新运行安装包进行修复')
  }
  const journal = validateProgramRollbackJournal({
    version: PROGRAM_ROLLBACK_JOURNAL_VERSION,
    state: 'prepared',
    dataChanged,
    currentAppVersion: String(options.currentAppVersion || ''),
    previousAppVersion: String(options.previousAppVersion || ''),
    configFile: path.resolve(options.configFile),
    dataDirectory: path.resolve(options.dataDirectory),
    dataRollbackDirectory: dataChanged ? path.resolve(options.dataRollbackDirectory) : null,
    secondaryDataDirectory: options.secondaryDataDirectory
      ? path.resolve(options.secondaryDataDirectory)
      : null,
    secondaryRollbackDirectory: options.secondaryRollbackDirectory
      ? path.resolve(options.secondaryRollbackDirectory)
      : null,
    programRoot: path.resolve(options.programRoot),
    script: path.resolve(options.script),
    installDirectory: path.resolve(options.installDirectory),
    currentExecutable: path.resolve(options.currentExecutable),
    previousExecutable: path.resolve(options.previousExecutable),
    createdAt: now,
    updatedAt: now,
    error: '',
  })
  if (!samePath(filename, getProgramRollbackJournalPath(path.dirname(journal.configFile)))) {
    throw new Error('程序回滚日志必须保存在设置文件所在的用户数据目录中')
  }
  for (const [field, type] of [
    ['script', 'file'],
    ['currentExecutable', 'file'],
    ['programRoot', 'directory'],
    ['installDirectory', 'directory'],
  ]) {
    let stat
    try { stat = fs.lstatSync(journal[field]) } catch { throw new Error(`程序回滚所需的 ${field} 不存在`) }
    if ((type === 'file' && !stat.isFile()) || (type === 'directory' && !stat.isDirectory())) {
      throw new Error(`程序回滚所需的 ${field} 类型无效`)
    }
  }
  writeDurableJson(filename, journal)
  return journal
}

function markProgramRollbackState(filenameValue, state, patch = {}) {
  if (!STATES.has(state)) throw new TypeError('程序回滚状态无效')
  for (const field of Object.keys(patch)) {
    if (!PATCH_FIELDS.has(field)) throw new TypeError(`不允许修改程序回滚日志字段 ${field}`)
  }
  const filename = path.resolve(filenameValue)
  const current = readProgramRollbackJournal(filename)
  if (!current) throw new Error('程序回滚日志不存在')
  if (!TRANSITIONS.get(current.state)?.has(state)) {
    throw new Error(`不允许从 ${current.state} 跳转到 ${state}`)
  }
  if (current.state === 'prepared'
    && ((state === 'data-backup-ready' && !current.dataChanged)
      || (state === 'data-unchanged' && current.dataChanged))) {
    throw new Error('程序回滚的数据状态与日志声明不一致')
  }
  const next = validateProgramRollbackJournal({
    ...current,
    ...patch,
    version: PROGRAM_ROLLBACK_JOURNAL_VERSION,
    state,
    updatedAt: new Date().toISOString(),
  })
  writeDurableJson(filename, next)
  return next
}

function versionMismatchError(runningVersion, journal) {
  const error = new Error(`程序回滚未完成，当前版本 ${runningVersion || '未知'} 与事务版本不匹配`)
  error.code = 'PROGRAM_ROLLBACK_VERSION_MISMATCH'
  error.details = {
    runningVersion,
    currentAppVersion: journal.currentAppVersion,
    previousAppVersion: journal.previousAppVersion,
    state: journal.state,
  }
  return error
}

function recoverProgramRollback(options) {
  const journalFile = path.resolve(options.journalFile)
  let journal = readProgramRollbackJournal(journalFile)
  if (!journal) return { recovered: false, action: 'none' }
  if (options.expectedConfigFile && !samePath(journal.configFile, options.expectedConfigFile)) {
    throw new Error('程序回滚日志与当前用户数据目录不匹配')
  }
  if (['program-restored', 'data-recovered'].includes(journal.state)) {
    return { recovered: false, action: journal.state, journal }
  }

  const runningVersion = String(options.currentAppVersion || '')
  if (runningVersion === journal.previousAppVersion) {
    if (!['helper-launched', 'program-failed'].includes(journal.state)) {
      throw versionMismatchError(runningVersion, journal)
    }
    const completed = markProgramRollbackState(journalFile, 'program-restored')
    return { recovered: false, action: 'program-restored', journal: completed }
  }
  if (runningVersion !== journal.currentAppVersion) throw versionMismatchError(runningVersion, journal)

  if (journal.state === 'helper-launched') {
    journal = markProgramRollbackState(journalFile, 'program-failed', {
      error: journal.error || '程序回滚帮助进程未完成，已恢复当前版本数据',
    })
  }

  // `prepared` is written before the current-data snapshot starts. No target
  // data can be replaced until the snapshot is complete and the state moves
  // to `data-backup-ready`, so even a leftover partial directory is not a
  // restore source.
  if (journal.state === 'prepared') {
    const completed = markProgramRollbackState(journalFile, 'data-recovered')
    return { recovered: false, action: 'no-data-change', journal: completed }
  }

  if (!journal.dataChanged) {
    const completed = markProgramRollbackState(journalFile, 'data-recovered')
    return { recovered: false, action: 'no-data-change', journal: completed }
  }
  const expectedDataDirectory = requireAbsolutePath(options, 'expectedDataDirectory')
  if (!samePath(journal.dataDirectory, expectedDataDirectory)) {
    throw new Error('程序回滚的当前数据目录与可信快照不匹配')
  }
  if (journal.secondaryDataDirectory) {
    const expectedSecondaryDataDirectory = requireAbsolutePath(options, 'expectedSecondaryDataDirectory')
    if (!samePath(journal.secondaryDataDirectory, expectedSecondaryDataDirectory)) {
      throw new Error('程序回滚的原数据目标与升级前快照不匹配')
    }
  }
  if (!exists(journal.dataRollbackDirectory)) {
    throw new Error('程序回滚失败，且找不到用于恢复当前版本的数据备份')
  }
  if (journal.secondaryRollbackDirectory
    && journal.state !== 'data-backup-ready'
    && !exists(journal.secondaryRollbackDirectory)) {
    throw new Error('程序回滚失败，且找不到用于恢复原数据目标的备份')
  }
  if (typeof options.restoreDataBackup !== 'function') throw new TypeError('缺少数据恢复实现')

  const recoveryRollbackDirectory = requireAbsolutePath(options, 'recoveryRollbackDirectory')
  const rollbackRoot = path.join(path.dirname(journal.configFile), 'rollback-backups')
  if (!isSameOrInside(recoveryRollbackDirectory, rollbackRoot)) {
    throw new Error('程序回滚恢复备份目录不在受保护的用户数据目录中')
  }
  if (journal.secondaryRollbackDirectory && exists(journal.secondaryRollbackDirectory)) {
    const secondaryRecoveryDirectory = `${recoveryRollbackDirectory}-Secondary-Target`
    if (!isSameOrInside(secondaryRecoveryDirectory, rollbackRoot)) {
      throw new Error('第二数据目标恢复备份目录不在受保护的用户数据目录中')
    }
    options.restoreDataBackup({
      backupDirectory: journal.secondaryRollbackDirectory,
      configFile: journal.configFile,
      dataDirectory: journal.secondaryDataDirectory,
      rollbackDirectory: secondaryRecoveryDirectory,
      appVersion: runningVersion,
      harnessVersion: String(options.harnessVersion || ''),
    })
  }
  options.restoreDataBackup({
    backupDirectory: journal.dataRollbackDirectory,
    configFile: journal.configFile,
    dataDirectory: journal.dataDirectory,
    rollbackDirectory: recoveryRollbackDirectory,
    appVersion: runningVersion,
    harnessVersion: String(options.harnessVersion || ''),
  })
  const completed = markProgramRollbackState(journalFile, 'data-recovered', {
    recoveryRollbackDirectory,
    error: journal.error || '',
  })
  return { recovered: true, action: 'data-recovered', journal: completed }
}

module.exports = {
  ACTIVE_STATES,
  PROGRAM_ROLLBACK_JOURNAL_VERSION,
  STATES,
  createProgramRollbackJournal,
  getProgramRollbackJournalPath,
  markProgramRollbackState,
  readProgramRollbackJournal,
  recoverProgramRollback,
  samePath,
  validateProgramRollbackJournal,
  writeDurableJson,
}
