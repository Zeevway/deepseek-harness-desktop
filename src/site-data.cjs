'use strict'

const net = require('node:net')

function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase()
  if (host === 'localhost') return true
  if (net.isIP(host) === 4) return host.startsWith('127.')
  if (net.isIP(host) === 6) {
    return host === '::1' || host === '0:0:0:0:0:0:0:1' || /^::ffff:127\./u.test(host)
  }
  return false
}

function assertHarnessOrigin(value) {
  let origin
  try {
    origin = new URL(value)
  } catch {
    throw new TypeError('Harness 站点地址无效')
  }
  if (!['http:', 'https:'].includes(origin.protocol) || !isLoopback(origin.hostname)) {
    throw new TypeError('只允许清理本机 Harness 站点数据')
  }
  if (origin.username || origin.password) throw new TypeError('Harness 站点地址不能包含登录凭据')
  return origin.origin
}

async function clearHarnessSiteData(session, originValue, options = {}) {
  if (!session || typeof session.clearStorageData !== 'function') {
    throw new TypeError('Electron session 不支持站点数据清理')
  }
  const origin = assertHarnessOrigin(originValue)

  // Omitting `storages` asks Electron to clear all supported storage types for
  // this origin, including cookies, local storage, IndexedDB, service
  // workers, CacheStorage and file-system data.
  await session.clearStorageData({ origin })
  if (typeof session.clearCodeCaches === 'function') {
    await session.clearCodeCaches({ urls: [origin] })
  }

  const clearPartitionCaches = options.clearPartitionCaches !== false
  if (clearPartitionCaches) {
    if (typeof session.clearCache === 'function') await session.clearCache()
    if (typeof session.clearAuthCache === 'function') await session.clearAuthCache()
    if (typeof session.clearHostResolverCache === 'function') await session.clearHostResolverCache()
  }
  return {
    origin,
    clearedAllOriginStorage: true,
    clearedPartitionCaches: clearPartitionCaches,
  }
}

async function clearSessionPartitionData(session) {
  if (!session || typeof session.clearStorageData !== 'function') {
    throw new TypeError('Electron session 不支持站点数据清理')
  }

  // Harness binds to a random loopback port. Clearing the whole dedicated
  // partition also removes data belonging to origins from earlier launches.
  await session.clearStorageData()
  if (typeof session.clearCodeCaches === 'function') await session.clearCodeCaches({})
  if (typeof session.clearCache === 'function') await session.clearCache()
  if (typeof session.clearAuthCache === 'function') await session.clearAuthCache()
  if (typeof session.clearHostResolverCache === 'function') await session.clearHostResolverCache()
  return { clearedAllPartitionStorage: true, clearedPartitionCaches: true }
}

module.exports = {
  assertHarnessOrigin,
  clearHarnessSiteData,
  clearSessionPartitionData,
  isLoopback,
}
