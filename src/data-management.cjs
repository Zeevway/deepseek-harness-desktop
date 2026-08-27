'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { DesktopError, ERROR_CODES } = require('./error-classifier.cjs')
const { CONFIG_VERSION } = require('./config-store.cjs')
const { isSameOrInside } = require('./workspace-selection.cjs')

const BACKUP_FORMAT_VERSION = 1
const RESTORE_JOURNAL_VERSION = 2
const RESTORE_ENTRY_KINDS = new Set(['config', 'data'])

function exists(value) {
  try {
    fs.accessSync(value)
    return true
  } catch {
    return false
  }
}

function realpath(value) {
  try {
    return fs.realpathSync.native(value)
  } catch {
    return fs.realpathSync(value)
  }
}

function canonicalizePotentialPath(value) {
  let current = path.resolve(value)
  const missingSegments = []
  while (!exists(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    missingSegments.unshift(path.basename(current))
    current = parent
  }
  const canonicalAncestor = exists(current) ? realpath(current) : current
  return path.resolve(canonicalAncestor, ...missingSegments)
}

function samePath(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isNetworkPath(value) {
  const candidate = String(value || '')
  return candidate.startsWith('\\\\') || candidate.startsWith('//')
}

function lstatIfPresent(filename) {
  try {
    return fs.lstatSync(filename)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function protectedRestoreRoots() {
  return [
    process.env.WINDIR,
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ]
    .filter((value) => typeof value === 'string' && value.trim() !== '' && path.isAbsolute(value))
    .map((value) => path.resolve(value))
}

function assertNoExistingReparsePoint(filename, label) {
  const root = path.parse(filename).root
  let cursor = filename
  while (!samePath(cursor, root)) {
    const stat = lstatIfPresent(cursor)
    if (stat?.isSymbolicLink()) {
      throw new Error(`${label} 不能经过符号链接或目录联接点`)
    }
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) break
    cursor = parent
  }
}

function assertGuardedRestorePath(value, label, kind = 'path') {
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
    throw new Error(`${label} 必须是绝对路径`)
  }
  if (isNetworkPath(value)) throw new Error(`${label} 不能是网络路径`)

  const filename = path.resolve(value)
  const root = path.parse(filename).root
  if (samePath(filename, root)) throw new Error(`${label} 不能是磁盘根目录`)
  if (protectedRestoreRoots().some((protectedRoot) => isSameOrInside(filename, protectedRoot))) {
    throw new Error(`${label} 不能位于 Windows 或 Program Files 受保护目录`)
  }
  assertNoExistingReparsePoint(filename, label)

  const stat = lstatIfPresent(filename)
  if (stat && kind === 'file' && !stat.isFile()) throw new Error(`${label} 必须是普通文件`)
  if (stat && kind === 'directory' && !stat.isDirectory()) throw new Error(`${label} 必须是普通目录`)
  return filename
}

function pathsOverlap(left, right) {
  const canonicalLeft = canonicalizePotentialPath(left)
  const canonicalRight = canonicalizePotentialPath(right)
  return isSameOrInside(canonicalLeft, canonicalRight)
    || isSameOrInside(canonicalRight, canonicalLeft)
}

function isPathInside(candidate, parent) {
  return isSameOrInside(canonicalizePotentialPath(candidate), canonicalizePotentialPath(parent))
}

function assertRegularTree(source) {
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(`备份不接受文件链接：${source}`)
  if (stat.isFile()) return
  if (!stat.isDirectory()) throw new Error(`备份不接受特殊文件：${source}`)
  for (const entry of fs.readdirSync(source)) assertRegularTree(path.join(source, entry))
}

function copyRegularTree(source, destination) {
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(`不允许复制文件链接：${source}`)
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
    return
  }
  if (!stat.isDirectory()) throw new Error(`不允许复制特殊文件：${source}`)
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const entry of fs.readdirSync(source)) {
    copyRegularTree(path.join(source, entry), path.join(destination, entry))
  }
}

