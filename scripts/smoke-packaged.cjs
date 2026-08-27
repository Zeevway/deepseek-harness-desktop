const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const {
  observeChildExit,
  waitForWindowsProcessesGone,
} = require('./process-exit-observer.cjs')
const {
  cleanupIsolatedPackagedApp,
  createIsolatedPackagedApp,
} = require('./packaged-smoke-isolation.cjs')

const projectRoot = path.resolve(__dirname, '..')
const electron = require('electron')
const manifest = require('../package.json')
const developmentMode = process.argv[2] === '--development'
const packagedExecutableName = `${manifest.build.win?.executableName || manifest.build.productName}.exe`
const sourceExecutable = developmentMode
  ? electron
  : path.resolve(process.argv[2] || path.join(projectRoot, 'release', 'win-unpacked', packagedExecutableName))
let executable = sourceExecutable
let applicationDirectory = projectRoot
const runRoot = path.join(projectRoot, 'test-results', 'packaged-smoke', `run-${Date.now()}`)
const userData = path.join(runRoot, 'user-data')
const workspace = path.join(runRoot, 'workspace')
const screenshotPath = path.join(runRoot, 'official-harness.png')
const rendererPort = 20_000 + Math.floor(Math.random() * 1_000)

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function stopSpawnedChild(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolve(false)
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('error', onStopped)
      child.off('exit', onStopped)
    }
    const onStopped = () => {
      cleanup()
      resolve(true)
    }
    child.once('error', onStopped)
    child.once('exit', onStopped)
    try {
      child.kill()
    } catch {
      cleanup()
      resolve(child.exitCode !== null || child.signalCode !== null)
    }
  })
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`test config helper exited with code ${code}`))
    })
  })
}

function closeMainWindow(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.reject(new Error(`invalid packaged app PID: ${pid}`))
  }

  const script = `
$ErrorActionPreference = 'Stop'
$targetPid = [int]$env:PACKAGED_SMOKE_TARGET_PID
$expectedPath = [IO.Path]::GetFullPath($env:PACKAGED_SMOKE_TARGET_EXE)
$targetProcess = Get-Process -Id $targetPid -ErrorAction Stop
$actualPath = [IO.Path]::GetFullPath($targetProcess.Path)
if (-not [String]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'target PID does not belong to the packaged app'
}

$targetProcess.Refresh()
$processRows = @(Get-CimInstance Win32_Process)
$targetIds = [Collections.Generic.HashSet[int]]::new()
[void]$targetIds.Add($targetPid)
do {
  $added = $false
  foreach ($row in $processRows) {
    if ($targetIds.Contains([int]$row.ParentProcessId) -and $targetIds.Add([int]$row.ProcessId)) {
      $added = $true
    }
  }
} while ($added)

$runnerIds = @(
  $processRows |
    Where-Object {
      $targetIds.Contains([int]$_.ProcessId) -and
      $_.CommandLine -and
      $_.CommandLine.IndexOf('harness-runner.mjs', [StringComparison]::OrdinalIgnoreCase) -ge 0
    } |
    ForEach-Object { [int]$_.ProcessId }
)
if (-not $targetProcess.CloseMainWindow()) {
  throw 'the packaged app main window did not accept a close request'
}
[Console]::Out.WriteLine((@{ posted = 1; runnerPids = $runnerIds } | ConvertTo-Json -Compress))
`.trim()

  return new Promise((resolve, reject) => {
    const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PACKAGED_SMOKE_TARGET_PID: String(pid),
        PACKAGED_SMOKE_TARGET_EXE: executable,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    helper.stdout.on('data', (chunk) => { output += chunk })
    helper.stderr.on('data', (chunk) => { output += chunk })
    helper.once('error', reject)
    helper.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`failed to close packaged app window (PowerShell exit ${code}): ${output.trim()}`))
        return
      }
      try {
        const resultLine = output.trim().split(/\r?\n/u).findLast((line) => line.trim().startsWith('{'))
        const result = JSON.parse(resultLine)
        if (!Array.isArray(result.runnerPids)) result.runnerPids = [result.runnerPids].filter(Number.isSafeInteger)
        resolve(result)
      } catch (error) {
        reject(new Error(`could not parse packaged app close result: ${error.message}; output: ${output.trim()}`))
      }
    })
  })
}

async function findTarget(port, predicate, label) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const target = targets.find(predicate)
      if (target) return target
    } catch {
      // The endpoint is unavailable while Electron or Harness is starting.
    }
    await delay(150)
  }
  throw new Error(`${label} did not appear`)
}

