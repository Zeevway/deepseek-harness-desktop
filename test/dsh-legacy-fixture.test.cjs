const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { zstdDecompressSync } = require('node:zlib')

const {
  EXPECTED_LEGACY_VERSION,
  loadLegacyFixture,
  materializeLegacyFixture,
  projectKey,
  replaceWorkspaceToken,
} = require('../scripts/smoke-dsh.cjs')

test('committed rc.7 fixture is portable, credential-free, and materializes a legacy session', (t) => {
  const fixture = loadLegacyFixture()
  const serialized = JSON.stringify(fixture)
  assert.equal(fixture.sourceHarnessVersion, EXPECTED_LEGACY_VERSION)
  assert.doesNotMatch(serialized, /\bsk-[A-Za-z0-9._-]{6,}\b/u)
  assert.doesNotMatch(serialized, /legacy-fixture-generation/iu)
  assert.doesNotMatch(serialized, /legacy-runtime/iu)
  assert.doesNotMatch(serialized, /http:\/\/127\.0\.0\.1:\d+/u)
  assert.doesNotMatch(serialized, /fixture-local-credential|migration-smoke-local-credential/u)
  assert.match(serialized, /\$LEGACY_RUNTIME/u)
  assert.match(serialized, /\$LOOPBACK_ORIGIN/u)
  assert.equal(fixture.expected.toolCall.name, 'todo_write')
  assert.equal(fixture.expected.toolCall.id, 'call-legacy-fixture-todo')

  assert.deepEqual(
    replaceWorkspaceToken({ nested: `prefix/$WORKSPACE/suffix` }, 'D:\\portable-workspace'),
    { nested: 'prefix/D:\\portable-workspace/suffix' },
  )

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-legacy-fixture-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dshHome = path.join(root, 'home')
  const workspace = path.join(root, 'unicode-workspace-\u6d4b\u8bd5')
  const result = materializeLegacyFixture(fixture, { dshHome, workspace })

  const workspaceDocument = JSON.parse(fs.readFileSync(path.join(dshHome, 'storages', 'workspace.json'), 'utf8'))
  assert.equal(workspaceDocument.tables.workspaces[fixture.workspaceId].path, path.resolve(workspace))
  assert.deepEqual(workspaceDocument.tables.workspaces[fixture.workspaceId].sessionIds, [fixture.sessionId])
  assert.equal(path.basename(path.dirname(path.dirname(result.sessionFile))), projectKey(path.resolve(workspace)))

  const header = JSON.parse(zstdDecompressSync(fs.readFileSync(result.sessionFile)).toString('utf8').trim())
  assert.equal(header.id, fixture.sessionId)
  assert.equal(header.cwd, path.resolve(workspace))
})
