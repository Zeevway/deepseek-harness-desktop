'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const yaml = require('js-yaml')
const manifest = require('../package.json')

const projectRoot = path.resolve(__dirname, '..')
const releaseRoot = path.join(projectRoot, 'release')
const ignoredNames = new Set([
  'builder-debug.yml',
  'builder-effective-config.yaml',
  'release-manifest.json',
  'SHA256SUMS.txt',
])

function digest(filePath, algorithm, encoding) {
  const hash = crypto.createHash(algorithm)
  hash.update(fs.readFileSync(filePath))
  return hash.digest(encoding)
}

function sha256(filePath) {
  return digest(filePath, 'sha256', 'hex')
}

function sha512(filePath) {
  return digest(filePath, 'sha512', 'base64')
}

function inferArchitecture(name) {
  if (/(?:^|[-.])arm64(?:[-.]|$)/iu.test(name)) return 'arm64'
  if (/(?:^|[-.])x64(?:[-.]|$)/iu.test(name)) return 'x64'
  return null
}

function validateExternalBlockmap(installerPath, blockmapPath, metadataName) {
  const compressed = fs.readFileSync(blockmapPath)
  if (compressed.length === 0) {
    throw new Error(`${metadataName} is empty`)
  }
  let blockmap
  try {
    const decompressed = compressed[0] === 0x1f && compressed[1] === 0x8b
      ? zlib.gunzipSync(compressed)
      : zlib.inflateRawSync(compressed)
    blockmap = JSON.parse(decompressed.toString('utf8'))
  } catch (error) {
    throw new Error(`${metadataName} is not a valid external blockmap: ${error.message}`)
  }
  if (blockmap?.version !== '2'
    || !Array.isArray(blockmap.files)
    || blockmap.files.length !== 1) {
    throw new Error(`${metadataName} has an unsupported blockmap schema`)
  }
  const [file] = blockmap.files
  if (file?.name !== 'file'
    || file.offset !== 0
    || !Array.isArray(file.sizes)
    || !Array.isArray(file.checksums)
    || file.sizes.length === 0
    || file.sizes.length !== file.checksums.length) {
    throw new Error(`${metadataName} does not describe one complete installer`)
  }
  let describedSize = 0
  for (let index = 0; index < file.sizes.length; index += 1) {
    const size = file.sizes[index]
    const checksum = file.checksums[index]
    if (!Number.isSafeInteger(size)
      || size <= 0
      || typeof checksum !== 'string'
      || !/^[A-Za-z0-9+/]{24}$/u.test(checksum)) {
      throw new Error(`${metadataName} contains an invalid block entry`)
    }
    describedSize += size
    if (!Number.isSafeInteger(describedSize)) {
      throw new Error(`${metadataName} describes an unsafe installer size`)
    }
  }
  if (describedSize !== fs.statSync(installerPath).size) {
    throw new Error(`${metadataName} does not correspond to its installer size`)
  }
  return compressed.length
}

const expectedArgument = process.argv.find((argument) => argument.startsWith('--expected='))
const expectedValue = expectedArgument?.slice('--expected='.length)
if (expectedValue && !['x64', 'arm64'].includes(expectedValue)) {
  throw new Error(`unsupported expected architecture: ${expectedValue}`)
}
const expectedArchitectures = expectedValue ? [expectedValue] : ['x64', 'arm64']
const prerelease = require('semver').prerelease(manifest.version)
if (prerelease && prerelease[0] !== 'preview') {
  throw new Error('prerelease desktop versions must use the -preview.N identifier')
}
const updateChannel = prerelease ? 'preview' : 'latest'
const updateMetadataName = `${updateChannel}.yml`

function validatedSourceMetadata(environment = process.env) {
  const repository = environment.GITHUB_REPOSITORY?.trim() || null
  const revision = environment.GITHUB_SHA?.trim() || null
  const ref = environment.GITHUB_REF?.trim() || null
  if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error('GITHUB_REPOSITORY is not a valid owner/repository pair')
  }
  if (revision && !/^[a-f0-9]{40}$/iu.test(revision)) {
    throw new Error('GITHUB_SHA is not a 40-character commit id')
  }
  if (ref && (ref.length > 512 || /[\u0000-\u001f\u007f]/u.test(ref))) {
    throw new Error('GITHUB_REF contains invalid characters')
  }
  return { repository, revision, ref }
}

