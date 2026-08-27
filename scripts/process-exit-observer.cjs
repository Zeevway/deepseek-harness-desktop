'use strict'

const childProcess = require('node:child_process')
const path = require('node:path')

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`)
  }
  return value
}

function normalizedPath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('executablePath must be a non-empty string')
  }
  return path.resolve(value)
}

function runPowerShell(script, environment, spawnCommand = childProcess.spawn) {
  let helper
  try {
    helper = spawnCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    return Promise.reject(error)
  }

  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false

    const finish = (error, result) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(result)
    }

    helper.stdout?.on('data', (chunk) => { output += chunk })
    helper.stderr?.on('data', (chunk) => { output += chunk })
    helper.once('error', (error) => finish(error))
    helper.once('exit', (code) => finish(null, { code, output: output.trim() }))
  })
}

const WINDOWS_EXIT_WAITER = `
$ErrorActionPreference = 'Stop'
$targetPid = [int]$env:PACKAGED_SMOKE_WAIT_PID
$timeoutMs = [int]$env:PACKAGED_SMOKE_WAIT_TIMEOUT_MS
$expectedPath = [IO.Path]::GetFullPath($env:PACKAGED_SMOKE_WAIT_EXE)
$target = [Diagnostics.Process]::GetProcessById($targetPid)
$actualPath = [IO.Path]::GetFullPath($target.MainModule.FileName)
if (-not [String]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'target PID no longer belongs to the packaged app'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PackagedSmokeProcessWaiter
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);
}
'@

