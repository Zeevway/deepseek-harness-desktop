'use strict'

const fs = require('node:fs')
const path = require('node:path')
const semver = require('semver')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`))
}

function packageNameParts(packageName) {
  if (typeof packageName !== 'string' || packageName.length === 0
    || packageName.includes('\\')) {
    throw new Error(`invalid package name: ${packageName}`)
  }

  const parts = packageName.split('/')
  const validShape = parts[0]?.startsWith('@') ? parts.length === 2 : parts.length === 1
  if (!validShape || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`invalid package name: ${packageName}`)
  }
  return parts
}

function parsePackageRelativeDirectory(relativeDirectory) {
  if (typeof relativeDirectory !== 'string' || relativeDirectory.length === 0
    || relativeDirectory.includes('\\') || path.posix.isAbsolute(relativeDirectory)) {
    throw new Error(`invalid package directory: ${relativeDirectory}`)
  }

  const parts = relativeDirectory.split('/')
  const packages = []
  let index = 0

  while (index < parts.length) {
    if (parts[index] !== 'node_modules') {
      throw new Error(`invalid package directory: ${relativeDirectory}`)
    }
    const nodeModulesIndex = index
    index += 1

    const first = parts[index]
    if (!first || first === '.' || first === '..') {
      throw new Error(`invalid package directory: ${relativeDirectory}`)
    }

    const nameParts = [first]
    index += 1
    if (first.startsWith('@')) {
      const second = parts[index]
      if (!second || second === '.' || second === '..') {
        throw new Error(`invalid scoped package directory: ${relativeDirectory}`)
      }
      nameParts.push(second)
      index += 1
    }

    packages.push({
      endIndex: index,
      name: nameParts.join('/'),
      nameParts,
      nodeModulesIndex,
    })
  }

  return { packages, parts }
}

function findPackageDirectory(packageName, fromDirectory, projectRoot) {
  let cursor = path.resolve(fromDirectory)
  const root = path.resolve(projectRoot)
  const nameParts = packageNameParts(packageName)

  if (!isPathInside(root, cursor)) {
    throw new Error(`package requester is outside package root: ${fromDirectory}`)
  }

  const realRoot = fs.realpathSync(root)
  const realRequester = fs.realpathSync(cursor)
  if (!isPathInside(realRoot, realRequester)) {
    throw new Error(`package requester resolves outside package root: ${fromDirectory}`)
  }

  while (isPathInside(root, cursor)) {
    if (path.basename(cursor).toLocaleLowerCase('en-US') !== 'node_modules') {
      const candidate = path.resolve(cursor, 'node_modules', ...nameParts)
      if (!isPathInside(root, candidate)) {
        throw new Error(`package candidate is outside package root: ${packageName}`)
      }

      const manifestPath = path.join(candidate, 'package.json')
      if (fs.existsSync(manifestPath)) {
        const realCandidate = fs.realpathSync(candidate)
        const realManifest = fs.realpathSync(manifestPath)
        if (!isPathInside(realRoot, realCandidate) || !isPathInside(realRoot, realManifest)) {
          throw new Error(`package candidate resolves outside package root: ${packageName}`)
        }
        const candidateManifest = readJson(manifestPath)
        if (candidateManifest.name !== packageName) {
          throw new Error(
            `package manifest name mismatch: expected ${packageName}, got ${candidateManifest.name}`,
          )
        }
        return candidate
      }
    }
    if (cursor === root) break
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }

  return null
}

function collectPackageClosure(projectRoot, entryNames, options = {}) {
  const includePeers = options.includePeers !== false
  const root = path.resolve(projectRoot)
  const queue = entryNames.map((name) => ({ name, from: root, required: true, range: null }))
  const packages = new Map()
  const missing = []
  const incompatible = []

  while (queue.length > 0) {
    const request = queue.shift()
    const directory = findPackageDirectory(request.name, request.from, root)

    if (!directory) {
      if (request.required) missing.push({ name: request.name, from: request.from })
      continue
    }

    const manifestPath = path.join(directory, 'package.json')
    const manifest = readJson(manifestPath)
    const relativeDirectory = path.relative(root, directory).split(path.sep).join('/')

    if (request.range && semver.validRange(request.range)
      && (!semver.valid(manifest.version) || !semver.satisfies(manifest.version, request.range))) {
      incompatible.push({
        name: request.name,
        version: manifest.version,
        range: request.range,
        from: request.from,
      })
    }

    if (packages.has(relativeDirectory)) continue
    packages.set(relativeDirectory, { directory, relativeDirectory, manifest })

    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      queue.push({ name, range, from: directory, required: true })
    }

    for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) {
      queue.push({ name, range, from: directory, required: false })
    }

    if (includePeers) {
      for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
        const optional = manifest.peerDependenciesMeta?.[name]?.optional === true
        queue.push({ name, range, from: directory, required: !optional })
      }
    }
  }

  return {
    packages: [...packages.values()].sort((left, right) => (
      left.relativeDirectory.localeCompare(right.relativeDirectory, 'en')
    )),
    missing,
    incompatible,
  }
}

function unpackPatterns(projectRoot) {
  const closure = collectPackageClosure(projectRoot, ['@deepseek-ai/dsh', 'pnpm'])

  if (closure.missing.length || closure.incompatible.length) {
    throw new Error(
      `cannot calculate unpack closure: ${JSON.stringify({
        missing: closure.missing,
        incompatible: closure.incompatible,
      })}`,
    )
  }

  return [
    'src/harness-runner.mjs',
    ...closure.packages.map(({ relativeDirectory }) => `${relativeDirectory}/**/*`),
    // The child-process runtime needs executable code, configuration, web assets,
    // and native binaries on the real filesystem. Build-only metadata stays in
    // app.asar and does not need a second unpacked copy.
    '!node_modules/**/*.map',
    '!node_modules/**/*.d.ts',
    '!node_modules/**/*.d.mts',
    '!node_modules/**/*.d.cts',
  ]
}

module.exports = {
  collectPackageClosure,
  findPackageDirectory,
  isPathInside,
  packageNameParts,
  parsePackageRelativeDirectory,
  unpackPatterns,
}
