'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildHarnessEnvironment,
  HarnessManager,
  HarnessManagerError,
} = require('../src/harness-manager.cjs');

const temporaryDirectories = [];

function createFixture(source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-manager-'));
  const runner = path.join(directory, 'fake-runner.cjs');
  const dshBin = path.join(directory, 'fake-dsh-bin.js');
  const workspace = path.join(directory, 'workspace');
  const dshHome = path.join(directory, 'dsh-home');

  fs.mkdirSync(workspace);
  fs.mkdirSync(dshHome);
  fs.writeFileSync(runner, source, 'utf8');
  fs.writeFileSync(dshBin, '// The fake runner validates this path.\n', 'utf8');
  temporaryDirectories.push(directory);

  return { directory, runner, dshBin, workspace, dshHome };
}

function startOptions(fixture) {
  return {
    executable: process.execPath,
    dshBin: fixture.dshBin,
    dshHome: fixture.dshHome,
    workspace: fixture.workspace,
    apiKey: 'test-deepseek-key',
  };
}

function createManager(fixture, options = {}) {
  return new HarnessManager({ runnerPath: fixture.runner, ...options });
}

test.after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('starts dsh in Electron Node mode, parses stderr, emits logs, and stops once', async () => {
  const fixture = createFixture(`
    'use strict';
    const fs = require('node:fs');
    const path = require('node:path');
    const marker = ${JSON.stringify('__MARKER__')};
    const expectedHome = ${JSON.stringify('__HOME__')};
    const expectedWorkspace = ${JSON.stringify('__WORKSPACE__')};
    const expectedDshBin = ${JSON.stringify('__DSH_BIN__')};
    const valid = process.argv[2] === expectedDshBin
      && process.argv[3] === 'web'
      && process.argv[4] === '--host'
      && process.argv[5] === '127.0.0.1'
      && process.argv[6] === '--port'
      && process.argv[7] === '0'
      && process.env.ELECTRON_RUN_AS_NODE === '1'
      && process.env.DSH_HOME === expectedHome
      && process.env.DSH_PERMISSION_MODE === 'workspace-write'
      && process.env.DEEPSEEK_API_KEY === 'test-deepseek-key'
      && process.cwd() === expectedWorkspace;
    if (!valid) process.exit(21);
    process.stderr.write('booting fake dsh\\n');
    process.stderr.write('dsh web: http://127.0.0.1:431');
    setTimeout(() => process.stderr.write('23\\n'), 10);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (text) => {
      if (text.includes('shutdown\\n')) {
        fs.writeFileSync(marker, String(process.pid));
        process.exit(0);
      }
    });
    setInterval(() => {}, 1000);
  `);
  const marker = path.join(fixture.directory, 'stopped.txt');
  const source = fs.readFileSync(fixture.runner, 'utf8')
    .replace('__MARKER__', marker.replace(/\\/g, '\\\\'))
    .replace('__HOME__', fixture.dshHome.replace(/\\/g, '\\\\'))
    .replace('__WORKSPACE__', fixture.workspace.replace(/\\/g, '\\\\'))
    .replace('__DSH_BIN__', fixture.dshBin.replace(/\\/g, '\\\\'));
  fs.writeFileSync(fixture.runner, source, 'utf8');

  const manager = createManager(fixture, { startupTimeoutMs: 5_000, stopTimeoutMs: 1_000 });
  const logs = [];
  const exits = [];
  manager.on('log', (text, event) => logs.push({ text, event }));
  manager.on('exit', (event) => exits.push(event));

  const firstStart = manager.start(startOptions(fixture));
  const duplicateStart = manager.start(startOptions(fixture));
  assert.strictEqual(duplicateStart, firstStart);

  const url = await firstStart;
  assert.equal(url, 'http://127.0.0.1:43123');
  assert.equal(manager.state, 'running');
  assert.equal(manager.url, url);
  assert.ok(logs.some(({ text, event }) => event.stream === 'stderr' && text.includes('booting fake dsh')));

  const firstStop = manager.stop();
  const duplicateStop = manager.stop();
  assert.strictEqual(duplicateStop, firstStop);
  await firstStop;

  assert.equal(manager.state, 'idle');
  assert.equal(manager.process, null);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].expected, true);
  assert.match(fs.readFileSync(marker, 'utf8'), /^\d+$/);
  await manager.stop();
});

