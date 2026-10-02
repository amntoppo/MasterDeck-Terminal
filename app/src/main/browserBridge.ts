import { compare } from 'fast-json-patch'
import { checkCommitment, E2EError, macHandshake, randomNonce, words, type Channel, type Hs1, type Hs3 } from '@shared/e2e'
import { CH } from '@shared/ipc'
import { ARG_FIX, DECK_ACCESS, type Access } from '@shared/remoteDeck'
import { MAX_FRAME, PROTOCOL_VERSION, type DesktopMsg, type ServerToDesktop } from '@shared/remote'
import type { MacToWeb, WebToMac } from '@shared/bridgeWire'
import type { BrowserRequestView } from '@shared/types'
import type { ApprovedBrowser, BrowserStore } from './browserStore'

export type { MacToWeb, WebToMac } from '@shared/bridgeWire'

type BrowserOut = Extract<DesktopMsg, { t: 'frame' | 'browserDecision' | 'browserNonce' | 'browserClose' }>

export interface BridgeDeps {
  store: BrowserStore
  key: () => { pair: CryptoKeyPair; publicKey: string } | null
  /** The signed-in account, only when CloudSync's welcome.user and Account agree. */
  account: () => { userId: string; email: string } | null
  send: (m: BrowserOut) => boolean
  /** DELETE /v1/browsers/:id with the device token; true when the backend revoked it. */
  revokeRemote: (id: string) => Promise<boolean>
  /** IpcRegistry.call */
  call: (ch: string, args: unknown[]) => Promise<unknown>
  /** Pending requests, the browser list or the warning changed. */
  onChange: () => void
  hello: { appVersion: string; platform: string; home: string }
  now?: () => number
  batchMs?: number
  stateMs?: number
  /** At most one resync-triggered full per connection this often. */
  resyncMs?: number
  log?: (line: string) => void
}

const BLOCKED = 'Not available on the web yet'
const HOUR = 3_600_000
const MAX_UNREVEALED = 3
const MAX_NONCES_PER_HOUR = 10
const MAX_CALLS_PER_SEC = 200
const REQUEST_TTL = 5 * 60_000
/** PaneSpec kinds the web screens open: session/master panes, shell tabs, and the ticket/workflow builders and tool installer. */
const WEB_PANES = new Set(['attach', 'shell', 'ticket-builder', 'builder', 'installer'])
const PER_ID = [CH.ptyData, CH.ptyExit]
/** PTY data per frame: even all-escaped JSON (6x) stays under MAX_FRAME after GCM + base64. */
const PTY_CHUNK = 128 * 1024
/** Base64url length of a sealed message whose JSON is this many UTF-8 bytes (+16 GCM tag). */
const sealedLen = (bytes: number) => Math.ceil(((bytes + 16) * 4) / 3)
const tooBig = (m: unknown) => sealedLen(Buffer.byteLength(JSON.stringify(m) ?? '')) > MAX_FRAME
const later = (ms: number, f: () => void) => setTimeout(f, Math.max(0, ms)).unref?.()
const isHs1 = (d: string) => {
  try {
    return (JSON.parse(d) as { k?: unknown } | null)?.k === 'hs1'
  } catch {
    return false
  }
}

/** Account state changed: approved browsers go on sign-out or when another email signs in (RF1). */
export function accountChange(lastEmail: string | null, s: { kind: string; email?: string }): { forget: boolean; email: string | null } {
  if (s.kind === 'signedOut') return { forget: true, email: null }
  if (s.kind === 'signedIn') return { forget: !!lastEmail && s.email !== lastEmail, email: s.email ?? null }
  return { forget: false, email: lastEmail } // pending: keep the last signed-in email
}
/** The backend's welcome.user moved to another account id. */
export const userChanged = (prev: { id: string } | null, next: { id: string } | null) => !!prev && !!next && prev.id !== next.id
const EVENTS = new Map(Object.values(DECK_ACCESS).flatMap((a) => (a.kind === 'event' ? [[a.ch, !!a.perId] as const] : [])))

