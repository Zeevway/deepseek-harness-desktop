const assert = require('node:assert/strict')
const test = require('node:test')

const {
  HARNESS_RELEASE_URL,
  REGISTRY_LATEST_URL,
  checkForHarnessUpdate,
  compareSemver,
  parseSemver,
} = require('../src/update-checker.cjs')

test('compares stable, prerelease, and build versions using SemVer precedence', () => {
  assert.equal(compareSemver('0.1.0-rc.7', '0.1.0-rc.8'), -1)
  assert.equal(compareSemver('0.1.0-rc.7', '0.1.0'), -1)
  assert.equal(compareSemver('0.1.0', '0.1.0-rc.99'), 1)
  assert.equal(compareSemver('1.2.3-alpha.9', '1.2.3-alpha.10'), -1)
  assert.equal(compareSemver('1.2.3-1', '1.2.3-alpha'), -1)
  assert.equal(compareSemver('1.2.3+desktop.1', '1.2.3+official.2'), 0)
  assert.equal(compareSemver('99999999999999999999.0.0', '2.0.0'), 1)
})

test('rejects malformed versions instead of guessing their precedence', () => {
  for (const value of ['v0.1.0', '01.0.0', '0.1', '0.1.0-rc.07', '0.1.0-', '', null]) {
    assert.throws(() => parseSemver(value), /版本格式无效/u)
  }
})

test('returns a normalized update result after reading the npm latest endpoint', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return {
      ok: true,
      async json() {
        return { version: '0.1.0' }
      },
    }
  }

  const result = await checkForHarnessUpdate('0.1.0-rc.7', {
    fetchImpl,
    now: () => new Date('2026-08-19T01:02:03.000Z'),
  })

  assert.deepEqual(result, {
    currentVersion: '0.1.0-rc.7',
    latestVersion: '0.1.0',
    updateAvailable: true,
    checkedAt: '2026-08-19T01:02:03.000Z',
    releaseUrl: HARNESS_RELEASE_URL,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, REGISTRY_LATEST_URL)
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.headers.Accept, 'application/json')
  assert.equal(calls[0].options.signal instanceof AbortSignal, true)
})

test('reports the same version as up to date', async () => {
  const result = await checkForHarnessUpdate('0.1.0-rc.7', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.1.0-rc.7' }) }),
  })

  assert.equal(result.updateAvailable, false)
})

test('uses fixed display-safe Chinese errors for network and response failures', async () => {
  await assert.rejects(
    checkForHarnessUpdate('0.1.0', {
      fetchImpl: async () => {
        throw new Error('secret-token=do-not-show')
      },
    }),
    (error) => {
      assert.equal(error.code, 'NETWORK_ERROR')
      assert.match(error.message, /无法连接更新服务/u)
      assert.equal(error.message.includes('secret-token'), false)
      return true
    },
  )

  await assert.rejects(
    checkForHarnessUpdate('0.1.0', {
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ secret: 'hidden' }) }),
    }),
    (error) => error.code === 'HTTP_ERROR' && !error.message.includes('hidden'),
  )

  await assert.rejects(
    checkForHarnessUpdate('0.1.0', {
      fetchImpl: async () => ({ ok: true, json: async () => ({ version: 'latest' }) }),
    }),
    (error) => error.code === 'INVALID_RESPONSE' && /版本信息无效/u.test(error.message),
  )
})

test('aborts and reports a timeout without making a real network request', async () => {
  let observedSignal
  const fetchImpl = (url, options) => {
    observedSignal = options.signal
    return new Promise(() => {})
  }

  await assert.rejects(
    checkForHarnessUpdate('0.1.0-rc.7', { fetchImpl, timeoutMs: 20 }),
    (error) => error.code === 'TIMEOUT' && /检查更新超时/u.test(error.message),
  )
  assert.equal(observedSignal.aborted, true)
})
