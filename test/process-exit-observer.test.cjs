'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const test = require('node:test')

const {
  observeChildExit,
  observeWindowsProcessExit,
  waitForWindowsProcessesGone,
} = require('../scripts/process-exit-observer.cjs')

function waitForActualExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', resolve))
}

test('Windows process waiter reads the real exit code from an OS process handle', {
  skip: process.platform !== 'win32',
}, async () => {
  const child = spawn(process.execPath, ['-e', "process.stdin.once('data', () => process.exit(7)); process.stdin.resume()"], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  })
  try {
    const observation = observeWindowsProcessExit(child.pid, process.execPath, 5_000)
    await observation.ready
    child.stdin.end('exit\n')
    const exitCode = await observation.result
    assert.equal(exitCode, 7)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await waitForActualExit(child)
  }
})

test('child exit wait falls back to the Windows process handle when no Node exit event arrives', {
  skip: process.platform !== 'win32',
}, async () => {
  const child = spawn(process.execPath, ['-e', "process.stdin.once('data', () => process.exit(0)); process.stdin.resume()"], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  })
  const silentChild = new EventEmitter()
  silentChild.pid = child.pid
  silentChild.exitCode = null
  silentChild.signalCode = null
  silentChild.killed = false

  try {
    const observation = observeChildExit(silentChild, {
      executablePath: process.execPath,
      platform: 'win32',
      timeoutMs: 5_000,
    })
    await observation.ready
    child.stdin.end('exit\n')
    const exitCode = await observation.result
    assert.equal(exitCode, 0)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await waitForActualExit(child)
  }
})

test('Windows cleanup check rejects a live process and accepts it after exit', {
  skip: process.platform !== 'win32',
}, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  try {
    await assert.rejects(
      waitForWindowsProcessesGone([child.pid], process.execPath, 250),
      /still running/u,
    )
    child.kill()
    await waitForActualExit(child)
    await waitForWindowsProcessesGone([child.pid], process.execPath, 5_000)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await waitForActualExit(child)
  }
})
