'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { DesktopError, ERROR_CODES } = require('./error-classifier.cjs')
const { redactSensitiveText } = require('./log-redaction.cjs')

const DIAGNOSTIC_FORMAT_VERSION = 1
const SENSITIVE_FIELD_PATTERN = /(?:encrypted.?api.?key|api.?key|token|password|secret|credential|authorization|cookie)/iu

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function redactPrivatePath(text, privateRoot) {
  if (typeof privateRoot !== 'string' || privateRoot.length <= 3) return text
  const segments = privateRoot.split(/[\\/]+/u).filter(Boolean).map(escapeRegExp)
  if (segments.length === 0) return text
  const prefix = /^[\\/]/u.test(privateRoot) ? '[\\\\/]+' : ''
  const pattern = new RegExp(`${prefix}${segments.join('[\\\\/]+')}`, process.platform === 'win32' ? 'giu' : 'gu')
  return text.replace(pattern, '[USER_HOME]')
}

function sanitizeDiagnosticValue(value, options = {}, key = '') {
  if (SENSITIVE_FIELD_PATTERN.test(key)) return '[OMITTED]'
  if (Array.isArray(value)) return value.map((entry) => sanitizeDiagnosticValue(entry, options))
  if (value && typeof value === 'object') {
    const output = {}
    for (const [field, entry] of Object.entries(value)) {
      output[field] = sanitizeDiagnosticValue(entry, options, field)
    }
    return output
  }
  if (typeof value !== 'string') return value
  let text = redactSensitiveText(value, { secrets: options.secrets })
  for (const privateRoot of options.privateRoots || [os.homedir()]) {
    text = redactPrivatePath(text, privateRoot)
  }
  return text
}

function readLogForDiagnostics(filename, options = {}) {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`日志不是普通文件：${filename}`)
  const maximumBytes = options.maximumLogBytes ?? 2 * 1024 * 1024
  const descriptor = fs.openSync(filename, 'r')
  const bytes = Math.min(stat.size, maximumBytes)
  const buffer = Buffer.alloc(bytes)
  try {
    fs.readSync(descriptor, buffer, 0, bytes, Math.max(0, stat.size - bytes))
  } finally {
    fs.closeSync(descriptor)
  }
  return sanitizeDiagnosticValue(buffer.toString('utf8'), options)
}

function exportDiagnosticBundle(options) {
  if (!options?.destination) throw new TypeError('必须指定诊断包导出目录')
  const destination = path.resolve(options.destination)
  if (fs.existsSync(destination)) throw new Error('诊断包目标已存在，请选择新的目录')
  const temporary = `${destination}.partial-${process.pid}-${Date.now()}`
  try {
    fs.mkdirSync(temporary, { recursive: false, mode: 0o700 })
    let config = null
    if (options.configFile && fs.existsSync(options.configFile)) {
      const stat = fs.lstatSync(options.configFile)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('设置文件不是普通文件')
      config = sanitizeDiagnosticValue(
        JSON.parse(fs.readFileSync(options.configFile, 'utf8')),
        options,
      )
    }

    const report = {
      format: 'deepseek-harness-desktop-diagnostics',
      formatVersion: DIAGNOSTIC_FORMAT_VERSION,
      createdAt: (options.now || new Date()).toISOString(),
      system: {
        platform: process.platform,
        architecture: process.arch,
        release: os.release(),
        node: process.versions.node,
      },
      application: sanitizeDiagnosticValue(options.metadata || {}, options),
      config,
    }
    fs.writeFileSync(
      path.join(temporary, 'diagnostic-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )

    const logsDirectory = path.join(temporary, 'logs')
    const logs = Array.isArray(options.logFiles) ? options.logFiles : []
    if (logs.length > 0) fs.mkdirSync(logsDirectory, { mode: 0o700 })
    logs.forEach((filename, index) => {
      if (!fs.existsSync(filename)) return
      const safeName = `${String(index + 1).padStart(2, '0')}-${path.basename(filename).replace(/[^A-Za-z0-9._-]/gu, '_')}`
      fs.writeFileSync(
        path.join(logsDirectory, safeName),
        readLogForDiagnostics(filename, options),
        { encoding: 'utf8', mode: 0o600 },
      )
    })

    fs.renameSync(temporary, destination)
    return {
      destination,
      format: 'directory',
      configIncluded: config !== null,
      logCount: logs.filter((filename) => fs.existsSync(filename)).length,
    }
  } catch (cause) {
    if (temporary.includes('.partial-')) fs.rmSync(temporary, { recursive: true, force: true })
    throw new DesktopError(
      ERROR_CODES.DIAGNOSTIC_EXPORT_FAILED,
      `无法导出脱敏诊断包：${cause.message}`,
      { destination },
      cause,
    )
  }
}

module.exports = {
  DIAGNOSTIC_FORMAT_VERSION,
  exportDiagnosticBundle,
  readLogForDiagnostics,
  redactPrivatePath,
  sanitizeDiagnosticValue,
}
