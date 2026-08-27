const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  findRecentWorkspaceId,
  inspectWorkspace,
  listRecentWorkspaces,
  recordRecentWorkspace,
} = require('../src/workspace-selection.cjs')
const {
  createWindowsDriveTypeResolver,
  defaultPowerShellPath,
} = require('../src/windows-drive-types.cjs')

test('uses the newest session timestamp across workspaces', () => {
  const workspaces = [
    { workspaceId: 'a', sessionIds: ['a1'], createdAt: '2026-01-01T00:00:00.000Z' },
    { workspaceId: 'b', sessionIds: ['b1'], createdAt: '2026-02-01T00:00:00.000Z' },
  ]
  const sessions = [
    { sessionId: 'a1', updatedAt: 20 },
    { sessionId: 'b1', updatedAt: 10 },
  ]

  assert.equal(findRecentWorkspaceId(workspaces, sessions), 'a')
})

test('falls back to workspace creation time and preserves host order on ties', () => {
  const workspaces = [
    { workspaceId: 'first', sessionIds: [], createdAt: '2026-02-01T00:00:00.000Z' },
    { workspaceId: 'second', sessionIds: [], createdAt: '2026-02-01T00:00:00.000Z' },
  ]

  assert.equal(findRecentWorkspaceId(workspaces, []), 'first')
})

test('ignores session summaries that are not attached to a workspace', () => {
  const workspaces = [
    { workspaceId: 'only', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z' },
  ]

  assert.equal(
    findRecentWorkspaceId(workspaces, [{ sessionId: 'orphan', updatedAt: Number.MAX_SAFE_INTEGER }]),
    'only',
  )
})

test('preflights a writable workspace without leaving its write probe behind', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-check-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const result = inspectWorkspace(root, { homeDirectory: path.join(root, 'different-home') })

  assert.equal(result.ok, true)
  assert.equal(result.writable, true)
  assert.equal(result.risks.some((entry) => entry.code === 'not-writable'), false)
  assert.deepEqual(fs.readdirSync(root), [])
})

test('read-only mode accepts a readable directory that is not writable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-read-only-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const result = inspectWorkspace(root, {
    requireWritable: false,
    homeDirectory: path.join(root, 'different-home'),
    accessSync(_target, mode) {
      if (mode === fs.constants.W_OK) {
        const error = new Error('write denied')
        error.code = 'EACCES'
        throw error
      }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.readable, true)
  assert.equal(result.writable, false)
  assert.equal(result.requiresWriteAccess, false)
  assert.equal(result.risks.some((entry) => entry.code === 'not-writable'), false)
  assert.deepEqual(fs.readdirSync(root), [])
})

test('workspace-write mode rejects the same non-writable directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-write-required-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const result = inspectWorkspace(root, {
    requireWritable: true,
    homeDirectory: path.join(root, 'different-home'),
    accessSync(_target, mode) {
      if (mode === fs.constants.W_OK) {
        const error = new Error('write denied')
        error.code = 'EACCES'
        throw error
      }
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.readable, true)
  assert.equal(result.writable, false)
  assert.equal(result.errorCode, 'WORKSPACE_NOT_WRITABLE')
  assert.ok(result.risks.some((entry) => entry.code === 'not-writable'))
})

test('read-only mode still rejects a directory that cannot be read', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-read-denied-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const result = inspectWorkspace(root, {
    requireWritable: false,
    homeDirectory: path.join(root, 'different-home'),
    accessSync(_target, mode) {
      if (mode === fs.constants.R_OK) {
        const error = new Error('read denied')
        error.code = 'EACCES'
        throw error
      }
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.readable, false)
  assert.equal(result.errorCode, 'WORKSPACE_NOT_READABLE')
  assert.ok(result.risks.some((entry) => entry.code === 'not-readable'))
})

test('classifies roots and network drives as confirmation risks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-risk-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const network = inspectWorkspace(root, {
    driveType: 'network',
    homeDirectory: path.join(root, 'different-home'),
    probeWritable: false,
  })
  assert.equal(network.requiresConfirmation, true)
  assert.ok(network.risks.some((entry) => entry.code === 'network-drive'))

  const filesystemRoot = path.parse(root).root
  const rootResult = inspectWorkspace(filesystemRoot, { probeWritable: false })
  assert.ok(rootResult.risks.some((entry) => entry.code === 'filesystem-root'))
  assert.equal(rootResult.riskLevel, 'critical')
})

