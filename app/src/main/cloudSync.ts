import WebSocket from 'ws'
import { compare } from 'fast-json-patch'
import { PROTOCOL_VERSION, type Command, type DesktopMsg, type ExternalItem, type RemoteSnapshot, type ServerToDesktop } from '@shared/remote'
import { fitSnapshot, SNAPSHOT_LIMIT, volatileKey, type RemoteStatus } from '@shared/remoteSnapshot'
import type { RemoteOutcome } from './remoteCommands'

const DELETED = 'This account was deleted'

export interface CloudSyncOpts {
  url: string
  token: string
  deviceId: string
  appVersion: string
  run(cmd: Command): Promise<RemoteOutcome>
  onItems(items: ExternalItem[]): void
  onStatus(s: RemoteStatus): void
  /** This Mac was signed out by the server (close 4003, HTTP 401/410); the line has stopped. */
  onSignedOut?: (message?: string) => void
  debounceMs?: number
  /** Snapshots differing only in time, cost or context go out at most this often (default 15 s). */
  minVolatileMs?: number
  /** How long a send may wait for snapshotAck before the next one is full again (default 10 s). */
  ackTimeoutMs?: number
  pingMs?: number
  backoff?: { min: number; max: number }
  log?: (line: string) => void
  /** Snapshot size limit in UTF-8 bytes (default SNAPSHOT_LIMIT). */
  limit?: number
  /** How long an open socket may wait for `welcome` before it is dropped and redialled (default 15 s). */
  welcomeTimeoutMs?: number
  /** How often and how long a transient outcome is re-run before it is sent (default 1 s, 60 s). */
  transientRetry?: { everyMs: number; forMs: number }
  /** The Mac's browser key, sent in hello (protocol 3). */
  macPublicKey?: () => string | null
  /** open / close / frame / browserRequest / browserReveal / browserRevoked, for the browser bridge. */
  onBrowser?: (m: ServerToDesktop) => void
  /** The account the backend says this device belongs to (from welcome), null when it does not say. */
  onUser?: (u: { id: string; email: string } | null) => void
  /** The socket closed or the line stopped: every browser channel is gone. */
  onDisconnect?: () => void
}

/**
 * MasterDeck's line to the remote backend: one outbound socket. Says hello, sends the snapshot
 * (debounced, only when changed, full), runs the commands it gets one at a time in order and
 * returns their results, and hands API-created items to the app. Reconnects with backoff.
 */
export class CloudSync {
  private ws: WebSocket | null = null
  private ready = false
  private stopped = true
  private attempt = 0
  private retry: NodeJS.Timeout | null = null
  private ping: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private welcomeWait: NodeJS.Timeout | null = null
  private pending: RemoteSnapshot | null = null
  private lastJson: string | null = null
  /** lastJson parsed, once per fitted snapshot (patch base and ack bookkeeping reuse it). */
  private lastDoc: object | null = null
  private lastKey: string | null = null
  private sentKey: string | null = null
  private lastVKey: string | null = null
  private sentVKey: string | null = null
  private sentAt = 0
  /** The version and parsed doc the server acknowledged; patches are computed against ackedDoc. */
  private ackedV: number | null = null
  private ackedDoc: unknown = null
  /** Sends not yet acked, oldest first (acks arrive in order). Patches only go out when this is empty. */
  private inflight: { doc: object }[] = []
  /** Oldest unacked fulls dropped from `inflight` (old server that never acks): their acks are ignored. */
  private dropped = 0
  private ackWait: NodeJS.Timeout | null = null
  private defer: NodeJS.Timeout | null = null
  private lastRx = 0
  private welcomed = new WeakSet<WebSocket>()
  private chain: Promise<void> = Promise.resolve()
  private trimLogged = false
  private oversizeLogged = false
  private st: RemoteStatus = { conn: 'off', message: null, lastSyncAt: null }

  constructor(private o: CloudSyncOpts) {}

  status(): RemoteStatus {
    return this.st
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    for (const t of [this.retry, this.ping, this.debounce, this.welcomeWait, this.defer, this.ackWait]) if (t) clearTimeout(t)
    this.retry = this.ping = this.debounce = this.welcomeWait = this.defer = this.ackWait = null
    this.ready = false
    const ws = this.ws
    this.ws = null
    ws?.removeAllListeners()
    ws?.on('error', () => {})
    ws?.close(1000, 'turned off')
    this.set({ conn: 'off', message: null })
    this.o.onDisconnect?.()
  }

