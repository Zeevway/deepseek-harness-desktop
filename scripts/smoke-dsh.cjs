'use strict'

const crypto = require('node:crypto')
const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { constants, zstdCompressSync } = require('node:zlib')

const projectRoot = path.resolve(__dirname, '..')
const fixtureFile = path.join(projectRoot, 'test', 'fixtures', 'dsh-0.1.0-rc.7', 'fixture.json')
const testRoot = path.join(projectRoot, 'test-results', 'dsh-smoke')
const dshHome = path.join(testRoot, 'home')
const workspace = path.join(testRoot, 'workspace')
const backupRoot = path.join(testRoot, 'pre-upgrade-backup')
const runner = path.join(projectRoot, 'src', 'harness-runner.mjs')
const dshPackage = require('../node_modules/@deepseek-ai/dsh/package.json')
const dshBin = path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const EXPECTED_LEGACY_VERSION = '0.1.0-rc.7'
const WORKSPACE_TOKEN = '$WORKSPACE'
const CURRENT_TOOL_CALL_ID = 'call-current-migration-smoke-todo'
const LOCAL_SMOKE_CREDENTIAL = 'migration-smoke-local-credential'
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const ENV_ALLOWLIST = new Set([
  'ALL_PROXY', 'APPDATA', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'LANG', 'LOCALAPPDATA', 'NODE_EXTRA_CA_CERTS',
  'NO_PROXY', 'PATH', 'PATHEXT', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SSL_CERT_DIR', 'SSL_CERT_FILE',
  'SYSTEMROOT', 'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
])

function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let output = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    output += character !== '~' && /^[A-Za-z0-9._-]$/u.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return output
}

function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/u.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/u, '') || 'root').slice(0, 251)}--`
}

function replaceWorkspaceToken(value, resolvedWorkspace) {
  if (typeof value === 'string') return value.replaceAll(WORKSPACE_TOKEN, resolvedWorkspace)
  if (Array.isArray(value)) return value.map((entry) => replaceWorkspaceToken(entry, resolvedWorkspace))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => (
      [key, replaceWorkspaceToken(entry, resolvedWorkspace)]
    )))
  }
  return value
}

function loadLegacyFixture(filename = fixtureFile) {
  const fixture = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/u, ''))
  if (fixture.schemaVersion !== 1
    || fixture.sourceHarnessVersion !== EXPECTED_LEGACY_VERSION
    || typeof fixture.workspaceId !== 'string'
    || typeof fixture.sessionId !== 'string'
    || fixture.header?.type !== 'session'
    || fixture.header?.id !== fixture.sessionId
    || fixture.header?.cwd !== WORKSPACE_TOKEN
    || !Array.isArray(fixture.events)
    || fixture.events.length === 0
    || fixture.workspaceDocument?.tables?.workspaces?.[fixture.workspaceId]?.path !== WORKSPACE_TOKEN) {
    throw new Error(`invalid legacy Harness fixture: ${filename}`)
  }
  return fixture
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function materializeLegacyFixture(fixture, options = {}) {
  const home = path.resolve(options.dshHome || dshHome)
  const resolvedWorkspace = path.resolve(options.workspace || workspace)
  const workspaceDocument = replaceWorkspaceToken(fixture.workspaceDocument, resolvedWorkspace)
  const header = replaceWorkspaceToken(fixture.header, resolvedWorkspace)
  const sessionDirectory = path.join(
    home,
    'sessions',
    projectKey(resolvedWorkspace),
    encodeSegment(fixture.sessionId),
  )
  const sessionFile = path.join(sessionDirectory, 'session.jsonl.zstd')
  const headerBytes = Buffer.from(`${JSON.stringify(header)}\n`, 'utf8')
  const eventBytes = Buffer.from(`${fixture.events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')

  fs.mkdirSync(resolvedWorkspace, { recursive: true })
  fs.mkdirSync(sessionDirectory, { recursive: true })
  writeJson(path.join(home, 'storages', 'workspace.json'), workspaceDocument)
  fs.writeFileSync(sessionFile, Buffer.concat([
    zstdCompressSync(headerBytes, CHECKSUM_OPTIONS),
    zstdCompressSync(eventBytes, CHECKSUM_OPTIONS),
  ]), { mode: 0o600 })
  return { home, resolvedWorkspace, sessionFile }
}

