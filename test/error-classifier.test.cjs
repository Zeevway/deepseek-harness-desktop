'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { ERROR_CODES, classifyError } = require('../src/error-classifier.cjs')

test('classifies API, network, workspace and runtime errors with sanitized output', () => {
  assert.equal(classifyError({ status: 401, message: 'unauthorized' }).code, ERROR_CODES.API_KEY_INVALID)
  assert.equal(classifyError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })).code, ERROR_CODES.NETWORK_TIMEOUT)
  assert.equal(classifyError(Object.assign(new Error('denied'), { code: 'EACCES' })).code, ERROR_CODES.WORKSPACE_NOT_WRITABLE)
  assert.equal(classifyError(Object.assign(new Error('exit'), { code: 'EARLY_EXIT' })).code, ERROR_CODES.RUNTIME_START_FAILED)

  const sanitized = classifyError(Object.assign(new Error('failed with sk-classifier-secret'), {
    details: { apiKey: 'sk-classifier-secret', status: 500 },
  }))
  assert.equal(sanitized.message.includes('sk-classifier-secret'), false)
  assert.equal(sanitized.details.apiKey, '[REDACTED]')
})
