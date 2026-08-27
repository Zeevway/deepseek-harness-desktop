const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  PluginManager,
  assertPluginName,
  inferCapabilities,
  publicManifest,
} = require('../src/plugin-manager.cjs')

function createManager(root, overrides = {}) {
  return new PluginManager({
    dshHome: path.join(root, 'harness'),
    dshBin: path.join(root, 'dsh-bin.js'),
    executable: path.join(root, 'electron.exe'),
    pnpmBin: path.join(root, 'pnpm.cjs'),
    fetchImpl: overrides.fetchImpl,
    spawn: overrides.spawn,
  })
}

function createProfile(manager, plugin = null) {
  fs.mkdirSync(manager.profileDir, { recursive: true })
  const dependencies = plugin ? { [plugin.name]: plugin.version } : {}
  const bundles = plugin ? [plugin.name] : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  fs.writeFileSync(path.join(manager.profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }))
  if (plugin) {
    const directory = path.join(manager.profileDir, 'node_modules', ...plugin.name.split('/'))
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
      ...plugin,
      description: 'A filesystem and shell plugin',
      license: 'MIT',
      dsh: { bundle: { patch: './patch.yml' } },
    }))
  }
}

function registryFetch(name, versions, latest = Object.keys(versions).at(-1)) {
  return async () => ({
    ok: true,
    json: async () => ({
      'dist-tags': { latest },
      versions: Object.fromEntries(Object.entries(versions).map(([version, extra]) => [version, {
        name,
        version,
        license: 'MIT',
        dsh: { bundle: { patch: './patch.yml' } },
        ...extra,
      }])),
    }),
  })
}

function spawnWithMutation(mutate, exitCode = 0, calls = []) {
  return (executable, args, options) => {
    calls.push({ executable, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    process.nextTick(() => {
      mutate(args, options)
      child.emit('close', exitCode, null)
    })
    return child
  }
}

function seedTransactionFiles(manager, label, options = {}) {
  fs.mkdirSync(manager.profileDir, { recursive: true })
  if (options.metadata !== false) {
    fs.writeFileSync(path.join(manager.profileDir, 'pnpm-lock.yaml'), `lockfile: ${label}\n`)
    fs.writeFileSync(path.join(manager.profileDir, 'cordis.patch.yml'), `patch: ${label}\n`)
  }
  if (options.nodeModules === false) return
  const baseline = path.join(manager.profileDir, 'node_modules', 'baseline')
  fs.mkdirSync(baseline, { recursive: true })
  fs.writeFileSync(path.join(baseline, 'sentinel.txt'), label)
}

function writeInstalledMutation(manager, plugin, label = plugin.version) {
  const manifestFile = path.join(manager.profileDir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  manifest.dependencies = { ...manifest.dependencies, [plugin.name]: plugin.version }
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  if (!bundles.includes(plugin.name)) bundles.push(plugin.name)
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  fs.writeFileSync(path.join(manager.profileDir, 'pnpm-lock.yaml'), `lockfile: ${label}\n`)
  fs.writeFileSync(path.join(manager.profileDir, 'cordis.patch.yml'), `patch: ${label}\n`)
  const baseline = path.join(manager.profileDir, 'node_modules', 'baseline')
  fs.mkdirSync(baseline, { recursive: true })
  fs.writeFileSync(path.join(baseline, 'sentinel.txt'), `changed-${label}`)
  const pluginDirectory = path.join(manager.profileDir, 'node_modules', ...plugin.name.split('/'))
  fs.mkdirSync(pluginDirectory, { recursive: true })
  fs.writeFileSync(path.join(pluginDirectory, 'package.json'), JSON.stringify({
    ...plugin,
    license: 'MIT',
    dsh: { bundle: { patch: './patch.yml' } },
  }))
}

function writeUninstalledMutation(manager, pluginName) {
  const manifestFile = path.join(manager.profileDir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  delete manifest.dependencies[pluginName]
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: bundles.filter((name) => name !== pluginName) },
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  fs.writeFileSync(path.join(manager.profileDir, 'pnpm-lock.yaml'), 'lockfile: removed\n')
  fs.writeFileSync(path.join(manager.profileDir, 'cordis.patch.yml'), 'patch: removed\n')
  const baseline = path.join(manager.profileDir, 'node_modules', 'baseline')
  fs.mkdirSync(baseline, { recursive: true })
  fs.writeFileSync(path.join(baseline, 'sentinel.txt'), 'changed-removed')
}

function captureTree(root) {
  const result = {}
  if (!fs.existsSync(root)) return result
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        result[`${relative}/`] = 'directory'
        visit(filename, relative)
      } else if (entry.isSymbolicLink()) {
        result[relative] = `link:${fs.readlinkSync(filename)}`
      } else {
        result[relative] = fs.readFileSync(filename, 'utf8')
      }
    }
  }
  visit(root)
  return result
}