test('rejects with a structured timeout error and cleans up the child', async () => {
  const fixture = createFixture(`
    process.stdin.resume();
    process.stdin.on('data', () => process.exit(0));
    setInterval(() => {}, 1000);
  `);
  const manager = createManager(fixture, { startupTimeoutMs: 60, stopTimeoutMs: 500 });

  await assert.rejects(
    manager.start(startOptions(fixture)),
    (error) => {
      assert.ok(error instanceof HarnessManagerError);
      assert.equal(error.code, 'START_TIMEOUT');
      assert.equal(error.details.timeoutMs, 60);
      return true;
    }
  );

  await manager.stop();
  assert.equal(manager.state, 'idle');
});

test('reports an early child exit with its code and recent output', async () => {
  const fixture = createFixture(`
    process.stderr.write('configuration failed\\n');
    process.exit(7);
  `);
  const manager = createManager(fixture, { startupTimeoutMs: 5_000 });

  await assert.rejects(
    manager.start(startOptions(fixture)),
    (error) => {
      assert.equal(error.code, 'EARLY_EXIT');
      assert.equal(error.details.exitCode, 7);
      assert.match(error.details.output, /configuration failed/);
      return true;
    }
  );
});

test('rejects an announced non-loopback URL', async () => {
  const fixture = createFixture(`
    process.stdout.write('dsh web: http://192.168.1.25:4567\\n');
    process.stdin.resume();
    process.stdin.on('data', () => process.exit(0));
    setInterval(() => {}, 1000);
  `);
  const manager = createManager(fixture, { startupTimeoutMs: 5_000, stopTimeoutMs: 500 });

  await assert.rejects(
    manager.start(startOptions(fixture)),
    (error) => {
      assert.equal(error.code, 'INVALID_URL');
      assert.equal(error.details.announcedUrl, 'http://192.168.1.25:4567');
      return true;
    }
  );

  await manager.stop();
});

test('validates the requested bind host before spawning', async () => {
  const fixture = createFixture('process.exit(99);');
  const manager = createManager(fixture);

  await assert.rejects(
    manager.start({ ...startOptions(fixture), host: '0.0.0.0' }),
    (error) => error.code === 'INVALID_OPTIONS' && error.details.field === 'host'
  );
  assert.equal(manager.process, null);
});

test('builds a minimum environment and strips Node injection and provider credentials', () => {
  const environment = buildHarnessEnvironment({
    Path: 'C:\\Windows\\System32',
    TEMP: 'C:\\Temp',
    HTTPS_PROXY: 'http://proxy.test',
    NODE_OPTIONS: '--require malicious.cjs',
    NODE_PATH: 'C:\\untrusted',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    AZURE_CLIENT_SECRET: 'azure-secret',
    GOOGLE_APPLICATION_CREDENTIALS: 'C:\\gcp.json',
    GITHUB_TOKEN: 'github-secret',
    OPENAI_API_KEY: 'openai-secret',
  }, {
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: 'C:\\Harness',
    DSH_PERMISSION_MODE: 'read-only',
    DEEPSEEK_API_KEY: 'deepseek-secret',
  });

  assert.equal(environment.Path, 'C:\\Windows\\System32');
  assert.equal(environment.HTTPS_PROXY, 'http://proxy.test');
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.NODE_PATH, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.AZURE_CLIENT_SECRET, undefined);
  assert.equal(environment.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.DSH_PERMISSION_MODE, 'read-only');
  assert.equal(environment.DEEPSEEK_API_KEY, 'deepseek-secret');
});

test('rejects an unsupported official permission mode before spawning', async () => {
  const fixture = createFixture('process.exit(99);');
  const manager = createManager(fixture);

  await assert.rejects(
    manager.start({ ...startOptions(fixture), permissionMode: 'full-access' }),
    (error) => error.code === 'INVALID_OPTIONS' && error.details.field === 'permissionMode'
  );
  assert.equal(manager.process, null);
});