function hashFile(filename) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(filename, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    let bytesRead
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function inventory(directory) {
  if (!exists(directory)) return []
  const files = []
  function visit(current, relative) {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`备份包含文件链接：${relative}`)
    if (stat.isFile()) {
      files.push({
        path: relative.split(path.sep).join('/'),
        bytes: stat.size,
        sha256: hashFile(current),
      })
      return
    }
    if (!stat.isDirectory()) throw new Error(`备份包含特殊文件：${relative}`)
    for (const entry of fs.readdirSync(current).sort()) {
      visit(path.join(current, entry), relative ? path.join(relative, entry) : entry)
    }
  }
  visit(directory, '')
  return files
}

function scanRegularTree(directory) {
  assertRegularTree(directory)
  const directories = ['']
  const files = []
  function visit(current, relative) {
    for (const entry of fs.readdirSync(current).sort()) {
      const absolute = path.join(current, entry)
      const childRelative = relative ? path.join(relative, entry) : entry
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error(`数据目录包含文件链接：${childRelative}`)
      if (stat.isDirectory()) {
        directories.push(childRelative)
        visit(absolute, childRelative)
      } else if (stat.isFile()) {
        files.push({
          relative: childRelative,
          bytes: stat.size,
          sha256: hashFile(absolute),
        })
      } else {
        throw new Error(`数据目录包含特殊文件：${childRelative}`)
      }
    }
  }
  visit(directory, '')
  return { directories, files }
}

function assertMigrationIntegrity(sourceInventory, destination) {
  for (const sourceFile of sourceInventory.files) {
    const target = path.join(destination, sourceFile.relative)
    if (!exists(target)) throw new Error(`目标缺少文件：${sourceFile.relative}`)
    const stat = fs.lstatSync(target)
    if (!stat.isFile() || stat.isSymbolicLink()
      || stat.size !== sourceFile.bytes
      || hashFile(target) !== sourceFile.sha256) {
      throw new Error(`目标文件校验失败：${sourceFile.relative}`)
    }
  }
}