function hashDirectory(directory) {
  const hash = crypto.createHash('sha256')
  const visit = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const childRelative = path.join(relative, entry.name)
      const child = path.join(current, entry.name)
      hash.update(childRelative)
      if (entry.isDirectory()) visit(child, childRelative)
      else hash.update(fs.readFileSync(child))
    }
  }
  visit(directory)
  return hash.digest('hex')
}

function preserveLegacyHome() {
  if (fs.existsSync(backupRoot)) throw new Error(`legacy backup already exists: ${backupRoot}`)
  fs.mkdirSync(backupRoot, { recursive: true })
  for (const directory of ['sessions', 'storages']) {
    fs.cpSync(path.join(dshHome, directory), path.join(backupRoot, directory), { recursive: true })
  }
  writeJson(path.join(backupRoot, 'backup.json'), {
    schemaVersion: 1,
    sourceHarnessVersion: EXPECTED_LEGACY_VERSION,
    fixture: path.relative(projectRoot, fixtureFile).replaceAll('\\', '/'),
  })
  return hashDirectory(backupRoot)
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function rpc(url, method, payload = {}) {
  const rpcId = randomUUID()
  const response = await fetch(new URL(`/api/${method}`, url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json()
  if (!response.ok || body.rpcId !== rpcId || body.result?.ok !== true) {
    throw new Error(`${method} failed: ${JSON.stringify(body)}`)
  }
  return body.result.value
}

function sendSse(response, chunk) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })
  response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  response.end('data: [DONE]\n\n')
}

function startFakeDeepSeek() {
  const calls = []
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        calls.push(body)
        const offersTodo = body.tools?.some((tool) => tool?.function?.name === 'todo_write') === true
        const hasToolResult = body.messages?.some((message) => message?.role === 'tool') === true
        if (offersTodo && !hasToolResult) {
          sendSse(response, {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: CURRENT_TOOL_CALL_ID,
                  type: 'function',
                  function: {
                    name: 'todo_write',
                    arguments: JSON.stringify({
                      todos: [{ content: 'Verify current tool history', status: 'completed' }],
                    }),
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          })
          return
        }
        sendSse(response, {
          choices: [{
            delta: { content: hasToolResult ? 'Current tool call completed.' : 'Current migration smoke' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: error.message } }))
      }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        baseURL: `http://127.0.0.1:${address.port}`,
        calls,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve())
        }),
      })
    })
  })
}

function smokeEnvironment(baseURL) {
  const environment = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && ENV_ALLOWLIST.has(name.toUpperCase())) environment[name] = value
  }
  return {
    ...environment,
    DEEPSEEK_API_KEY: LOCAL_SMOKE_CREDENTIAL,
    DEEPSEEK_BASE_URL: baseURL,
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: 'workspace-write',
    DSH_TELEMETRY_DISABLED: '1',
  }
}

async function startHarness(baseURL) {
  const child = spawn(process.execPath, [
    runner,
    dshBin,
    'web',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--no-open',
  ], {
    cwd: workspace,
    env: smokeEnvironment(baseURL),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let output = ''
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`dsh startup timed out\n${output}`)), 60_000)
      const consume = (chunk) => {
        const text = chunk.toString()
        output += text
        process.stdout.write(text)
        const match = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/u)
        if (match) {
          clearTimeout(timeout)
          resolve(match[1])
        }
      }
      child.stdout.on('data', consume)
      child.stderr.on('data', consume)
      child.once('error', reject)
      child.once('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error(`dsh exited before startup with code ${code}\n${output}`))
      })
    })
    return { child, url, getOutput: () => output }
  } catch (error) {
    child.kill()
    throw error
  }
}

