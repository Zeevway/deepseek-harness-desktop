'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const manifest = require('../package.json')
const {
  buildProductionSbom,
  collectProductionInventory,
} = require('./release-inventory.cjs')

const projectRoot = path.resolve(__dirname, '..')
const releaseRoot = path.join(projectRoot, 'release')
const npmCli = process.env.npm_execpath
  || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
function electronExtra() {
  const directory = path.join(projectRoot, 'node_modules', 'electron')
  return {
    directory,
    relativeDirectory: 'node_modules/electron',
    manifest: require('../node_modules/electron/package.json'),
    componentType: 'framework',
    direct: true,
  }
}

function generateSbom() {
  const result = spawnSync(
    process.execPath,
    [npmCli, 'sbom', '--omit=dev', '--sbom-format=cyclonedx'],
    { cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (result.status !== 0) {
    throw new Error(`npm sbom failed: ${result.stderr || result.stdout}`)
  }

  const inventory = collectProductionInventory(projectRoot, manifest, [electronExtra()])
  const sbom = buildProductionSbom(JSON.parse(result.stdout), inventory)
  const output = path.join(
    releaseRoot,
    `deepseek-harness-desktop-${manifest.version}.sbom.cdx.json`,
  )
  fs.mkdirSync(releaseRoot, { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`)
  console.log(
    `SBOM written: ${path.basename(output)} `
      + `(${inventory.packages.length} unique production packages, `
      + `${inventory.occurrenceCount} installed occurrences)`,
  )
  return { inventory, output, sbom }
}

if (require.main === module) generateSbom()

module.exports = { generateSbom }
