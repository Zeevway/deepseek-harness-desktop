'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { exportDiagnosticBundle, redactPrivatePath, sanitizeDiagnosticValue } = require('../src/diagnostics.cjs')

test('exports a diagnostic directory without DPAPI ciphertext, API keys, tokens, or home paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-diagnostics-'))
  const configFile = path.join(root, 'config.json')
  const logFile = path.join(root, 'desktop.log')
  const destination = path.join(root, 'diagnostics')
  const secret = 'sk-diagnostic-secret-value'
  fs.writeFileSync(configFile, JSON.stringify({
    version: 3,
    encryptedApiKey: 'opaque-dpapi-ciphertext',
    workspace: path.join(os.homedir(), 'private-work'),
  }))
  fs.writeFileSync(logFile, `API_KEY=${secret}\nAuthorization: Bearer bearer-secret\n`)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const result = exportDiagnosticBundle({
    destination,
    configFile,
    logFiles: [logFile],
    secrets: [secret],
    metadata: { appVersion: '0.3.0', accessToken: 'metadata-secret' },
    now: new Date('2026-08-26T00:00:00.000Z'),
  })
  const contents = fs.readdirSync(destination, { recursive: true })
    .filter((entry) => fs.statSync(path.join(destination, entry)).isFile())
    .map((entry) => fs.readFileSync(path.join(destination, entry), 'utf8'))
    .join('\n')

  assert.equal(result.format, 'directory')
  assert.equal(result.logCount, 1)
  assert.equal(contents.includes(secret), false)
  assert.equal(contents.includes('opaque-dpapi-ciphertext'), false)
  assert.equal(contents.includes('metadata-secret'), false)
  assert.equal(contents.includes(os.homedir()), false)
  assert.match(contents, /\[OMITTED\]|\[REDACTED\]/u)
})

test('recursively omits sensitive fields while retaining useful diagnostics', () => {
  assert.deepEqual(sanitizeDiagnosticValue({
    status: 'failed',
    nested: { password: 'secret', statusCode: 401 },
  }), {
    status: 'failed',
    nested: { password: '[OMITTED]', statusCode: 401 },
  })
})

test('redacts Windows private paths across case and slash variants', () => {
  const root = 'C:\\Users\\PrivateUser'
  const text = 'C:\\USERS\\PRIVATEUSER\\work C:/Users/PrivateUser/logs'
  const redacted = redactPrivatePath(text, root)

  assert.equal(redacted.toLowerCase().includes('privateuser'), false)
  assert.equal(redacted.match(/\[USER_HOME\]/gu)?.length, 2)
})