const artifacts = fs.readdirSync(releaseRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && !ignoredNames.has(entry.name))
  .map((entry) => {
    const filePath = path.join(releaseRoot, entry.name)
    const stat = fs.statSync(filePath)
    return {
      name: entry.name,
      architecture: inferArchitecture(entry.name),
      size: stat.size,
      sha256: sha256(filePath),
    }
  })
  .sort((left, right) => left.name.localeCompare(right.name, 'en'))

const expectedInstallers = expectedArchitectures.map(
  (architecture) => `DeepSeek-Harness-Desktop-Setup-${manifest.version}-${architecture}.exe`,
)
const expectedBlockmaps = expectedInstallers.map((installer) => `${installer}.blockmap`)
for (const installer of expectedInstallers) {
  if (!artifacts.some(({ name }) => name === installer)) {
    throw new Error(`release installer is missing: ${installer}`)
  }
  if (!artifacts.some(({ name }) => name === `${installer}.blockmap`)) {
    throw new Error(`release blockmap is missing: ${installer}.blockmap`)
  }
  validateExternalBlockmap(
    path.join(releaseRoot, installer),
    path.join(releaseRoot, `${installer}.blockmap`),
    `${installer}.blockmap`,
  )
}
const unexpectedInstallers = artifacts
  .filter(({ name }) => /\.exe$/iu.test(name))
  .filter(({ name }) => !expectedInstallers.includes(name))
if (unexpectedInstallers.length > 0) {
  throw new Error(`unexpected installers in clean release directory: ${unexpectedInstallers.map(({ name }) => name).join(', ')}`)
}
const unexpectedBlockmaps = artifacts
  .filter(({ name }) => /\.exe\.blockmap$/iu.test(name))
  .filter(({ name }) => !expectedBlockmaps.includes(name))
if (unexpectedBlockmaps.length > 0) {
  throw new Error(`unexpected blockmaps in clean release directory: ${unexpectedBlockmaps.map(({ name }) => name).join(', ')}`)
}

const updateMetadataPath = path.join(releaseRoot, updateMetadataName)
let updateMetadata = null
if (fs.existsSync(updateMetadataPath)) {
  updateMetadata = yaml.load(fs.readFileSync(updateMetadataPath, 'utf8'))
  if (updateMetadata?.version !== manifest.version || !Array.isArray(updateMetadata.files)) {
    throw new Error(`${updateMetadataName} has an invalid version or file list`)
  }
  if (updateMetadata.files.length !== expectedInstallers.length) {
    throw new Error(`${updateMetadataName} files must exactly match the expected installers`)
  }
  for (const entry of updateMetadata.files) {
    if (!entry
      || typeof entry !== 'object'
      || typeof entry.url !== 'string'
      || entry.url.includes('/')
      || entry.url.includes('\\')
      || entry.url.includes('?')
      || entry.url.includes('#')
      || !expectedInstallers.includes(entry.url)) {
      throw new Error(`${updateMetadataName} contains a non-canonical installer URL`)
    }
  }
  for (const installer of expectedInstallers) {
    const matches = updateMetadata.files.filter((entry) => entry?.url === installer)
    if (matches.length !== 1) {
      throw new Error(`${updateMetadataName} must reference expected installer exactly once: ${installer}`)
    }
    const entry = matches[0]
    const installerPath = path.join(releaseRoot, installer)
    const installerSize = fs.statSync(installerPath).size
    const installerSha512 = sha512(installerPath)
    if (!Number.isSafeInteger(entry.size) || entry.size !== installerSize) {
      throw new Error(`${updateMetadataName} size does not match installer: ${installer}`)
    }
    if (typeof entry.sha512 !== 'string'
      || !/^[A-Za-z0-9+/]{86}==$/u.test(entry.sha512)
      || entry.sha512 !== installerSha512) {
      throw new Error(`${updateMetadataName} sha512 does not match installer: ${installer}`)
    }
    if (Object.hasOwn(entry, 'blockMapSize')) {
      const blockmapSize = validateExternalBlockmap(
        installerPath,
        `${installerPath}.blockmap`,
        `${installer}.blockmap`,
      )
      if (!Number.isSafeInteger(entry.blockMapSize) || entry.blockMapSize !== blockmapSize) {
        throw new Error(`${updateMetadataName} blockMapSize does not match installer: ${installer}`)
      }
    }
  }
  if (typeof updateMetadata.path !== 'string'
    || typeof updateMetadata.sha512 !== 'string'
    || typeof updateMetadata.releaseDate !== 'string'
    || !Number.isFinite(Date.parse(updateMetadata.releaseDate))) {
    throw new Error(`${updateMetadataName} requires valid top-level path, sha512, and releaseDate fields`)
  }
  if (updateMetadata.path.includes('/')
    || updateMetadata.path.includes('\\')
    || updateMetadata.path.includes('?')
    || updateMetadata.path.includes('#')
    || !expectedInstallers.includes(updateMetadata.path)) {
    throw new Error(`${updateMetadataName} top-level path is not a canonical expected installer`)
  }
  const matchingEntry = updateMetadata.files.find(({ url }) => url === updateMetadata.path)
  const actualSha512 = sha512(path.join(releaseRoot, updateMetadata.path))
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(updateMetadata.sha512)
    || updateMetadata.sha512 !== matchingEntry.sha512
    || updateMetadata.sha512 !== actualSha512) {
    throw new Error(`${updateMetadataName} top-level sha512 does not match its installer`)
  }
} else if (process.env.DSH_DESKTOP_REQUIRE_UPDATE_CONFIG === '1') {
  throw new Error(`${updateMetadataName} is required for an update-enabled release`)
}

