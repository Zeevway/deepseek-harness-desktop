'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MAX_RECENT_WORKSPACES = 10
const RISK_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 })

function normalizePathForComparison(value) {
  const resolved = path.resolve(value)
  const normalized = resolved.replace(/[\\/]+$/u, '') || path.parse(resolved).root
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isSameOrInside(candidate, parent) {
  const normalizedCandidate = normalizePathForComparison(candidate)
  const normalizedParent = normalizePathForComparison(parent)
  if (normalizedCandidate === normalizedParent) return true
  const relative = path.relative(normalizedParent, normalizedCandidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function isUncPath(value) {
  return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(String(value))
}

function risk(code, severity, message, requiresConfirmation = true) {
  return { code, severity, message, requiresConfirmation }
}

function resolveDriveType(resolved, options) {
  if (typeof options.driveType === 'function') return options.driveType(resolved)
  if (typeof options.driveType === 'string') return options.driveType
  const root = normalizePathForComparison(path.parse(resolved).root)
  if (Array.isArray(options.networkDrives)
    && options.networkDrives.some((entry) => normalizePathForComparison(entry) === root)) {
    return 'network'
  }
  return isUncPath(resolved) ? 'network' : 'unknown'
}

function inspectWorkspace(workspace, options = {}) {
  const requireWritable = options.requireWritable !== false
  const accessSync = typeof options.accessSync === 'function' ? options.accessSync : fs.accessSync
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    return {
      ok: false,
      readable: false,
      writable: false,
      requiresWriteAccess: requireWritable,
      path: '',
      realPath: '',
      riskLevel: 'high',
      risks: [risk('missing-path', 'high', '请选择一个工作文件夹', false)],
      errorCode: 'WORKSPACE_INVALID',
    }
  }

  const resolved = path.resolve(workspace.trim())
  let stat
  try {
    stat = fs.statSync(resolved)
  } catch (error) {
    return {
      ok: false,
      readable: false,
      writable: false,
      requiresWriteAccess: requireWritable,
      path: resolved,
      realPath: resolved,
      riskLevel: 'high',
      risks: [risk('missing-directory', 'high', '所选工作文件夹不存在', false)],
      errorCode: 'WORKSPACE_INVALID',
      causeCode: error?.code,
    }
  }

  if (!stat.isDirectory()) {
    return {
      ok: false,
      readable: false,
      writable: false,
      requiresWriteAccess: requireWritable,
      path: resolved,
      realPath: resolved,
      riskLevel: 'high',
      risks: [risk('not-a-directory', 'high', '所选路径不是文件夹', false)],
      errorCode: 'WORKSPACE_INVALID',
    }
  }

  let realPath = resolved
  try {
    realPath = fs.realpathSync.native(resolved)
  } catch {
    try { realPath = fs.realpathSync(resolved) } catch { realPath = resolved }
  }

  const risks = []
  const evaluatedPaths = [...new Set([resolved, realPath].map(normalizePathForComparison))]
  if (evaluatedPaths.some((candidate) => {
    const root = path.parse(candidate).root
    return candidate === normalizePathForComparison(root)
  })) {
    risks.push(risk('filesystem-root', 'critical', '磁盘或文件系统根目录会暴露过大的操作范围'))
  }

  const home = options.homeDirectory || os.homedir()
  if (home && evaluatedPaths.includes(normalizePathForComparison(home))) {
    risks.push(risk('user-home', 'high', '用户主目录包含大量与任务无关的个人文件'))
  }

  const managedRoots = [
    options.windowsDirectory,
    process.env.WINDIR,
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
  ].filter(Boolean)
  if (managedRoots.some((managedRoot) => evaluatedPaths.some((candidate) => isSameOrInside(candidate, managedRoot)))) {
    risks.push(risk('system-managed-directory', 'high', '系统或应用数据目录不适合作为工作区'))
  }

  const cloudRoots = (options.cloudRoots || [
    process.env.OneDrive,
    process.env.OneDriveCommercial,
    process.env.OneDriveConsumer,
  ]).filter(Boolean)
  if (cloudRoots.some((cloudRoot) => evaluatedPaths.some((candidate) => isSameOrInside(candidate, cloudRoot)))) {
    risks.push(risk('cloud-synced-directory', 'medium', '同步盘可能产生冲突、延迟或额外上传'))
  }

  const driveTypes = new Set([resolveDriveType(resolved, options), resolveDriveType(realPath, options)])
  const driveType = driveTypes.has('network')
    ? 'network'
    : (driveTypes.has('removable') ? 'removable' : [...driveTypes][0])
  if (driveType === 'network') {
    risks.push(risk('network-drive', 'high', '网络位置可能中断，且权限与本地磁盘不同'))
  } else if (driveType === 'removable') {
    risks.push(risk('removable-drive', 'medium', '可移动磁盘断开后工作区将不可用'))
  }

  if (normalizePathForComparison(realPath) !== normalizePathForComparison(resolved)) {
    risks.push(risk('linked-directory', 'medium', '该路径通过链接指向其他位置'))
  }

  let readable = true
  let readError
  try {
    accessSync(resolved, fs.constants.R_OK)
  } catch (error) {
    readable = false
    readError = error
    risks.push(risk('not-readable', 'critical', '当前用户无法读取该工作区', false))
  }

  let writable = false
  let writeError
  if (readable) {
    try {
      accessSync(resolved, fs.constants.W_OK)
      writable = true
    } catch (error) {
      writeError = error
    }
  }

  if (readable && requireWritable && writable && options.probeWritable !== false) {
    try {
      const probe = path.join(
        resolved,
        `.dsh-desktop-write-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      try {
        const descriptor = fs.openSync(probe, 'wx', 0o600)
        fs.closeSync(descriptor)
      } finally {
        try {
          fs.unlinkSync(probe)
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
    } catch (error) {
      writable = false
      writeError = error
    }
  }

  if (readable && requireWritable && !writable) {
    risks.push(risk('not-writable', 'critical', '当前用户无法写入该工作区', false))
  }

  const available = readable && (!requireWritable || writable)
  const riskLevel = risks.reduce(
    (highest, entry) => RISK_RANK[entry.severity] > RISK_RANK[highest] ? entry.severity : highest,
    'low',
  )
  return {
    ok: available,
    readable,
    writable,
    requiresWriteAccess: requireWritable,
    path: resolved,
    realPath,
    driveType,
    riskLevel,
    risks,
    requiresConfirmation: available && risks.some((entry) => entry.requiresConfirmation),
    errorCode: !readable
      ? 'WORKSPACE_NOT_READABLE'
      : (requireWritable && !writable ? 'WORKSPACE_NOT_WRITABLE' : undefined),
    causeCode: readError?.code || writeError?.code,
  }
}

function assertWorkspaceWritable(workspace, options) {
  const result = inspectWorkspace(workspace, options)
  if (!result.ok) {
    const message = result.risks.at(-1)?.message || '工作区不可用'
    const error = new Error(message)
    error.code = result.errorCode || 'WORKSPACE_INVALID'
    error.details = result
    throw error
  }
  return result.path
}

function normalizeRecentWorkspaces(entries, options = {}) {
  if (!Array.isArray(entries)) return []
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : MAX_RECENT_WORKSPACES
  const seen = new Set()
  const normalized = []
  for (const entry of entries) {
    const workspace = typeof entry === 'string' ? entry : entry?.path
    if (typeof workspace !== 'string' || workspace.trim() === '') continue
    const resolved = path.resolve(workspace)
    const key = normalizePathForComparison(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    const lastUsedAt = typeof entry?.lastUsedAt === 'string' && Number.isFinite(Date.parse(entry.lastUsedAt))
      ? new Date(entry.lastUsedAt).toISOString()
      : new Date(0).toISOString()
    normalized.push({ path: resolved, lastUsedAt })
  }
  normalized.sort((left, right) => Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt))
  return normalized.slice(0, limit)
}

function recordRecentWorkspace(entries, workspace, now = new Date()) {
  const resolved = path.resolve(workspace)
  return normalizeRecentWorkspaces([
    { path: resolved, lastUsedAt: now.toISOString() },
    ...normalizeRecentWorkspaces(entries),
  ])
}

function listRecentWorkspaces(entries, options = {}) {
  const normalized = normalizeRecentWorkspaces(entries, options)
  if (options.existingOnly === false) return normalized
  return normalized.filter((entry) => {
    try {
      return fs.statSync(entry.path).isDirectory()
    } catch {
      return false
    }
  })
}

function findRecentWorkspaceId(workspaces, sessions) {
  if (!Array.isArray(workspaces) || !Array.isArray(sessions)) return undefined

  const sessionsById = new Map()
  for (const session of sessions) {
    if (session && typeof session.sessionId === 'string') {
      sessionsById.set(session.sessionId, session)
    }
  }

  let selected
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    if (!workspace || typeof workspace.workspaceId !== 'string' || !Array.isArray(workspace.sessionIds)) {
      continue
    }

    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessionsById.get(sessionId)
      if (session && typeof session.updatedAt === 'number') {
        latest = Math.max(latest, session.updatedAt)
      }
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)

    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

module.exports = {
  MAX_RECENT_WORKSPACES,
  assertWorkspaceWritable,
  findRecentWorkspaceId,
  inspectWorkspace,
  isSameOrInside,
  isUncPath,
  listRecentWorkspaces,
  normalizeRecentWorkspaces,
  recordRecentWorkspace,
}