function migrateDataDirectory(sourceValue, destinationValue, options = {}) {
  if (typeof sourceValue !== 'string' || sourceValue.trim() === ''
    || typeof destinationValue !== 'string' || destinationValue.trim() === '') {
    throw new TypeError('数据目录迁移需要有效的源目录和目标目录')
  }
  const source = path.resolve(sourceValue)
  const destination = path.resolve(destinationValue)
  const strategy = options.strategy ?? 'reject'
  if (!['reject', 'merge'].includes(strategy)) {
    throw new TypeError('数据目录迁移策略仅支持 reject 或 merge')
  }

  try {
    if (!exists(source) || !fs.statSync(source).isDirectory()) throw new Error('源数据目录不存在')
    if (pathsOverlap(destination, source)) {
      throw new Error('源数据目录与目标目录不能互相包含')
    }
    const sourceInventory = scanRegularTree(source)

    if (strategy === 'reject') {
      if (exists(destination)) throw new Error('目标数据目录已存在；默认策略不会覆盖或合并')
      const staged = `${destination}.migration-stage-${process.pid}-${Date.now()}`
      try {
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
        if (pathsOverlap(staged, source)) throw new Error('迁移暂存目录实际指向源数据目录')
        copyRegularTree(source, staged)
        assertMigrationIntegrity(sourceInventory, staged)
        const sourceAfterCopy = scanRegularTree(source)
        if (JSON.stringify(sourceAfterCopy.files) !== JSON.stringify(sourceInventory.files)) {
          throw new Error('复制期间源数据发生变化，请停止 Harness 后重试')
        }
        fs.renameSync(staged, destination)
      } catch (error) {
        if (exists(staged)) safeRemoveTemporary(staged, '.migration-stage-')
        throw error
      }
      return {
        source,
        destination,
        strategy,
        filesCopied: sourceInventory.files.length,
        sourceRetained: true,
        requiresConfigUpdate: true,
      }
    }

    const destinationCreated = !exists(destination)
    if (destinationCreated) fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
    if (pathsOverlap(destination, source)) throw new Error('目标目录实际指向源数据目录')
    if (!fs.statSync(destination).isDirectory()) throw new Error('目标数据路径不是文件夹')
    const destinationInventory = scanRegularTree(destination)
    const destinationFiles = new Map(destinationInventory.files.map((entry) => [entry.relative, entry]))
    for (const sourceFile of sourceInventory.files) {
      const current = destinationFiles.get(sourceFile.relative)
      if (current && (current.bytes !== sourceFile.bytes || current.sha256 !== sourceFile.sha256)) {
        throw new Error(`合并被拒绝，目标存在内容不同的文件：${sourceFile.relative}`)
      }
    }

    const createdFiles = []
    const createdDirectories = []
    try {
      for (const relative of sourceInventory.directories) {
        if (!relative) continue
        const targetDirectory = path.join(destination, relative)
        if (!exists(targetDirectory)) {
          fs.mkdirSync(targetDirectory, { mode: 0o700 })
          createdDirectories.push(targetDirectory)
        } else if (!fs.statSync(targetDirectory).isDirectory()) {
          throw new Error(`合并被拒绝，目标路径不是文件夹：${relative}`)
        }
      }
      for (const sourceFile of sourceInventory.files) {
        if (destinationFiles.has(sourceFile.relative)) continue
        const target = path.join(destination, sourceFile.relative)
        fs.copyFileSync(path.join(source, sourceFile.relative), target, fs.constants.COPYFILE_EXCL)
        createdFiles.push(target)
      }
      assertMigrationIntegrity(sourceInventory, destination)
      const sourceAfterCopy = scanRegularTree(source)
      if (JSON.stringify(sourceAfterCopy.files) !== JSON.stringify(sourceInventory.files)) {
        throw new Error('复制期间源数据发生变化，请停止 Harness 后重试')
      }
    } catch (error) {
      for (const filename of createdFiles.reverse()) {
        try { fs.unlinkSync(filename) } catch {}
      }
      for (const directory of createdDirectories.reverse()) {
        try { fs.rmdirSync(directory) } catch {}
      }
      if (destinationCreated) {
        try { fs.rmdirSync(destination) } catch {}
      }
      throw error
    }
    return {
      source,
      destination,
      strategy,
      filesCopied: createdFiles.length,
      sourceRetained: true,
      requiresConfigUpdate: true,
    }
  } catch (cause) {
    throw new DesktopError(
      ERROR_CODES.DATA_MIGRATION_FAILED,
      `无法迁移 Harness 数据目录：${cause.message}`,
      { source, destination, strategy },
      cause,
    )
  }
}

function safeRemoveTemporary(target, expectedFragment) {
  if (!target.includes(expectedFragment)) return
  fs.rmSync(target, { recursive: true, force: true })
}

