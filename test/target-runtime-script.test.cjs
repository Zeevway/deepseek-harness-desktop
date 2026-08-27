const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(projectRoot, 'scripts', 'ensure-target-runtime.cjs'), 'utf8')
const manifest = require('../package.json')
const lock = require('../package-lock.json')

test('target runtime extraction uses the pinned Node tar implementation', () => {
  assert.equal(manifest.devDependencies.tar, '7.5.22')
  assert.equal(lock.packages[''].devDependencies.tar, '7.5.22')
  assert.match(source, /const tar = require\('tar'\)/u)
  assert.match(source, /tar\.x\(\{[\s\S]*file: archive[\s\S]*strict: true[\s\S]*sync: true/u)
  assert.doesNotMatch(source, /spawnSync\('tar\.exe'/u)
})

test('target runtime npm failures include spawn errors before process output', () => {
  assert.match(source, /packed\.error\?\.message \|\| packed\.stderr \|\| packed\.stdout/u)
})
