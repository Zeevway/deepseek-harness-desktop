'use strict'

const { redactSensitiveText } = require('./log-redaction.cjs')

const ERROR_CATEGORIES = Object.freeze({
  API_KEY: 'api-key',
  CONFIGURATION: 'configuration',
  DATA: 'data',
  NETWORK: 'network',
  RUNTIME: 'runtime',
  UPDATE: 'update',
  WORKSPACE: 'workspace',
  UNKNOWN: 'unknown',
})

const ERROR_CODES = Object.freeze({
  API_KEY_INVALID: 'API_KEY_INVALID',
  API_KEY_MISSING: 'API_KEY_MISSING',
  KEY_DECRYPT_FAILED: 'KEY_DECRYPT_FAILED',
  CONFIG_INVALID: 'CONFIG_INVALID',
  DATA_BACKUP_FAILED: 'DATA_BACKUP_FAILED',
  DATA_MIGRATION_FAILED: 'DATA_MIGRATION_FAILED',
  DATA_RESTORE_FAILED: 'DATA_RESTORE_FAILED',
  DIAGNOSTIC_EXPORT_FAILED: 'DIAGNOSTIC_EXPORT_FAILED',
  NETWORK_OFFLINE: 'NETWORK_OFFLINE',
  NETWORK_RATE_LIMITED: 'NETWORK_RATE_LIMITED',
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  RUNTIME_START_FAILED: 'RUNTIME_START_FAILED',
  UPDATE_FAILED: 'UPDATE_FAILED',
  WORKSPACE_DANGEROUS: 'WORKSPACE_DANGEROUS',
  WORKSPACE_INVALID: 'WORKSPACE_INVALID',
  WORKSPACE_NOT_WRITABLE: 'WORKSPACE_NOT_WRITABLE',
  UNKNOWN: 'UNKNOWN',
})

const CODE_CATEGORIES = new Map([
  [ERROR_CODES.API_KEY_INVALID, ERROR_CATEGORIES.API_KEY],
  [ERROR_CODES.API_KEY_MISSING, ERROR_CATEGORIES.API_KEY],
  [ERROR_CODES.KEY_DECRYPT_FAILED, ERROR_CATEGORIES.API_KEY],
  [ERROR_CODES.CONFIG_INVALID, ERROR_CATEGORIES.CONFIGURATION],
  [ERROR_CODES.DATA_BACKUP_FAILED, ERROR_CATEGORIES.DATA],
  [ERROR_CODES.DATA_MIGRATION_FAILED, ERROR_CATEGORIES.DATA],
  [ERROR_CODES.DATA_RESTORE_FAILED, ERROR_CATEGORIES.DATA],
  [ERROR_CODES.DIAGNOSTIC_EXPORT_FAILED, ERROR_CATEGORIES.DATA],
  [ERROR_CODES.NETWORK_OFFLINE, ERROR_CATEGORIES.NETWORK],
  [ERROR_CODES.NETWORK_RATE_LIMITED, ERROR_CATEGORIES.NETWORK],
  [ERROR_CODES.NETWORK_TIMEOUT, ERROR_CATEGORIES.NETWORK],
  [ERROR_CODES.RUNTIME_START_FAILED, ERROR_CATEGORIES.RUNTIME],
  [ERROR_CODES.UPDATE_FAILED, ERROR_CATEGORIES.UPDATE],
  [ERROR_CODES.WORKSPACE_DANGEROUS, ERROR_CATEGORIES.WORKSPACE],
  [ERROR_CODES.WORKSPACE_INVALID, ERROR_CATEGORIES.WORKSPACE],
  [ERROR_CODES.WORKSPACE_NOT_WRITABLE, ERROR_CATEGORIES.WORKSPACE],
  [ERROR_CODES.UNKNOWN, ERROR_CATEGORIES.UNKNOWN],
])

function sanitizedDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {}
  const output = {}
  for (const [key, value] of Object.entries(details)) {
    if (/(?:api.?key|token|password|secret|credential|authorization|cookie)/iu.test(key)) {
      output[key] = '[REDACTED]'
    } else if (typeof value === 'string') {
      output[key] = redactSensitiveText(value)
    } else if (value === null || ['number', 'boolean'].includes(typeof value)) {
      output[key] = value
    }
  }
  return output
}

class DesktopError extends Error {
  constructor(code, message, details = {}, cause) {
    super(redactSensitiveText(message))
    this.name = 'DesktopError'
    this.code = CODE_CATEGORIES.has(code) ? code : ERROR_CODES.UNKNOWN
    this.category = CODE_CATEGORIES.get(this.code)
    this.details = sanitizedDetails(details)
    if (cause !== undefined) this.cause = cause
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      details: this.details,
    }
  }
}

function inferErrorCode(error) {
  const explicitCode = typeof error?.code === 'string' ? error.code.toUpperCase() : ''
  if (CODE_CATEGORIES.has(explicitCode)) return explicitCode
  if (['EACCES', 'EPERM', 'EROFS'].includes(explicitCode)) return ERROR_CODES.WORKSPACE_NOT_WRITABLE
  if (['ENOENT', 'ENOTDIR', 'EINVAL'].includes(explicitCode)) return ERROR_CODES.WORKSPACE_INVALID
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(explicitCode)) {
    return ERROR_CODES.NETWORK_TIMEOUT
  }
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN'].includes(explicitCode)) {
    return ERROR_CODES.NETWORK_OFFLINE
  }
  if (['SPAWN_FAILED', 'EARLY_EXIT', 'STOP_FAILED', 'INVALID_URL', 'START_TIMEOUT'].includes(explicitCode)) {
    return ERROR_CODES.RUNTIME_START_FAILED
  }

  const status = Number(error?.status ?? error?.statusCode ?? error?.details?.status)
  if (status === 401 || status === 403) return ERROR_CODES.API_KEY_INVALID
  if (status === 429) return ERROR_CODES.NETWORK_RATE_LIMITED

  const name = String(error?.name ?? '')
  if (name === 'TimeoutError' || name === 'AbortError') return ERROR_CODES.NETWORK_TIMEOUT
  const message = String(error?.message ?? error ?? '')
  if (/api\s*key.*(?:missing|required|invalid|expired)|(?:invalid|expired).*api\s*key/iu.test(message)) {
    return ERROR_CODES.API_KEY_INVALID
  }
  if (/timeout|timed out|超时/iu.test(message)) return ERROR_CODES.NETWORK_TIMEOUT
  if (/network|offline|fetch failed|网络|代理/iu.test(message)) return ERROR_CODES.NETWORK_OFFLINE
  return ERROR_CODES.UNKNOWN
}

function classifyError(error, fallbackMessage = '发生未知错误') {
  if (error instanceof DesktopError) return error
  const code = inferErrorCode(error)
  const message = error instanceof Error && error.message
    ? error.message
    : (typeof error === 'string' && error ? error : fallbackMessage)
  return new DesktopError(code, message, error?.details, error)
}

module.exports = {
  ERROR_CATEGORIES,
  ERROR_CODES,
  DesktopError,
  classifyError,
  inferErrorCode,
  sanitizedDetails,
}