interface Pending { id: string; name: string; email: string; commit: string; nM: string; expiresAt: number; publicKey?: string; nB?: string; words?: [string, string, string] }
interface Conn {
  b: string
  name: string
  pub: string
  state: 'hs1' | 'busy' | 'hs3' | 'open' | 'closed'
  confirm?: (hs3: Hs3) => Promise<Channel>
  ch?: Channel
  subs: Set<string>
  visible: boolean
  /** When the channel opened, and what the web said it runs on (sanitized, null until it does). */
  connectedAt?: number
  device: string | null
  /** Took over from an earlier channel of this browser: that channel's late frames are ignored, not failures. */
  replaced: boolean
  calls: number[]
  lastState?: string
  /** Patch-capable state subscriber: `sent` is our own parsed copy of lastState (the evp base), `n` its number. */
  patches: boolean
  sent?: unknown
  n: number
  resyncAt: number
  resyncTimer?: NodeJS.Timeout
  stateAt: number
  stateNext?: unknown
  stateTimer?: NodeJS.Timeout
  ptyBuf: Map<string, { d: string; seq: unknown }>
  ptyTimer?: NodeJS.Timeout
}

/**
 * The Mac end of browser control (spec §1-§4): approval by commit-reveal words, one encrypted channel per
 * approved browser, DeckApi calls through the allowlist, and event fan-out. The Mac's store is authoritative.
 */
export class BrowserBridge {
  private conns = new Map<string, Conn>()
  private pending = new Map<string, Pending>()
  private nonceTimes: number[] = []
  private failures = new Map<string, { name: string; at: number[] }>()
  private now: () => number

  constructor(private d: BridgeDeps) {
    this.now = d.now ?? Date.now
  }

  async onServer(m: ServerToDesktop): Promise<void> {
    switch (m.t) {
      case 'browserRequest': return this.onRequest(m)
      case 'browserReveal': return this.onReveal(m)
      case 'open': return this.onOpen(m)
      case 'frame': return this.onFrame(m.b, m.d)
      case 'close': {
        const c = this.conns.get(m.b)
        if (c) this.drop(c)
        return
      }
      case 'browserRevoked':
        this.forget(m.id)
        return
    }
  }

  /** A renderer event (from emit()); channels are full, e.g. `pty:data:<id>`. */
  event(ch: string, args: unknown[]): void {
    const prefix = PER_ID.find((p) => ch.startsWith(p + ':'))
    const ev = prefix ?? ch, arg = prefix ? ch.slice(prefix.length + 1) : undefined
    let stateJson: string | undefined
    for (const c of this.conns.values()) {
      if (c.state !== 'open' || !c.subs.has(ch)) continue
      if (ch === CH.state) {
        stateJson ??= JSON.stringify(args[0])
        // A pending timer always takes the latest (A sent, B, A → nothing stale goes out); it dedupes when it fires.
        if (c.stateTimer || stateJson !== c.lastState) this.queueState(c, args[0])
      } else if (ev === CH.ptyData) {
        if (!c.visible) continue
        const buf = c.ptyBuf.get(arg!)
        const d = (buf?.d ?? '') + String(args[0])
        c.ptyBuf.set(arg!, { d, seq: args[1] })
        if (d.length >= PTY_CHUNK) this.flushPty(c) // heavy output: don't wait to build one huge frame
        else c.ptyTimer ??= setTimeout(() => this.flushPty(c), this.d.batchMs ?? 50)
      } else {
        if (ev === CH.ptyExit) this.flushPty(c)
        void this.out(c, { k: 'ev', ev, ...(arg !== undefined ? { arg } : {}), v: args })
      }
    }
  }

  async decide(id: string, allow: boolean): Promise<void> {
    const p = this.live().get(id)
    if (!p?.publicKey) return
    const a = this.d.account()
    const ok = allow && !!a
    // Not sent (the Mac is offline): keep the prompt; the user decides again once the line is back.
    if (!this.d.send({ t: 'browserDecision', id, allow: ok })) {
      this.d.log?.(`browser request ${id}: decision not sent; your Mac is offline`)
      return
    }
    this.pending.delete(id)
    if (ok) this.d.store.add(a.userId, { id, name: p.name, publicKey: p.publicKey, approvedAt: this.now() })
    this.d.onChange()
  }

  /**
   * Revoke from the Mac: the backend first, so the hub closes the browser with 4003 (revoked) rather than 4008, then
   * locally. Local always happens (the Mac is authoritative); the result says whether the backend got it.
   */
  async revoke(id: string): Promise<boolean> {
    const ok = await this.d.revokeRemote(id).catch(() => false)
    const c = this.conns.get(id)
    if (c) this.close(c)
    this.forget(id)
    return ok
  }

