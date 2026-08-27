'use strict'

const path = require('node:path')
const manifest = require('../package.json')
const lock = require('../package-lock.json')
const { collectPackageClosure, unpackPatterns } = require('./package-closure.cjs')

const projectRoot = path.resolve(__dirname, '..')
const closure = collectPackageClosure(projectRoot, Object.keys(manifest.dependencies))

if (closure.missing.length || closure.incompatible.length) {
  throw new Error(JSON.stringify({
    missing: closure.missing.map(({ name, from }) => ({ name, from: path.relative(projectRoot, from) })),
    incompatible: closure.incompatible.map(({ name, version, range, from }) => ({
      name,
      version,
      range,
      from: path.relative(projectRoot, from),
    })),
  }, null, 2))
}

const lockDrift = closure.packages.flatMap((entry) => {
  const locked = lock.packages?.[entry.relativeDirectory]
  if (!locked?.version) return [`${entry.relativeDirectory}: missing from package-lock.json`]
  if (locked.version !== entry.manifest.version) {
    return [`${entry.relativeDirectory}: installed ${entry.manifest.version}, locked ${locked.version}`]
  }
  return []
})
if (lockDrift.length > 0) {
  throw new Error(`production dependency tree differs from package-lock.json:\n${lockDrift.join('\n')}`)
}

const unpack = unpackPatterns(projectRoot)
const unpackedPackageCount = unpack.length - 1

if (unpack.some((pattern) => pattern === 'node_modules/**/*')) {
  throw new Error('the complete node_modules tree must not be unpacked')
}

console.log(`runtime dependency closure ok: ${closure.packages.length} packages; unpack closure: ${unpackedPackageCount} packages`)