function createDataBackup(options) {
  const destination = path.resolve(String(options?.destination || ''))
  const configFile = options?.configFile ? path.resolve(options.configFile) : ''
  const dataDirectory = options?.dataDirectory ? path.resolve(options.dataDirectory) : ''
  if (!options?.destination) throw new TypeError('必须指定备份目标目录')
  const temporary = `${destination}.partial-${process.pid}-${Date.now()}`
  try {
    if (exists(destination)) throw new Error('备份目标已存在，请选择新的目录')
    for (const source of [configFile, dataDirectory].filter(Boolean)) {
      if (exists(source) && isPathInside(destination, source)) {
        throw new Error('备份目标不能位于被备份的数据目录内')
      }
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    fs.mkdirSync(temporary, { recursive: false, mode: 0o700 })
    for (const source of [configFile, dataDirectory].filter((entry) => entry && exists(entry))) {
      if (isPathInside(temporary, source)) throw new Error('备份暂存目录实际位于源数据目录内')
    }
    const hasConfig = Boolean(configFile && exists(configFile))
    const hasData = Boolean(dataDirectory && exists(dataDirectory))
    if (hasConfig) {
      assertRegularTree(configFile)
      copyRegularTree(configFile, path.join(temporary, 'desktop-config.json'))
    }
    if (hasData) {
      assertRegularTree(dataDirectory)
      copyRegularTree(dataDirectory, path.join(temporary, 'harness-data'))
    }

    const manifest = {
      format: 'deepseek-harness-desktop-backup',
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: (options.now || new Date()).toISOString(),
      appVersion: String(options.appVersion || ''),
      harnessVersion: String(options.harnessVersion || ''),
      hasConfig,
      hasData,
      files: inventory(temporary),
    }
    fs.writeFileSync(
      path.join(temporary, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    fs.renameSync(temporary, destination)
    return { destination, manifest }
  } catch (cause) {
    safeRemoveTemporary(temporary, '.partial-')
    throw new DesktopError(
      ERROR_CODES.DATA_BACKUP_FAILED,
      `无法创建数据备份：${cause.message}`,
      { destination },
      cause,
    )
  }
}

function readBackupManifest(backupDirectory) {
  const root = path.resolve(backupDirectory)
  assertRegularTree(root)
  const filename = path.join(root, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (manifest?.format !== 'deepseek-harness-desktop-backup'
    || manifest.formatVersion !== BACKUP_FORMAT_VERSION
    || !Array.isArray(manifest.files)) {
    throw new Error('无法识别该备份格式')
  }

  const expected = JSON.stringify([...manifest.files].sort((a, b) => a.path.localeCompare(b.path)))
  const actual = JSON.stringify(inventory(root)
    .filter((entry) => entry.path !== 'manifest.json')
    .sort((a, b) => a.path.localeCompare(b.path)))
  if (actual !== expected) throw new Error('备份完整性校验失败，文件可能已损坏或被修改')
  if (manifest.hasConfig !== exists(path.join(root, 'desktop-config.json'))) {
    throw new Error('备份中的设置文件与清单不一致')
  }
  if (manifest.hasData !== exists(path.join(root, 'harness-data'))) {
    throw new Error('备份中的 Harness 数据与清单不一致')
  }
  if (manifest.hasConfig) {
    const stat = fs.lstatSync(path.join(root, 'desktop-config.json'))
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('备份中的设置内容不是普通文件')
  }
  if (manifest.hasData) {
    const stat = fs.lstatSync(path.join(root, 'harness-data'))
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('备份中的 Harness 数据不是文件夹')
  }
  if (manifest.hasConfig) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'desktop-config.json'), 'utf8'))
    if (!Number.isInteger(config?.version) || config.version < 1 || config.version > CONFIG_VERSION) {
      throw new Error('备份中的设置文件版本不受支持')
    }
    if (config.encryptedApiKey !== undefined && typeof config.encryptedApiKey !== 'string') {
      throw new Error('备份中的加密 API Key 格式无效')
    }
    if (typeof config.workspace !== 'string') throw new Error('备份中的工作区设置无效')
    for (const key of Object.keys(config)) {
      if (key !== 'encryptedApiKey'
        && /(?:api.?key|token|password|secret|credential|authorization|cookie)/iu.test(key)) {
        throw new Error('备份设置包含不允许的明文敏感字段')
      }
    }
  }
  return { root, manifest }
}

function readBackupDataSettings(backupDirectory, defaultDataDirectoryValue) {
  const validated = readBackupManifest(backupDirectory)
  const defaultDataDirectory = path.resolve(defaultDataDirectoryValue)
  if (!validated.manifest.hasConfig) {
    return {
      dataDirectory: defaultDataDirectory,
      workspace: '',
      configVersion: null,
      backup: validated,
    }
  }
  const document = JSON.parse(fs.readFileSync(path.join(validated.root, 'desktop-config.json'), 'utf8'))
  let configuredDataDirectory = ''
  if (document.version >= 2 && document.dataDirectory !== undefined) {
    if (typeof document.dataDirectory !== 'string'
      || (document.dataDirectory !== '' && !path.isAbsolute(document.dataDirectory))) {
      throw new Error('备份中的 Harness 数据目录设置无效')
    }
    configuredDataDirectory = document.dataDirectory
  }
  return {
    dataDirectory: configuredDataDirectory ? path.resolve(configuredDataDirectory) : defaultDataDirectory,
    workspace: document.workspace,
    configVersion: document.version,
    backup: validated,
  }
}