async function readVisiblePage(send) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const result = await send('Runtime.evaluate', {
      expression: "document.body ? JSON.stringify({text: document.body.innerText.trim().slice(0, 500), width: innerWidth, height: innerHeight}) : null",
      returnByValue: true,
    })
    if (typeof result.result?.value === 'string') {
      const state = JSON.parse(result.result.value)
      if (state.text && !state.text.includes('Loading plugins')) return state
    }
    await delay(100)
  }
  throw new Error('Harness Web UI did not finish loading plugins')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function createClient(socket) {
  let nextId = 0
  const pending = new Map()
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString())
    if (!message.id || !pending.has(message.id)) return
    const { method, resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(`${method}: ${message.error.message}`))
    else resolve(message.result)
  })
  socket.on('close', () => {
    for (const { method, reject } of pending.values()) {
      reject(new Error(`${method}: debugger connection closed`))
    }
    pending.clear()
  })
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { method, resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function rpc(url, method, payload = {}) {
  const rpcId = randomUUID()
  const response = await fetch(new URL(`/api/${method}`, url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(5_000),
  })
  const body = await response.json()
  if (!response.ok || body.rpcId !== rpcId || body.result?.ok !== true) {
    throw new Error(`${method} failed: ${JSON.stringify(body)}`)
  }
  return body.result.value
}

async function waitForHarnessStop(url) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(250) })
    } catch {
      return true
    }
    await delay(100)
  }
  return false
}

async function main() {
  const isolation = developmentMode ? null : createIsolatedPackagedApp(sourceExecutable)
  if (isolation) {
    executable = isolation.executable
    applicationDirectory = isolation.applicationDirectory
  }
  let child
  let output = ''
  let pageSocket
  let appExitConfirmed = false
  let exitTask
  try {
    fs.mkdirSync(runRoot, { recursive: true })
    await run(electron, [
      `--user-data-dir=${userData}`,
      path.join(__dirname, 'create-test-config.cjs'),
      userData,
      workspace,
    ])

    const launchArguments = [
      '--disable-gpu',
      `--remote-debugging-port=${rendererPort}`,
      `--user-data-dir=${userData}`,
    ]
    if (developmentMode) launchArguments.push(projectRoot)

    child = spawn(executable, launchArguments, {
      cwd: applicationDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })

    const page = await findTarget(
      rendererPort,
      (target) => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/?/u.test(target.url),
      'Harness Web UI',
    )
    const response = await fetch(page.url, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error(`Harness returned HTTP ${response.status}`)

    const workspaces = await rpc(page.url, 'workspace.list')
    const expectedPath = path.resolve(workspace).toLocaleLowerCase('en-US')
    const registered = workspaces.items.find((item) => path.resolve(item.path).toLocaleLowerCase('en-US') === expectedPath)
    if (!registered) throw new Error('Configured workspace was not registered')

    pageSocket = await connect(page.webSocketDebuggerUrl)
    const sendPage = createClient(pageSocket)
    await sendPage('Page.enable')
    const pageState = await readVisiblePage(sendPage)
    const screenshot = await sendPage('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    })
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))

    pageSocket.terminate()
    pageSocket = null
    const exitObservation = observeChildExit(child, {
      executablePath: executable,
      timeoutMs: 35_000,
    })
    exitTask = exitObservation.result
    void exitTask.catch(() => {})
    await exitObservation.ready
    const closeResult = await closeMainWindow(child.pid)
    if (closeResult.runnerPids.length === 0) {
      throw new Error('Harness runner process was not found before closing the desktop app')
    }

    const exitCode = await exitTask
    appExitConfirmed = true
    if (exitCode !== 0) throw new Error(`packaged app exited with code ${exitCode}`)
    if (!await waitForHarnessStop(page.url)) throw new Error('Harness still responds after the desktop app exits')
    await waitForWindowsProcessesGone(closeResult.runnerPids, executable, 5_000)

    console.log(`harnessUrl=${page.url}`)
    console.log(`httpStatus=${response.status}`)
    console.log(`workspaceId=${registered.workspaceId}`)
    console.log(`visibleTextLength=${pageState.text.length}`)
    console.log(`screenshot=${screenshotPath}`)
    console.log('harnessStopped=true')
  } catch (error) {
    throw new Error(`${error.message}\n${output}`)
  } finally {
    pageSocket?.terminate()
    const stopped = !child || appExitConfirmed || await stopSpawnedChild(child)
    if (isolation && stopped) cleanupIsolatedPackagedApp(isolation)
    else if (isolation) {
      console.error(`packaged smoke isolation preserved because the app did not stop: ${isolation.isolationRoot}`)
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