function captureProfileTransactionState(manager) {
  const selected = {}
  for (const filename of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
    const target = path.join(manager.profileDir, filename)
    selected[filename] = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
  }
  selected.nodeModules = captureTree(path.join(manager.profileDir, 'node_modules'))
  return selected
}

test('accepts npm package names but rejects URLs and ranges', () => {
  assert.equal(assertPluginName('@scope/dsh-tool'), '@scope/dsh-tool')
  assert.equal(assertPluginName('dsh-tool'), 'dsh-tool')
  for (const value of ['https://example.com/a.tgz', 'github:user/repo', '../plugin', 'name@latest']) {
    assert.throws(() => assertPluginName(value), /npm 软件包/u)
  }
})

test('presents source, install scripts, integrity, compatibility and inferred capabilities', () => {
  const result = publicManifest({
    name: 'dsh-shell-network',
    version: '1.2.3',
    description: 'runs shell commands and fetches URLs',
    license: 'MIT',
    scripts: { postinstall: 'node setup.js' },
    dist: { integrity: 'sha512-test' },
    peerDependencies: { '@deepseek-ai/dsh': '^0.1.1-rc.1' },
    dsh: { bundle: { patch: './patch.yml' } },
  }, 'npm', '0.1.1-rc.2')
  assert.equal(result.scriptsBlocked, true)
  assert.equal(result.integrity, 'sha512-test')
  assert.match(result.capabilities.join(' '), /命令/u)
  assert.match(result.capabilities.join(' '), /网络/u)
  assert.equal(result.isHarnessBundle, true)
  assert.equal(result.compatibilityState, 'compatible')
  assert.deepEqual(inferCapabilities({ name: 'plain' }), ['在 Harness 进程中运行'])
})

test('inspects an exact registry version instead of accepting an arbitrary source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-inspect-'))
  const manager = createManager(root, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '2.0.0': { name: '@example/dsh-plugin', version: '2.0.0', dist: { integrity: 'sha512-value' } },
        },
      }),
    }),
  })
  const result = await manager.inspect('@example/dsh-plugin')
  assert.equal(result.version, '2.0.0')
  assert.equal(result.integrity, 'sha512-value')
})

test('lists, disables and enters safe mode without removing plugin files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-list-'))
  const manager = createManager(root)
  createProfile(manager, { name: '@example/dsh-plugin', version: '1.0.0' })

  assert.equal(manager.listInstalled()[0].enabled, true)
  assert.equal(manager.disable('@example/dsh-plugin').enabled, false)
  manager.enable('@example/dsh-plugin')
  assert.deepEqual(manager.enterSafeMode().disabled, ['@example/dsh-plugin'])
  assert.deepEqual(manager.exitSafeMode().restored, ['@example/dsh-plugin'])
  assert.equal(manager.listInstalled()[0].enabled, true)
  assert.equal(fs.existsSync(path.join(manager.profileDir, 'node_modules', '@example', 'dsh-plugin')), true)
})

test('requires risk acceptance before spawning an install', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-review-'))
  let spawned = false
  const manager = createManager(root, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name: 'dsh-plugin-example', version: '1.0.0' } },
      }),
    }),
    spawn: () => {
      spawned = true
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      process.nextTick(() => child.emit('close', 0, null))
      return child
    },
  })

  await assert.rejects(
    manager.install('dsh-plugin-example', '1.0.0'),
    (error) => error.code === 'PLUGIN_REVIEW_REQUIRED',
  )
  assert.equal(spawned, false)
})

