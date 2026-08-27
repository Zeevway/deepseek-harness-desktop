'use strict'

const childProcess = require('node:child_process')
const path = require('node:path')

const DEFAULT_CACHE_TTL_MS = 5_000
const DEFAULT_TIMEOUT_MS = 2_000
const DRIVE_INFO_SCRIPT = [
  '$drives = @([System.IO.DriveInfo]::GetDrives() | ForEach-Object {',
  "  [PSCustomObject]@{ root = $_.Name; type = [int]$_.DriveType }",
  '})',
  'ConvertTo-Json -InputObject $drives -Compress',
].join('; ')

function isUncPath(value) {
  return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(String(value))
}

function normalizeDriveRoot(value) {
  const match = /^([A-Za-z]):(?:[\\/]|$)/u.exec(String(value || '').trim())
  return match ? `${match[1].toUpperCase()}:\\` : ''
}

function normalizeDriveType(value) {
  switch (Number(value)) {
    case 2: return 'removable'
    case 3: return 'fixed'
    case 4: return 'network'
    default: return 'unknown'
  }
}

function parseDriveInfoOutput(output) {
  const text = String(output || '').replace(/^\uFEFF/u, '').trim()
  if (!text) throw new Error('Windows drive type query returned no data')
  const parsed = JSON.parse(text)
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const driveTypes = new Map()
  for (const entry of entries) {
    const root = normalizeDriveRoot(entry?.root ?? entry?.Root)
    const driveType = normalizeDriveType(entry?.type ?? entry?.Type)
    if (root) driveTypes.set(root, driveType)
  }
  return driveTypes
}

function defaultPowerShellPath(environment = process.env) {
  const windowsDirectory = environment.SystemRoot || environment.WINDIR || 'C:\\Windows'
  return path.win32.join(
    windowsDirectory,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

function createWindowsDriveTypeResolver(options = {}) {
  const platform = options.platform || process.platform
  const execute = options.execFileSync || childProcess.execFileSync
  const now = options.now || Date.now
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const powershell = options.powershellPath || defaultPowerShellPath(options.environment)
  const onError = typeof options.onError === 'function' ? options.onError : null
  let cachedDriveTypes = new Map()
  let cacheExpiresAt = 0
  let cacheInitialized = false

  function refreshDriveTypes() {
    const refreshedAt = now()
    try {
      const output = execute(powershell, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        DRIVE_INFO_SCRIPT,
      ], {
        cwd: path.win32.dirname(powershell),
        encoding: 'utf8',
        maxBuffer: 128 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      })
      cachedDriveTypes = parseDriveInfoOutput(output)
    } catch (error) {
      cachedDriveTypes = new Map()
      try { onError?.(error) } catch {}
    }
    cacheInitialized = true
    cacheExpiresAt = refreshedAt + cacheTtlMs
  }

  return function resolveWindowsDriveType(candidate) {
    if (isUncPath(candidate)) return 'network'
    if (platform !== 'win32') return 'unknown'
    const root = normalizeDriveRoot(candidate)
    if (!root) return 'unknown'
    if (!cacheInitialized || now() >= cacheExpiresAt) refreshDriveTypes()
    return cachedDriveTypes.get(root) || 'unknown'
  }
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  DRIVE_INFO_SCRIPT,
  createWindowsDriveTypeResolver,
  defaultPowerShellPath,
  normalizeDriveRoot,
  parseDriveInfoOutput,
}
