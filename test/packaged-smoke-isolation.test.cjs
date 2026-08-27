'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  cleanupIsolatedPackagedApp,
  createIsolatedPackagedApp,
  findAncestorNodeModules,
} = require('../scripts/packaged-smoke-isolation.cjs')

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-isolation-test-'))
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  return root
}

test('packaged smoke copies the complete app outside repository dependency ancestors', (t) => {
  const fixture = createFixture(t)
  const sourceDirectory = path.join(fixture, 'repository', 'release', 'win-unpacked')
  const sourceExecutable = path.join(sourceDirectory, 'Desktop.exe')
  const packagedModule = path.join(
    sourceDirectory,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'runtime-package',
    'package.json',
  )
  fs.mkdirSync(path.join(fixture, 'repository', 'node_modules', 'host-only'), { recursive: true })
  fs.mkdirSync(path.dirname(packagedModule), { recursive: true })
  fs.writeFileSync(sourceExecutable, 'packaged executable')
  fs.writeFileSync(packagedModule, '{"name":"runtime-package","version":"1.0.0"}\n')

  const isolation = createIsolatedPackagedApp(sourceExecutable)
  t.after(() => {
    if (fs.existsSync(isolation.isolationRoot)) cleanupIsolatedPackagedApp(isolation)
  })

  assert.notEqual(path.dirname(isolation.executable), sourceDirectory)
  assert.equal(findAncestorNodeModules(isolation.isolationRoot), null)
  assert.equal(fs.readFileSync(isolation.executable, 'utf8'), 'packaged executable')
  assert.equal(
    fs.readFileSync(path.join(
      isolation.applicationDirectory,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'runtime-package',
      'package.json',
    ), 'utf8'),
    '{"name":"runtime-package","version":"1.0.0"}\n',
  )
})

test('packaged smoke cleanup removes only its marked isolation and preserves the source', (t) => {
  const fixture = createFixture(t)
  const sourceDirectory = path.join(fixture, 'source-app')
  const sourceExecutable = path.join(sourceDirectory, 'Desktop.exe')
  fs.mkdirSync(sourceDirectory, { recursive: true })
  fs.writeFileSync(sourceExecutable, 'source remains')

  const isolation = createIsolatedPackagedApp(sourceExecutable)
  assert.equal(cleanupIsolatedPackagedApp(isolation), true)
  assert.equal(fs.existsSync(isolation.isolationRoot), false)
  assert.equal(fs.readFileSync(sourceExecutable, 'utf8'), 'source remains')

  const unrelated = path.join(fixture, 'unrelated')
  fs.mkdirSync(unrelated)
  fs.writeFileSync(path.join(unrelated, 'sentinel.txt'), 'keep')
  assert.throws(
    () => cleanupIsolatedPackagedApp({
      ...isolation,
      isolationRoot: unrelated,
      temporaryRoot: fixture,
    }),
    /refusing to clean/u,
  )
  assert.equal(fs.readFileSync(path.join(unrelated, 'sentinel.txt'), 'utf8'), 'keep')
})
