'use strict'

const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models'
const DEFAULT_TIMEOUT_MS = 15_000

function normalizeApiKey(apiKey) {
  if (typeof apiKey !== 'string') {
    return { ok: false, code: 'KEY_FORMAT', message: 'API Key 应以 sk- 开头' }
  }
  const value = apiKey.trim()
  if (!/^sk-[A-Za-z0-9._-]+$/u.test(value) || value.length > 512) {
    return { ok: false, code: 'KEY_FORMAT', message: 'API Key 格式不正确' }
  }
  return { ok: true, value }
}

async function testDeepSeekApiKey(apiKey, options = {}) {
  const normalized = normalizeApiKey(apiKey)
  if (!normalized.ok) return normalized

  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { ok: false, code: 'NETWORK_UNAVAILABLE', message: '当前环境无法发起连接测试' }
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('连接测试超时时间无效')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(DEEPSEEK_MODELS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${normalized.value}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (response?.ok) return { ok: true, code: 'CONNECTED', message: '连接成功，可以开始使用' }
    if (response?.status === 401 || response?.status === 403) {
      return { ok: false, code: 'KEY_REJECTED', message: 'Key 无效或已失效，请检查后重试' }
    }
    if (response?.status === 429) {
      return { ok: false, code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' }
    }
    return { ok: false, code: 'SERVICE_ERROR', message: `DeepSeek 返回错误（${response?.status || '未知'}）` }
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      return { ok: false, code: 'NETWORK_TIMEOUT', message: '连接超时，请检查网络或代理设置后重试' }
    }
    return { ok: false, code: 'NETWORK_ERROR', message: '无法连接 DeepSeek，请检查网络或代理设置' }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  DEEPSEEK_MODELS_URL,
  DEFAULT_TIMEOUT_MS,
  normalizeApiKey,
  testDeepSeekApiKey,
}