  requests(): BrowserRequestView[] {
    return [...this.live().values()].flatMap((p) => (p.words ? [{ id: p.id, name: p.name, email: p.email, words: p.words, expiresAt: p.expiresAt }] : []))
  }

  browsers(): (ApprovedBrowser & { connected: boolean; connectedAt?: number; device?: string | null })[] {
    const a = this.d.account()
    return a
      ? this.d.store.list(a.userId).map((b) => {
          const c = this.conns.get(b.id)
          return c?.state === 'open' ? { ...b, connected: true, connectedAt: c.connectedAt, device: c.device } : { ...b, connected: false }
        })
      : []
  }

  /** "Possible tampering…" after 3 channel failures for one browser within an hour. */
  warning(): string | null {
    const t = this.now()
    for (const f of this.failures.values()) if (f.at.filter((x) => x > t - HOUR).length >= 3) return `Possible tampering on the connection to ${f.name}`
    return null
  }

  /** Sign-out, account change: channels and approval requests go. */
  closeAll(): void {
    for (const c of [...this.conns.values()]) this.close(c)
    this.pending.clear()
    this.d.onChange()
  }

  /** The line to the backend dropped: channels are gone, approval requests stay (they complete after the reconnect). */
  dropChannels(): void {
    for (const c of [...this.conns.values()]) this.drop(c)
    this.d.onChange()
  }

  // ---- approval ----

  private async onRequest(m: Extract<ServerToDesktop, { t: 'browserRequest' }>): Promise<void> {
    const deny = () => void this.d.send({ t: 'browserDecision', id: m.id, allow: false })
    const a = this.d.account(), key = this.d.key()
    if (!a || !key || typeof m.email !== 'string' || m.email !== a.email) return deny()
    const t = this.now()
    const held = this.live().get(m.id)
    if (held) {
      // Re-sent after a reconnect: same nonce, no new one spent.
      if (!held.publicKey) this.d.send({ t: 'browserNonce', id: m.id, macPublicKey: key.publicKey, nonce: held.nM })
      return
    }
    this.nonceTimes = this.nonceTimes.filter((x) => x > t - HOUR)
    const unrevealed = [...this.pending.values()].filter((p) => !p.publicKey).length
    if (unrevealed >= MAX_UNREVEALED || this.nonceTimes.length >= MAX_NONCES_PER_HOUR) {
      this.d.log?.(`browser request ${m.id} refused: too many approval requests`)
      return deny()
    }
    this.nonceTimes.push(t)
    const nM = randomNonce()
    this.pending.set(m.id, {
      id: m.id,
      name: [...String(m.name).replace(/[\p{Cc}\p{Cf}]/gu, '')].slice(0, 80).join(''),
      email: m.email,
      commit: String(m.commit),
      nM,
      // The backend may lie about the expiry; never longer than 5 minutes from now.
      expiresAt: Math.min(Number(m.expiresAt) || 0, t + REQUEST_TTL),
    })
    this.d.send({ t: 'browserNonce', id: m.id, macPublicKey: key.publicKey, nonce: nM })
    // Expiry: drop the prompt (and log an unrevealed request) without waiting for another change.
    later(this.pending.get(m.id)!.expiresAt - t + 1, () => {
      this.live()
      this.d.onChange()
    })
  }

  private async onReveal(m: Extract<ServerToDesktop, { t: 'browserReveal' }>): Promise<void> {
    const p = this.live().get(m.id), key = this.d.key()
    const deny = (why: string) => {
      this.pending.delete(m.id)
      this.d.log?.(`browser request ${m.id} denied: ${why}`)
      this.d.send({ t: 'browserDecision', id: m.id, allow: false })
      this.d.onChange()
    }
    if (!p || !key) return deny('no such request')
    // The same reveal again (re-sent after a reconnect): keep the words.
    if (p.publicKey && p.publicKey === m.publicKey && p.nB === m.nonce) return
    if (p.publicKey) return deny('revealed twice')
    if (!(await checkCommitment(p.commit, m.publicKey, m.nonce))) return deny('commitment mismatch')
    let w: [string, string, string]
    try {
      w = await words(key.publicKey, m.publicKey, p.nM, m.nonce)
    } catch {
      return deny('malformed reveal')
    }
    if (this.pending.get(m.id) !== p) return
    p.publicKey = m.publicKey
    p.nB = m.nonce
    p.words = w
    this.d.onChange()
  }