async function stopHarness(instance) {
  const exit = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`dsh shutdown timed out\n${instance.getOutput()}`)), 15_000)
    instance.child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`dsh exited with code ${code}\n${instance.getOutput()}`))
    })
  })
  instance.child.stdin.write('shutdown\n')
  await exit
}

function findSession(items, sessionId, message) {
  const session = items.find((item) => item.sessionId === sessionId)
  if (!session) throw new Error(message)
  return session
}

function assertCompletedToolCall(history, expected, message) {
  const events = history?.events?.map((entry) => entry.event) || []
  const call = events.find((event) => event.type === 'tool/call'
    && event.data?.callId === expected.id
    && event.data?.name === expected.name)
  const result = events.find((event) => event.type === 'tool/result'
    && (event.data?.message?.source?.callId === expected.id
      || event.data?.message?.content?.some((item) => item?.toolCallId === expected.id)))
  const resultContent = result?.data?.message?.content
    ?.flatMap((item) => item?.content || [])
    .map((item) => item?.text || '')
    .join('\n') || ''
  const isError = result?.data?.message?.content?.some((item) => item?.isError === true) === true
  if (!call || !result || isError
    || (expected.resultContains && !resultContent.includes(expected.resultContains))) {
    throw new Error(message)
  }
}

function assertLegacyHistory(fixture, history) {
  const events = history?.events?.map((entry) => entry.event) || []
  const actualTypes = events.map((event) => event.type)
  for (const expectedType of fixture.expected.eventTypes) {
    if (!actualTypes.includes(expectedType)) {
      throw new Error(`legacy session history is missing ${expectedType}`)
    }
  }
  const projections = history?.projections?.values || {}
  if (projections.title !== fixture.expected.title) {
    throw new Error('legacy session title projection was not restored')
  }
  if (projections.permissions?.currentValue !== fixture.expected.permissionPreset) {
    throw new Error('legacy session permission projection was not restored')
  }
  if (projections.plan?.active !== fixture.expected.planActive) {
    throw new Error('legacy session plan projection was not restored')
  }
  assertCompletedToolCall(history, fixture.expected.toolCall,
    'legacy todo_write tool call/result was not restored')
}

async function waitForCompletedToolCall(url, sessionId, expected) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const history = await rpc(url, 'session.history', { sessionId, maxMessages: 100 })
    try {
      assertCompletedToolCall(history, expected, 'current tool call/result is not complete yet')
      const eventTypes = history?.events?.map((entry) => entry.event?.type) || []
      if (eventTypes.includes('turn/end')) return history
    } catch {}
    await delay(100)
  }
  throw new Error('current Harness did not complete the deterministic todo_write tool call')
}

