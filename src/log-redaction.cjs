'use strict'

const DEFAULT_REPLACEMENT = '[REDACTED]'
const MAX_SECRET_LENGTH = 2_048

function uniqueSecrets(secrets) {
  if (!Array.isArray(secrets)) return []
  const values = new Set()
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue
    values.add(secret)
    try {
      values.add(encodeURIComponent(secret))
    } catch {
      // The raw value is still protected when it cannot be URL encoded.
    }
  }
  return [...values].sort((left, right) => right.length - left.length)
}

function redactSensitiveText(value, options = {}) {
  let text = typeof value === 'string' ? value : String(value ?? '')
  const replacement = typeof options.replacement === 'string'
    ? options.replacement
    : DEFAULT_REPLACEMENT

  for (const secret of uniqueSecrets(options.secrets)) {
    text = text.split(secret).join(replacement)
  }

  // DeepSeek-style keys are removed even when a caller forgot to supply the
  // exact secret. The upper bound keeps malformed output from matching forever.
  text = text.replace(/\bsk-[A-Za-z0-9][A-Za-z0-9._-]{5,511}\b/gu, replacement)
  text = text.replace(
    /((?:["']?(?:authorization|proxy-authorization)["']?)\s*[:=]\s*["']?)[^\r\n"']+/giu,
    `$1${replacement}`,
  )
  text = text.replace(
    /((?:["']?(?:cookie|set-cookie)["']?)\s*[:=]\s*["']?)[^\r\n"']+/giu,
    `$1${replacement}`,
  )
  text = text.replace(
    /((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential)["']?)\s*[:=]\s*["']?)([^\s,"';}]+)/giu,
    `$1${replacement}`,
  )
  text = text.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, `$1${replacement}@`)
  text = text.replace(
    /([?&](?:api[_-]?key|access[_-]?token|token|secret)=)[^&#\s]+/giu,
    `$1${replacement}`,
  )
  return text
}

class StreamingLogRedactor {
  constructor(options = {}) {
    this.secrets = uniqueSecrets(options.secrets)
    this.replacement = options.replacement ?? DEFAULT_REPLACEMENT
    this.maxBufferedCharacters = options.maxBufferedCharacters ?? 16_384
    const longestSecret = this.secrets.reduce((longest, value) => Math.max(longest, value.length), 0)
    this.holdCharacters = Math.min(
      MAX_SECRET_LENGTH,
      Math.max(64, longestSecret > 0 ? longestSecret - 1 : 0),
    )
    this.buffer = ''
  }

  write(value) {
    this.buffer += typeof value === 'string' ? value : String(value ?? '')
    const lastNewline = Math.max(this.buffer.lastIndexOf('\n'), this.buffer.lastIndexOf('\r'))
    if (lastNewline >= 0) {
      const complete = this.buffer.slice(0, lastNewline + 1)
      this.buffer = this.buffer.slice(lastNewline + 1)
      return this.redact(complete)
    }

    if (this.buffer.length > this.maxBufferedCharacters) {
      const emitLength = Math.max(0, this.buffer.length - this.holdCharacters)
      const complete = this.buffer.slice(0, emitLength)
      this.buffer = this.buffer.slice(emitLength)
      return this.redact(complete)
    }
    return ''
  }

  flush() {
    const remaining = this.redact(this.buffer)
    this.buffer = ''
    return remaining
  }

  redact(value) {
    return redactSensitiveText(value, {
      secrets: this.secrets,
      replacement: this.replacement,
    })
  }
}

function createStreamingLogRedactor(options) {
  return new StreamingLogRedactor(options)
}

module.exports = {
  DEFAULT_REPLACEMENT,
  MAX_SECRET_LENGTH,
  StreamingLogRedactor,
  createStreamingLogRedactor,
  redactSensitiveText,
}
