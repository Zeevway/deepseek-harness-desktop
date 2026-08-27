'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  assertHarnessOrigin,
  clearHarnessSiteData,
  clearSessionPartitionData,
} = require('../src/site-data.cjs')

test('clears all origin storage and partition caches for a local Harness origin', async () => {
  const calls = []
  const session = {
    clearStorageData: async (options) => calls.push(['storage', options]),
    clearCodeCaches: async (options) => calls.push(['code', options]),
    clearCache: async () => calls.push(['cache']),
    clearAuthCache: async () => calls.push(['auth']),
    clearHostResolverCache: async () => calls.push(['dns']),
  }

  const result = await clearHarnessSiteData(session, 'http://127.0.0.1:43123/path')

  assert.equal(result.origin, 'http://127.0.0.1:43123')
  assert.deepEqual(calls[0], ['storage', { origin: 'http://127.0.0.1:43123' }])
  assert.deepEqual(calls[1], ['code', { urls: ['http://127.0.0.1:43123'] }])
  assert.deepEqual(calls.slice(2).map((entry) => entry[0]), ['cache', 'auth', 'dns'])
})

test('refuses to clear arbitrary remote sites', () => {
  assert.throws(() => assertHarnessOrigin('https://example.com'), /本机/u)
})

test('clears every origin and cache in a session partition', async () => {
  const calls = []
  const session = {
    clearStorageData: async (...args) => calls.push(['storage', ...args]),
    clearCodeCaches: async (options) => calls.push(['code', options]),
    clearCache: async () => calls.push(['cache']),
    clearAuthCache: async () => calls.push(['auth']),
    clearHostResolverCache: async () => calls.push(['dns']),
  }

  const result = await clearSessionPartitionData(session)

  assert.deepEqual(result, {
    clearedAllPartitionStorage: true,
    clearedPartitionCaches: true,
  })
  assert.deepEqual(calls, [
    ['storage'],
    ['code', {}],
    ['cache'],
    ['auth'],
    ['dns'],
  ])
})