function stageRestore(source, target, token) {
  const staged = `${target}.restore-stage-${token}`
  if (exists(staged)) throw new Error(`恢复暂存路径已存在：${staged}`)
  if (source) copyRegularTree(source, staged)
  return source ? staged : null
}

function getRestoreJournalPath(configFile) {
  return path.join(path.dirname(path.resolve(configFile)), '.dsh-desktop-restore-journal.json')
}

function writeDurableJson(filename, document) {
  const directory = path.dirname(filename)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    assertGuardedRestorePath(filename, '恢复日志', 'file')
    assertGuardedRestorePath(temporary, '恢复日志临时文件', 'file')
    fs.renameSync(temporary, filename)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (exists(temporary)) fs.unlinkSync(temporary)
  }
}

function normalizeExpectedRestoreTargets(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('恢复中断事务需要预期的设置文件和 Harness 数据目录')
  }
  const configFile = assertGuardedRestorePath(options.configFile, '预期设置文件', 'file')
  const dataDirectory = assertGuardedRestorePath(options.dataDirectory, '预期 Harness 数据目录', 'directory')
  if (pathsOverlap(configFile, dataDirectory)) {
    throw new Error('预期设置文件和 Harness 数据目录不能互相包含')
  }
  return { configFile, dataDirectory }
}

function validateRestoreEntryPaths(entry, journal, expectedTargets) {
  if (typeof entry?.kind !== 'string'
    || !RESTORE_ENTRY_KINDS.has(entry.kind)
    || typeof entry.target !== 'string'
    || typeof entry.previous !== 'string'
    || typeof entry.staged !== 'string'
    || typeof entry.hadPrevious !== 'boolean'
    || typeof entry.hasReplacement !== 'boolean'
    || !['pending', 'previous-moved', 'target-installed', 'rollback-started', 'rolled-back', 'cleaned'].includes(entry.state)) {
    throw new Error('恢复日志条目无效')
  }

  const expectedTarget = entry.kind === 'config'
    ? expectedTargets.configFile
    : expectedTargets.dataDirectory
  const targetKind = entry.kind === 'config' ? 'file' : 'directory'
  const target = assertGuardedRestorePath(entry.target, `恢复日志 ${entry.kind} 目标`, targetKind)
  const expectedPrevious = `${expectedTarget}.restore-previous-${journal.token}`
  const expectedStaged = `${expectedTarget}.restore-stage-${journal.token}`
  if (!samePath(target, expectedTarget)
    || !samePath(entry.previous, expectedPrevious)
    || !samePath(entry.staged, expectedStaged)) {
    throw new Error('恢复日志路径与调用方预期目标不一致')
  }

  const previous = assertGuardedRestorePath(entry.previous, `恢复日志 ${entry.kind} 原目标`, targetKind)
  const staged = assertGuardedRestorePath(entry.staged, `恢复日志 ${entry.kind} 暂存目标`, targetKind)
  return { ...entry, target, previous, staged }
}

function readRestoreJournal(journalFile, expectedTargets) {
  const expectedJournalFile = getRestoreJournalPath(expectedTargets.configFile)
  const guardedJournalFile = assertGuardedRestorePath(journalFile, '恢复日志', 'file')
  if (!samePath(guardedJournalFile, expectedJournalFile)) {
    throw new Error('恢复日志不在预期设置目录中')
  }
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
  if (journal?.version !== RESTORE_JOURNAL_VERSION
    || !/^\d+-\d+$/u.test(journal.token)
    || !['prepared', 'swapping', 'committed'].includes(journal.phase)
    || typeof journal.configFile !== 'string'
    || typeof journal.dataDirectory !== 'string'
    || !Array.isArray(journal.entries)
    || journal.entries.length !== 2) {
    throw new Error('恢复日志格式无效')
  }

  const boundConfigFile = assertGuardedRestorePath(journal.configFile, '恢复日志设置文件', 'file')
  const boundDataDirectory = assertGuardedRestorePath(journal.dataDirectory, '恢复日志 Harness 数据目录', 'directory')
  if (!samePath(boundConfigFile, expectedTargets.configFile)
    || !samePath(boundDataDirectory, expectedTargets.dataDirectory)) {
    throw new Error('恢复日志绑定与调用方预期目标不一致')
  }
  journal.configFile = boundConfigFile
  journal.dataDirectory = boundDataDirectory

  const seenKinds = new Set()
  journal.entries = journal.entries.map((entry) => {
    const validated = validateRestoreEntryPaths(entry, journal, expectedTargets)
    if (seenKinds.has(validated.kind)) throw new Error('恢复日志包含重复目标')
    seenKinds.add(validated.kind)
    return validated
  })
  if (seenKinds.size !== RESTORE_ENTRY_KINDS.size) throw new Error('恢复日志缺少必要目标')
  return journal
}

