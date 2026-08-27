'use strict'

const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { zstdDecompressSync } = require('node:zlib')

const projectRoot = path.resolve(__dirname, '..')
const legacyRuntimeRoot = path.join(projectRoot, '.cache', 'legacy-runtime')
const sourceRoot = path.join(legacyRuntimeRoot, 'node_modules')
const sourcePackageFile = path.join(sourceRoot, '@deepseek-ai', 'dsh', 'package.json')
const sourceBin = path.join(sourceRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const runner = path.join(projectRoot, 'src', 'harness-runner.mjs')
const generationRoot = path.join(projectRoot, '.cache', 'legacy-fixture-generation')
const dshHome = path.join(generationRoot, 'home')
const workspace = path.join(generationRoot, 'workspace')
const outputDirectory = path.join(projectRoot, 'test', 'fixtures', 'dsh-0.1.0-rc.7')
const outputFile = path.join(outputDirectory, 'fixture.json')
const expectedVersion = '0.1.0-rc.7'
const sessionId = 'session-legacy-rc7'
const fixtureTitle = 'Legacy RC7 migration fixture'
const workspaceToken = '$WORKSPACE'
const legacyRuntimeToken = '$LEGACY_RUNTIME'
const loopbackOriginToken = '$LOOPBACK_ORIGIN'
const localFixtureCredential = 'fixture-local-credential'
const ENV_ALLOWLIST = new Set([
  'ALL_PROXY', 'APPDATA', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'LANG', 'LOCALAPPDATA', 'NODE_EXTRA_CA_CERTS',
  'NO_PROXY', 'PATH', 'PATHEXT', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SSL_CERT_DIR', 'SSL_CERT_FILE',
  'SYSTEMROOT', 'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
])

function sourceEnvironment(baseURL) {
  const environment = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && ENV_ALLOWLIST.has(name.toUpperCase())) environment[name] = value
  }
  return {
    ...environment,
    DEEPSEEK_API_KEY: localFixtureCredential,
    DEEPSEEK_BASE_URL: baseURL,
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: 'workspace-write',
    DSH_TELEMETRY_DISABLED: '1',
  }
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

async function startHarness(baseURL) {
  const child = spawn(process.execPath, [
    runner,
    sourceBin,
    'web',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--no-open',
  ], {
    cwd: workspace,
    env: sourceEnvironment(baseURL),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`legacy dsh startup timed out\n${output}`)), 60_000)
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
        reject(new Error(`legacy dsh exited before startup with code ${code}\n${output}`))
      })
    })
    return { child, url, getOutput: () => output }
  } catch (error) {
    child.kill()
    throw error
  }
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
        const tools = Array.isArray(body.tools) ? body.tools : []
        const offersTodo = tools.some((tool) => tool?.function?.name === 'todo_write')
        const hasToolResult = body.messages?.some((message) => message?.role === 'tool') === true
        if (offersTodo && !hasToolResult) {
          sendSse(response, {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call-legacy-fixture-todo',
                  type: 'function',
                  function: {
                    name: 'todo_write',
                    arguments: JSON.stringify({
                      todos: [{ content: 'Verify legacy tool history', status: 'completed' }],
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
            delta: { content: hasToolResult ? 'Legacy tool call completed.' : fixtureTitle },
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

async function waitForToolCall(url) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const history = await rpc(url, 'session.history', { sessionId, maxMessages: 100 })
    const eventTypes = history?.events?.map((entry) => entry.event?.type) || []
    if (eventTypes.includes('tool/call')
      && eventTypes.includes('tool/result')
      && eventTypes.includes('turn/end')) return history
    await delay(100)
  }
  throw new Error('legacy runtime did not complete the deterministic tool call')
}

async function stopHarness(instance) {
  const exit = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`legacy dsh shutdown timed out\n${instance.getOutput()}`)), 15_000)
    instance.child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`legacy dsh exited with code ${code}\n${instance.getOutput()}`))
    })
  })
  instance.child.stdin.write('shutdown\n')
  await exit
}

function findSessionFile(directory) {
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(child)
      else if (entry.name === 'session.jsonl.zstd') return child
    }
  }
  throw new Error('legacy runtime did not materialize the session log')
}

function assertCommand(result, name) {
  if (result?.result?.kind !== 'success') {
    throw new Error(`${name} command failed: ${JSON.stringify(result)}`)
  }
}

function tokenizeFixture(value) {
  if (typeof value === 'string') {
    return value
      .replaceAll(workspace, workspaceToken)
      .replaceAll(legacyRuntimeRoot, legacyRuntimeToken)
      .replace(/http:\/\/127\.0\.0\.1:\d+/gu, loopbackOriginToken)
  }
  if (Array.isArray(value)) return value.map(tokenizeFixture)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, tokenizeFixture(entry)]))
  }
  return value
}

function fixtureStrings(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) value.forEach((entry) => fixtureStrings(entry, output))
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => fixtureStrings(entry, output))
  }
  return output
}