  sendBrowser(m: Extract<DesktopMsg, { t: 'frame' | 'browserDecision' | 'browserNonce' | 'browserClose' }>): boolean {
    return this.send(m)
  }

  push(snap: RemoteSnapshot): void {
    this.pending = snap
    if (this.debounce) return
    this.debounce = setTimeout(() => {
      this.debounce = null
      this.flush()
    }, this.o.debounceMs ?? 1000)
  }

  answerItem(itemId: string, answer: string, by: string): boolean {
    return this.send({ t: 'itemAnswered', itemId, answer, by })
  }

  dismissItem(itemId: string): boolean {
    return this.send({ t: 'itemDismissed', itemId })
  }

  private set(p: Partial<RemoteStatus>): void {
    this.st = { ...this.st, ...p }
    this.o.onStatus(this.st)
  }

  private send(m: unknown): boolean {
    if (!this.ws || !this.ready || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(m))
    return true
  }

  private flush(): void {
    if (this.pending) {
      const { snap, json, trimmed, oversize } = fitSnapshot(this.pending, this.o.limit ?? SNAPSHOT_LIMIT)
      this.pending = null
      if (trimmed.length && !this.trimLogged) {
        this.trimLogged = true
        this.o.log?.(`remote: snapshot over the limit; trimmed ${trimmed.join(', ')}`)
      }
      if (oversize) {
        if (!this.oversizeLogged) {
          this.oversizeLogged = true
          this.o.log?.('remote: snapshot still over the limit after trimming; not sent')
        }
        this.lastJson = null
        this.lastDoc = null
        this.lastKey = null
        this.lastVKey = null
        this.set({ message: 'snapshot too large to send' })
        return
      }
      this.lastJson = json
      this.lastDoc = null
      this.lastKey = JSON.stringify({ ...snap, takenAt: 0 })
      this.lastVKey = volatileKey(snap)
    }
    if (!this.lastJson || this.lastKey === this.sentKey || !this.ready || !this.ws) return
    // Only cost/context moved: hold it to one send per minVolatileMs (deferred, never dropped).
    const wait = this.sentAt + (this.o.minVolatileMs ?? 15_000) - Date.now()
    if (this.sentKey !== null && this.lastVKey === this.sentVKey && wait > 0) {
      if (!this.defer)
        this.defer = setTimeout(() => {
          this.defer = null
          this.flush()
        }, wait)
      return
    }
    if (this.defer) clearTimeout(this.defer)
    this.defer = null
    if (this.ackedV !== null && this.inflight.length) return // one patch/full at a time once the server acks; flushed again on the ack
    let out = `{"t":"snapshot","data":${this.lastJson}}`
    let patched = false
    if (this.ackedV !== null) {
      const ops = compare(this.ackedDoc as object, (this.lastDoc ??= JSON.parse(this.lastJson)) as object)
      if (!ops.length) {
        this.sentKey = this.lastKey
        this.sentVKey = this.lastVKey
        return
      }
      const p = JSON.stringify({ t: 'snapshotPatch', base: this.ackedV, ops })
      if (ops.length <= 2000 && p.length <= this.lastJson.length * 0.6) {
        out = p
        patched = true
      }
    }
    this.ws.send(out)
    this.track((this.lastDoc ??= JSON.parse(this.lastJson)) as object, patched)
    this.sentKey = this.lastKey
    this.sentVKey = this.lastVKey
    this.sentAt = Date.now()
    this.set({ lastSyncAt: Date.now(), ...(this.st.message === 'snapshot too large to send' ? { message: null } : {}) })
  }

  private track(doc: object, patched: boolean): void {
    this.inflight.push({ doc })
    // ponytail: an old server never acks; keep the queue short and ignore the acks of what fell off.
    if (!patched && this.inflight.length > 16) {
      this.inflight.shift()
      this.dropped++
    }
    this.arm()
  }

  /** (Re)start the ack timeout while anything is unacked; on expiry the next send is full. */
  private arm(): void {
    if (this.ackWait) clearTimeout(this.ackWait)
    this.ackWait = null
    if (!this.inflight.length) return
    this.ackWait = setTimeout(() => {
      this.ackWait = null
      this.resetAcks()
      this.flush()
    }, this.o.ackTimeoutMs ?? 10_000)
  }

