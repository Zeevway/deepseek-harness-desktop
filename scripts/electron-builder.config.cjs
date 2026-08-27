'use strict'

const path = require('node:path')
const semver = require('semver')
const manifest = require('../package.json')
const { unpackPatterns } = require('./package-closure.cjs')

const projectRoot = path.resolve(__dirname, '..')
const config = {
  ...manifest.build,
  asar: { smartUnpack: false },
  asarUnpack: unpackPatterns(projectRoot),
}
const electronCache = process.env.ELECTRON_CACHE?.trim()
if (electronCache) {
  config.electronDownload = {
    ...(config.electronDownload ?? {}),
    cache: path.resolve(projectRoot, electronCache),
  }
}
const electronDist = process.env.DSH_ELECTRON_DIST?.trim()
if (electronDist) {
  config.electronDist = path.resolve(projectRoot, electronDist)
}

const prerelease = semver.prerelease(manifest.version)
if (prerelease && prerelease[0] !== 'preview') {
  throw new Error('prerelease desktop versions must use the -preview.N identifier')
}
const updateChannel = prerelease ? 'preview' : 'latest'
const genericUpdateUrl = process.env.DSH_DESKTOP_UPDATE_URL?.trim()
const repository = process.env.GITHUB_REPOSITORY?.trim()

if (genericUpdateUrl) {
  const parsed = new URL(genericUpdateUrl)
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw new Error('DSH_DESKTOP_UPDATE_URL must be an absolute HTTPS URL without credentials, query, or fragment')
  }
  config.publish = [{
    provider: 'generic',
    url: parsed.href.replace(/\/$/u, ''),
    channel: updateChannel,
  }]
} else if (repository?.includes('/')) {
  const [owner, repo] = repository.split('/', 2)
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repo)) {
    throw new Error('GITHUB_REPOSITORY must contain one valid owner/repository pair')
  }
  config.publish = [{ provider: 'github', owner, repo, releaseType: 'release', channel: updateChannel }]
} else if (process.env.DSH_DESKTOP_REQUIRE_UPDATE_CONFIG === '1') {
  throw new Error('an HTTPS update URL or GITHUB_REPOSITORY is required for release builds')
}

module.exports = config
