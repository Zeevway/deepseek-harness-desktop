'use strict'

const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const semver = require('semver')
const tar = require('tar')
const { collectPackageClosure } = require('./package-closure.cjs')

const projectRoot = path.resolve(__dirname, '..')
const targetArchitecture = process.argv[2]
const supportedArchitectures = new Set(['x64', 'arm64'])

if (!supportedArchitectures.has(targetArchitecture)) {
  throw new Error('usage: node scripts/ensure-target-runtime.cjs <x64|arm64>')
}

const lock = require('../package-lock.json')
const hostClosure = collectPackageClosure(projectRoot, ['@deepseek-ai/dsh'])
if (hostClosure.missing.length || hostClosure.incompatible.length) {
  throw new Error(`cannot resolve Harness runtime closure: ${JSON.stringify({
    missing: hostClosure.missing,
    incompatible: hostClosure.incompatible,
  })}`)
}

const requiredNativePackageNames = (architecture) => new Set([
  `@img/sharp-win32-${architecture}`,
  `@koromix/koffi-win32-${architecture}`,
  `@vscode/ripgrep-win32-${architecture}`,
  `node-addon-require-builtin-win32-${architecture}-msvc`,
])

function lockPackagePath(packageName, fromRelativeDirectory) {
  let cursor = fromRelativeDirectory.split('\\').join('/')
  while (true) {
    const candidate = path.posix.join(cursor, 'node_modules', packageName)
    if (lock.packages?.[candidate]) return candidate
    if (!cursor) return null
    const parent = path.posix.dirname(cursor)
    cursor = parent === '.' || parent === cursor ? '' : parent
  }
}

function architecturePackagesFromLock(architecture) {
  const discovered = new Map()

  for (const parent of hostClosure.packages) {
    const lockedParent = lock.packages?.[parent.relativeDirectory]
    if (!lockedParent?.version) {
      throw new Error(`package-lock is missing reachable package: ${parent.relativeDirectory}`)
    }

    for (const [name, range] of Object.entries(lockedParent.optionalDependencies ?? {})) {
      const relativeDirectory = lockPackagePath(name, parent.relativeDirectory)
      if (!relativeDirectory) continue
      const lockEntry = lock.packages[relativeDirectory]
      if (!lockEntry?.os?.includes('win32') || !lockEntry.cpu?.includes(architecture)) continue
      if (!semver.satisfies(lockEntry.version, range, { includePrerelease: true })) {
        throw new Error(`${relativeDirectory}@${lockEntry.version} does not satisfy ${range}`)
      }
      if (typeof lockEntry.resolved !== 'string' || typeof lockEntry.integrity !== 'string') {
        throw new Error(`package-lock does not contain a complete target runtime package: ${name}`)
      }
      discovered.set(relativeDirectory, { name, relativeDirectory, ...lockEntry })
    }
  }

  const discoveredNames = new Set([...discovered.values()].map(({ name }) => name))
  const missingRequired = [...requiredNativePackageNames(architecture)]
    .filter((name) => !discoveredNames.has(name))
  if (missingRequired.length > 0) {
    throw new Error(`package-lock is missing required ${architecture} native runtime packages: ${missingRequired.join(', ')}`)
  }
  return [...discovered.values()].sort((left, right) => (
    left.relativeDirectory.localeCompare(right.relativeDirectory, 'en')
  ))
}

const x64Packages = architecturePackagesFromLock('x64')
const arm64Packages = architecturePackagesFromLock('arm64')
const normalizedNames = (entries, architecture) => entries
  .map(({ name }) => name.replace(architecture, '{arch}'))
  .sort((left, right) => left.localeCompare(right, 'en'))
if (JSON.stringify(normalizedNames(x64Packages, 'x64'))
  !== JSON.stringify(normalizedNames(arm64Packages, 'arm64'))) {
  throw new Error('x64 and arm64 native runtime package sets are not symmetric in package-lock.json')
}

const architecturePackages = targetArchitecture === 'arm64' ? arm64Packages : x64Packages

function installedManifest(entry) {
  const manifestPath = path.join(projectRoot, ...entry.relativeDirectory.split('/'), 'package.json')
  if (!fs.existsSync(manifestPath)) return null
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

function verifyIntegrity(file, integrity) {
  const separator = integrity.indexOf('-')
  const algorithm = integrity.slice(0, separator)
  const expected = integrity.slice(separator + 1)
  if (!algorithm || !expected || !crypto.getHashes().includes(algorithm)) {
    throw new Error(`unsupported package integrity: ${integrity}`)
  }
  const actual = crypto.createHash(algorithm).update(fs.readFileSync(file)).digest('base64')
  if (actual !== expected) throw new Error(`integrity mismatch for ${path.basename(file)}`)
}

function downloadAndExtract(entry) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-runtime-${targetArchitecture}-`))
  try {
    const npmCli = process.env.npm_execpath
      || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const packed = spawnSync(process.execPath, [
      npmCli,
      'pack',
      `${entry.name}@${entry.version}`,
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      temporaryRoot,
      '--cache',
      path.join(projectRoot, '.cache', 'npm'),
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
    if (packed.status !== 0) {
      const detail = packed.error?.message || packed.stderr || packed.stdout || `exit status ${packed.status}`
      throw new Error(`npm pack failed for ${entry.name}@${entry.version}: ${detail}`)
    }
    const report = JSON.parse(packed.stdout)
    const filename = report[0]?.filename
    if (!filename) throw new Error(`npm pack returned no archive for ${entry.name}@${entry.version}`)
    const archive = path.join(temporaryRoot, filename)
    verifyIntegrity(archive, entry.integrity)

    const extraction = path.join(temporaryRoot, 'extract')
    fs.mkdirSync(extraction)
    try {
      tar.x({
        cwd: extraction,
        file: archive,
        filter: (entryPath) => entryPath === 'package' || entryPath.startsWith('package/'),
        preservePaths: false,
        strict: true,
        sync: true,
      })
    } catch (error) {
      throw new Error(`could not extract ${entry.name}@${entry.version}: ${error.message}`, { cause: error })
    }

    const source = path.join(extraction, 'package')
    const destination = path.join(projectRoot, ...entry.relativeDirectory.split('/'))
    const nodeModulesRoot = `${path.join(projectRoot, 'node_modules')}${path.sep}`
    if (!destination.startsWith(nodeModulesRoot) || !fs.existsSync(path.join(source, 'package.json'))) {
      throw new Error(`invalid extraction target for ${entry.name}`)
    }
    fs.rmSync(destination, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.cpSync(source, destination, { recursive: true, errorOnExist: true })
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

for (const entry of architecturePackages) {
  const installed = installedManifest(entry)
  if (installed?.version === entry.version && installed.cpu?.includes(targetArchitecture)) continue
  downloadAndExtract(entry)
}

for (const entry of architecturePackages) {
  const installed = installedManifest(entry)
  if (installed?.name !== entry.name
    || installed.version !== entry.version
    || !installed.cpu?.includes(targetArchitecture)) {
    throw new Error(`invalid target runtime package: ${entry.name}@${installed?.version ?? 'missing'}`)
  }
}

console.log(`target runtime ready: ${targetArchitecture}, ${architecturePackages.length} native packages`)
