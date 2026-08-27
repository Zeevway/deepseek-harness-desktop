const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest'
const HARNESS_RELEASE_URL = 'https://github.com/deepseek-ai/deepseek-harness/releases'
const DEFAULT_TIMEOUT_MS = 15_000

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

class UpdateCheckError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'UpdateCheckError'
    this.code = code
  }
}

function parseSemver(value) {
  if (typeof value !== 'string') {
    throw new TypeError('版本格式无效。')
  }

  const match = SEMVER_PATTERN.exec(value)
  if (!match) {
    throw new TypeError('版本格式无效。')
  }

  const prerelease = match[4] ? match[4].split('.') : []
  if (prerelease.some((identifier) => /^\d+$/u.test(identifier) && identifier.length > 1 && identifier[0] === '0')) {
    throw new TypeError('版本格式无效。')
  }

  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
  }
}

function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)

  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] < b[key]) return -1
    if (a[key] > b[key]) return 1
  }

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1

  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index]
    const rightIdentifier = b.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue

    const leftIsNumeric = /^\d+$/u.test(leftIdentifier)
    const rightIsNumeric = /^\d+$/u.test(rightIdentifier)
    if (leftIsNumeric && rightIsNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1
    }
    if (leftIsNumeric) return -1
    if (rightIsNumeric) return 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }

  return 0
}

function createTimeout(controller, timeoutMs) {
  let timeoutId
  const promise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort()
      reject(new UpdateCheckError('检查更新超时，请检查网络后重试。', 'TIMEOUT'))
    }, timeoutMs)
  })

  return {
    promise,
    clear() {
      clearTimeout(timeoutId)
    },
  }
}

async function requestLatestVersion(fetchImpl, signal) {
  const response = await fetchImpl(REGISTRY_LATEST_URL, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  })

  if (!response || response.ok !== true || typeof response.json !== 'function') {
    throw new UpdateCheckError('更新服务暂时不可用，请稍后重试。', 'HTTP_ERROR')
  }

  const document = await response.json()
  if (!document || typeof document !== 'object' || typeof document.version !== 'string') {
    throw new UpdateCheckError('更新服务返回的版本信息无效，请稍后重试。', 'INVALID_RESPONSE')
  }

  try {
    parseSemver(document.version)
  } catch {
    throw new UpdateCheckError('更新服务返回的版本信息无效，请稍后重试。', 'INVALID_RESPONSE')
  }

  return document.version
}

async function checkForHarnessUpdate(currentVersion, options = {}) {
  try {
    parseSemver(currentVersion)
  } catch {
    throw new UpdateCheckError('当前 Harness 版本格式无效。', 'INVALID_CURRENT_VERSION')
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new UpdateCheckError('当前环境不支持在线检查更新。', 'FETCH_UNAVAILABLE')
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('检查更新的超时时间必须为正数。')
  }

  const controller = new AbortController()
  const timeout = createTimeout(controller, timeoutMs)
  let latestVersion

  try {
    latestVersion = await Promise.race([
      requestLatestVersion(fetchImpl, controller.signal),
      timeout.promise,
    ])
  } catch (error) {
    if (error instanceof UpdateCheckError) throw error
    throw new UpdateCheckError('无法连接更新服务，请检查网络后重试。', 'NETWORK_ERROR')
  } finally {
    timeout.clear()
  }

  const checkedAt = options.now ? options.now() : new Date()
  if (!(checkedAt instanceof Date) || Number.isNaN(checkedAt.getTime())) {
    throw new TypeError('检查时间无效。')
  }

  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareSemver(currentVersion, latestVersion) < 0,
    checkedAt: checkedAt.toISOString(),
    releaseUrl: HARNESS_RELEASE_URL,
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  HARNESS_RELEASE_URL,
  REGISTRY_LATEST_URL,
  UpdateCheckError,
  checkForHarnessUpdate,
  compareSemver,
  parseSemver,
}
