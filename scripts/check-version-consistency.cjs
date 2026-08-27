'use strict'

const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const manifest = require('../package.json')
const lock = require('../package-lock.json')
const expectedHarnessVersion = manifest.dependencies['@deepseek-ai/dsh']
const errors = []

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/'
  const index = lockPath.lastIndexOf(marker)
  if (index < 0) return null
  const segments = lockPath.slice(index + marker.length).split('/')
  return segments[0].startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

if (manifest.version !== lock.version || manifest.version !== lock.packages?.['']?.version) {
  errors.push(`desktop version mismatch: package=${manifest.version}, lock=${lock.version}, lockRoot=${lock.packages?.['']?.version}`)
}

for (const [name, version] of Object.entries(manifest.dependencies)) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    errors.push(`production dependency must be pinned exactly: ${name}=${version}`)
  }
  if (lock.packages?.['']?.dependencies?.[name] !== version) {
    errors.push(`lock root does not match package.json: ${name}`)
  }
}

let harnessPackageCount = 0
for (const [lockPath, entry] of Object.entries(lock.packages ?? {})) {
  const name = packageNameFromLockPath(lockPath)
  if (name !== '@deepseek-ai/dsh' && !name?.startsWith('@deepseek-ai/dsh-')) continue
  harnessPackageCount += 1
  if (entry.version !== expectedHarnessVersion) {
    errors.push(`mixed Harness version: ${name}@${entry.version} at ${lockPath}`)
  }
}

for (const name of ['@deepseek-ai/dsh', 'electron-updater', 'pnpm', 'semver']) {
  const packagePath = path.join(projectRoot, 'node_modules', ...name.split('/'), 'package.json')
  if (!fs.existsSync(packagePath)) {
    errors.push(`required production package is not installed: ${name}`)
    continue
  }
  const installed = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  if (installed.version !== manifest.dependencies[name]) {
    errors.push(`installed version mismatch: ${name}@${installed.version}`)
  }
}

if (harnessPackageCount < 100) {
  errors.push(`unexpectedly small Harness lock closure: ${harnessPackageCount} packages`)
}

if (errors.length) {
  throw new Error(errors.join('\n'))
}

console.log(`version consistency ok: desktop ${manifest.version}, Harness ${expectedHarnessVersion}, ${harnessPackageCount} Harness packages`)
