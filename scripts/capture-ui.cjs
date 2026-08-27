const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const projectRoot = path.resolve(__dirname, '..')
const outputRoot = path.join(projectRoot, 'test-results', 'ui-capture')
const userData = path.join(outputRoot, `user-data-${Date.now()}`)
const packagedExecutable = process.argv[2] ? path.resolve(process.argv[2]) : null
const executable = packagedExecutable || require('electron')
const capturePrefix = packagedExecutable ? 'packaged-' : ''
const port = 19_000 + Math.floor(Math.random() * 1_000)
const mainPort = port + 1

fs.mkdirSync(outputRoot, { recursive: true })

const launchArguments = [
  '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--inspect=127.0.0.1:${mainPort}`,
  `--user-data-dir=${userData}`,
]
if (!packagedExecutable) launchArguments.push('--no-sandbox', projectRoot)

const child = spawn(executable, launchArguments, {
  cwd: projectRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let processOutput = ''
child.stdout.on('data', (chunk) => { processOutput += chunk })
child.stderr.on('data', (chunk) => { processOutput += chunk })

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function findTarget(debugPort, predicate, label) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      const targets = await response.json()
      const target = targets.find(predicate)
      if (target) return target
    } catch {
      // Electron may not have opened its debugging endpoint yet.
    }
    await delay(100)
  }
  throw new Error(`${label} did not appear. Output:\n${processOutput}`)
}

async function connect(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl)
    socket.addEventListener('open', () => resolve(socket), { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
}

function createClient(socket) {
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const { method, resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(`${method}: ${message.error.message}`))
    else resolve(message.result)
  })
  socket.addEventListener('close', () => {
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

async function waitForSetup(send) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const result = await send('Runtime.evaluate', {
      expression: "document.querySelector('#setupScreen')?.hidden === false",
      returnByValue: true,
    })
    if (result.result?.value === true) return
    await delay(100)
  }
  throw new Error('Setup screen did not become visible')
}

async function capture(send, width, height, filename, options = {}) {
  const deviceScaleFactor = options.deviceScaleFactor ?? 1
  const forcedColors = options.forcedColors === true
  await send('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [{ name: 'forced-colors', value: forcedColors ? 'active' : 'none' }],
  })
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    screenWidth: width,
    screenHeight: height,
    deviceScaleFactor,
    mobile: false,
  })
  await delay(400)
  const screenshot = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  })
  const image = Buffer.from(screenshot.data, 'base64')
  const imageWidth = image.readUInt32BE(16)
  const imageHeight = image.readUInt32BE(20)
  if (imageWidth !== width * deviceScaleFactor || imageHeight !== height * deviceScaleFactor) {
    throw new Error(
      `${filename} pixel size mismatch: ${imageWidth}x${imageHeight}, expected ${width * deviceScaleFactor}x${height * deviceScaleFactor}`,
    )
  }
  if (image.length < 4_096) {
    throw new Error(`${filename} screenshot is unexpectedly small and may be blank: ${image.length} bytes`)
  }
  fs.writeFileSync(path.join(outputRoot, filename), image)
  const result = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      innerWidth,
      innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      title: document.title,
      visibleScreen: [...document.querySelectorAll('.screen')].find((node) => !node.hidden)?.id,
      activeSection: document.querySelector('[data-section-panel]:not([hidden])')?.dataset.sectionPanel,
      contentWidth: document.querySelector('.settings-content')?.clientWidth,
      contentScrollWidth: document.querySelector('.settings-content')?.scrollWidth,
      theme: document.documentElement.dataset.theme,
      forcedColors: matchMedia('(forced-colors: active)').matches,
      navigationOrientation: document.querySelector('.section-nav')?.getAttribute('aria-orientation'),
      activeTabVisible: Boolean(document.querySelector('.section-nav-item.active')?.getClientRects().length),
      activePanelVisible: Boolean(document.querySelector('[data-section-panel]:not([hidden])')?.getClientRects().length),
      nextButtonVisible: Boolean(document.querySelector('#nextButton:not([hidden])')?.getClientRects().length),
    })`,
    returnByValue: true,
  })
  const state = JSON.parse(result.result.value)
  if (state.scrollWidth > state.innerWidth
    || (state.contentWidth && state.contentScrollWidth > state.contentWidth)) {
    throw new Error(`${filename} has horizontal overflow: ${JSON.stringify(state)}`)
  }
  if (state.forcedColors !== forcedColors) {
    throw new Error(`${filename} forced-colors emulation did not apply`)
  }
  if (!state.activePanelVisible) throw new Error(`${filename} has no visible active settings panel`)
  return { ...state, imageWidth, imageHeight, deviceScaleFactor }
}

async function click(send, selector) {
  const result = await send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})?.click(); true`,
    returnByValue: true,
  })
  if (result.result?.value !== true) throw new Error(`Could not click ${selector}`)
  await delay(500)
}