$synchronize = [uint32]0x00100000
$queryLimitedInformation = [uint32]0x00001000
$handle = [PackagedSmokeProcessWaiter]::OpenProcess(
  ($synchronize -bor $queryLimitedInformation),
  $false,
  [uint32]$targetPid
)
if ($handle -eq [IntPtr]::Zero) {
  throw 'could not open target process for exit observation'
}
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
try {
  $waitResult = [PackagedSmokeProcessWaiter]::WaitForSingleObject($handle, [uint32]$timeoutMs)
  if ($waitResult -eq [uint32]258) {
    throw "target process did not exit within $timeoutMs ms"
  }
  if ($waitResult -ne [uint32]0) {
    throw "target process wait failed with result $waitResult"
  }
  $exitCode = [uint32]0
  if (-not [PackagedSmokeProcessWaiter]::GetExitCodeProcess($handle, [ref]$exitCode)) {
    throw 'could not read target process exit code'
  }
  [Console]::Out.WriteLine("EXIT_CODE=$exitCode")
} finally {
  [void][PackagedSmokeProcessWaiter]::CloseHandle($handle)
}
`.trim()

function observeWindowsProcessExit(pid, executablePath, timeoutMs, options = {}) {
  positiveInteger(pid, 'pid')
  positiveInteger(timeoutMs, 'timeoutMs')
  const expectedPath = normalizedPath(executablePath)
  const spawnCommand = options.spawnCommand ?? childProcess.spawn
  let helper
  try {
    helper = spawnCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_EXIT_WAITER], {
      env: {
        ...process.env,
        PACKAGED_SMOKE_WAIT_PID: String(pid),
        PACKAGED_SMOKE_WAIT_TIMEOUT_MS: String(timeoutMs),
        PACKAGED_SMOKE_WAIT_EXE: expectedPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    return {
      ready: Promise.reject(error),
      result: Promise.reject(error),
    }
  }

  let output = ''
  let readySettled = false
  let resultSettled = false
  let resolveReady
  let rejectReady
  let resolveResult
  let rejectResult
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const acceptOutput = (chunk) => {
    output += chunk
    if (!readySettled && /^READY\r?$/mu.test(output)) {
      readySettled = true
      resolveReady()
    }
  }
  const fail = (error) => {
    if (!readySettled) {
      readySettled = true
      rejectReady(error)
    }
    if (!resultSettled) {
      resultSettled = true
      rejectResult(error)
    }
  }

  helper.stdout?.on('data', acceptOutput)
  helper.stderr?.on('data', acceptOutput)
  helper.once('error', fail)
  helper.once('exit', (code) => {
    const match = /^EXIT_CODE=(-?\d+)\r?$/mu.exec(output)
    if (code !== 0 || !match) {
      fail(new Error(`Windows process exit waiter failed (PowerShell exit ${code}): ${output.trim()}`))
      return
    }
    if (!readySettled) {
      readySettled = true
      resolveReady()
    }
    if (!resultSettled) {
      resultSettled = true
      resolveResult(Number(match[1]))
    }
  })

  return { ready, result }
}

function waitForWindowsProcessExit(pid, executablePath, timeoutMs, options = {}) {
  return observeWindowsProcessExit(pid, executablePath, timeoutMs, options).result
}

function observeChildExit(child, options = {}) {
  const timeoutMs = positiveInteger(options.timeoutMs, 'timeoutMs')
  if (!child || typeof child.once !== 'function') {
    const error = new TypeError('child must be a ChildProcess-like object')
    return { ready: Promise.reject(error), result: Promise.reject(error) }
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return { ready: Promise.resolve(), result: Promise.resolve(child.exitCode) }
  }

  let ready = Promise.resolve()
  const result = new Promise((resolve, reject) => {
    let settled = false
    let osError = null
    let timer = null

    const finish = (error, exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      if (error) reject(error)
      else resolve(exitCode)
    }
    const onExit = (code) => finish(null, code)
    const armTimer = () => {
      if (timer !== null || settled) return
      timer = setTimeout(() => {
      const detail = osError ? `; Windows fallback: ${osError.message}` : ''
      finish(new Error(
        `packaged app did not exit (exitCode=${child.exitCode}, signalCode=${child.signalCode}, killed=${child.killed})${detail}`,
      ))
      }, timeoutMs + 2_000)
    }

    child.once('exit', onExit)
    if ((options.platform ?? process.platform) === 'win32') {
      const osObservation = observeWindowsProcessExit(child.pid, options.executablePath, timeoutMs, options)
      ready = osObservation.ready
      ready.then(armTimer, (error) => {
        osError = error
        armTimer()
      })
      osObservation.result.then(
        (code) => finish(null, code),
        (error) => { osError = error },
      )
    } else {
      armTimer()
    }
  })
  return { ready, result }
}

function waitForChildExit(child, options = {}) {
  return observeChildExit(child, options).result
}

const WINDOWS_GONE_WAITER = `
$ErrorActionPreference = 'Stop'
$targetIds = @($env:PACKAGED_SMOKE_GONE_PIDS.Split(',') | ForEach-Object { [int]$_ })
$timeoutMs = [int]$env:PACKAGED_SMOKE_GONE_TIMEOUT_MS
$expectedPath = [IO.Path]::GetFullPath($env:PACKAGED_SMOKE_GONE_EXE)
$stopwatch = [Diagnostics.Stopwatch]::StartNew()
do {
  $live = @()
  foreach ($targetPid in $targetIds) {
    try { $target = [Diagnostics.Process]::GetProcessById($targetPid) } catch { continue }
    try { $actualPath = [IO.Path]::GetFullPath($target.MainModule.FileName) } catch { continue }
    if ([String]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
      $live += $targetPid
    }
  }
  if ($live.Count -eq 0) {
    [Console]::Out.WriteLine('ALL_GONE')
    exit 0
  }
  Start-Sleep -Milliseconds 100
} while ($stopwatch.ElapsedMilliseconds -lt $timeoutMs)
throw "packaged Harness processes are still running: $($live -join ',')"
`.trim()

async function waitForWindowsProcessesGone(pids, executablePath, timeoutMs, options = {}) {
  if (!Array.isArray(pids)) throw new TypeError('pids must be an array')
  const normalizedPids = [...new Set(pids.map((pid) => positiveInteger(pid, 'pid')))]
  if (normalizedPids.length === 0) return true
  positiveInteger(timeoutMs, 'timeoutMs')
  const expectedPath = normalizedPath(executablePath)
  const result = await runPowerShell(WINDOWS_GONE_WAITER, {
    PACKAGED_SMOKE_GONE_PIDS: normalizedPids.join(','),
    PACKAGED_SMOKE_GONE_TIMEOUT_MS: String(timeoutMs),
    PACKAGED_SMOKE_GONE_EXE: expectedPath,
  }, options.spawnCommand)
  if (result.code !== 0 || !/^ALL_GONE$/mu.test(result.output)) {
    throw new Error(`Windows process cleanup check failed (PowerShell exit ${result.code}): ${result.output}`)
  }
  return true
}

module.exports = {
  observeChildExit,
  observeWindowsProcessExit,
  waitForChildExit,
  waitForWindowsProcessExit,
  waitForWindowsProcessesGone,
}