function recoverInterruptedRestore(journalFileValue, options) {
  const journalFile = path.resolve(journalFileValue)
  if (!exists(journalFile)) return { recovered: false, action: 'none' }
  let journal
  let expectedTargets
  try {
    expectedTargets = normalizeExpectedRestoreTargets(options)
    journal = readRestoreJournal(journalFile, expectedTargets)
  } catch (cause) {
    throw new DesktopError(
      ERROR_CODES.DATA_RESTORE_FAILED,
      `无法读取中断恢复日志：${cause.message}`,
      { journalFile },
      cause,
    )
  }

  const errors = []
  const committed = journal.phase === 'committed'
  let deferredConfigPrevious = null
  for (const entry of [...journal.entries].reverse()) {
    if (committed) {
      if (entry.state === 'cleaned') continue
      const errorCount = errors.length
      for (const key of ['previous', 'staged']) {
        try {
          const validated = validateRestoreEntryPaths(entry, journal, expectedTargets)
          const temporary = validated[key]
          if (entry.kind === 'config' && key === 'previous') {
            if (exists(temporary)) deferredConfigPrevious = temporary
            continue
          }
          if (exists(temporary)) fs.rmSync(temporary, { recursive: true, force: true })
        } catch (error) { errors.push(error) }
      }
      if (errors.length === errorCount) {
        entry.state = 'cleaned'
        try { writeDurableJson(journalFile, journal) } catch (error) { errors.push(error) }
      }
      continue
    }

    if (entry.state === 'rolled-back') continue

    const errorCount = errors.length
    if (entry.state !== 'rollback-started') {
      entry.state = 'rollback-started'
      try { writeDurableJson(journalFile, journal) } catch (error) { errors.push(error) }
    }
    if (errors.length !== errorCount) continue
    try {
      let validated = validateRestoreEntryPaths(entry, journal, expectedTargets)
      if (entry.hadPrevious && exists(validated.previous)) {
        if (exists(validated.target)) {
          validated = validateRestoreEntryPaths(entry, journal, expectedTargets)
          fs.rmSync(validated.target, { recursive: true, force: true })
        }
        validated = validateRestoreEntryPaths(entry, journal, expectedTargets)
        fs.renameSync(validated.previous, validated.target)
      } else if (entry.hadPrevious && !exists(validated.previous) && !exists(validated.target)) {
        throw new Error(`无法找到原数据：${validated.target}`)
      } else if (!entry.hadPrevious && exists(validated.target)) {
        validated = validateRestoreEntryPaths(entry, journal, expectedTargets)
        fs.rmSync(validated.target, { recursive: true, force: true })
      }
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === errorCount && exists(entry.staged)) {
      try {
        const validated = validateRestoreEntryPaths(entry, journal, expectedTargets)
        fs.rmSync(validated.staged, { recursive: true, force: true })
      } catch (error) { errors.push(error) }
    }
    if (errors.length === errorCount) {
      entry.state = 'rolled-back'
      try { writeDurableJson(journalFile, journal) } catch (error) { errors.push(error) }
    }
  }

  if (errors.length > 0) {
    throw new DesktopError(
      ERROR_CODES.DATA_RESTORE_FAILED,
      '中断的数据恢复未能完全处理；恢复日志和临时数据已保留',
      { journalFile, errorCount: errors.length },
      errors[0],
    )
  }
  let guardedJournalFile
  try {
    guardedJournalFile = assertGuardedRestorePath(journalFile, '恢复日志', 'file')
  } catch (cause) {
    throw new DesktopError(
      ERROR_CODES.DATA_RESTORE_FAILED,
      `恢复日志位置在清理前失去安全边界：${cause.message}`,
      { journalFile },
      cause,
    )
  }
  if (!samePath(guardedJournalFile, getRestoreJournalPath(expectedTargets.configFile))) {
    throw new DesktopError(
      ERROR_CODES.DATA_RESTORE_FAILED,
      '恢复日志位置在清理前发生变化，已停止删除',
      { journalFile },
    )
  }
  fs.unlinkSync(journalFile)
  if (deferredConfigPrevious) {
    try {
      const configEntry = journal.entries.find((entry) => entry.kind === 'config')
      const validated = validateRestoreEntryPaths(configEntry, journal, expectedTargets)
      if (samePath(validated.previous, deferredConfigPrevious) && exists(validated.previous)) {
        fs.rmSync(validated.previous, { recursive: true, force: true })
      }
    } catch {
      // The committed restore is authoritative after journal removal. A stale
      // guarded previous file is harmless and safer than deleting on doubt.
    }
  }
  return { recovered: true, action: committed ? 'commit-cleanup' : 'rollback' }
}