  private resetAcks(): void {
    this.ackedV = null
    this.ackedDoc = null
    this.inflight = []
    this.dropped = 0
    if (this.ackWait) clearTimeout(this.ackWait)
    this.ackWait = null
  }

  private connect(): void {
    if (this.stopped) return
    this.set({ conn: 'connecting' })
    const url = `${this.o.url.replace(/\/+$/, '').replace(/^http/, 'ws')}/v1/desktop`
    let ws: WebSocket
    try {
      ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.o.token}` }, handshakeTimeout: 15_000 })
    } catch (e) {
      // A malformed address (or a token no HTTP header can carry) throws here, not as an 'error' event.
      this.ws = null
      this.set({ conn: 'error', message: `bad backend address or token: ${e instanceof Error ? e.message : String(e)}` })
      this.later(true)
      return
    }
    this.ws = ws
    ws.on('open', () => {
      const macPublicKey = this.o.macPublicKey?.()
      ws.send(JSON.stringify({ t: 'hello', deviceId: this.o.deviceId, appVersion: this.o.appVersion, protocol: PROTOCOL_VERSION, ...(macPublicKey ? { macPublicKey } : {}) }))
      // Open but never welcomed (a proxy, a wedged server): drop it so the close path redials.
      if (this.welcomeWait) clearTimeout(this.welcomeWait)
      this.welcomeWait = setTimeout(() => {
        this.welcomeWait = null
        if (this.ws === ws && !this.welcomed.has(ws)) {
          this.o.log?.('remote: no welcome from the backend; reconnecting')
          ws.terminate()
        }
      }, this.o.welcomeTimeoutMs ?? 15_000)
    })
    ws.on('unexpected-response', (_req, res) => {
      if (this.ws !== ws) return
      const code = res.statusCode ?? 0
      if (code === 401) return this.signedOut()
      if (code === 410) return this.signedOut(DELETED)
      this.set({ conn: 'error', message: code === 401 || code === 403 ? `the backend rejected the token (${code})` : `the backend answered ${code}` })
      ws.removeAllListeners('close')
      ws.on('error', () => {})
      ws.terminate()
      this.later(code === 401 || code === 403)
    })
    ws.on('message', (raw) => {
      if (this.ws !== ws) return
      this.lastRx = Date.now()
      this.onMessage(ws, String(raw))
    })
    ws.on('error', (e) => {
      if (this.ws !== ws) return
      if (this.st.conn !== 'error') this.set({ conn: 'connecting', message: `cannot reach the backend: ${e.message}` })
    })
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return
      const wasWelcomed = this.welcomed.has(ws)
      this.ready = false
      if (this.welcomeWait) clearTimeout(this.welcomeWait)
      this.welcomeWait = null
      if (this.ping) clearInterval(this.ping)
      this.ping = null
      this.o.onDisconnect?.()
      if (code === 4003) return this.signedOut(String(reason) === 'account deleted' ? DELETED : undefined)
      if (code === 4005) this.set({ conn: 'error', message: 'Another Mac is connected to this account' })
      else if (code === 4001) this.set({ conn: 'error', message: String(reason) || 'protocol mismatch; update MasterDeck' })
      else if (this.st.conn !== 'error' && !wasWelcomed && this.st.message?.startsWith('cannot reach')) this.set({ conn: 'connecting' })
      else if (this.st.conn !== 'error') this.set({ conn: 'connecting', message: `disconnected (${code}); reconnecting` })
      this.later(code === 4001 || code === 4005)
    })
  }

  private signedOut(message?: string): void {
    this.stop()
    this.set({ conn: 'off', message: 'Signed out' })
    this.o.onSignedOut?.(message)
  }

  /** Reconnect after a backoff (at the cap for errors the user has to fix). */
  private later(atCap: boolean): void {
    if (this.stopped || this.retry) return
    const { min, max } = this.o.backoff ?? { min: 1000, max: 60_000 }
    const base = atCap ? max : Math.min(max, min * 2 ** this.attempt)
    this.attempt++
    const wait = Math.round(base * (0.5 + Math.random() / 2))
    this.retry = setTimeout(() => {
      this.retry = null
      this.connect()
    }, wait)
  }

  private onMessage(ws: WebSocket, raw: string): void {
    let m: ServerToDesktop
    try {
      m = JSON.parse(raw) as ServerToDesktop
    } catch {
      return
    }
    if (!m || typeof m !== 'object') return
    switch (m.t) {
      case 'welcome':
        if (!Array.isArray(m.pending)) {
          this.o.log?.('remote: malformed welcome ignored')
          return
        }
        if (this.welcomeWait) clearTimeout(this.welcomeWait)
        this.welcomeWait = null
        this.ready = true
        this.attempt = 0
        this.set({ conn: 'connected', message: null })
        if (this.ping) clearInterval(this.ping)
        const pingMs = this.o.pingMs ?? 30_000
        this.ping = setInterval(() => {
          if (Date.now() - this.lastRx > 2 * pingMs) {
            ws.terminate()
            return
          }
          this.send({ t: 'ping' })
        }, pingMs)
        this.sentKey = null
        this.resetAcks()
        this.welcomed.add(ws)
        this.lastRx = Date.now()
        this.o.onUser?.(m.user && typeof m.user.id === 'string' && typeof m.user.email === 'string' ? { id: m.user.id, email: m.user.email } : null)
        this.flush()
        for (const cmd of m.pending) this.enqueue(cmd)
        return
      case 'snapshotAck': {
        if (this.dropped > 0) {
          this.dropped--
          return
        }
        // A late ack after a timeout is stale; the server's base check is the backstop for any other mismatch.
        if (typeof m.v !== 'number' || (this.ackedV !== null && m.v <= this.ackedV)) return
        const sent = this.inflight.shift()
        if (!sent) return
        this.ackedV = m.v
        this.ackedDoc = sent.doc
        this.arm()
        this.flush()
        return
      }
      case 'snapshotNeeded':
        this.resetAcks()
        this.sentKey = null
        this.flush()
        return
      case 'command':
        this.enqueue(m.cmd)
        return
      case 'items':
        if (!Array.isArray(m.items)) {
          this.o.log?.('remote: malformed items ignored')
          return
        }
        this.o.onItems(m.items)
        return
      case 'open':
      case 'close':
      case 'frame':
      case 'browserRequest':
      case 'browserReveal':
      case 'browserRevoked':
        this.o.onBrowser?.(m)
        return
      case 'error':
        this.o.log?.(`remote: ${m.code}: ${m.message}`)
        // A rejected snapshot is never acked; forget what is in flight so the next ack is not credited to it.
        if (m.code === 'bad_message' || m.code === 'too_large') this.resetAcks()
        if (m.code === 'protocol') this.set({ conn: 'error', message: m.message })
        return
      default:
        return
    }
  }

  /**
   * Runs a command until its outcome is final: a transient one (MasterDeck still loading) is run
   * again every second for up to a minute, so it is never reported to the backend as a failure.
   * Stops early (with the last outcome) when the line is stopped.
   */
  private async runSettled(cmd: Command): Promise<RemoteOutcome> {
    const { everyMs, forMs } = this.o.transientRetry ?? { everyMs: 1_000, forMs: 60_000 }
    const until = Date.now() + forMs
    let r = await this.o.run(cmd)
    while (r.transient && !this.stopped && Date.now() + everyMs <= until) {
      await new Promise((res) => setTimeout(res, everyMs))
      r = await this.o.run(cmd)
    }
    if (r.transient) {
      const { transient: _t, ...rest } = r
      return rest
    }
    return r
  }

  /** One at a time, in order; a result for a dropped socket goes out on the next one (the server re-sends). */
  private enqueue(cmd: Command): void {
    this.chain = this.chain.then(async () => {
      let msg: Record<string, unknown>
      try {
        const r = await this.runSettled(cmd)
        msg = { t: 'result', cmdId: cmd.id, ok: r.ok, message: String(r.message ?? '').slice(0, 2000) }
        if (r.status) msg.status = r.status
        if (r.data !== undefined) msg.data = r.data
        JSON.stringify(msg)
      } catch (e) {
        msg = { t: 'result', cmdId: cmd.id, ok: false, message: `failed: ${String(e)}`.slice(0, 2000) }
      }
      this.send(msg)
    }).catch(() => {})
  }
}
