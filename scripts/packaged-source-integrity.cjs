'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')

const REQUIRED_PROJECT_PATTERNS = Object.freeze([
  'package.json',
  'src/*.cjs',
  'src/*.mjs',
  'src/ui/**/*',
  'assets/icon.svg',
  'assets/icon.png',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
])

const IGNORED_PACKAGE_PROPERTIES = new Set([
  'dist',
  'gitHead',
  'build',
  'jspm',
  'ava',
  'xo',
  'nyc',
  'eslintConfig',
  'contributors',
  'bundleDependencies',
  'tags',
  'scripts',
  'keywords',
  'devDependencies',
])

function normalizeRelativePath(filename) {
  const normalized = filename.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
  if (!normalized
    || path.posix.isAbsolute(normalized)
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.split('/').includes('..')) {
    throw new Error(`invalid project-relative path: ${filename}`)
  }
  return normalized
}

function compileGlob(pattern) {
  let expression = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          expression += '(?:.*/)?'
        } else {
          expression += '.*'
        }
      } else {
        expression += '[^/]*'
      }
    } else if (character === '?') {
      expression += '[^/]'
    } else {
      expression += character.replace(/[\\^$+?.()|[\]{}]/gu, '\\$&')
    }
  }
  return new RegExp(`${expression}$`, 'u')
}

function listPatternMatches(projectRoot, rawPattern) {
  const pattern = normalizeRelativePath(rawPattern.replace(/^!/u, '').replace(/^\.\//u, ''))
  if (/[\[\]{}]/u.test(pattern)) {
    throw new Error(`unsupported build.files glob syntax: ${rawPattern}`)
  }

  const wildcardIndex = pattern.search(/[?*]/u)
  if (wildcardIndex === -1) {
    const filename = path.join(projectRoot, ...pattern.split('/'))
    if (!fs.existsSync(filename)) return []
    const stat = fs.lstatSync(filename)
    if (!stat.isFile()) throw new Error(`project file is not a regular file: ${pattern}`)
    return [pattern]
  }

  const prefix = pattern.slice(0, wildcardIndex)
  const lastSlash = prefix.lastIndexOf('/')
  const baseRelative = lastSlash === -1 ? '' : prefix.slice(0, lastSlash)
  const baseDirectory = path.join(projectRoot, ...baseRelative.split('/').filter(Boolean))
  if (!fs.existsSync(baseDirectory)) return []

  const matcher = compileGlob(pattern)
  const recursive = pattern.includes('**')
  const matches = []
  const queue = [baseDirectory]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (recursive) queue.push(filename)
        continue
      }
      if (!entry.isFile()) continue
      const relative = path.relative(projectRoot, filename).replace(/\\/gu, '/')
      if (matcher.test(relative)) matches.push(relative)
    }
  }
  return matches.sort()
}

function collectExpectedProjectFiles(projectRoot, buildFiles) {
  if (!Array.isArray(buildFiles)) {
    throw new Error('build.files must be an array for packaged source integrity verification')
  }

  const expected = new Set()
  const patterns = [...buildFiles, ...REQUIRED_PROJECT_PATTERNS]
  for (const entry of patterns) {
    if (typeof entry !== 'string') {
      throw new Error('object build.files entries are not supported by packaged source integrity verification')
    }
    const excluded = entry.startsWith('!')
    const matches = listPatternMatches(projectRoot, entry)
    if (!excluded && matches.length === 0) {
      throw new Error(`build.files pattern did not match a project file: ${entry}`)
    }
    for (const filename of matches) {
      if (excluded) expected.delete(filename)
      else expected.add(filename)
    }
  }
  return [...expected].sort()
}

function normalizeMainPackageManifest(manifest) {
  const normalized = JSON.parse(JSON.stringify(manifest))
  const dependencies = normalized.dependencies
  const removeBabel = dependencies != null
    && typeof dependencies === 'object'
    && !Object.keys(dependencies).some((name) => name.startsWith('babel'))

  for (const property of Object.keys(normalized)) {
    if (property.startsWith('_')
      || IGNORED_PACKAGE_PROPERTIES.has(property)
      || (removeBabel && property === 'babel')) {
      delete normalized[property]
    }
  }
  return normalized
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value != null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function listPackagedProjectFiles(appAsar) {
  const files = []
  const seen = new Set()
  for (const archivePath of asar.listPackage(appAsar)) {
    const relative = normalizeRelativePath(archivePath)
    if (relative === 'node_modules' || relative.startsWith('node_modules/')) continue
    if (seen.has(relative)) throw new Error(`duplicate packaged project path: ${relative}`)
    seen.add(relative)
    const nativeArchivePath = relative.split('/').join(path.sep)
    const metadata = asar.statFile(appAsar, nativeArchivePath, false)
    if (metadata.files != null) continue
    if (metadata.link != null) {
      throw new Error(`packaged project path must not be a symbolic link: ${relative}`)
    }
    files.push(relative)
  }
  return files.sort()
}

function verifyPackagedProjectFiles({ projectRoot, appAsar, buildFiles }) {
  const expectedFiles = collectExpectedProjectFiles(projectRoot, buildFiles)
  const packagedFiles = listPackagedProjectFiles(appAsar)
  const expectedSet = new Set(expectedFiles)
  const packagedSet = new Set(packagedFiles)
  const missing = expectedFiles.filter((filename) => !packagedSet.has(filename))
  const unexpected = packagedFiles.filter((filename) => !expectedSet.has(filename))
  const mismatched = []

  for (const filename of expectedFiles) {
    if (!packagedSet.has(filename)) continue
    const nativeArchivePath = filename.split('/').join(path.sep)
    const packagedContent = asar.extractFile(appAsar, nativeArchivePath, false)
    const sourceContent = fs.readFileSync(path.join(projectRoot, ...filename.split('/')))
    if (filename === 'package.json') {
      const expectedManifest = normalizeMainPackageManifest(JSON.parse(sourceContent.toString('utf8')))
      const packagedManifest = JSON.parse(packagedContent.toString('utf8'))
      const expectedCanonical = canonicalJson(expectedManifest)
      const packagedCanonical = canonicalJson(packagedManifest)
      if (expectedCanonical !== packagedCanonical) {
        mismatched.push(
          `${filename} metadata (expected ${sha256(expectedCanonical)}, got ${sha256(packagedCanonical)})`,
        )
      }
    } else {
      const expectedHash = sha256(sourceContent)
      const packagedHash = sha256(packagedContent)
      if (expectedHash !== packagedHash) {
        mismatched.push(`${filename} (expected ${expectedHash}, got ${packagedHash})`)
      }
    }
  }

  const failures = []
  if (missing.length > 0) failures.push(`missing: ${missing.join(', ')}`)
  if (unexpected.length > 0) failures.push(`unexpected or stale: ${unexpected.join(', ')}`)
  if (mismatched.length > 0) failures.push(`content mismatch: ${mismatched.join(', ')}`)
  if (failures.length > 0) {
    throw new Error(`packaged project files do not match the current worktree: ${failures.join('; ')}`)
  }

  return {
    packagedFiles,
    verifiedFileCount: expectedFiles.length,
  }
}

module.exports = {
  REQUIRED_PROJECT_PATTERNS,
  collectExpectedProjectFiles,
  normalizeMainPackageManifest,
  verifyPackagedProjectFiles,
}
