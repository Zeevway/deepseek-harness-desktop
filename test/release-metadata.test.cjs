'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const zlib = require('node:zlib')
const yaml = require('js-yaml')

const projectRoot = path.resolve(__dirname, '..')
const generator = path.join(projectRoot, 'scripts', 'generate-release-metadata.cjs')

function sha512(content) {
  return crypto.createHash('sha512').update(content).digest('base64')
}

function makeBlockmap(content, describedSize = content.length) {
  const data = {
    version: '2',
    files: [{
      name: 'file',
      offset: 0,
      checksums: [Buffer.alloc(18, 7).toString('base64')],
      sizes: [describedSize],
    }],
  }
  return zlib.gzipSync(Buffer.from(JSON.stringify(data)), { mtime: 0 })
}

function runFixture(mutate = () => {}, environment = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-metadata-'))
  const scripts = path.join(root, 'scripts')
  const release = path.join(root, 'release')
  fs.mkdirSync(scripts)
  fs.mkdirSync(release)
  fs.copyFileSync(generator, path.join(scripts, 'generate-release-metadata.cjs'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'deepseek-harness-desktop',
    version: '0.3.0',
    dependencies: { '@deepseek-ai/dsh': '0.1.1-rc.2' },
  }))

  const installers = ['x64', 'arm64'].map((architecture) => {
    const name = `DeepSeek-Harness-Desktop-Setup-0.3.0-${architecture}.exe`
    const content = Buffer.from(`installer-${architecture}-content`)
    fs.writeFileSync(path.join(release, name), content)
    fs.writeFileSync(path.join(release, `${name}.blockmap`), makeBlockmap(content))
    return { name, content }
  })
  const metadata = {
    version: '0.3.0',
    files: installers.map(({ name, content }) => ({
      url: name,
      sha512: sha512(content),
      size: content.length,
    })),
    path: installers[0].name,
    sha512: sha512(installers[0].content),
    releaseDate: '2026-08-26T00:00:00.000Z',
  }
  mutate({ metadata, release, installers })
  fs.writeFileSync(path.join(release, 'latest.yml'), yaml.dump(metadata, { lineWidth: -1 }))

  const result = spawnSync(
    process.execPath,
    [path.join(scripts, 'generate-release-metadata.cjs')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_PATH: path.join(projectRoot, 'node_modules'),
        ...environment,
      },
    },
  )
  result.releaseManifest = fs.existsSync(path.join(release, 'release-manifest.json'))
    ? JSON.parse(fs.readFileSync(path.join(release, 'release-manifest.json'), 'utf8'))
    : null
  fs.rmSync(root, { recursive: true, force: true })
  return result
}

test('release metadata accepts one canonical entry and blockmap per architecture', () => {
  const result = runFixture()
  assert.equal(result.status, 0, result.stderr)
})

test('release metadata records a validated source repository and commit', () => {
  const result = runFixture(() => {}, {
    GITHUB_REPOSITORY: 'example/deepseek-harness-desktop',
    GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
    GITHUB_REF: 'refs/tags/v0.3.0',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.releaseManifest.source, {
    repository: 'example/deepseek-harness-desktop',
    revision: '0123456789abcdef0123456789abcdef01234567',
    ref: 'refs/tags/v0.3.0',
  })
})

test('release metadata rejects malformed source provenance', () => {
  const result = runFixture(() => {}, { GITHUB_SHA: 'not-a-commit' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /40-character commit id/u)
})

for (const [name, mutate, expected] of [
  [
    'duplicate installer URL',
    ({ metadata }) => { metadata.files[1] = { ...metadata.files[0] } },
    'exactly once',
  ],
  [
    'query-bearing installer URL',
    ({ metadata }) => { metadata.files[0].url += '?source=mirror' },
    'non-canonical installer URL',
  ],
  [
    'case-mismatched installer URL',
    ({ metadata }) => { metadata.files[0].url = metadata.files[0].url.toUpperCase() },
    'non-canonical installer URL',
  ],
  [
    'wrong installer size',
    ({ metadata }) => { metadata.files[0].size += 1 },
    'size does not match installer',
  ],
  [
    'wrong installer SHA-512',
    ({ metadata }) => { metadata.files[0].sha512 = Buffer.alloc(64).toString('base64') },
    'sha512 does not match installer',
  ],
  [
    'missing top-level SHA-512',
    ({ metadata }) => { delete metadata.sha512 },
    'requires valid top-level',
  ],
  [
    'unexpected executable entry',
    ({ metadata }) => {
      metadata.files.push({
        url: 'evil-x64.EXE',
        size: 1,
        sha512: Buffer.alloc(64).toString('base64'),
      })
    },
    'files must exactly match',
  ],
  [
    'unexpected executable artifact',
    ({ release }) => { fs.writeFileSync(path.join(release, 'other-arm64.EXE'), 'x') },
    'unexpected installers',
  ],
  [
    'blockmap for a different installer size',
    ({ release, installers }) => {
      const installer = installers[0]
      fs.writeFileSync(
        path.join(release, `${installer.name}.blockmap`),
        makeBlockmap(installer.content, installer.content.length + 1),
      )
    },
    'does not correspond to its installer size',
  ],
]) {
  test(`release metadata rejects ${name}`, () => {
    const result = runFixture(mutate)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, new RegExp(expected, 'iu'))
  })
}
