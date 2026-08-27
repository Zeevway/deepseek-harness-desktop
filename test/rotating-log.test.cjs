'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { RotatingLog } = require('../src/rotating-log.cjs')

test('redacts secrets and rotates bounded log files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rotating-log-'))
  const filename = path.join(root, 'desktop.log')
  const secret = 'sk-log-secret-value'
  const log = new RotatingLog(filename, { maxBytes: 256, maxFiles: 2, secrets: [secret] })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  for (let index = 0; index < 12; index += 1) {
    log.append(`entry ${index}: ${'x'.repeat(55)} API_KEY=${secret}`)
  }
  const files = log.listFiles()
  const content = files.map((entry) => fs.readFileSync(entry, 'utf8')).join('\n')

  assert.ok(files.length >= 2)
  assert.ok(files.length <= 3)
  assert.equal(content.includes(secret), false)
  assert.match(content, /\[REDACTED\]/u)
  assert.ok(files.every((entry) => fs.statSync(entry).size <= 256))
})