function assertSafeFixture(fixture) {
  const serialized = JSON.stringify(fixture)
  const strings = fixtureStrings(fixture)
  if (/\bsk-[A-Za-z0-9._-]{6,}\b/u.test(serialized)
    || /(?:authorization|cookie|password|secret|credential)["']?\s*:/iu.test(serialized)) {
    throw new Error('refusing to write a fixture that appears to contain credentials')
  }
  if (strings.some((value) => value.includes(generationRoot)
      || value.includes(legacyRuntimeRoot)
      || value.includes(localFixtureCredential))
    || strings.some((value) => /http:\/\/127\.0\.0\.1:\d+/u.test(value))) {
    throw new Error('refusing to write a fixture that contains generator-local values')
  }
}

async function main() {
  const sourcePackage = JSON.parse(fs.readFileSync(sourcePackageFile, 'utf8'))
  if (sourcePackage.version !== expectedVersion) {
    throw new Error(`expected legacy Harness ${expectedVersion}, found ${sourcePackage.version}`)
  }

  fs.rmSync(generationRoot, { recursive: true, force: true })
  fs.mkdirSync(workspace, { recursive: true })
  const fakeDeepSeek = await startFakeDeepSeek()
  let instance
  let workspaceId
  let history
  try {
    instance = await startHarness(fakeDeepSeek.baseURL)
    const createdWorkspace = await rpc(instance.url, 'workspace.create', { path: workspace })
    workspaceId = createdWorkspace?.workspace?.workspaceId
    if (!workspaceId) throw new Error('legacy runtime did not create a workspace')
    const createdSession = await rpc(instance.url, 'session.create', { workspaceId, sessionId })
    if (createdSession?.sessionId !== sessionId) throw new Error('legacy runtime did not honor the fixture session id')
    assertCommand(await rpc(instance.url, 'commands/execute', {
      args: { agentId: sessionId, line: '/permission read-only', images: [] },
    }), 'permission')
    await rpc(instance.url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Run the deterministic fixture tool call.' }],
      clientTimeZone: 'UTC',
    })
    await waitForToolCall(instance.url)
    assertCommand(await rpc(instance.url, 'commands/execute', {
      args: { agentId: sessionId, line: '/plan', images: [] },
    }), 'plan')
    const renamed = await rpc(instance.url, 'session.rename', { sessionId, title: fixtureTitle })
    if (renamed?.title !== fixtureTitle) throw new Error('legacy runtime did not persist the fixture title')
    history = await rpc(instance.url, 'session.history', { sessionId, maxMessages: 100 })
  } finally {
    try {
      if (instance) await stopHarness(instance)
    } finally {
      await fakeDeepSeek.close()
    }
  }
  if (!fakeDeepSeek.calls.some((call) => call.tools?.some((tool) => tool?.function?.name === 'todo_write'))
    || !fakeDeepSeek.calls.some((call) => call.messages?.some((message) => message?.role === 'tool'))) {
    throw new Error('the fake model did not observe both sides of the tool call')
  }

  await delay(250)
  const workspaceDocument = JSON.parse(fs.readFileSync(path.join(dshHome, 'storages', 'workspace.json'), 'utf8'))
  const workspaceRecord = workspaceDocument?.tables?.workspaces?.[workspaceId]
  if (!workspaceRecord || !workspaceRecord.sessionIds.includes(sessionId)) {
    throw new Error('legacy workspace storage does not own the fixture session')
  }

  const sessionFile = findSessionFile(path.join(dshHome, 'sessions'))
  const header = JSON.parse(zstdDecompressSync(fs.readFileSync(sessionFile)).toString('utf8').trim())
  if (header.id !== sessionId || path.resolve(header.cwd) !== path.resolve(workspace)) {
    throw new Error('legacy session header is inconsistent with the generated fixture')
  }
  const events = history?.events?.map((entry) => entry.event) || []
  const eventTypes = [...new Set(events.map((event) => event.type))]
  const projections = history?.projections?.values || {}
  if (events.length === 0
    || !eventTypes.includes('tool/call')
    || !eventTypes.includes('tool/result')
    || projections.title !== fixtureTitle
    || projections.permissions?.currentValue !== 'read-only'
    || projections.plan?.active !== true) {
    throw new Error('legacy session did not expose the expected durable state')
  }

  const fixture = tokenizeFixture({
    schemaVersion: 1,
    sourceHarnessPackage: '@deepseek-ai/dsh',
    sourceHarnessVersion: sourcePackage.version,
    generatedBy: 'scripts/generate-legacy-dsh-fixture.cjs',
    workspaceId,
    sessionId,
    workspaceDocument,
    header,
    events,
    expected: {
      title: fixtureTitle,
      permissionPreset: 'read-only',
      planActive: true,
      eventTypes,
      toolCall: {
        id: 'call-legacy-fixture-todo',
        name: 'todo_write',
        resultContains: 'Updated todo list:',
      },
    },
  })
  if (fixture.workspaceDocument?.tables?.workspaces?.[workspaceId]?.path !== workspaceToken
    || fixture.header?.cwd !== workspaceToken) {
    throw new Error('fixture path tokenization did not cover workspace storage and session header')
  }
  assertSafeFixture(fixture)
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
  console.log(`legacy fixture written: ${outputFile}`)
  console.log(`source Harness=${sourcePackage.version}, workspace=${workspaceId}, session=${sessionId}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
