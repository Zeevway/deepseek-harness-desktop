'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { redactSensitiveText } = require('./log-redaction.cjs')

function truncateUtf8Tail(text, maximumBytes) {
  const content = Buffer.from(text, 'utf8')
  if (content.length <= maximumBytes) return text
  const marker = Buffer.from('[earlier log content truncated]\n', 'utf8')
  const available = Math.max(0, maximumBytes - marker.length)
  return Buffer.concat([marker, content.subarray(content.length - available)]).toString('utf8')
}

class RotatingLog {
  constructor(filename, options = {}) {
    if (typeof filename !== 'string' || filename.trim() === '') {
      throw new TypeError('日志文件路径无效')
    }
    this.filename = path.resolve(filename)
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024
    this.maxFiles = options.maxFiles ?? 5
    this.syncWrites = options.syncWrites ?? false
    this.secrets = Array.isArray(options.secrets) ? [...options.secrets] : []
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 256) {
      throw new TypeError('maxBytes 必须是不小于 256 的整数')
    }
    if (!Number.isInteger(this.maxFiles) || this.maxFiles < 1 || this.maxFiles > 100) {
      throw new TypeError('maxFiles 必须是 1 到 100 之间的整数')
    }
  }

  setSecrets(secrets) {
    this.secrets = Array.isArray(secrets) ? [...secrets] : []
  }

  append(value) {
    let line = redactSensitiveText(value, { secrets: this.secrets })
    if (!line.endsWith('\n')) line += '\n'
    line = truncateUtf8Tail(line, this.maxBytes)
    const entry = Buffer.from(line, 'utf8')
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    let currentBytes = 0
    try {
      currentBytes = fs.statSync(this.filename).size
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (currentBytes > 0 && currentBytes + entry.length > this.maxBytes) this.rotate()

    const descriptor = fs.openSync(this.filename, 'a', 0o600)
    try {
      fs.writeSync(descriptor, entry)
      if (this.syncWrites) fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
  }

  rotate() {
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const source = `${this.filename}.${index}`
      const destination = `${this.filename}.${index + 1}`
      if (!fs.existsSync(source)) continue
      if (fs.existsSync(destination)) fs.unlinkSync(destination)
      fs.renameSync(source, destination)
    }
    if (fs.existsSync(this.filename)) {
      const first = `${this.filename}.1`
      if (fs.existsSync(first)) fs.unlinkSync(first)
      fs.renameSync(this.filename, first)
    }
  }

  listFiles() {
    const files = []
    if (fs.existsSync(this.filename)) files.push(this.filename)
    for (let index = 1; index <= this.maxFiles; index += 1) {
      const archived = `${this.filename}.${index}`
      if (fs.existsSync(archived)) files.push(archived)
    }
    return files
  }
}

module.exports = { RotatingLog, truncateUtf8Tail }
