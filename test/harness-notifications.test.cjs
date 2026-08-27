'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const {
  HarnessNotificationMonitor,
  createMuxUrl,
  parseEnvelope,
} = require('../src/harness-notifications.cjs')

class FakeSocket {
  constructor() {
    this.closed = false
    this.listeners = new Map()
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event)
  }

  close() {
    this.closed = true
  }
}

class FakeNotification extends EventEmitter {
  constructor() {
    super()
    this.closeCount = 0
  }

  close() {
    this.closeCount += 1
    this.emit('close')
  }
}

function envelope(payload) {
  return JSON.stringify({ type: 'server-request', rpcId: 'push-1', payload })
}

function send(socket, payload) {
  socket.emit('message', { data: envelope(payload) })
}

function completed(seq) {
  return { type: 'turn/end', seq, time: Date.now(), data: { reason: { kind: 'completed' } } }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('accepts only loopback HTTP event sources and ignores malformed envelopes', () => {
  assert.equal(createMuxUrl('http://127.0.0.1:43123/'), 'ws://127.0.0.1:43123/api/events.mux')
  assert.equal(createMuxUrl('https://[::1]:43123/base'), 'wss://[::1]:43123/api/events.mux')
  assert.throws(() => createMuxUrl('https://example.com'), /回环地址/u)
  assert.throws(() => createMuxUrl('file:///tmp/harness'), /回环地址|HTTP/u)

  for (const value of [
    null,
    Buffer.from('{}'),
    '',
    '{',
    'null',
    '[]',
    JSON.stringify({ type: 'server-request', payload: null }),
    JSON.stringify({ type: 'server-response', payload: {} }),
  ]) {
    assert.equal(parseEnvelope(value), null)
  }
})

test('baselines existing history, notifies only completed root turns, and deduplicates sequence numbers', async () => {
  const socket = new FakeSocket()
  const notifications = []
  const monitor = new HarnessNotificationMonitor({
    createWebSocket: () => socket,
    listSessions: async () => ({
      items: [
        { sessionId: 'root', running: true },
        { sessionId: 'child', parentSessionId: 'root', origin: 'subagent', running: true },
      ],
    }),
    notify: (title, body) => notifications.push({ title, body }),
  })

  monitor.start('http://localhost:43123')
  await tick()
  send(socket, { type: 'session/subscribed', sessionId: 'root', lastSeq: 10 })
  send(socket, { type: 'session/subscribed', sessionId: 'child', lastSeq: 20 })
  assert.deepEqual(notifications, [])

  send(socket, { type: 'session/event', sessionId: 'root', event: completed(11) })
  send(socket, { type: 'session/event', sessionId: 'root', event: completed(11) })
  send(socket, {
    type: 'session/event',
    sessionId: 'root',
    event: { type: 'turn/end', seq: 12, time: Date.now(), data: { reason: { kind: 'aborted' } } },
  })
  send(socket, { type: 'session/event', sessionId: 'child', event: completed(21) })
  await tick()

  assert.deepEqual(notifications, [{
    title: 'Harness 本轮处理已完成',
    body: '当前会话已完成本轮处理。',
  }])
  monitor.stop()
})

test('approval requests notify for every session, deduplicate replay, and close when resolved', async () => {
  const socket = new FakeSocket()
  const notifications = []
  const monitor = new HarnessNotificationMonitor({
    createWebSocket: () => socket,
    listSessions: async () => ({ items: [] }),
    notify: (title, body) => {
      const notification = new FakeNotification()
      notifications.push({ title, body, notification })
      return notification
    },
  })

  monitor.start('http://127.0.0.1:43123')
  await tick()
  const request = {
    type: 'approval/requested',
    sessionId: 'child',
    approvalId: 'approval-1',
    toolName: 'write_file',
  }
  send(socket, request)
  send(socket, request)
  send(socket, { ...request, approvalId: '' })

  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].title, 'Harness 需要批准')
  assert.match(notifications[0].body, /write_file/u)

  send(socket, {
    type: 'approval/resolved',
    sessionId: 'child',
    approvalId: 'approval-1',
    outcome: 'approved',
  })
  assert.equal(notifications[0].notification.closeCount, 1)
  send(socket, request)
  assert.equal(notifications.length, 1)
  monitor.stop()
})

test('reconnect history recovery paginates across the sequence gap without replaying the baseline', async () => {
  const sockets = []
  const timers = []
  const historyPayloads = []
  const notifications = []
  const monitor = new HarnessNotificationMonitor({
    createWebSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    setTimeout: (callback) => {
      const timer = { callback, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimeout: () => {},
    listSessions: async () => ({ items: [{ sessionId: 'root' }] }),
    loadHistory: async (payload) => {
      historyPayloads.push(payload)
      if (payload.beforeSeq === undefined) {
        return {
          events: [{ event: completed(5) }, { event: completed(6) }],
          hasMore: true,
        }
      }
      return { events: [{ event: completed(4) }], hasMore: false }
    },
    notify: (title, body) => notifications.push({ title, body }),
  })

  monitor.start('http://127.0.0.1:43123')
  await tick()
  send(sockets[0], { type: 'session/subscribed', sessionId: 'root', lastSeq: 3 })
  sockets[0].emit('close')
  assert.equal(timers.length, 1)
  timers[0].callback()
  assert.equal(sockets.length, 2)
  send(sockets[1], { type: 'session/subscribed', sessionId: 'root', lastSeq: 6 })
  await tick()
  await tick()

  assert.deepEqual(historyPayloads.map((payload) => payload.beforeSeq), [undefined, 5])
  assert.equal(notifications.length, 3)
  send(sockets[1], { type: 'session/event', sessionId: 'root', event: completed(6) })
  assert.equal(notifications.length, 3)
  monitor.stop()
})

test('stop closes the active socket and invalidates reconnect callbacks and old messages', async () => {
  const sockets = []
  const timers = []
  const notifications = []
  const monitor = new HarnessNotificationMonitor({
    createWebSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    setTimeout: (callback) => {
      const timer = { callback, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimeout: () => {},
    notify: (title, body) => notifications.push({ title, body }),
  })

  monitor.start('http://127.0.0.1:43123')
  send(sockets[0], { type: 'session/subscribed', sessionId: 'root', lastSeq: 1 })
  sockets[0].emit('close')
  assert.equal(timers.length, 1)
  monitor.stop()
  timers[0].callback()
  send(sockets[0], { type: 'session/event', sessionId: 'root', event: completed(2) })
  await tick()

  assert.equal(sockets.length, 1)
  assert.equal(sockets[0].closed, false)
  assert.deepEqual(notifications, [])
})
