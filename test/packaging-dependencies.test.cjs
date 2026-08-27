const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  collectPackageClosure,
  findPackageDirectory,
  unpackPatterns,
} = require('../scripts/package-closure.cjs')

const projectRoot = path.resolve(__dirname, '..')

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'))
}

function createPackage(root, relativeDirectory, name, version, fields = {}) {
  const directory = path.join(root, ...relativeDirectory.split('/'))
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ name, version, ...fields })}\n`,
    'utf8',
  )
  return directory
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-packaged-deps-'))
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  return root
}

test('DeepSeek runtime peers are promoted to production dependencies', () => {
  const manifest = readJson('package.json')
  const lockfile = readJson('package-lock.json')
  const peerOnlyPackages = Object.entries(lockfile.packages)
    .filter(([packagePath, metadata]) => (
      packagePath.startsWith('node_modules/@deepseek-ai/')
      && metadata.peer === true
      && metadata.dev !== true
      && metadata.optional !== true
    ))
    .map(([packagePath]) => packagePath.slice('node_modules/'.length))

  assert.deepEqual(
    peerOnlyPackages,
    [],
    `electron-builder would omit these DeepSeek runtime peers: ${peerOnlyPackages.join(', ')}`,
  )

  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.equal(
      /^[~^]/u.test(version),
      false,
      `${name} must stay exact so the packaged Harness dependency set is reproducible`,
    )
  }
})

test('packaged closure prefers the nested dependency selected by Node resolution', (t) => {
  const root = createFixture(t)
  createPackage(root, 'node_modules/parent', 'parent', '1.0.0', {
    dependencies: { child: '^2.0.0' },
  })
  createPackage(root, 'node_modules/parent/node_modules/child', 'child', '2.0.0')
  createPackage(root, 'node_modules/child', 'child', '1.0.0')

  const closure = collectPackageClosure(root, ['parent'])

  assert.deepEqual(closure.missing, [])
  assert.deepEqual(closure.incompatible, [])
  assert.ok(closure.packages.some((entry) => (
    entry.relativeDirectory === 'node_modules/parent/node_modules/child'
      && entry.manifest.version === '2.0.0'
  )))
})

test('packaged closure accepts a compatible top-level hoist', (t) => {
  const root = createFixture(t)
  createPackage(root, 'node_modules/parent', 'parent', '1.0.0', {
    dependencies: { child: '^1.0.0' },
  })
  createPackage(root, 'node_modules/child', 'child', '1.0.0')

  const closure = collectPackageClosure(root, ['parent'])

  assert.deepEqual(closure.missing, [])
  assert.deepEqual(closure.incompatible, [])
  assert.ok(closure.packages.some((entry) => entry.relativeDirectory === 'node_modules/child'))
})

test('packaged closure preserves scoped package names when hoisted', (t) => {
  const root = createFixture(t)
  createPackage(root, 'node_modules/@scope/parent', '@scope/parent', '1.0.0', {
    dependencies: { '@scope/child': '^1.0.0' },
  })
  createPackage(root, 'node_modules/@scope/child', '@scope/child', '1.0.0')

  const closure = collectPackageClosure(root, ['@scope/parent'])

  assert.deepEqual(closure.missing, [])
  assert.deepEqual(closure.incompatible, [])
})

test('packaged closure rejects a hoisted version mismatch', (t) => {
  const root = createFixture(t)
  createPackage(root, 'node_modules/parent', 'parent', '1.0.0', {
    dependencies: { child: '^2.0.0' },
  })
  createPackage(root, 'node_modules/child', 'child', '1.0.0')

  const closure = collectPackageClosure(root, ['parent'])

  assert.equal(closure.incompatible.length, 1)
  assert.equal(closure.incompatible[0].name, 'child')
  assert.equal(closure.incompatible[0].version, '1.0.0')
})

test('packaged dependency lookup cannot escape the packaged root', (t) => {
  const root = createFixture(t)

  assert.throws(
    () => findPackageDirectory('../child', root, root),
    /invalid package name/u,
  )
})

test('packaged closure reports a truly absent required dependency', (t) => {
  const root = createFixture(t)
  createPackage(root, 'node_modules/parent', 'parent', '1.0.0', {
    dependencies: { child: '^1.0.0' },
  })

  const closure = collectPackageClosure(root, ['parent'])

  assert.equal(closure.missing.length, 1)
  assert.equal(closure.missing[0].name, 'child')
})

test('unpack closure keeps runtime packages but excludes build-only metadata', () => {
  const patterns = unpackPatterns(projectRoot)

  assert.ok(patterns.includes('src/harness-runner.mjs'))
  assert.ok(patterns.includes('node_modules/@deepseek-ai/dsh/**/*'))
  assert.ok(patterns.includes('node_modules/pnpm/**/*'))
  assert.ok(patterns.includes('!node_modules/**/*.map'))
  assert.ok(patterns.includes('!node_modules/**/*.d.ts'))
  assert.ok(patterns.includes('!node_modules/**/*.d.mts'))
  assert.ok(patterns.includes('!node_modules/**/*.d.cts'))
})