test('redacts an API key split across output chunks and startup error details', async () => {
  const fixture = createFixture(`
    process.stderr.write('credential=sk-test-');
    setTimeout(() => {
      process.stderr.write('secret-value\\n');
      process.exit(9);
    }, 10);
  `);
  const manager = createManager(fixture, { startupTimeoutMs: 5_000 });
  const logs = [];
  manager.on('log', (text) => logs.push(text));

  await assert.rejects(
    manager.start({ ...startOptions(fixture), apiKey: 'sk-test-secret-value' }),
    (error) => {
      assert.equal(error.code, 'EARLY_EXIT');
      assert.equal(error.details.output.includes('sk-test-secret-value'), false);
      assert.match(error.details.output, /\[REDACTED\]/u);
      return true;
    }
  );
  assert.equal(logs.join('').includes('sk-test-secret-value'), false);
  assert.match(logs.join(''), /\[REDACTED\]/u);
});

test('keeps the child reference when Windows taskkill reports failure', async () => {
  const fixture = createFixture(`
    process.stdout.write('dsh web: http://127.0.0.1:43124\\n');
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `);
  const spawnCommand = () => {
    const killer = new EventEmitter();
    process.nextTick(() => killer.emit('exit', 1, null));
    return killer;
  };
  const manager = createManager(fixture, {
    platform: 'win32',
    spawnCommand,
    startupTimeoutMs: 5_000,
    stopTimeoutMs: 50,
    forceKillTimeoutMs: 100,
  });

  await manager.start(startOptions(fixture));
  const child = manager.process;

  await assert.rejects(manager.stop(), (error) => error.code === 'STOP_FAILED');
  assert.strictEqual(manager.process, child);
  assert.equal(manager.state, 'running');

  child.kill();
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test child did not exit')), 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await manager.stop();
  assert.equal(manager.process, null);
});

test('accepts a nonzero taskkill result when the target exits immediately afterward', async () => {
  const fixture = createFixture(`
    process.stdout.write('dsh web: http://127.0.0.1:43125\\n');
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `);
  let target;
  const spawnCommand = () => {
    const killer = new EventEmitter();
    process.nextTick(() => {
      killer.emit('exit', 1, null);
      setTimeout(() => target.kill(), 10);
    });
    return killer;
  };
  const manager = createManager(fixture, {
    platform: 'win32',
    spawnCommand,
    startupTimeoutMs: 5_000,
    stopTimeoutMs: 50,
    forceKillTimeoutMs: 500,
  });

  await manager.start(startOptions(fixture));
  target = manager.process;
  await manager.stop();

  assert.equal(manager.process, null);
  assert.equal(manager.state, 'idle');
});

test('repeats the graceful shutdown request before invoking taskkill', async () => {
  const fixture = createFixture(`
    'use strict';
    const fs = require('node:fs');
    const marker = ${JSON.stringify('__MARKER__')};
    let requests = 0;
    process.stdout.write('dsh web: http://127.0.0.1:43126\\n');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (text) => {
      requests += (text.match(/shutdown\\n/g) || []).length;
      if (requests >= 2) {
        fs.writeFileSync(marker, String(requests));
        process.exit(0);
      }
    });
    setInterval(() => {}, 1000);
  `);
  const marker = path.join(fixture.directory, 'shutdown-count.txt');
  const source = fs.readFileSync(fixture.runner, 'utf8')
    .replace('__MARKER__', marker.replace(/\\/g, '\\\\'));
  fs.writeFileSync(fixture.runner, source, 'utf8');
  const manager = createManager(fixture, {
    platform: 'win32',
    spawnCommand: () => {
      throw new Error('taskkill should not run after the repeated shutdown succeeds');
    },
    startupTimeoutMs: 5_000,
    stopTimeoutMs: 50,
    forceKillTimeoutMs: 500,
  });

  await manager.start(startOptions(fixture));
  await manager.stop();

  assert.equal(fs.readFileSync(marker, 'utf8'), '2');
  assert.equal(manager.state, 'idle');
});
