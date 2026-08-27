'use strict'

const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const isolationPrefix = 'dsh-packaged-smoke-'
const markerName = '.dsh-packaged-smoke-isolation.json'

function samePath(left, right) {
  return path.resolve(left).toLocaleLowerCase('en-US')
    === path.resolve(right).toLocaleLowerCase('en-US')
}

function findAncestorNodeModules(startDirectory) {
  let cursor = path.resolve(startDirectory)
  while (true) {
    const candidate = path.join(cursor, 'node_modules')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(cursor)
    if (parent === cursor) return null
    cursor = parent
  }
}

function cleanupIsolatedPackagedApp(isolation) {
  const isolationRoot = path.resolve(isolation?.isolationRoot ?? '')
  const temporaryRoot = path.resolve(isolation?.temporaryRoot ?? '')
  if (!path.basename(isolationRoot).startsWith(isolationPrefix)
    || !samePath(path.dirname(isolationRoot), temporaryRoot)) {
    throw new Error('refusing to clean an unrecognized packaged smoke isolation path')
  }
  if (!fs.existsSync(isolationRoot)) return false

  const realTemporaryRoot = fs.realpathSync(temporaryRoot)
  const realIsolationRoot = fs.realpathSync(isolationRoot)
  if (!samePath(path.dirname(realIsolationRoot), realTemporaryRoot)) {
    throw new Error('refusing to clean a packaged smoke isolation path outside the temporary root')
  }

  const markerPath = path.join(isolationRoot, markerName)
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
  if (marker.id !== isolation.id || marker.purpose !== 'deepseek-harness-packaged-smoke') {
    throw new Error('refusing to clean a packaged smoke isolation path with an invalid marker')
  }

  fs.rmSync(isolationRoot, { recursive: true })
  return true
}

function createIsolatedPackagedApp(sourceExecutable, options = {}) {
  const source = path.resolve(sourceExecutable)
  if (!fs.statSync(source).isFile()) {
    throw new Error(`packaged executable is not a file: ${source}`)
  }

  const temporaryRoot = fs.realpathSync(path.resolve(options.temporaryRoot || os.tmpdir()))
  const contamination = findAncestorNodeModules(temporaryRoot)
  if (contamination) {
    throw new Error(`temporary root can resolve repository dependencies: ${contamination}`)
  }

  const isolationRoot = fs.mkdtempSync(path.join(temporaryRoot, isolationPrefix))
  const id = randomUUID()
  const isolation = { id, isolationRoot, temporaryRoot }

  try {
    const markerPath = path.join(isolationRoot, markerName)
    fs.writeFileSync(markerPath, `${JSON.stringify({
      id,
      purpose: 'deepseek-harness-packaged-smoke',
      sourceDirectory: path.dirname(source),
    })}\n`, { encoding: 'utf8', flag: 'wx' })

    const contaminationAfterCreate = findAncestorNodeModules(isolationRoot)
    if (contaminationAfterCreate) {
      throw new Error(`isolated app can resolve repository dependencies: ${contaminationAfterCreate}`)
    }

    const applicationDirectory = path.join(isolationRoot, 'app')
    fs.cpSync(path.dirname(source), applicationDirectory, {
      dereference: false,
      recursive: true,
      verbatimSymlinks: true,
    })
    const executable = path.join(applicationDirectory, path.basename(source))
    if (!fs.statSync(executable).isFile()) {
      throw new Error('isolated packaged executable was not copied')
    }

    return {
      ...isolation,
      applicationDirectory,
      executable,
    }
  } catch (error) {
    try {
      cleanupIsolatedPackagedApp(isolation)
    } catch (cleanupError) {
      error.message += `; isolation cleanup failed: ${cleanupError.message}`
    }
    throw error
  }
}

module.exports = {
  cleanupIsolatedPackagedApp,
  createIsolatedPackagedApp,
  findAncestorNodeModules,
}
