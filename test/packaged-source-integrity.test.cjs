const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const asar = require('@electron/asar')

const {
  collectExpectedProjectFiles,
  normalizeMainPackageManifest,
  verifyPackagedProjectFiles,
} = require('../scripts/packaged-source-integrity.cjs')

const projectRoot = path.resolve(__dirname, '..')

function writeFile(root, relative, content) {
  const filename = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, content)
}

function copyFile(sourceRoot, destinationRoot, relative) {
  const source = path.join(sourceRoot, ...relative.split('/'))
  const destination = path.join(destinationRoot, ...relative.split('/'))
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-source-integrity-'))
  const source = path.join(root, 'source')
  const staged = path.join(root, 'staged')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(staged, { recursive: true })
  const manifest = {
    name: 'source-integrity-fixture',
    version: '1.2.3',
    private: true,
    description: 'fixture',
    main: 'src/main.cjs',
    license: 'MIT',
    scripts: { test: 'node --test' },
    dependencies: { runtime: '4.5.6' },
    devDependencies: { builder: '7.8.9' },
    build: {
      files: [
        'package.json',
        'src/*.cjs',
        'src/*.mjs',
        'src/ui/**/*',
        'assets/icon.svg',
        'assets/icon.png',
        'LICENSE',
        'THIRD_PARTY_NOTICES.md',
      ],
    },
  }
  writeFile(source, 'package.json', `${JSON.stringify(manifest, null, 2)}\n`)
  writeFile(source, 'src/main.cjs', "'use strict'\n")
  writeFile(source, 'src/harness-runner.mjs', 'export const ready = true\n')
  writeFile(source, 'src/ui/index.html', '<!doctype html>\n')
  writeFile(source, 'src/ui/nested/app.js', 'globalThis.ready = true\n')
  writeFile(source, 'assets/icon.svg', '<svg/>\n')
  writeFile(source, 'assets/icon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFile(source, 'LICENSE', 'fixture license\n')
  writeFile(source, 'THIRD_PARTY_NOTICES.md', '# Notices\n')
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  return { root, source, staged, manifest }
}

async function createFixtureArchive(t, mutate) {
  const fixture = createFixture(t)
  const expected = collectExpectedProjectFiles(fixture.source, fixture.manifest.build.files)
  for (const relative of expected) copyFile(fixture.source, fixture.staged, relative)
  writeFile(
    fixture.staged,
    'package.json',
    JSON.stringify(normalizeMainPackageManifest(fixture.manifest), null, 2),
  )
  if (mutate) mutate(fixture)
  const archive = path.join(fixture.root, 'app.asar')
  await asar.createPackageWithOptions(fixture.staged, archive, {
    unpack: 'src/harness-runner.mjs',
  })
  return { ...fixture, archive }
}

test('required integrity baseline covers every owned runtime file class', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const expected = collectExpectedProjectFiles(projectRoot, manifest.build.files)

  assert.ok(expected.includes('package.json'))
  assert.ok(expected.includes('src/main.cjs'))
  assert.ok(expected.includes('src/harness-runner.mjs'))
  assert.ok(expected.includes('src/ui/index.html'))
  assert.ok(expected.includes('assets/icon.svg'))
  assert.ok(expected.includes('assets/icon.png'))
  assert.ok(expected.includes('LICENSE'))
  assert.ok(expected.includes('THIRD_PARTY_NOTICES.md'))
})

test('packaged source verifier accepts exact packed and unpacked project files', async (t) => {
  const fixture = await createFixtureArchive(t)

  const result = verifyPackagedProjectFiles({
    projectRoot: fixture.source,
    appAsar: fixture.archive,
    buildFiles: fixture.manifest.build.files,
  })

  assert.equal(result.verifiedFileCount, 9)
  assert.ok(result.packagedFiles.includes('src/harness-runner.mjs'))
})

test('packaged source verifier rejects source content from an older build', async (t) => {
  const fixture = await createFixtureArchive(t, ({ staged }) => {
    writeFile(staged, 'src/main.cjs', "'use strict'\n// stale\n")
  })

  assert.throws(
    () => verifyPackagedProjectFiles({
      projectRoot: fixture.source,
      appAsar: fixture.archive,
      buildFiles: fixture.manifest.build.files,
    }),
    /content mismatch: src\/main\.cjs/u,
  )
})

test('packaged source verifier rejects missing and stale owned files', async (t) => {
  const fixture = await createFixtureArchive(t, ({ staged }) => {
    fs.rmSync(path.join(staged, 'src', 'ui', 'index.html'))
    writeFile(staged, 'src/ui/old.js', 'stale\n')
  })

  assert.throws(
    () => verifyPackagedProjectFiles({
      projectRoot: fixture.source,
      appAsar: fixture.archive,
      buildFiles: fixture.manifest.build.files,
    }),
    (error) => {
      assert.match(error.message, /missing: src\/ui\/index\.html/u)
      assert.match(error.message, /unexpected or stale: src\/ui\/old\.js/u)
      return true
    },
  )
})

test('packaged package metadata cannot restore builder-omitted development fields', async (t) => {
  const fixture = await createFixtureArchive(t, ({ staged }) => {
    const packagedManifest = JSON.parse(fs.readFileSync(path.join(staged, 'package.json'), 'utf8'))
    packagedManifest.scripts = { stale: 'true' }
    writeFile(staged, 'package.json', JSON.stringify(packagedManifest, null, 2))
  })

  assert.throws(
    () => verifyPackagedProjectFiles({
      projectRoot: fixture.source,
      appAsar: fixture.archive,
      buildFiles: fixture.manifest.build.files,
    }),
    /content mismatch: package\.json metadata/u,
  )
})

test('packaged package runtime metadata must match current dependency versions', async (t) => {
  const fixture = await createFixtureArchive(t, ({ staged }) => {
    const packagedManifest = JSON.parse(fs.readFileSync(path.join(staged, 'package.json'), 'utf8'))
    packagedManifest.dependencies.runtime = '0.0.1'
    writeFile(staged, 'package.json', JSON.stringify(packagedManifest, null, 2))
  })

  assert.throws(
    () => verifyPackagedProjectFiles({
      projectRoot: fixture.source,
      appAsar: fixture.archive,
      buildFiles: fixture.manifest.build.files,
    }),
    /content mismatch: package\.json metadata/u,
  )
})