async function runMigrationSmoke(fakeDeepSeek) {
  const fixture = loadLegacyFixture()
  fs.rmSync(testRoot, { recursive: true, force: true })
  materializeLegacyFixture(fixture)
  const preservedHash = preserveLegacyHome()

  const currentToolCall = {
    id: CURRENT_TOOL_CALL_ID,
    name: 'todo_write',
    resultContains: 'Updated todo list:',
  }
  let first
  let createdSessionId
  try {
    first = await startHarness(fakeDeepSeek.baseURL)
    const workspaces = await rpc(first.url, 'workspace.list')
    const legacyWorkspace = workspaces.items.find((item) => item.workspaceId === fixture.workspaceId)
    if (!legacyWorkspace || path.resolve(legacyWorkspace.path) !== path.resolve(workspace)) {
      throw new Error('legacy workspace was not readable after migration')
    }
    if (!legacyWorkspace.sessionIds.includes(fixture.sessionId)) {
      throw new Error('legacy workspace no longer owns its legacy session')
    }

    const sessions = await rpc(first.url, 'session.list')
    findSession(sessions.items, fixture.sessionId, 'legacy session was not listed after migration')
    assertLegacyHistory(fixture, await rpc(first.url, 'session.history', {
      sessionId: fixture.sessionId,
      maxMessages: 100,
    }))

    const created = await rpc(first.url, 'session.create', { workspaceId: fixture.workspaceId })
    createdSessionId = created.sessionId
    if (!createdSessionId || createdSessionId === fixture.sessionId) {
      throw new Error('session.create did not return a distinct sessionId')
    }
    const permission = await rpc(first.url, 'commands/execute', {
      args: { agentId: createdSessionId, line: '/permission read-only', images: [] },
    })
    if (permission?.result?.kind !== 'success') {
      throw new Error(`permission command failed: ${JSON.stringify(permission)}`)
    }
    await rpc(first.url, 'session.prompt', {
      sessionId: createdSessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Run the deterministic current-version tool call.' }],
      clientTimeZone: 'UTC',
    })
    await waitForCompletedToolCall(first.url, createdSessionId, currentToolCall)
  } finally {
    if (first) await stopHarness(first)
  }

  await delay(250)
  let second
  try {
    second = await startHarness(fakeDeepSeek.baseURL)
    const workspaces = await rpc(second.url, 'workspace.list')
    const legacyWorkspace = workspaces.items.find((item) => item.workspaceId === fixture.workspaceId)
    if (!legacyWorkspace
      || !legacyWorkspace.sessionIds.includes(fixture.sessionId)
      || !legacyWorkspace.sessionIds.includes(createdSessionId)) {
      throw new Error('workspace/session ownership did not survive restart')
    }

    const sessions = await rpc(second.url, 'session.list')
    findSession(sessions.items, fixture.sessionId, 'legacy session disappeared after restart')
    findSession(sessions.items, createdSessionId, 'new session was not persistent after restart')
    assertLegacyHistory(fixture, await rpc(second.url, 'session.history', {
      sessionId: fixture.sessionId,
      maxMessages: 100,
    }))
    const newHistory = await rpc(second.url, 'session.history', {
      sessionId: createdSessionId,
      maxMessages: 100,
    })
    if (newHistory?.projections?.values?.permissions?.currentValue !== 'read-only') {
      throw new Error('new session permission selection did not survive restart')
    }
    assertCompletedToolCall(newHistory, currentToolCall,
      'current todo_write tool call/result did not survive restart')
  } finally {
    if (second) await stopHarness(second)
  }

  if (!fakeDeepSeek.calls.some((call) => call.tools?.some((tool) => tool?.function?.name === 'todo_write'))
    || !fakeDeepSeek.calls.some((call) => call.messages?.some((message) => message?.role === 'tool'))) {
    throw new Error('current fake model did not observe both sides of the todo_write tool call')
  }

  if (hashDirectory(backupRoot) !== preservedHash) {
    throw new Error('the pre-upgrade backup was modified')
  }

  console.log(`dsh migration smoke ok: ${EXPECTED_LEGACY_VERSION} -> ${dshPackage.version}`)
  console.log(`legacy workspace=${fixture.workspaceId}, legacy session=${fixture.sessionId}`)
  console.log(`new session persisted with read-only permission=${createdSessionId}`)
  console.log(`current todo_write call/result persisted=${CURRENT_TOOL_CALL_ID}`)
  console.log(`legacy backup preserved=${backupRoot}`)
}

async function main() {
  const fakeDeepSeek = await startFakeDeepSeek()
  try {
    await runMigrationSmoke(fakeDeepSeek)
  } finally {
    await fakeDeepSeek.close()
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = {
  EXPECTED_LEGACY_VERSION,
  WORKSPACE_TOKEN,
  encodeSegment,
  loadLegacyFixture,
  materializeLegacyFixture,
  projectKey,
  replaceWorkspaceToken,
}
