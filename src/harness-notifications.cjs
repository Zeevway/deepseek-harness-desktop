'use strict'

const net = require('node:net')

const MUX_EVENTS_PATH = '/api/events.mux'
const DEFAULT_RECONNECT_DELAY_MS = 1_500
const MAX_SEEN_APPROVALS = 512

function createMuxUrl(baseUrl) {
  const url = new URL(MUX_EVENTS_PATH, baseUrl)
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase()
  const addressType = net.isIP(hostname)
  const loopback = hostname === 'localhost'
    || (addressType === 4 && hostname.split('.')[0] === '127')
    || (addressType === 6 && (hostname === '::1'
      || hostname === '0:0:0:0:0:0:0:1'
      || /^::ffff:127\./u.test(hostname)))
  if (!loopback) throw new TypeError('Harness 通知事件源必须是本机回环地址')
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else throw new TypeError('Harness 通知事件源必须使用 HTTP 或 HTTPS')
  return url.href
}

function defaultWebSocketFactory(url) {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error('当前 Electron 运行时不支持 WebSocket 通知事件流')
  }
  return new globalThis.WebSocket(url)
}

function parseEnvelope(data) {
  if (typeof data !== 'string') return null
  let envelope
  try {
    envelope = JSON.parse(data)
  } catch {
    return null
  }
  if (!envelope
    || envelope.type !== 'server-request'
    || envelope.payload === null
    || Array.isArray(envelope.payload)
    || typeof envelope.payload !== 'object') return null
  return envelope
}

