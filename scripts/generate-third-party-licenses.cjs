'use strict'

const fs = require('node:fs')
const path = require('node:path')
const manifest = require('../package.json')
const {
  buildLicenseInventory,
  collectProductionInventory,
  formatThirdPartyNotices,
} = require('./release-inventory.cjs')

const projectRoot = path.resolve(__dirname, '..')
const releaseRoot = path.join(projectRoot, 'release')
const electronDistribution = path.join(projectRoot, 'node_modules', 'electron', 'dist')

function electronExtra() {
  return {
    directory: path.join(projectRoot, 'node_modules', 'electron'),
    relativeDirectory: 'node_modules/electron',
    manifest: require('../node_modules/electron/package.json'),
    componentType: 'framework',
    direct: true,
    additionalLicenseFiles: [path.join(electronDistribution, 'LICENSE')],
  }
}

function generateThirdPartyLicenses() {
  const inventory = collectProductionInventory(projectRoot, manifest, [electronExtra()])
  const licenses = buildLicenseInventory(inventory)

  fs.mkdirSync(releaseRoot, { recursive: true })
  const projectLicense = path.join(projectRoot, 'LICENSE')
  if (!fs.existsSync(projectLicense)) throw new Error('project LICENSE is missing')
  fs.copyFileSync(projectLicense, path.join(releaseRoot, 'LICENSE'))
  fs.writeFileSync(
    path.join(releaseRoot, 'THIRD-PARTY-LICENSES.json'),
    `${JSON.stringify({
      schemaVersion: licenses.schemaVersion,
      packages: licenses.packages,
      notices: licenses.notices.map(({ content, ...notice }) => notice),
    }, null, 2)}\n`,
  )
  fs.writeFileSync(
    path.join(releaseRoot, 'THIRD-PARTY-LICENSES.txt'),
    formatThirdPartyNotices(licenses),
  )
  for (const [sourceName, outputName] of [
    ['LICENSE', 'ELECTRON-LICENSE.txt'],
    ['LICENSES.chromium.html', 'ELECTRON-CHROMIUM-LICENSES.html'],
  ]) {
    const source = path.join(electronDistribution, sourceName)
    if (!fs.existsSync(source)) {
      throw new Error(`Electron distribution license is missing: ${sourceName}`)
    }
    fs.copyFileSync(source, path.join(releaseRoot, outputName))
  }
  const declaredOnly = licenses.packages.filter(({ licenseTextStatus }) => (
    licenseTextStatus === 'declared-only'
  )).length
  console.log(
    `third-party license inventory: ${licenses.packages.length} unique packages, `
      + `${licenses.notices.length} deduplicated texts, ${declaredOnly} declared-only`,
  )
  return { inventory, licenses }
}

if (require.main === module) generateThirdPartyLicenses()

module.exports = { generateThirdPartyLicenses }