  /** Pending requests still in time; the expired ones are dropped (logged when never revealed). */
  private live(): Map<string, Pending> {
    const t = this.now()
    for (const p of this.pending.values())
      if (p.expiresAt <= t) {
        this.pending.delete(p.id)
        if (!p.publicKey) this.d.log?.(`browser request ${p.id} expired without a reveal`)
      }
    return this.pending
  }

  private forget(id: string): void {
    const c = this.conns.get(id)
    if (c) this.drop(c)
    this.d.store.remove(id)
    this.pending.delete(id)
    this.d.onChange()
  }

  // ---- channel ----

  private onOpen(m: Extract<ServerToDesktop, { t: 'open' }>): void {
    const a = this.d.account()
    const known = a ? this.d.store.get(a.userId, m.b) : null
    const old = this.conns.get(m.b)
    if (old) this.drop(old)
    if (!known || known.publicKey !== m.publicKey || !this.d.key()) {
      const close = () => void this.d.send({ t: 'browserClose', b: m.b })
      // Not ours under this account (e.g. approved before an account switch): revoke its backend row too, so the
      // hub closes it with 4003 and the browser asks for approval again instead of reconnecting forever.
      if (a && !known) void this.d.revokeRemote(m.b).catch(() => false).then(close)
      else close()
      return
    }
    this.conns.set(m.b, { b: m.b, name: known.name, pub: known.publicKey, state: 'hs1', subs: new Set(), visible: true, device: null, replaced: !!old, calls: [], patches: false, n: 0, resyncAt: -Infinity, stateAt: 0, ptyBuf: new Map() })
  }

  private async onFrame(b: string, d: string): Promise<void> {
    const c = this.conns.get(b)
    if (!c) return
    if (typeof d !== 'string' || d.length > MAX_FRAME) return this.fail(c, 'frame too large')
    if (c.state === 'hs1' && c.replaced && !isHs1(d)) return // a late frame of the superseded channel: not a failure
    if (c.state === 'hs1' || c.state === 'hs3') return this.handshake(c, d)
    if (c.state !== 'open') return this.fail(c, 'frame during handshake')
    let msg: WebToMac
    try {
      msg = (await c.ch!.open(d)) as WebToMac
    } catch (e) {
      if (c.state === 'open') this.fail(c, e instanceof E2EError ? e.message : 'frame rejected')
      return
    }
    if (c.state !== 'open' || !msg || typeof msg !== 'object') return
    if (msg.k === 'call' || msg.k === 'sub' || msg.k === 'unsub' || msg.k === 'resync') {
      const t = this.now()
      c.calls = c.calls.filter((x) => x > t - 1000)
      c.calls.push(t)
      if (c.calls.length > MAX_CALLS_PER_SEC) return msg.k === 'call' ? this.ret(c, msg.id, false, 'too many calls') : undefined
    }
    switch (msg.k) {
      case 'call': return this.onCall(c, msg)
      case 'sub':
      case 'unsub': return this.onSub(c, msg)
      case 'visible':
        c.visible = msg.on === true
        if (!c.visible) c.ptyBuf.clear()
        return
      case 'device':
        if (typeof msg.device === 'string') c.device = [...msg.device.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0, 80).join('') || null
        this.d.onChange()
        return
      case 'resync':
        if (msg.ev === CH.state && c.patches && c.lastState !== undefined) this.resync(c)
        return
    }
  }

