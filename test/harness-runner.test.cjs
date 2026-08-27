const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

test('runner shuts Harness down when its parent pipe closes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-'))
  const entry = path.join(root, 'fake-dsh.mjs')
  const marker = path.join(root, 'stopped.txt')
  const runner = path.resolve(__dirname, '..', 'src', 'harness-runner.mjs')

  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(entry, `
    import fs from 'node:fs'
    process.on('SIGTERM', () => {
      fs.writeFileSync(${JSON.stringify(marker)}, 'stopped')
      process.exit(0)
    })
    process.stdout.write('ready\\n')
    setInterval(() => {}, 1000)
  `, 'utf8')

  const child = spawn(process.execPath, [runner, entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  t.after(() => {
    if (child.exitCode === null) child.kill()
  })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runner did not become ready')), 5_000)
    child.once('error', reject)
    child.stdout.on('data', (chunk) => {
      if (!chunk.toString().includes('ready')) return
      clearTimeout(timer)
      resolve()
    })
  })

  child.stdin.end()
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runner did not stop after stdin closed')), 5_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

  assert.equal(exitCode, 0)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'stopped')
})

test('runner exits if the parent pipe closes before Harness installs its signal listener', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-early-'))
  const entry = path.join(root, 'slow-dsh.mjs')
  const runner = path.resolve(__dirname, '..', 'src', 'harness-runner.mjs')

  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(entry, `
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    process.on('SIGTERM', () => process.exit(0))
    setInterval(() => {}, 1000)
  `, 'utf8')

  const child = spawn(process.execPath, [runner, entry], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  })
  t.after(() => {
    if (child.exitCode === null) child.kill()
  })
  child.stdin.end()

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('early runner did not stop')), 5_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

  assert.equal(exitCode, 0)
})

test('runner forwards a repeated shutdown so Harness can force an exit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-repeat-'))
  const entry = path.join(root, 'fake-dsh.mjs')
  const marker = path.join(root, 'signals.txt')
  const runner = path.resolve(__dirname, '..', 'src', 'harness-runner.mjs')

  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(entry, `
    import fs from 'node:fs'
    let signals = 0
    process.on('SIGTERM', () => {
      signals += 1
      fs.writeFileSync(${JSON.stringify(marker)}, String(signals))
      if (signals >= 2) process.exit(0)
    })
    process.stdout.write('ready\\n')
    setInterval(() => {}, 1000)
  `, 'utf8')

  const child = spawn(process.execPath, [runner, entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  t.after(() => {
    if (child.exitCode === null) child.kill()
  })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runner did not become ready')), 5_000)
    child.once('error', reject)
    child.stdout.on('data', (chunk) => {
      if (!chunk.toString().includes('ready')) return
      clearTimeout(timer)
      resolve()
    })
  })

  child.stdin.write('shutdown\nshutdown\n')
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runner did not forward the second shutdown')), 5_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

  assert.equal(exitCode, 0)
  assert.equal(fs.readFileSync(marker, 'utf8'), '2')
})
