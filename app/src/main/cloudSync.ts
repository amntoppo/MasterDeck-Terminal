import WebSocket from 'ws'
import { PROTOCOL_VERSION, type Command, type ExternalItem, type RemoteSnapshot, type ServerToDesktop } from '@shared/remote'
import { fitSnapshot, SNAPSHOT_LIMIT, type RemoteStatus } from '@shared/remoteSnapshot'
import type { RemoteOutcome } from './remoteCommands'

export interface CloudSyncOpts {
  url: string
  token: string
  deviceId: string
  appVersion: string
  run(cmd: Command): Promise<RemoteOutcome>
  onItems(items: ExternalItem[]): void
  onStatus(s: RemoteStatus): void
  debounceMs?: number
  pingMs?: number
  backoff?: { min: number; max: number }
  log?: (line: string) => void
  /** Snapshot size limit in UTF-8 bytes (default SNAPSHOT_LIMIT). */
  limit?: number
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
  private pending: RemoteSnapshot | null = null
  private lastJson: string | null = null
  private sentJson: string | null = null
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
    for (const t of [this.retry, this.ping, this.debounce]) if (t) clearTimeout(t)
    this.retry = this.ping = this.debounce = null
    this.ready = false
    const ws = this.ws
    this.ws = null
    ws?.removeAllListeners()
    ws?.on('error', () => {})
    ws?.close(1000, 'turned off')
    this.set({ conn: 'off', message: null })
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
      const { json, trimmed, oversize } = fitSnapshot(this.pending, this.o.limit ?? SNAPSHOT_LIMIT)
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
        this.set({ message: 'snapshot too large to send' })
        return
      }
      this.lastJson = json
    }
    if (!this.lastJson || this.lastJson === this.sentJson || !this.ready || !this.ws) return
    this.ws.send(`{"t":"snapshot","data":${this.lastJson}}`)
    this.sentJson = this.lastJson
    this.set({ lastSyncAt: Date.now() })
  }

  private connect(): void {
    if (this.stopped) return
    this.set({ conn: 'connecting' })
    const url = `${this.o.url.replace(/\/+$/, '').replace(/^http/, 'ws')}/v1/desktop`
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.o.token}` }, handshakeTimeout: 15_000 })
    this.ws = ws
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', deviceId: this.o.deviceId, appVersion: this.o.appVersion, protocol: PROTOCOL_VERSION }))
    })
    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode ?? 0
      this.set({ conn: 'error', message: code === 401 || code === 403 ? `the backend rejected the token (${code})` : `the backend answered ${code}` })
      ws.removeAllListeners('close')
      ws.on('error', () => {})
      ws.terminate()
      this.later(true)
    })
    ws.on('message', (raw) => this.onMessage(ws, String(raw)))
    ws.on('error', (e) => {
      if (this.st.conn !== 'error') this.set({ conn: 'connecting', message: `cannot reach the backend: ${e.message}` })
    })
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return
      this.ready = false
      if (this.ping) clearInterval(this.ping)
      this.ping = null
      if (code === 4001) this.set({ conn: 'error', message: String(reason) || 'protocol mismatch; update MasterDeck' })
      else if (this.st.conn !== 'error') this.set({ conn: 'connecting', message: `disconnected (${code}); reconnecting` })
      this.later(code === 4001)
    })
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
    switch (m.t) {
      case 'welcome':
        this.ready = true
        this.attempt = 0
        this.set({ conn: 'connected', message: null })
        if (this.ping) clearInterval(this.ping)
        this.ping = setInterval(() => this.send({ t: 'ping' }), this.o.pingMs ?? 30_000)
        this.sentJson = null
        this.flush()
        for (const cmd of m.pending) this.enqueue(cmd)
        return
      case 'command':
        this.enqueue(m.cmd)
        return
      case 'items':
        this.o.onItems(m.items)
        return
      case 'error':
        this.o.log?.(`remote: ${m.code}: ${m.message}`)
        if (m.code === 'protocol') this.set({ conn: 'error', message: m.message })
        return
      default:
        return
    }
  }

  /** One at a time, in order; a result for a dropped socket goes out on the next one (the server re-sends). */
  private enqueue(cmd: Command): void {
    this.chain = this.chain.then(async () => {
      const r = await this.o.run(cmd)
      const msg: Record<string, unknown> = { t: 'result', cmdId: cmd.id, ok: r.ok, message: String(r.message ?? '').slice(0, 2000) }
      if (r.status) msg.status = r.status
      if (r.data !== undefined) msg.data = r.data
      this.send(msg)
    })
  }
}