  private async handshake(c: Conn, d: string): Promise<void> {
    const step = c.state
    c.state = 'busy'
    try {
      const hs = JSON.parse(d) as Hs1 | Hs3
      if (step === 'hs1') {
        if (hs.k !== 'hs1') throw new E2EError('expected hs1')
        const key = this.d.key()
        if (!key) throw new E2EError('no Mac key')
        const mh = await macHandshake(key.pair, c.pub, hs)
        if (c.state !== 'busy') return
        c.confirm = mh.confirm
        c.state = 'hs3'
        this.d.send({ t: 'frame', b: c.b, d: JSON.stringify(mh.hs2) })
      } else {
        if (hs.k !== 'hs3') throw new E2EError('expected hs3')
        const ch = await c.confirm!(hs)
        if (c.state !== 'busy') return
        c.ch = ch
        c.state = 'open'
        c.connectedAt = this.now()
        await this.out(c, { k: 'hello', protocol: PROTOCOL_VERSION, ...this.d.hello })
        this.d.onChange()
      }
    } catch (e) {
      if (c.state === 'busy') this.fail(c, `handshake: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async onCall(c: Conn, m: Extract<WebToMac, { k: 'call' }>): Promise<void> {
    const access: Access | undefined = typeof m.m === 'string' && Object.hasOwn(DECK_ACCESS, m.m) ? DECK_ACCESS[m.m as keyof typeof DECK_ACCESS] : undefined
    let args = Array.isArray(m.a) ? m.a : []
    if (access?.kind !== 'remote' || (m.m === 'ptyOpen' && !WEB_PANES.has((args[1] as { kind?: unknown } | null)?.kind as string)))
      return this.ret(c, m.id, false, BLOCKED)
    args = ARG_FIX[m.m as keyof typeof ARG_FIX]?.(args) ?? args
    try {
      const v = await this.d.call(access.ch, args)
      if (access.mode === 'invoke') await this.ret(c, m.id, true, v)
    } catch (e) {
      if (access.mode === 'invoke') await this.ret(c, m.id, false, e instanceof Error ? e.message : String(e))
      else this.d.log?.(`browser ${c.b}: ${m.m} failed: ${String(e)}`)
    }
  }

  private async onSub(c: Conn, m: Extract<WebToMac, { k: 'sub' | 'unsub' }>): Promise<void> {
    const perId = EVENTS.get(m.ev)
    if (perId === undefined || perId !== (typeof m.arg === 'string' && m.arg.length > 0 && m.arg.length <= 200)) return
    const key = perId ? `${m.ev}:${m.arg}` : m.ev
    if (m.ev === CH.state) {
      c.patches = m.k === 'sub' && m.patches === 1
      c.sent = undefined
      c.n = 0
      clearTimeout(c.resyncTimer)
      c.resyncTimer = undefined
    }
    if (m.k === 'unsub') {
      c.subs.delete(key)
      if (perId) c.ptyBuf.delete(m.arg!)
      return
    }
    c.subs.add(key)
    if (m.ev === CH.state) {
      const s = await this.d.call(CH.getState, [])
      if (this.conns.get(c.b) !== c || c.state !== 'open' || !c.subs.has(key)) return
      await this.sendState(c, JSON.stringify(s), true, s)
    }
  }

  private queueState(c: Conn, s: unknown): void {
    c.stateNext = s
    if (c.stateTimer) return
    const wait = Math.max(0, c.stateAt + (this.d.stateMs ?? 1500) - this.now())
    c.stateTimer = setTimeout(() => {
      c.stateTimer = undefined
      const json = JSON.stringify(c.stateNext)
      if (c.state !== 'open' || !c.subs.has(CH.state) || json === c.lastState) return
      void this.sendState(c, json, false, c.stateNext)
    }, wait)
  }

  /** A full for a resync, at most one per resyncMs; resyncs inside the window get one full at its end. */
  private resync(c: Conn): void {
    if (c.resyncTimer) return
    const wait = c.resyncAt + (this.d.resyncMs ?? 1000) - this.now()
    const go = () => {
      c.resyncTimer = undefined
      if (c.state !== 'open' || !c.patches || c.lastState === undefined) return
      c.resyncAt = this.now()
      void this.sendState(c, c.lastState, true)
    }
    if (wait <= 0) go()
    else c.resyncTimer = setTimeout(go, wait)
  }

  /**
   * One state message. An old web: the full state, as always. A patch subscriber: numbered; `evp` with the diff from
   * what it last got, or a full (`full`, no base yet, or the diff isn't much smaller than the state).
   */
  private sendState(c: Conn, json: string, full: boolean, s?: unknown): Promise<void> {
    c.lastState = json
    c.stateAt = this.now()
    if (!c.patches) return this.out(c, { k: 'ev', ev: CH.state, v: [s ?? JSON.parse(json)] })
    // Our own copy: the caller's object may change later, and the web sees the JSON round-trip anyway.
    // ponytail: one parse + compare per patch connection; share one parse per event() across connections if many tabs.
    const next: unknown = JSON.parse(json), prev = c.sent
    let m: MacToWeb = { k: 'ev', ev: CH.state, v: [next], n: c.n + 1 }
    if (!full && prev !== undefined) {
      const ops = compare(prev as object, next as object)
      if (!ops.length) return Promise.resolve() // same content, other key order
      if (JSON.stringify(ops).length <= json.length * 0.6) m = { k: 'evp', ev: CH.state, n: c.n + 1, ops }
    }
    // Too big for the relay (out() drops it): no base, n unchanged, so the next state goes as a full again.
    if (tooBig(m)) c.sent = undefined
    else {
      c.sent = next
      c.n++
    }
    return this.out(c, m)
  }

  private flushPty(c: Conn): void {
    clearTimeout(c.ptyTimer)
    c.ptyTimer = undefined
    for (const [id, { d, seq }] of c.ptyBuf)
      for (let at = 0; at < d.length; ) {
        let end = Math.min(d.length, at + PTY_CHUNK)
        if (end < d.length && /[\ud800-\udbff]/.test(d[end - 1])) end-- // keep surrogate pairs whole
        // seq counts characters up to the end of this piece (ptys.ts: cumulative length).
        void this.out(c, { k: 'ev', ev: CH.ptyData, arg: id, v: [d.slice(at, end), typeof seq === 'number' ? seq - (d.length - end) : seq] })
        at = end
      }
    c.ptyBuf.clear()
  }

  private async ret(c: Conn, id: number, ok: boolean, v: unknown): Promise<void> {
    // A call whose channel closed or was revoked meanwhile is dropped (RF3).
    if (this.conns.get(c.b) !== c || c.state !== 'open') return
    return this.out(c, ok ? { k: 'ret', id, ok: true, v } : { k: 'ret', id, ok: false, e: String(v) })
  }

  private out(c: Conn, m: MacToWeb): Promise<void> {
    // Too big for the relay: never seal it (the counter must not move for a frame the hub would drop).
    // ponytail: stringified twice (here and in seal); fine at AppState sizes.
    if (tooBig(m)) {
      this.d.log?.(`browser ${c.b}: ${m.k === 'ev' && m.ev === CH.state ? 'state too large for the web' : `${m.k} too large for the web`}; not sent`)
      return m.k === 'ret' ? this.out(c, { k: 'ret', id: m.id, ok: false, e: 'result too large for the web' }) : Promise.resolve()
    }
    return c.ch!.seal(m).then(
      (d) => {
        if (this.conns.get(c.b) !== c || c.state !== 'open') return
        // A sealed frame that cannot go out leaves the channel out of step: close it, never continue.
        if (d.length > MAX_FRAME || !this.d.send({ t: 'frame', b: c.b, d })) {
          this.d.log?.(`browser ${c.b}: frame not sent; channel closed`)
          this.close(c)
        }
      },
      (e) => this.d.log?.(`browser ${c.b}: not sent: ${String(e)}`),
    )
  }

  private fail(c: Conn, why: string): void {
    this.d.log?.(`browser ${c.b} (${c.name}): channel closed: ${why}`)
    const t = this.now()
    const f = this.failures.get(c.b) ?? { name: c.name, at: [] }
    f.at = [...f.at.filter((x) => x > t - HOUR), t]
    this.failures.set(c.b, f)
    this.close(c)
    if (f.at.length >= 3) this.d.log?.(`Possible tampering on the connection to ${c.name}`)
    this.d.onChange()
    later(HOUR + 1, () => this.d.onChange()) // the warning ages out
  }

  /** Tell the server and forget the connection. */
  private close(c: Conn): void {
    this.drop(c)
    this.d.send({ t: 'browserClose', b: c.b })
  }

  private drop(c: Conn): void {
    const wasOpen = c.state === 'open'
    c.state = 'closed'
    clearTimeout(c.stateTimer)
    clearTimeout(c.resyncTimer)
    clearTimeout(c.ptyTimer)
    if (this.conns.get(c.b) === c) this.conns.delete(c.b)
    if (wasOpen) this.d.onChange()
  }
}