test('Windows drive resolver maps fixed, network, and removable drives without passing a user path', () => {
  const calls = []
  const resolver = createWindowsDriveTypeResolver({
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    execFileSync(executable, args, options) {
      calls.push({ executable, args, options })
      return JSON.stringify([
        { root: 'C:\\', type: 3 },
        { root: 'R:\\', type: 4 },
        { root: 'U:\\', type: 2 },
      ])
    },
  })

  assert.equal(resolver('C:\\work\\project'), 'fixed')
  assert.equal(resolver('R:\\shared\\project'), 'network')
  assert.equal(resolver('U:\\portable\\project'), 'removable')
  assert.equal(resolver('Q:\\missing'), 'unknown')
  assert.equal(resolver('\\\\server\\share\\project'), 'network')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].executable, defaultPowerShellPath({ SystemRoot: 'C:\\Windows' }))
  assert.equal(calls[0].options.timeout, 2_000)
  assert.equal(calls[0].args.some((argument) => argument.includes('work\\project')), false)
  assert.equal(calls[0].args.some((argument) => argument.includes('shared\\project')), false)
})

test('Windows drive resolver caches success and refreshes the whole drive table after expiry', () => {
  let currentTime = 1_000
  let calls = 0
  const resolver = createWindowsDriveTypeResolver({
    platform: 'win32',
    cacheTtlMs: 5_000,
    now: () => currentTime,
    execFileSync() {
      calls += 1
      return JSON.stringify([{ root: 'C:\\', type: calls === 1 ? 3 : 2 }])
    },
  })

  assert.equal(resolver('C:\\first'), 'fixed')
  currentTime = 5_999
  assert.equal(resolver('C:\\second'), 'fixed')
  assert.equal(calls, 1)
  currentTime = 6_000
  assert.equal(resolver('C:\\third'), 'removable')
  assert.equal(calls, 2)
})

test('Windows drive resolver caches failures and safely retries after expiry', () => {
  let currentTime = 10
  let calls = 0
  const errors = []
  const resolver = createWindowsDriveTypeResolver({
    platform: 'win32',
    cacheTtlMs: 100,
    now: () => currentTime,
    onError: (error) => errors.push(error.message),
    execFileSync() {
      calls += 1
      if (calls === 1) throw new Error('PowerShell unavailable')
      return JSON.stringify([{ root: 'C:\\', type: 3 }])
    },
  })

  assert.equal(resolver('C:\\first'), 'unknown')
  assert.equal(resolver('C:\\second'), 'unknown')
  assert.equal(calls, 1)
  assert.deepEqual(errors, ['PowerShell unavailable'])
  currentTime = 110
  assert.equal(resolver('C:\\third'), 'fixed')
  assert.equal(calls, 2)
})

test('workspace risks reflect fixed, network, and removable drive resolver results', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-drive-risk-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  for (const [driveType, expectedRisk] of [
    ['fixed', null],
    ['network', 'network-drive'],
    ['removable', 'removable-drive'],
  ]) {
    const result = inspectWorkspace(root, {
      driveType: () => driveType,
      homeDirectory: path.join(root, 'different-home'),
      probeWritable: false,
    })
    assert.equal(result.driveType, driveType)
    assert.equal(
      result.risks.find((entry) => ['network-drive', 'removable-drive'].includes(entry.code))?.code || null,
      expectedRisk,
    )
  }
})

test('normalizes, deduplicates, limits, and filters recent workspaces', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-recent-'))
  const first = path.join(root, 'first')
  const second = path.join(root, 'second')
  fs.mkdirSync(first)
  fs.mkdirSync(second)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  let recent = recordRecentWorkspace([], first, new Date('2026-01-01T00:00:00.000Z'))
  recent = recordRecentWorkspace(recent, second, new Date('2026-02-01T00:00:00.000Z'))
  recent = recordRecentWorkspace(recent, first, new Date('2026-03-01T00:00:00.000Z'))
  recent.push({ path: path.join(root, 'missing'), lastUsedAt: '2026-04-01T00:00:00.000Z' })

  assert.deepEqual(listRecentWorkspaces(recent).map((entry) => entry.path), [first, second])
  assert.deepEqual(
    listRecentWorkspaces(recent, { existingOnly: false, limit: 2 }).map((entry) => entry.path),
    [path.join(root, 'missing'), first],
  )
})

test('evaluates the real target of a linked workspace for risk', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-link-'))
  const target = path.join(root, 'cloud-target')
  const cloudRoot = path.join(root, 'cloud-root-link')
  const linked = path.join(root, 'linked-workspace')
  fs.mkdirSync(target)
  try {
    fs.symlinkSync(target, cloudRoot, process.platform === 'win32' ? 'junction' : 'dir')
    fs.symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true })
    t.skip(`links are unavailable: ${error.code}`)
    return
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const result = inspectWorkspace(linked, { cloudRoots: [cloudRoot], probeWritable: false })
  assert.ok(result.risks.some((entry) => entry.code === 'linked-directory'))
  assert.ok(result.risks.some((entry) => entry.code === 'cloud-synced-directory'))
})