function addBounded(set, value, limit = MAX_SEEN_APPROVALS) {
  if (set.has(value)) return false
  set.add(value)
  while (set.size > limit) set.delete(set.values().next().value)
  return true
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

class HarnessNotificationMonitor {
  constructor(options = {}) {
    this._notify = typeof options.notify === 'function' ? options.notify : () => {}
    this._logger = typeof options.logger === 'function' ? options.logger : () => {}
    this._createWebSocket = options.createWebSocket || defaultWebSocketFactory
    this._listSessions = typeof options.listSessions === 'function' ? options.listSessions : null
    this._loadHistory = typeof options.loadHistory === 'function' ? options.loadHistory : null
    this._setTimeout = options.setTimeout || setTimeout
    this._clearTimeout = options.clearTimeout || clearTimeout
    this._reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
    this._generation = 0
    this._baseUrl = ''
    this._endpoint = ''
    this._socket = null
    this._removeSocketListeners = null
    this._reconnectTimer = null
    this._lastSequenceBySession = new Map()
    this._seenApprovals = new Set()
    this._seenTurnEnds = new Set()
    this._approvalNotifications = new Map()
    this._knownSessions = new Set()
    this._rootSessions = new Set()
    this._rootSessionsReady = this._listSessions === null
    this._pendingCompletions = new Map()
    this._pendingResolution = null
    this._sessionRefresh = null
    this._gapRecoveries = new Map()
  }

  start(baseUrl) {
    const endpoint = createMuxUrl(baseUrl)
    this.stop()
    const generation = this._generation
    this._baseUrl = new URL(baseUrl).href
    this._endpoint = endpoint
    void this._refreshSessionRoots(generation)
    this._connect(generation)
    return endpoint
  }

  stop() {
    this._generation += 1
    this._baseUrl = ''
    this._endpoint = ''
    this._lastSequenceBySession.clear()
    this._seenApprovals.clear()
    this._seenTurnEnds.clear()
    for (const notification of this._approvalNotifications.values()) {
      try { notification?.close?.() } catch {}
    }
    this._approvalNotifications.clear()
    this._knownSessions.clear()
    this._rootSessions.clear()
    this._rootSessionsReady = this._listSessions === null
    this._pendingCompletions.clear()
    this._pendingResolution = null
    this._sessionRefresh = null
    this._gapRecoveries.clear()
    if (this._reconnectTimer !== null) {
      this._clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    const socket = this._socket
    this._socket = null
    this._removeSocketListeners?.()
    this._removeSocketListeners = null
    try { socket?.close() } catch {}
  }

  _connect(generation) {
    if (generation !== this._generation || !this._endpoint) return
    let socket
    try {
      socket = this._createWebSocket(this._endpoint)
    } catch (error) {
      this._log(`notification event connection failed: ${error?.message || String(error)}`)
      this._scheduleReconnect(generation)
      return
    }

    this._socket = socket
    const onOpen = () => this._log('notification event stream connected')
    const onMessage = (event) => {
      if (generation !== this._generation || this._socket !== socket) return
      try {
        this._handleMessage(event?.data, generation)
      } catch (error) {
        this._log(`notification event handling failed: ${error?.message || String(error)}`)
      }
    }
    const onError = () => this._log('notification event stream reported a transport error')
    const onClose = () => {
      removeListeners()
      if (this._socket === socket) this._socket = null
      this._scheduleReconnect(generation)
    }
    const removeListeners = () => {
      socket.removeEventListener?.('open', onOpen)
      socket.removeEventListener?.('message', onMessage)
      socket.removeEventListener?.('error', onError)
      socket.removeEventListener?.('close', onClose)
      if (this._removeSocketListeners === removeListeners) this._removeSocketListeners = null
    }
    this._removeSocketListeners = removeListeners
    socket.addEventListener('open', onOpen)
    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
  }

  _scheduleReconnect(generation) {
    if (generation !== this._generation || !this._endpoint || this._reconnectTimer !== null) return
    this._reconnectTimer = this._setTimeout(() => {
      this._reconnectTimer = null
      this._connect(generation)
    }, this._reconnectDelayMs)
    this._reconnectTimer?.unref?.()
  }

  _handleMessage(data, generation = this._generation) {
    const envelope = parseEnvelope(data)
    if (!envelope) {
      this._log('notification event stream dropped a malformed frame')
      return
    }
    const frame = envelope.payload
    if (frame.type === 'session/subscribed') {
      if (isNonEmptyString(frame.sessionId) && Number.isSafeInteger(frame.lastSeq) && frame.lastSeq >= -1) {
        if (!this._lastSequenceBySession.has(frame.sessionId)) {
          this._lastSequenceBySession.set(frame.sessionId, frame.lastSeq)
        } else {
          const previous = this._lastSequenceBySession.get(frame.sessionId)
          if (frame.lastSeq > previous) this._queueGapRecovery(frame.sessionId, previous, frame.lastSeq, generation)
        }
      }
      return
    }

    if (frame.type === 'session/event') {
      const sessionId = frame.sessionId
      const event = frame.event
      if (!isNonEmptyString(sessionId)
        || !event
        || !Number.isSafeInteger(event.seq)
        || event.seq < 0) return
      const previous = this._lastSequenceBySession.get(sessionId) ?? Number.NEGATIVE_INFINITY
      if (event.seq <= previous) return
      this._lastSequenceBySession.set(sessionId, event.seq)
      this._considerTurnEnd(sessionId, event, generation)
      return
    }

    if (frame.type === 'approval/requested') {
      if (!isNonEmptyString(frame.sessionId) || !isNonEmptyString(frame.approvalId)) return
      const key = `${frame.sessionId}:${frame.approvalId}`
      if (!addBounded(this._seenApprovals, key)) return
      const toolName = typeof frame.toolName === 'string' && frame.toolName.trim()
        ? frame.toolName.trim().slice(0, 120)
        : '某项操作'
      const notification = this._emitNotification('Harness 需要批准', `工具 ${toolName} 正在等待你的决定。`)
      if (notification && typeof notification.close === 'function') {
        this._approvalNotifications.set(key, notification)
        notification.once?.('close', () => {
          if (this._approvalNotifications.get(key) === notification) {
            this._approvalNotifications.delete(key)
          }
        })
        while (this._approvalNotifications.size > MAX_SEEN_APPROVALS) {
          const [oldestKey, oldest] = this._approvalNotifications.entries().next().value
          this._approvalNotifications.delete(oldestKey)
          try { oldest?.close?.() } catch {}
        }
      }
      return
    }

    if (frame.type === 'approval/resolved') {
      if (!isNonEmptyString(frame.sessionId) || !isNonEmptyString(frame.approvalId)) return
      const key = `${frame.sessionId}:${frame.approvalId}`
      addBounded(this._seenApprovals, key)
      const notification = this._approvalNotifications.get(key)
      this._approvalNotifications.delete(key)
      try { notification?.close?.() } catch {}
      return
    }

    if (frame.type === 'stream/error') {
      this._log(`notification event stream error: ${frame.error?.code || 'unknown'}`)
    }
  }

  _emitNotification(title, body) {
    try {
      return this._notify(title, body)
    } catch (error) {
      this._log(`notification dispatch failed: ${error?.message || String(error)}`)
      return undefined
    }
  }

  _considerTurnEnd(sessionId, event, generation) {
    if (event?.type !== 'turn/end'
      || event.data?.reason?.kind !== 'completed'
      || !Number.isInteger(event.seq)) return
    const key = `${sessionId}:${event.seq}`
    if (!addBounded(this._seenTurnEnds, key, 2_048)) return
    if (this._listSessions === null || this._rootSessions.has(sessionId)) {
      this._emitNotification('Harness 本轮处理已完成', '当前会话已完成本轮处理。')
      return
    }
    if (this._rootSessionsReady && this._knownSessions.has(sessionId)) return
    this._pendingCompletions.set(key, { sessionId, generation })
    this._schedulePendingResolution(generation)
  }

  _schedulePendingResolution(generation) {
    if (this._listSessions === null || generation !== this._generation) return
    if (this._pendingResolution) return
    const resolution = (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await this._refreshSessionRoots(generation)
        if (generation !== this._generation) return
        this._flushPendingCompletions(generation)
        if (![...this._pendingCompletions.values()].some((entry) => entry.generation === generation)) return
      }
      for (const [key, pending] of this._pendingCompletions) {
        if (pending.generation === generation) this._pendingCompletions.delete(key)
      }
      this._log('notification session catalog did not identify one or more completed sessions')
    })()
      .catch((error) => this._log(`notification session resolution failed: ${error?.message || String(error)}`))
      .finally(() => {
        if (this._pendingResolution === resolution) this._pendingResolution = null
      })
    this._pendingResolution = resolution
  }

  _flushPendingCompletions(generation) {
    for (const [key, pending] of this._pendingCompletions) {
      if (pending.generation !== generation) {
        this._pendingCompletions.delete(key)
        continue
      }
      if (!this._knownSessions.has(pending.sessionId)) continue
      this._pendingCompletions.delete(key)
      if (this._rootSessions.has(pending.sessionId)) {
        this._emitNotification('Harness 本轮处理已完成', '当前会话已完成本轮处理。')
      }
    }
  }

  _queueGapRecovery(sessionId, afterSeq, throughSeq, generation) {
    if (this._loadHistory === null) {
      this._log(`notification event gap could not be recovered for session ${sessionId}`)
      return
    }
    const previous = this._gapRecoveries.get(sessionId) || Promise.resolve()
    const recovery = previous.then(() => this._recoverGap(sessionId, afterSeq, throughSeq, generation))
      .catch((error) => this._log(`notification event gap recovery failed: ${error?.message || String(error)}`))
      .finally(() => {
        if (this._gapRecoveries.get(sessionId) === recovery) this._gapRecoveries.delete(sessionId)
      })
    this._gapRecoveries.set(sessionId, recovery)
  }

  async _recoverGap(sessionId, afterSeq, throughSeq, generation) {
    let beforeSeq
    for (let page = 0; page < 100; page += 1) {
      if (generation !== this._generation || !this._baseUrl) return
      const result = await this._loadHistory({
        baseUrl: this._baseUrl,
        sessionId,
        beforeSeq,
        maxMessages: 50,
      })
      if (generation !== this._generation) return
      const entries = Array.isArray(result?.events) ? result.events : []
      let minimum = Number.POSITIVE_INFINITY
      for (const entry of entries) {
        const event = entry?.event
        if (!Number.isInteger(event?.seq)) continue
        minimum = Math.min(minimum, event.seq)
        if (event.seq > afterSeq && event.seq <= throughSeq) {
          this._considerTurnEnd(sessionId, event, generation)
        }
      }
      if (!result?.hasMore || !Number.isFinite(minimum) || minimum <= afterSeq) break
      beforeSeq = minimum
    }
    const current = this._lastSequenceBySession.get(sessionId) ?? Number.NEGATIVE_INFINITY
    this._lastSequenceBySession.set(sessionId, Math.max(current, throughSeq))
  }

  async _refreshSessionRoots(generation) {
    if (this._listSessions === null || generation !== this._generation || !this._baseUrl) return
    if (this._sessionRefresh) return this._sessionRefresh
    const refresh = Promise.resolve()
      .then(() => this._listSessions(this._baseUrl))
      .then((result) => {
        if (generation !== this._generation) return
        const items = Array.isArray(result) ? result : (Array.isArray(result?.items) ? result.items : [])
        this._knownSessions = new Set(items.map((item) => item?.sessionId).filter(Boolean))
        this._rootSessions = new Set(items
          .filter((item) => item?.sessionId && !item.parentSessionId && item.origin !== 'subagent')
          .map((item) => item.sessionId))
        this._rootSessionsReady = true
        this._flushPendingCompletions(generation)
      })
      .catch((error) => this._log(`notification session catalog refresh failed: ${error?.message || String(error)}`))
      .finally(() => {
        if (this._sessionRefresh === refresh) this._sessionRefresh = null
      })
    this._sessionRefresh = refresh
    return refresh
  }

  _log(message) {
    try { this._logger(message) } catch {}
  }
}

module.exports = {
  DEFAULT_RECONNECT_DELAY_MS,
  HarnessNotificationMonitor,
  MUX_EVENTS_PATH,
  addBounded,
  createMuxUrl,
  parseEnvelope,
}
