'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  buildLicenseInventory,
  buildProductionSbom,
  collectProductionInventory,
  extractReadmeLicense,
  formatThirdPartyNotices,
  licenseExpression,
  validateSbomCoverage,
} = require('../scripts/release-inventory.cjs')

const MIT_TEXT = `Copyright (c) 2026 Fixture Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
`

const ISC_TEXT = `Copyright (c) 2026 Shared Fixture Authors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
`

function writePackage(root, relativeDirectory, manifest, files = {}) {
  const directory = path.join(root, ...relativeDirectory.split('/'))
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), content)
  }
  return directory
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-inventory-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = {
    name: 'inventory-fixture',
    version: '1.0.0',
    dependencies: {
      alpha: '1.0.0',
      gamma: '1.0.0',
      orphan: '1.0.0',
    },
  }
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writePackage(root, 'node_modules/alpha', {
    name: 'alpha',
    version: '1.0.0',
    license: 'MIT',
    repository: 'git+https://example.test/shared-repository.git',
    dependencies: { shared: '^1.0.0' },
  }, { LICENSE: MIT_TEXT })
  writePackage(root, 'node_modules/alpha/node_modules/shared', {
    name: 'shared',
    version: '1.0.0',
    license: 'ISC',
    repository: 'https://example.test/shared-package',
  }, { 'README.md': `# Shared\n\n## License\n\n${ISC_TEXT}` })
  writePackage(root, 'node_modules/gamma', {
    name: 'gamma',
    version: '1.0.0',
    license: 'MIT',
    repository: 'https://example.test/shared-repository',
    dependencies: { shared: '^1.0.0' },
  })
  writePackage(root, 'node_modules/gamma/node_modules/shared', {
    name: 'shared',
    version: '1.0.0',
    license: 'ISC',
    repository: 'https://example.test/shared-package',
  }, { 'README.md': `Shared package\n\nLicense\n-------\n\n${ISC_TEXT}` })
  writePackage(root, 'node_modules/orphan', {
    name: 'orphan',
    version: '1.0.0',
    license: 'MIT',
    repository: 'https://example.test/orphan',
  })
  return { manifest, root }
}

test('SBOM exactly covers unique production identities with complete dependency nodes', (t) => {
  const { manifest, root } = fixture(t)
  const inventory = collectProductionInventory(root, manifest)
  assert.equal(inventory.occurrenceCount, 5)
  assert.equal(inventory.packages.length, 4)

  const base = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    metadata: {
      component: {
        'bom-ref': 'inventory-fixture@1.0.0',
        type: 'application',
        name: 'inventory-fixture',
        version: '1.0.0',
      },
    },
    components: [
      { 'bom-ref': 'alpha@1.0.0', type: 'library', name: 'alpha', version: '1.0.0' },
      { 'bom-ref': 'dev-only@9.0.0', type: 'library', name: 'dev-only', version: '9.0.0' },
    ],
    dependencies: [{ ref: 'inventory-fixture@1.0.0', dependsOn: ['dev-only@9.0.0'] }],
  }
  const sbom = buildProductionSbom(base, inventory)
  const refs = sbom.components.map((component) => component['bom-ref'])
  assert.deepEqual(refs, ['alpha@1.0.0', 'gamma@1.0.0', 'orphan@1.0.0', 'shared@1.0.0'])
  assert.equal(sbom.dependencies.length, refs.length + 1)

  const graph = new Map(sbom.dependencies.map((entry) => [entry.ref, entry.dependsOn]))
  assert.deepEqual(graph.get('inventory-fixture@1.0.0'), [
    'alpha@1.0.0',
    'gamma@1.0.0',
    'orphan@1.0.0',
  ])
  assert.deepEqual(graph.get('alpha@1.0.0'), ['shared@1.0.0'])
  assert.deepEqual(graph.get('gamma@1.0.0'), ['shared@1.0.0'])
  assert.deepEqual(graph.get('orphan@1.0.0'), [])
  assert.deepEqual(graph.get('shared@1.0.0'), [])
  assert.equal(validateSbomCoverage(sbom, inventory), true)

  sbom.components.pop()
  assert.throws(() => validateSbomCoverage(sbom, inventory), /exactly cover/u)
})

test('license inventory deduplicates identities and texts with explicit fallback status', (t) => {
  const { manifest, root } = fixture(t)
  const inventory = collectProductionInventory(root, manifest)
  const licenses = buildLicenseInventory(inventory)

  assert.equal(licenses.schemaVersion, 2)
  assert.equal(licenses.packages.length, 4)
  assert.equal(new Set(licenses.packages.map(({ name, version }) => `${name}@${version}`)).size, 4)
  assert.equal(licenses.notices.length, 2)

  const byName = new Map(licenses.packages.map((entry) => [entry.name, entry]))
  assert.equal(byName.get('alpha').licenseTextStatus, 'direct')
  assert.equal(byName.get('gamma').licenseTextStatus, 'repository')
  assert.deepEqual(byName.get('gamma').noticeIds, byName.get('alpha').noticeIds)
  assert.equal(byName.get('shared').licenseTextStatus, 'direct')
  assert.equal(byName.get('orphan').licenseTextStatus, 'declared-only')
  assert.deepEqual(byName.get('orphan').noticeIds, [])

  const notices = formatThirdPartyNotices(licenses)
  assert.match(notices, /gamma@1\.0\.0 \| MIT \| repository/u)
  assert.match(notices, /orphan@1\.0\.0 \| MIT \| https:\/\/example\.test\/orphan/u)
  assert.equal(notices.split(MIT_TEXT.trim()).length - 1, 1)
  assert.equal(notices.split(ISC_TEXT.trim()).length - 1, 1)
})

test('README extraction requires substantive terms and unknown licenses fail closed', () => {
  assert.equal(extractReadmeLicense('# Package\n\n## License\n\nMIT\n'), '')
  assert.equal(
    extractReadmeLicense(`# Package\n\n## License\n\n${MIT_TEXT}\n## Usage\n`),
    `${MIT_TEXT.trim()}\n`,
  )
  assert.throws(
    () => licenseExpression({ name: 'bad', version: '1.0.0', license: 'UNKNOWN' }),
    /no declared license/u,
  )
})