test('installs a plugin and commits the replacement node_modules tree', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-install-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const plugin = { name: '@example/dsh-plugin', version: '1.0.0' }
  const calls = []
  let manager
  manager = createManager(root, {
    fetchImpl: registryFetch(plugin.name, { [plugin.version]: {} }),
    spawn: spawnWithMutation(() => writeInstalledMutation(manager, plugin), 0, calls),
  })
  createProfile(manager)
  seedTransactionFiles(manager, 'before-install')

  const installed = await manager.install(plugin.name, plugin.version, { acceptRisk: true })

  assert.equal(installed.version, plugin.version)
  assert.equal(installed.enabled, true)
  assert.equal(fs.readFileSync(
    path.join(manager.profileDir, 'node_modules', 'baseline', 'sentinel.txt'),
    'utf8',
  ), 'changed-1.0.0')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args.slice(4, 7), ['add', `${plugin.name}@${plugin.version}`, '--save-exact'])
  assert.equal(calls[0].args.includes('--ignore-scripts'), true)
  assert.equal(fs.existsSync(manager.transactionFile), false)
  const history = JSON.parse(fs.readFileSync(manager.historyFile, 'utf8'))
  assert.equal(history[0].action, 'install')
  assert.equal(history[0].previousVersion, null)
  assert.equal(fs.existsSync(path.join(history[0].directory, 'node_modules')), false)
})

test('updates a plugin in one transaction and records its previous version', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-update-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const previous = { name: '@example/dsh-plugin', version: '1.0.0' }
  const next = { ...previous, version: '2.0.0' }
  let manager
  manager = createManager(root, {
    fetchImpl: registryFetch(next.name, { '1.0.0': {}, '2.0.0': {} }, '2.0.0'),
    spawn: spawnWithMutation(() => writeInstalledMutation(manager, next)),
  })
  createProfile(manager, previous)
  seedTransactionFiles(manager, 'before-update')

  // The desktop IPC already inspected an exact version and calls install(); an
  // existing dependency must still be recorded as an update transaction.
  const installed = await manager.install(next.name, next.version, { acceptRisk: true })

  assert.equal(installed.version, next.version)
  const history = JSON.parse(fs.readFileSync(manager.historyFile, 'utf8'))
  assert.equal(history[0].action, 'update')
  assert.equal(history[0].previousVersion, previous.version)
  assert.equal(history[0].previousEnabled, true)
  assert.equal(fs.existsSync(manager.transactionFile), false)
})

test('uninstalls a plugin and commits the profile without its package tree', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-uninstall-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const plugin = { name: '@example/dsh-plugin', version: '1.0.0' }
  let manager
  manager = createManager(root, {
    spawn: spawnWithMutation(() => writeUninstalledMutation(manager, plugin.name)),
  })
  createProfile(manager, plugin)
  seedTransactionFiles(manager, 'before-uninstall')

  const result = await manager.uninstall(plugin.name)

  assert.deepEqual(result, { ok: true, name: plugin.name })
  assert.deepEqual(manager.listInstalled(), [])
  assert.equal(fs.existsSync(path.join(manager.profileDir, 'node_modules', '@example', 'dsh-plugin')), false)
  const history = JSON.parse(fs.readFileSync(manager.historyFile, 'utf8'))
  assert.equal(history[0].action, 'uninstall')
  assert.equal(history[0].previousVersion, plugin.version)
  assert.equal(fs.existsSync(manager.transactionFile), false)
})

