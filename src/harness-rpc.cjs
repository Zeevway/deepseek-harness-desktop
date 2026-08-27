'use strict'

const { randomUUID } = require('node:crypto')

const { findRecentWorkspaceId } = require('./workspace-selection.cjs')

const RPC_METHOD_PATTERN = /^[A-Za-z0-9_$.-]+(?:\/[A-Za-z0-9_$.-]+)*$/u

function fatalRpcError(message, code = 'HARNESS_RPC_FAILED', details = {}) {
  const error = new Error(message)
  error.code = code
  error.details = details
  error.rpcFatal = true
  return error
}

async function callHarnessRpc(baseUrl, method, payload = {}, options = {}) {
  if (typeof method !== 'string' || !RPC_METHOD_PATTERN.test(method)) {
    throw new TypeError('Harness RPC 方法无效')
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('当前环境无法调用 Harness RPC')
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Harness RPC 超时时间无效')

  const rpcId = randomUUID()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(new URL(`/api/${method}`, baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method,
        payload,
      }),
      signal: controller.signal,
    })
    if (!response?.ok) {
      const error = new Error(`Harness RPC HTTP ${response?.status || '未知'}`)
      error.code = 'HARNESS_RPC_TRANSPORT'
      throw error
    }

    const body = await response.json()
    if (body?.type !== 'server-response' || body.rpcId !== rpcId) {
      throw fatalRpcError('Harness 接口返回了无法识别的响应', 'HARNESS_RPC_PROTOCOL')
    }
    if (body.result?.ok === true) return body.result.value
    if (body.result?.ok === false) {
      const failure = body.result.error?.message || body.result.error?.code || `${method} 调用失败`
      throw fatalRpcError(failure, body.result.error?.code || 'HARNESS_RPC_REJECTED')
    }
    throw fatalRpcError('Harness 接口响应缺少调用结果', 'HARNESS_RPC_PROTOCOL')
  } finally {
    clearTimeout(timer)
  }
}

async function prepareWorkspace(baseUrl, workspace, options = {}) {
  const rpc = options.rpc ?? ((method, payload) => callHarnessRpc(baseUrl, method, payload, options))
  const created = await rpc('workspace.create', { path: workspace })
  const targetId = created?.workspace?.workspaceId
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw fatalRpcError('Harness 没有返回有效的工作区标识', 'WORKSPACE_INVALID')
  }

  const [workspaces, sessions] = await Promise.all([
    rpc('workspace.list', {}),
    rpc('session.list', {}),
  ])
  const workspaceItems = Array.isArray(workspaces?.items) ? workspaces.items : []
  const target = workspaceItems.find((item) => item?.workspaceId === targetId) || created.workspace
  const targetSessionIds = Array.isArray(target?.sessionIds) ? target.sessionIds : []
  const recentId = findRecentWorkspaceId(workspaceItems, sessions?.items)
  const needsNewSession = targetSessionIds.length === 0 || recentId !== targetId

  let newSessionId = null
  if (needsNewSession) {
    const session = await rpc('session.create', { workspaceId: targetId })
    newSessionId = session?.sessionId
    if (typeof newSessionId !== 'string' || newSessionId.length === 0) {
      throw fatalRpcError('Harness 没有返回有效的会话标识', 'SESSION_CREATE_FAILED')
    }
    if (options.workMode === 'plan') {
      const commandResult = await rpc('commands/execute', {
        args: { agentId: newSessionId, line: '/plan', images: [] },
      })
      if (commandResult?.result?.kind !== 'success') {
        throw fatalRpcError(
          commandResult?.result?.text || '无法为新会话启用 Plan 模式',
          'PLAN_MODE_FAILED',
        )
      }
    }
  }

  return { workspace: created.workspace, newSessionId }
}

async function ensureWorkspace(baseUrl, workspace, options = {}) {
  const timeoutMs = options.startupTimeoutMs ?? 25_000
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await prepareWorkspace(baseUrl, workspace, options)
    } catch (error) {
      if (error?.rpcFatal === true) throw error
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const error = new Error(`Harness 工作区未能就绪：${lastError?.message || '连接超时'}`)
  error.code = lastError?.code || 'START_TIMEOUT'
  error.cause = lastError
  throw error
}

module.exports = {
  RPC_METHOD_PATTERN,
  callHarnessRpc,
  ensureWorkspace,
  fatalRpcError,
  prepareWorkspace,
}