function validateUpdateFeed(architecture) {
  const filename = path.join(
    releaseRoot,
    architecture === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked',
    'resources',
    'app-update.yml',
  )
  if (!fs.existsSync(filename)) return null
  const feed = yaml.load(fs.readFileSync(filename, 'utf8'))
  if (!feed || typeof feed !== 'object' || !['generic', 'github'].includes(feed.provider)) {
    throw new Error(`invalid packaged update provider for ${architecture}`)
  }
  if (feed.channel !== updateChannel) {
    throw new Error(`packaged update channel mismatch for ${architecture}: ${feed.channel}`)
  }
  if (feed.provider === 'generic') {
    const url = new URL(feed.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error(`packaged generic update URL is not safe for ${architecture}`)
    }
  } else if (!/^[A-Za-z0-9_.-]+$/u.test(feed.owner)
    || !/^[A-Za-z0-9_.-]+$/u.test(feed.repo)) {
    throw new Error(`packaged GitHub update repository is invalid for ${architecture}`)
  }
  return feed
}

const updateFeeds = expectedArchitectures
  .map((architecture) => [architecture, validateUpdateFeed(architecture)])
const updateFeedArchitectures = updateFeeds.filter(([, feed]) => feed).map(([architecture]) => architecture)
if (process.env.DSH_DESKTOP_REQUIRE_UPDATE_CONFIG === '1'
  && updateFeedArchitectures.length !== expectedArchitectures.length) {
  throw new Error(`packaged update feed is missing for: ${expectedArchitectures.filter((value) => !updateFeedArchitectures.includes(value)).join(', ')}`)
}
const comparableFeeds = updateFeeds
  .filter(([, feed]) => feed)
  .map(([, feed]) => JSON.stringify({
    provider: feed.provider,
    url: feed.url,
    owner: feed.owner,
    repo: feed.repo,
    channel: feed.channel,
  }))
if (new Set(comparableFeeds).size > 1) {
  throw new Error('x64 and arm64 packaged update feeds do not match')
}

const releaseManifest = {
  schemaVersion: 1,
  product: manifest.name,
  desktopVersion: manifest.version,
  harnessPackage: '@deepseek-ai/dsh',
  harnessVersion: manifest.dependencies['@deepseek-ai/dsh'],
  generatedAt: new Date().toISOString(),
  source: validatedSourceMetadata(),
  signing: {
    authenticode: false,
    policy: 'unsigned-by-user-request',
  },
  updateFormat: 'electron-builder-nsis',
  updates: {
    configured: updateFeedArchitectures.length === expectedArchitectures.length,
    architectures: updateFeedArchitectures,
    channel: updateChannel,
    metadata: updateMetadata ? updateMetadataName : null,
  },
  artifacts,
}

fs.writeFileSync(
  path.join(releaseRoot, 'release-manifest.json'),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
)
fs.writeFileSync(
  path.join(releaseRoot, 'SHA256SUMS.txt'),
  `${artifacts.map(({ sha256: digest, name }) => `${digest}  ${name}`).join('\n')}\n`,
)
console.log(`release metadata written: ${artifacts.length} artifacts`)
