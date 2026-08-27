const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..')
const configPath = path.join(projectRoot, 'scripts', 'electron-builder.config.cjs')
const manifestPath = path.join(projectRoot, 'package.json')
const manifest = require(manifestPath)

function loadConfig(electronCache, existingDownloadOptions, electronDist) {
  const previousCache = process.env.ELECTRON_CACHE
  const previousDist = process.env.DSH_ELECTRON_DIST
  const previousDownloadOptions = manifest.build.electronDownload
  try {
    if (electronCache === undefined) delete process.env.ELECTRON_CACHE
    else process.env.ELECTRON_CACHE = electronCache
    if (electronDist === undefined) delete process.env.DSH_ELECTRON_DIST
    else process.env.DSH_ELECTRON_DIST = electronDist
    if (existingDownloadOptions === undefined) delete manifest.build.electronDownload
    else manifest.build.electronDownload = existingDownloadOptions
    delete require.cache[require.resolve(configPath)]
    return require(configPath)
  } finally {
    if (previousCache === undefined) delete process.env.ELECTRON_CACHE
    else process.env.ELECTRON_CACHE = previousCache
    if (previousDist === undefined) delete process.env.DSH_ELECTRON_DIST
    else process.env.DSH_ELECTRON_DIST = previousDist
    if (previousDownloadOptions === undefined) delete manifest.build.electronDownload
    else manifest.build.electronDownload = previousDownloadOptions
    delete require.cache[require.resolve(configPath)]
  }
}

test('builder config leaves electron downloads unchanged without a non-empty cache setting', () => {
  const existing = { mirror: 'https://example.invalid/electron/' }
  assert.deepEqual(loadConfig(undefined, existing).electronDownload, existing)
  assert.deepEqual(loadConfig('   ', existing).electronDownload, existing)
  assert.equal(loadConfig(undefined, existing).electronDist, undefined)
  assert.equal(loadConfig(undefined, existing, '   ').electronDist, undefined)
})

test('builder config resolves ELECTRON_CACHE and preserves other download options', () => {
  const existing = { mirror: 'https://example.invalid/electron/' }
  const config = loadConfig('  .cache/electron  ', existing)

  assert.deepEqual(config.electronDownload, {
    mirror: existing.mirror,
    cache: path.resolve(projectRoot, '.cache/electron'),
  })
  assert.equal(path.isAbsolute(config.electronDownload.cache), true)
})

test('builder config resolves DSH_ELECTRON_DIST only when explicitly set', () => {
  const relativeConfig = loadConfig(undefined, undefined, '  .cache/electron-dist  ')
  const absoluteDist = path.resolve(projectRoot, '.cache/prepared-electron')
  const absoluteConfig = loadConfig(undefined, undefined, absoluteDist)

  assert.equal(relativeConfig.electronDist, path.resolve(projectRoot, '.cache/electron-dist'))
  assert.equal(path.isAbsolute(relativeConfig.electronDist), true)
  assert.equal(absoluteConfig.electronDist, absoluteDist)
})

test('builder disables broad native auto-unpacking in favor of the audited closure', () => {
  const config = loadConfig()

  assert.deepEqual(config.asar, { smartUnpack: false })
  assert.ok(config.asarUnpack.includes('node_modules/@deepseek-ai/dsh/**/*'))
  assert.ok(config.asarUnpack.includes('!node_modules/**/*.map'))
  assert.ok(config.asarUnpack.includes('!node_modules/**/*.d.ts'))
})
