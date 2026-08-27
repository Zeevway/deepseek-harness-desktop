'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..')
const smoke = fs.readFileSync(path.join(projectRoot, 'scripts', 'smoke-nsis.cjs'), 'utf8')
const ci = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
const release = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'release.yml'), 'utf8')

test('NSIS smoke requires explicit mutation consent and refuses existing installations', () => {
  assert.match(smoke, /process\.argv\.includes\('--allow-install'\)/u)
  assert.match(smoke, /refusing to overwrite it/u)
  assert.match(smoke, /existing product shortcut would be overwritten/u)
  assert.match(smoke, /readProductRegistrations/u)
  assert.match(smoke, /UUID\.v5\(manifest\.build\.appId/u)
  assert.match(smoke, /readInstallerIdentities/u)
  assert.match(smoke, /installer identity registry key remains/u)
  assert.match(smoke, /assertIsolatedInstallDirectory/u)
  assert.match(smoke, /assertNoLinks/u)
  assert.match(smoke, /refusing to clean registry state owned by another installation/u)
  assert.match(smoke, /refusing to clean an uninstall registration owned by another installation/u)
  assert.match(smoke, /refusing to clean another shortcut/u)
})

test('NSIS smoke verifies install, repair, shortcuts, registry, and both uninstall choices', () => {
  for (const evidence of [
    'install-verified',
    'repair-verified',
    'uninstall-verified',
    'delete-data-install-verified',
    'uninstall-delete-data-verified',
    '.smoke-damaged',
    'installInstance',
    'displayVersion',
    'exactly one installer identity is required',
    'installInstanceToken',
    'uninstall registration points to a different executable',
    'shortcut target is wrong',
    'uninstall removed kept data',
    'delete-data uninstall crossed its data boundary',
    'real Electron userData directory',
    'installer registry state still exists after uninstall',
  ]) {
    assert.ok(smoke.includes(evidence), `missing NSIS smoke evidence: ${evidence}`)
  }
  assert.match(smoke, /readInstallMarker\(installDirectory\)/u)
  assert.match(smoke, /fs\.writeFileSync\(dataProbe[\s\S]*flag: 'wx'/u)
  assert.match(smoke, /path\.resolve\(appData, productName\)/u)
  assert.match(smoke, /--delete-app-data/u)
  assert.match(smoke, /DSH_UNINSTALLER_DIAGNOSTIC_LOG: diagnosticLog/u)
  assert.match(smoke, /waitForMissing\(dataProbeDirectory\)/u)
  assert.match(smoke, /DeepSeek Harness Desktop NSIS Boundary/u)
  assert.match(smoke, /must-survive\.json/u)
  assert.match(smoke, /waitForRegistryCleanup/u)
  assert.doesNotMatch(smoke, /manifest\.name, manifest\.build\.win\.executableName/u)
  assert.doesNotMatch(smoke, /rmSync\(installDirectory/u)
  assert.match(smoke, /cleanup-owned-remnants-complete/u)
})

test('both Windows workflows execute the final installer smoke', () => {
  assert.match(ci, /npm run test:installer/u)
  assert.match(release, /npm run test:installer/u)
  assert.match(ci, /npm audit --omit=dev --audit-level=high/u)
  assert.match(release, /npm audit --omit=dev --audit-level=high/u)
  assert.match(ci, /capture-ui\.cjs/u)
  assert.match(release, /capture-ui\.cjs/u)
})
