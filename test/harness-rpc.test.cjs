const assert = require('node:assert/strict')
const test = require('node:test')

const { callHarnessRpc, prepareWorkspace } = require('../src/harness-rpc.cjs')

test('validates the correlated Harness RPC envelope', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body)
    calls.push({ url: String(url), request })
    return {
      ok: true,
      json: async () => ({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: { accepted: true } },
      }),
    }
  }
  const value = await callHarnessRpc('http://127.0.0.1:43123', 'commands/execute', {
    args: { agentId: 'session-1', line: '/plan', images: [] },
  }, { fetchImpl })

  assert.deepEqual(value, { accepted: true })
  assert.equal(calls[0].url, 'http://127.0.0.1:43123/api/commands/execute')
  assert.equal(calls[0].request.method, 'commands/execute')
})

test('applies Plan mode only to a newly created session', async () => {
  const calls = []
  const rpc = async (method, payload) => {
    calls.push({ method, payload })
    if (method === 'workspace.create') {
      return { workspace: { workspaceId: 'workspace-a', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z' } }
    }
    if (method === 'workspace.list') {
      return { items: [{ workspaceId: 'workspace-a', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z' }] }
    }
    if (method === 'session.list') return { items: [] }
    if (method === 'session.create') return { sessionId: 'session-new' }
    if (method === 'commands/execute') {
      return { commandId: 'command-plan', result: { kind: 'success', text: 'Plan mode on.' } }
    }
    throw new Error(`unexpected method ${method}`)
  }

  const result = await prepareWorkspace('http://127.0.0.1:1', 'C:\\workspace', { rpc, workMode: 'plan' })
  assert.equal(result.newSessionId, 'session-new')
  assert.deepEqual(calls.at(-1), {
    method: 'commands/execute',
    payload: { args: { agentId: 'session-new', line: '/plan', images: [] } },
  })
})

test('rejects a command-level Plan mode failure even when RPC transport succeeds', async () => {
  const rpc = async (method) => {
    if (method === 'workspace.create') {
      return { workspace: { workspaceId: 'workspace-a', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z' } }
    }
    if (method === 'workspace.list') {
      return { items: [{ workspaceId: 'workspace-a', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z' }] }
    }
    if (method === 'session.list') return { items: [] }
    if (method === 'session.create') return { sessionId: 'session-new' }
    if (method === 'commands/execute') {
      return { commandId: 'command-plan', result: { kind: 'error', text: 'Plan mode is unavailable.' } }
    }
    throw new Error(`unexpected method ${method}`)
  }

  await assert.rejects(
    prepareWorkspace('http://127.0.0.1:1', 'C:\\workspace', { rpc, workMode: 'plan' }),
    (error) => error?.code === 'PLAN_MODE_FAILED'
      && error.message === 'Plan mode is unavailable.'
      && error.rpcFatal === true,
  )
})

test('preserves an existing recent session without changing its mode', async () => {
  const calls = []
  const rpc = async (method) => {
    calls.push(method)
    if (method === 'workspace.create') {
      return { workspace: { workspaceId: 'workspace-a', sessionIds: ['session-old'], createdAt: '2026-01-01T00:00:00.000Z' } }
    }
    if (method === 'workspace.list') {
      return { items: [{ workspaceId: 'workspace-a', sessionIds: ['session-old'], createdAt: '2026-01-01T00:00:00.000Z' }] }
    }
    if (method === 'session.list') return { items: [{ sessionId: 'session-old', updatedAt: 100 }] }
    throw new Error(`unexpected method ${method}`)
  }

  const result = await prepareWorkspace('http://127.0.0.1:1', 'C:\\workspace', { rpc, workMode: 'plan' })
  assert.equal(result.newSessionId, null)
  assert.equal(calls.includes('session.create'), false)
  assert.equal(calls.includes('commands/execute'), false)
})
