'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { StreamingLogRedactor, redactSensitiveText } = require('../src/log-redaction.cjs')

test('redacts common secret forms', () => {
  const output = redactSensitiveText(
    'apiKey=sk-direct-secret Authorization: Bearer token-value?token=yes&access_token=query-secret',
  )
  assert.equal(output.includes('sk-direct-secret'), false)
  assert.equal(output.includes('token-value'), false)
  assert.equal(output.includes('query-secret'), false)
})

test('redacts authorization schemes, cookies, JSON headers, and URL credentials', () => {
  const output = redactSensitiveText([
    'Authorization: Basic dXNlcjpwYXNz',
    'Cookie: session=private-cookie',
    'Set-Cookie: refresh=private-refresh; HttpOnly',
    '{"Authorization":"Bearer json-token"}',
    'https://private-user:private-password@example.test/path',
  ].join('\n'))

  for (const secret of [
    'dXNlcjpwYXNz',
    'private-cookie',
    'private-refresh',
    'json-token',
    'private-user',
    'private-password',
  ]) assert.equal(output.includes(secret), false)
})

test('stream redaction holds an incomplete line so a split secret cannot leak', () => {
  const secret = 'sk-stream-secret-value'
  const redactor = new StreamingLogRedactor({ secrets: [secret] })
  const first = redactor.write('key=sk-stream-')
  const second = redactor.write('secret-value\nnext line\n')

  assert.equal(first, '')
  assert.equal(second.includes(secret), false)
  assert.match(second, /\[REDACTED\]/u)
  assert.equal(redactor.flush(), '')
})