function restoreDataBackup(options) {
  if (!options?.backupDirectory || !options?.configFile || !options?.dataDirectory) {
    throw new TypeError('恢复备份需要备份目录、设置文件和 Harness 数据目录')
  }
  const expectedTargets = normalizeExpectedRestoreTargets({
    configFile: options.configFile,
    dataDirectory: options.dataDirectory,
  })
  const { configFile, dataDirectory } = expectedTargets
  const journalFile = path.resolve(options.journalFile || getRestoreJournalPath(configFile))
  recoverInterruptedRestore(journalFile, expectedTargets)

  let validated
  try {
    validated = readBackupManifest(options.backupDirectory)
  } catch (cause) {
    throw new DesktopError(
      ERROR_CODES.DATA_RESTORE_FAILED,
      `无法读取数据备份：${cause.message}`,
      { backupDirectory: options.backupDirectory },
      cause,
    )
  }
  if (pathsOverlap(configFile, dataDirectory)
    || pathsOverlap(configFile, validated.root)
    || pathsOverlap(dataDirectory, validated.root)) {
    throw new DesktopError(
      ERROR_CODES.DATA_RESTORE_FAILED,
      '备份目录、设置文件和 Harness 数据目录不能互相包含',
      { backupDirectory: validated.root, configFile, dataDirectory },
    )
  }

  const rollbackDirectory = path.resolve(options.rollbackDirectory || path.join(
    path.dirname(validated.root),
    `DeepSeek-Harness-Pre-Restore-${Date.now()}`,
  ))
  if (pathsOverlap(rollbackDirectory, validated.root)
    || pathsOverlap(rollbackDirectory, dataDirectory)) {
    throw new DesktopError(
      ERROR_CODES.DATA_RESTORE_FAILED,
      '回滚备份目录不能与源备份或 Harness 数据目录互相包含',
      { backupDirectory: validated.root, rollbackDirectory },
    )
  }
  try {
    const rollbackBackup = createDataBackup({
      destination: rollbackDirectory,
      configFile,
      dataDirectory,
      appVersion: options.appVersion,
      harnessVersion: options.harnessVersion,
      now: options.now,
    })
    if (options.onRollbackCreated !== undefined) {
      if (typeof options.onRollbackCreated !== 'function') {
        throw new TypeError('数据恢复回滚回调无效')
      }
      options.onRollbackCreated({
        backupDirectory: rollbackBackup.destination,
        manifest: rollbackBackup.manifest,
      })
    }
  } catch (cause) {
    throw new DesktopError(
      ERROR_CODES.DATA_RESTORE_FAILED,
      `恢复前无法创建回滚备份：${cause.message}`,
      { backupDirectory: validated.root, rollbackDirectory },
      cause,
    )
  }

  const token = `${process.pid}-${Date.now()}`
  const sources = [
    {
      kind: 'config',
      target: configFile,
      source: validated.manifest.hasConfig ? path.join(validated.root, 'desktop-config.json') : null,
    },
    {
      kind: 'data',
      target: dataDirectory,
      source: validated.manifest.hasData ? path.join(validated.root, 'harness-data') : null,
    },
  ]
  const journal = {
    version: RESTORE_JOURNAL_VERSION,
    token,
    phase: 'prepared',
    createdAt: new Date().toISOString(),
    configFile,
    dataDirectory,
    entries: [],
  }
  let journalWritten = false
  try {
    for (const entry of sources) {
      fs.mkdirSync(path.dirname(entry.target), { recursive: true, mode: 0o700 })
      const previous = `${entry.target}.restore-previous-${token}`
      if (exists(previous)) throw new Error(`恢复回滚路径已存在：${previous}`)
      const staged = stageRestore(entry.source, entry.target, token)
      journal.entries.push({
        kind: entry.kind,
        target: entry.target,
        previous,
        staged: `${entry.target}.restore-stage-${token}`,
        hadPrevious: exists(entry.target),
        hasReplacement: Boolean(staged),
        state: 'pending',
      })
    }
    writeDurableJson(journalFile, journal)
    journalWritten = true
    journal.phase = 'swapping'
    writeDurableJson(journalFile, journal)

    for (const entry of journal.entries) {
      let guarded = validateRestoreEntryPaths(entry, journal, expectedTargets)
      if (entry.hadPrevious) {
        guarded = validateRestoreEntryPaths(entry, journal, expectedTargets)
        fs.renameSync(guarded.target, guarded.previous)
      }
      entry.state = entry.hadPrevious ? 'previous-moved' : 'pending'
      writeDurableJson(journalFile, journal)
      if (entry.hasReplacement) {
        guarded = validateRestoreEntryPaths(entry, journal, expectedTargets)
        fs.renameSync(guarded.staged, guarded.target)
      }
      entry.state = 'target-installed'
      writeDurableJson(journalFile, journal)
    }
    journal.phase = 'committed'
    writeDurableJson(journalFile, journal)
  } catch (cause) {
    let recoveryError
    if (journalWritten) {
      try { recoverInterruptedRestore(journalFile, expectedTargets) } catch (error) { recoveryError = error }
    } else {
      for (const entry of journal.entries) {
        if (exists(entry.staged)) {
          try {
            const guarded = validateRestoreEntryPaths(entry, journal, expectedTargets)
            fs.rmSync(guarded.staged, { recursive: true, force: true })
          } catch {}
        }
      }
    }
    throw new DesktopError(
      ERROR_CODES.DATA_RESTORE_FAILED,
      recoveryError
        ? `无法恢复数据备份，自动回滚也未完全完成：${cause.message}`
        : `无法恢复数据备份，原数据已还原：${cause.message}`,
      { backupDirectory: validated.root, rollbackDirectory, journalFile },
      recoveryError || cause,
    )
  }

  const cleanupWarnings = []
  try { recoverInterruptedRestore(journalFile, expectedTargets) }
  catch (error) { cleanupWarnings.push(error.message) }
  return {
    restored: true,
    backupDirectory: validated.root,
    rollbackDirectory,
    requiresRestart: true,
    cleanupWarnings,
    journalFile: cleanupWarnings.length > 0 ? journalFile : null,
  }
}

module.exports = {
  BACKUP_FORMAT_VERSION,
  RESTORE_JOURNAL_VERSION,
  canonicalizePotentialPath,
  createDataBackup,
  inventory,
  getRestoreJournalPath,
  migrateDataDirectory,
  readBackupDataSettings,
  readBackupManifest,
  recoverInterruptedRestore,
  restoreDataBackup,
}
