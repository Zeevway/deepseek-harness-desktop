'use strict';

const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const { createStreamingLogRedactor } = require('./log-redaction.cjs');

const ANNOUNCEMENT_PATTERN = /dsh web:\s*(https?:\/\/[^\s\u0000-\u001f]+)/i;
const ANSI_PATTERN = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
const HARNESS_ENV_ALLOWLIST = new Set([
  'ALL_PROXY',
  'APPDATA',
  'COLORTERM',
  'COMSPEC',
  'FORCE_COLOR',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]);
const DSH_PERMISSION_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const HARNESS_INJECTED_ENV = new Set([
  'DEEPSEEK_API_KEY',
  'DSH_HOME',
  'DSH_PERMISSION_MODE',
  'ELECTRON_RUN_AS_NODE',
]);

function buildHarnessEnvironment(sourceEnvironment = process.env, injected = {}) {
  const environment = {};
  for (const [name, value] of Object.entries(sourceEnvironment || {})) {
    if (typeof value !== 'string' || !HARNESS_ENV_ALLOWLIST.has(name.toUpperCase())) continue;
    environment[name] = value;
  }

  // These values are owned by the desktop launcher. They are not copied from
  // the parent environment, so NODE_OPTIONS/NODE_PATH and unrelated provider
  // credentials cannot flow into Harness or the tools it starts.
  for (const [name, value] of Object.entries(injected)) {
    if (typeof value === 'string' && HARNESS_INJECTED_ENV.has(name)) environment[name] = value;
  }
  return environment;
}

class HarnessManagerError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message);
    this.name = 'HarnessManagerError';
    this.code = code;
    this.details = details;

    if (cause !== undefined) {
      this.cause = cause;
    }
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

function managerError(code, message, details, cause) {
  return new HarnessManagerError(code, message, details, cause);
}

function isExited(child) {
  return typeof child.exitCode === 'number' || child.signalCode !== null && child.signalCode !== undefined;
}

function normalizedHostname(hostname) {
  let value = String(hostname).trim().toLowerCase();

  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }

  if (value.endsWith('.')) {
    value = value.slice(0, -1);
  }

  return value;
}

function isLoopbackHostname(hostname) {
  const value = normalizedHostname(hostname);

  if (value === 'localhost') {
    return true;
  }

  const addressType = net.isIP(value);

  if (addressType === 4) {
    return value.split('.')[0] === '127';
  }

  if (addressType === 6) {
    return value === '::1' || value === '0:0:0:0:0:0:0:1' || /^::ffff:127\./i.test(value);
  }

  return false;
}

function parseAnnouncedUrl(rawUrl) {
  // A terminal may append punctuation or an ANSI reset directly after the URL.
  const candidate = rawUrl.replace(/[\])},;]+$/, '');
  let parsed;

  try {
    parsed = new URL(candidate);
  } catch (cause) {
    throw managerError(
      'INVALID_URL',
      'DeepSeek Harness announced an invalid URL.',
      { announcedUrl: candidate },
      cause
    );
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopbackHostname(parsed.hostname)) {
    throw managerError(
      'INVALID_URL',
      'DeepSeek Harness announced a non-loopback URL.',
      { announcedUrl: candidate }
    );
  }

  return candidate;
}

function requireNonEmptyString(options, field) {
  if (typeof options[field] !== 'string' || options[field].trim() === '') {
    throw managerError(
      'INVALID_OPTIONS',
      `The ${field} option must be a non-empty string.`,
      { field }
    );
  }

  return options[field];
}

function validateStartOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw managerError('INVALID_OPTIONS', 'Start options are required.', { field: 'options' });
  }

  const host = options.host === undefined ? '127.0.0.1' : requireNonEmptyString(options, 'host');
  const port = options.port === undefined ? 0 : options.port;
  const permissionMode = options.permissionMode === undefined
    ? 'workspace-write'
    : requireNonEmptyString(options, 'permissionMode');

  if (!isLoopbackHostname(host)) {
    throw managerError(
      'INVALID_OPTIONS',
      'The host option must be a loopback address.',
      { field: 'host', value: host }
    );
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw managerError(
      'INVALID_OPTIONS',
      'The port option must be an integer between 0 and 65535.',
      { field: 'port', value: port }
    );
  }

  if (!DSH_PERMISSION_MODES.has(permissionMode)) {
    throw managerError(
      'INVALID_OPTIONS',
      'The permissionMode option is not supported by DeepSeek Harness.',
      { field: 'permissionMode', value: permissionMode }
    );
  }

  return {
    executable: requireNonEmptyString(options, 'executable'),
    dshBin: requireNonEmptyString(options, 'dshBin'),
    dshHome: requireNonEmptyString(options, 'dshHome'),
    workspace: requireNonEmptyString(options, 'workspace'),
    apiKey: requireNonEmptyString(options, 'apiKey'),
    permissionMode,
    host,
    port,
  };
}

class HarnessManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this.startupTimeoutMs = options.startupTimeoutMs ?? 45_000;
    this.announcementSettleMs = options.announcementSettleMs ?? 50;
    this.stopTimeoutMs = options.stopTimeoutMs ?? options.shutdownTimeoutMs ?? 7_000;
    this.forceKillTimeoutMs = options.forceKillTimeoutMs ?? 2_000;
    this.runnerPath = options.runnerPath ?? path.join(__dirname, 'harness-runner.mjs');
    this._spawn = options.spawn ?? childProcess.spawn;
    this._spawnCommand = options.spawnCommand ?? childProcess.spawn;
    this._platform = options.platform ?? process.platform;
    this._createLogRedactor = options.createLogRedactor ?? createStreamingLogRedactor;

    this._state = 'idle';
    this._child = null;
    this._url = null;
    this._startPromise = null;
    this._stopPromise = null;
    this._terminatingChild = null;
    this._cancelStart = null;
  }

  get state() {
    return this._state;
  }

  get url() {
    return this._url;
  }

  get process() {
    return this._child;
  }

  start(options) {
    if (this._state === 'running' && this._child && !isExited(this._child)) {
      return Promise.resolve(this._url);
    }

    if (this._state === 'starting' && this._startPromise) {
      return this._startPromise;
    }

    if (this._state === 'stopping') {
      const stopPromise = this._stopPromise ?? Promise.resolve();
      return stopPromise.then(() => this.start(options));
    }

    let launchOptions;

    try {
      launchOptions = validateStartOptions(options);
    } catch (error) {
      return Promise.reject(error);
    }

    this._state = 'starting';
    const startPromise = this._launch(launchOptions);
    this._startPromise = startPromise;

    startPromise.then(
      () => {
        if (this._startPromise === startPromise) {
          this._startPromise = null;
        }
      },
      () => {
        if (this._startPromise === startPromise) {
          this._startPromise = null;
        }
      }
    );

    return startPromise;
  }

  stop() {
    if (this._stopPromise) {
      return this._stopPromise;
    }

    const child = this._child;

    if (!child || isExited(child)) {
      this._child = null;
      this._url = null;
      this._state = 'idle';
      return Promise.resolve();
    }

    this._state = 'stopping';

    if (this._cancelStart) {
      this._cancelStart();
    }

    return this._beginTermination(child);
  }

  _launch(options) {
    const args = [
      this.runnerPath,
      options.dshBin,
      'web',
      '--host',
      options.host,
      '--port',
      String(options.port),
    ];

    let child;

    try {
      child = this._spawn(options.executable, args, {
        cwd: options.workspace,
        windowsHide: true,
        env: buildHarnessEnvironment(process.env, {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_HOME: options.dshHome,
          DSH_PERMISSION_MODE: options.permissionMode,
          DEEPSEEK_API_KEY: options.apiKey,
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (cause) {
      this._state = 'idle';
      return Promise.reject(
        managerError(
          'SPAWN_FAILED',
          'DeepSeek Harness could not be launched.',
          { executable: options.executable, runnerPath: this.runnerPath, dshBin: options.dshBin },
          cause
        )
      );
    }

    this._child = child;
    this._url = null;

    return new Promise((resolve, reject) => {
      let settled = false;
      let exitHandled = false;
      let recentOutput = '';
      let startupTimer = null;
      let announcementTimer = null;
      const streamState = new Map();

      const emitSanitizedLog = (stream, text) => {
        if (!text) return;
        const data = Buffer.from(text, 'utf8');
        const logEvent = { stream, text, data };
        this.emit('log', text, logEvent);
        this.emit(stream, text);
        recentOutput = `${recentOutput}${text}`.slice(-8_192);
      };

      const flushSanitizedLogs = () => {
        for (const [stream, state] of streamState) {
          emitSanitizedLog(stream, state.logRedactor.flush());
        }
      };

      const cleanupStartup = () => {
        clearTimeout(startupTimer);
        clearTimeout(announcementTimer);
        this._cancelStart = null;
      };

      const fail = (error, terminate = true) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanupStartup();

        if (terminate && this._child === child && !isExited(child)) {
          this._state = 'stopping';
          this._beginTermination(child).catch((stopError) => {
            this.emit('stop-error', stopError);
          });
        } else if (this._child !== child || isExited(child)) {
          this._state = 'idle';
        }

        reject(error);
      };

      const succeed = (announcedUrl) => {
        if (settled || this._state !== 'starting' || this._child !== child) {
          return;
        }

        settled = true;
        cleanupStartup();
        this._state = 'running';
        this._url = announcedUrl;
        this.emit('ready', announcedUrl);
        resolve(announcedUrl);
      };

      const handleOutput = (stream, chunk) => {
        let state = streamState.get(stream);

        if (!state) {
          state = {
            decoder: new StringDecoder('utf8'),
            buffer: '',
            logRedactor: this._createLogRedactor({ secrets: [options.apiKey] }),
          };
          streamState.set(stream, state);
        }

        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const text = state.decoder.write(data);
        emitSanitizedLog(stream, state.logRedactor.write(text));

        if (settled) {
          return;
        }

        state.buffer = `${state.buffer}${text.replace(ANSI_PATTERN, '')}`.slice(-8_192);
        const match = ANNOUNCEMENT_PATTERN.exec(state.buffer);

        if (!match) {
          return;
        }

        const tokenEndsAtBufferBoundary = match.index + match[0].length === state.buffer.length;

        const acceptAnnouncement = () => {
          try {
            succeed(parseAnnouncedUrl(match[1]));
          } catch (error) {
            fail(error);
          }
        };

        clearTimeout(announcementTimer);

        if (tokenEndsAtBufferBoundary) {
          // There is no delimiter yet, so the final chunk may have split a
          // valid URL. A short quiet period also supports output without a
          // trailing newline while avoiding acceptance of a partial port.
          announcementTimer = setTimeout(acceptAnnouncement, this.announcementSettleMs);
          if (typeof announcementTimer.unref === 'function') {
            announcementTimer.unref();
          }
          return;
        }

        acceptAnnouncement();
      };

      const handleChildExit = (code, signal) => {
        if (exitHandled) {
          return;
        }

        exitHandled = true;
        flushSanitizedLogs();
        const expected = this._state === 'stopping';

        if (this._child === child) {
          this._child = null;
          this._url = null;
          this._state = 'idle';
        }

        this.emit('exit', { code, signal, expected });

        if (!settled) {
          fail(
            managerError(
              'EARLY_EXIT',
              'DeepSeek Harness exited before announcing its URL.',
              { exitCode: code, signal, output: recentOutput.trim() },
            ),
            false
          );
        }
      };

      child.once('error', (cause) => {
        fail(
          managerError(
            'SPAWN_FAILED',
            'DeepSeek Harness could not be launched.',
            { executable: options.executable, runnerPath: this.runnerPath, dshBin: options.dshBin },
            cause
          )
        );
      });
      child.once('exit', handleChildExit);
      child.once('close', handleChildExit);

      if (child.stdin) {
        child.stdin.on('error', (error) => this.emit('stdin-error', error));
      }

      if (child.stdout) {
        child.stdout.on('data', (chunk) => handleOutput('stdout', chunk));
      }

      if (child.stderr) {
        child.stderr.on('data', (chunk) => handleOutput('stderr', chunk));
      }

      startupTimer = setTimeout(() => {
        fail(
          managerError(
            'START_TIMEOUT',
            'Timed out while waiting for DeepSeek Harness to announce its URL.',
            { timeoutMs: this.startupTimeoutMs, output: recentOutput.trim() }
          )
        );
      }, this.startupTimeoutMs);

      if (typeof startupTimer.unref === 'function') {
        startupTimer.unref();
      }

      this._cancelStart = () => {
        fail(
          managerError(
            'START_CANCELLED',
            'DeepSeek Harness startup was cancelled.',
            {}
          ),
          false
        );
      };
    });
  }

  _beginTermination(child) {
    if (this._stopPromise && this._terminatingChild === child) {
      return this._stopPromise;
    }

    this._state = 'stopping';
    this._terminatingChild = child;

    let trackedPromise;
    trackedPromise = this._terminateChild(child).then(
      () => {
        if (this._child === child) {
          this._child = null;
          this._url = null;
        }
        this._state = 'idle';
      },
      (error) => {
        if (isExited(child)) {
          if (this._child === child) {
            this._child = null;
            this._url = null;
          }
          this._state = 'idle';
        } else {
          this._state = 'running';
        }
        throw error;
      }
    ).finally(() => {
      if (this._stopPromise === trackedPromise) {
        this._stopPromise = null;
        this._terminatingChild = null;
      }
    });

    this._stopPromise = trackedPromise;
    return trackedPromise;
  }

  async _terminateChild(child) {
    if (isExited(child)) {
      return;
    }

    const termError = this._requestGracefulShutdown(child);

    if (await this._waitForExit(child, this.stopTimeoutMs)) {
      return;
    }

    // Harness treats a repeated shutdown signal as a request to stop immediately.
    const repeatedTermError = this._requestGracefulShutdown(child);
    if (await this._waitForExit(child, this.forceKillTimeoutMs)) {
      return;
    }

    let forceError = repeatedTermError ?? termError;

    try {
      if (this._platform === 'win32') {
        await this._taskkillExactChild(child);
      } else {
        child.kill('SIGKILL');
      }
    } catch (cause) {
      forceError = cause;
    }

    if (await this._waitForExit(child, this.forceKillTimeoutMs)) {
      return;
    }

    throw managerError(
      'STOP_FAILED',
      'DeepSeek Harness did not exit after it was terminated.',
      { pid: child.pid },
      forceError ?? termError
    );
  }

  _requestGracefulShutdown(child) {
    try {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write('shutdown\n');
        return undefined;
      }

      // The packaged runner always has piped stdin. SIGTERM keeps injected
      // children and older runners stoppable on non-Windows platforms.
      if (this._platform !== 'win32') {
        child.kill('SIGTERM');
      }

      return undefined;
    } catch (error) {
      return error;
    }
  }

  _waitForExit(child, timeoutMs) {
    if (isExited(child)) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let complete = false;

      const finish = (exited) => {
        if (complete) {
          return;
        }

        complete = true;
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        child.removeListener('close', onExit);
        resolve(exited);
      };

      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(isExited(child)), timeoutMs);

      child.once('exit', onExit);
      child.once('close', onExit);

      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
  }

  _taskkillExactChild(child) {
    // Re-check ownership immediately before taskkill so an old PID is never reused
    // after this manager has already observed the child exiting.
    if (this._child !== child || isExited(child)) {
      return Promise.resolve();
    }

    const pid = child.pid;

    if (!Number.isInteger(pid) || pid <= 0) {
      return Promise.reject(
        managerError('STOP_FAILED', 'DeepSeek Harness has no valid process ID.', { pid })
      );
    }

    return new Promise((resolve, reject) => {
      let killer;

      try {
        killer = this._spawnCommand('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          shell: false,
          stdio: 'ignore',
        });
      } catch (cause) {
        reject(cause);
        return;
      }

      killer.once('error', reject);
      killer.once('exit', (code, signal) => {
        if (code === 0 || isExited(child)) {
          resolve();
          return;
        }
        reject(
          managerError(
            'STOP_FAILED',
            'taskkill could not stop DeepSeek Harness.',
            { pid, exitCode: code, signal }
          )
        );
      });
    });
  }
}

module.exports = HarnessManager;
module.exports.HARNESS_ENV_ALLOWLIST = HARNESS_ENV_ALLOWLIST;
module.exports.DSH_PERMISSION_MODES = DSH_PERMISSION_MODES;
module.exports.HarnessManager = HarnessManager;
module.exports.HarnessManagerError = HarnessManagerError;
module.exports.buildHarnessEnvironment = buildHarnessEnvironment;
