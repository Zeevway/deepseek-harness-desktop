const assert = require('node:assert/strict')
const test = require('node:test')

const { DEEPSEEK_MODELS_URL, testDeepSeekApiKey } = require('../src/deepseek-api.cjs')

test('rejects malformed keys without sending a request', async () => {
  for (const value of ['not-a-key', 'sk-invalid:value', `sk-${'a'.repeat(510)}`]) {
    let called = false
    const result = await testDeepSeekApiKey(value, { fetchImpl: async () => { called = true } })
    assert.equal(result.code, 'KEY_FORMAT')
    assert.equal(called, false)
  }
})

test('uses the same 512-character boundary as persisted API keys', async () => {
  let called = false
  const result = await testDeepSeekApiKey(`sk-${'a'.repeat(509)}`, {
    fetchImpl: async () => {
      called = true
      return { ok: true, status: 200 }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(called, true)
})

test('performs a real authenticated models request for the supplied key', async () => {
  let request
  const result = await testDeepSeekApiKey(' sk-new-value ', {
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, status: 200 }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(request.url, DEEPSEEK_MODELS_URL)
  assert.equal(request.options.headers.Authorization, 'Bearer sk-new-value')
})

test('classifies rejected credentials, rate limits and service errors', async () => {
  for (const [status, code] of [[401, 'KEY_REJECTED'], [403, 'KEY_REJECTED'], [429, 'RATE_LIMITED'], [503, 'SERVICE_ERROR']]) {
    const result = await testDeepSeekApiKey('sk-value', { fetchImpl: async () => ({ ok: false, status }) })
    assert.equal(result.code, code)
  }
})

test('returns a fixed network error without exposing the thrown message', async () => {
  const result = await testDeepSeekApiKey('sk-secret-value', {
    fetchImpl: async () => { throw new Error('request leaked sk-secret-value') },
  })
  assert.equal(result.code, 'NETWORK_ERROR')
  assert.doesNotMatch(result.message, /secret/u)
})