async function navigateToSettings(send, currentUrl, section) {
  const url = new URL(currentUrl)
  url.search = new URLSearchParams({ mode: 'settings', section }).toString()
  await send('Page.navigate', { url: url.href })
  await waitForSetup(send)
  await delay(500)
}

async function main() {
  const page = await findTarget(
    port,
    (target) => target.type === 'page' && target.url.includes('/src/ui/index.html'),
    'Electron UI',
  )
  const socket = await connect(page.webSocketDebuggerUrl)
  const send = createClient(socket)
  await send('Page.enable')
  await send('Runtime.enable')
  await waitForSetup(send)

  const standard = await capture(send, 1280, 820, `${capturePrefix}setup-1280x820.png`)
  const minimum = await capture(send, 960, 650, `${capturePrefix}setup-960x650.png`)
  const compact = await capture(send, 820, 720, `${capturePrefix}setup-820x720.png`)
  const narrow = await capture(send, 360, 720, `${capturePrefix}setup-360x720@2x.png`, {
    deviceScaleFactor: 2,
  })
  const highContrast = await capture(
    send,
    960,
    650,
    `${capturePrefix}setup-high-contrast-960x650.png`,
    { forcedColors: true },
  )
  for (const [label, result] of Object.entries({ standard, minimum, compact, narrow, highContrast })) {
    if (!result.activeTabVisible) throw new Error(`${label} has no visible active navigation tab`)
    if (!result.nextButtonVisible) throw new Error(`${label} has no visible next-step control`)
  }
  if (standard.navigationOrientation !== 'vertical') {
    throw new Error(`desktop navigation orientation is not vertical: ${standard.navigationOrientation}`)
  }
  if (narrow.navigationOrientation !== 'horizontal') {
    throw new Error(`compact navigation orientation is not horizontal: ${narrow.navigationOrientation}`)
  }
  await navigateToSettings(send, page.url, 'plugins')
  const plugins = await capture(send, 960, 650, `${capturePrefix}plugins-960x650.png`)
  await click(send, '[data-section="appearance"]')
  await click(send, '[data-theme-value="light"]')
  const light = await capture(send, 960, 650, `${capturePrefix}appearance-light-960x650.png`)
  await click(send, '[data-theme-value="dark"]')
  const dark = await capture(send, 960, 650, `${capturePrefix}appearance-dark-960x650.png`)
  for (const [label, result] of Object.entries({ plugins, light, dark })) {
    if (!result.activeTabVisible) throw new Error(`${label} has no visible active settings tab`)
  }
  console.log(`standard=${JSON.stringify(standard)}`)
  console.log(`minimum=${JSON.stringify(minimum)}`)
  console.log(`compact=${JSON.stringify(compact)}`)
  console.log(`narrow=${JSON.stringify(narrow)}`)
  console.log(`highContrast=${JSON.stringify(highContrast)}`)
  console.log(`plugins=${JSON.stringify(plugins)}`)
  console.log(`light=${JSON.stringify(light)}`)
  console.log(`dark=${JSON.stringify(dark)}`)

  const mainTarget = await findTarget(
    mainPort,
    (target) => target.type === 'node' || target.url.includes('main.cjs'),
    'Electron main process inspector',
  )
  const mainSocket = await connect(mainTarget.webSocketDebuggerUrl)
  const sendMain = createClient(mainSocket)
  await sendMain('Runtime.evaluate', {
    expression: "setTimeout(() => require('electron').app.quit(), 500); 'scheduled'",
  })
  socket.terminate()
  mainSocket.terminate()
}

main().catch((error) => {
  console.error(`${error.stack || error.message}\n${processOutput}`)
  process.exitCode = 1
}).finally(async () => {
  const deadline = Date.now() + 10_000
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100)
  if (child.exitCode === null && child.signalCode === null) child.kill()
})