test('restores metadata and all node_modules content after install, update, or uninstall fails', async (t) => {
  const scenarios = [
    { action: 'install', before: null, attemptedVersion: '1.0.0', metadataFiles: false, nodeModules: false },
    { action: 'update', before: '1.0.0', attemptedVersion: '2.0.0', metadataFiles: true },
    { action: 'uninstall', before: '1.0.0', attemptedVersion: null, metadataFiles: true },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.action, async (subtest) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-plugin-${scenario.action}-rollback-`))
      subtest.after(() => fs.rmSync(root, { recursive: true, force: true }))
      const name = '@example/dsh-plugin'
      const previous = scenario.before ? { name, version: scenario.before } : null
      const attempted = scenario.attemptedVersion ? { name, version: scenario.attemptedVersion } : null
      let manager
      manager = createManager(root, {
        fetchImpl: attempted
          ? registryFetch(name, { [attempted.version]: {} }, attempted.version)
          : undefined,
        spawn: spawnWithMutation(() => {
          if (scenario.action === 'uninstall') writeUninstalledMutation(manager, name)
          else writeInstalledMutation(manager, attempted, `failed-${scenario.action}`)
          fs.writeFileSync(path.join(manager.profileDir, 'node_modules', 'partial.txt'), 'must-not-survive')
        }, 7),
      })
      createProfile(manager, previous)
      seedTransactionFiles(manager, `original-${scenario.action}`, {
        metadata: scenario.metadataFiles,
        nodeModules: scenario.nodeModules,
      })
      const before = captureProfileTransactionState(manager)

      const operation = scenario.action === 'install'
        ? manager.install(name, attempted.version, { acceptRisk: true })
        : (scenario.action === 'update'
            ? manager.update(name, { acceptRisk: true })
            : manager.uninstall(name))
      await assert.rejects(operation, (error) => error.code === 'PLUGIN_COMMAND_FAILED')

      assert.deepEqual(captureProfileTransactionState(manager), before)
      assert.equal(fs.existsSync(manager.transactionFile), false)
      assert.equal(fs.existsSync(manager.historyFile), false)
    })
  }
})

test('rolls back when the plugin command exits successfully without producing the requested package', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-invalid-result-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const name = '@example/dsh-plugin'
  const manager = createManager(root, {
    fetchImpl: registryFetch(name, { '1.0.0': {} }),
    spawn: spawnWithMutation(() => {}),
  })
  createProfile(manager)
  seedTransactionFiles(manager, 'before-invalid-result')
  const before = captureProfileTransactionState(manager)

  await assert.rejects(
    manager.install(name, '1.0.0', { acceptRisk: true }),
    (error) => error.code === 'PLUGIN_RESULT_INVALID',
  )

  assert.deepEqual(captureProfileTransactionState(manager), before)
  assert.equal(fs.existsSync(manager.transactionFile), false)
})

test('recovers an interrupted running transaction by restoring the original tree', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-crash-rollback-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const plugin = { name: '@example/dsh-plugin', version: '1.0.0' }
  const manager = createManager(root)
  createProfile(manager, plugin)
  seedTransactionFiles(manager, 'before-crash')
  const before = captureProfileTransactionState(manager)

  manager.beginTransaction(plugin.name, 'update')
  writeInstalledMutation(manager, { ...plugin, version: '2.0.0' }, 'interrupted')
  assert.equal(fs.existsSync(manager.transactionFile), true)

  const recovered = createManager(root)
  assert.deepEqual(captureProfileTransactionState(recovered), before)
  assert.equal(fs.existsSync(recovered.transactionFile), false)
  assert.equal(fs.existsSync(recovered.historyFile), false)
})

test('finishes a commit-ready transaction after a crash without reverting new modules', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-crash-commit-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const previous = { name: '@example/dsh-plugin', version: '1.0.0' }
  const next = { ...previous, version: '2.0.0' }
  const manager = createManager(root)
  createProfile(manager, previous)
  seedTransactionFiles(manager, 'before-commit')

  const transaction = manager.beginTransaction(previous.name, 'update')
  writeInstalledMutation(manager, next, 'committed')
  manager.writeTransaction(transaction, 'commit-ready')

  const recovered = createManager(root)
  assert.equal(recovered.listInstalled()[0].version, next.version)
  assert.equal(fs.readFileSync(
    path.join(recovered.profileDir, 'node_modules', 'baseline', 'sentinel.txt'),
    'utf8',
  ), 'changed-committed')
  const history = JSON.parse(fs.readFileSync(recovered.historyFile, 'utf8'))
  assert.equal(history.length, 1)
  assert.equal(history[0].action, 'update')
  assert.equal(history[0].previousVersion, previous.version)
  assert.equal(fs.existsSync(path.join(history[0].directory, 'node_modules')), false)
  assert.equal(fs.existsSync(recovered.transactionFile), false)
})
