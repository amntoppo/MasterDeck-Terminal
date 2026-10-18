import { useEffect, useRef, useState } from 'react'
import { browserHandshake, generateStatic, type Channel } from '@shared/e2e'
import { deviceFrom } from '@shared/deviceInfo'
import { PROTOCOL_VERSION, type DesktopStatus, type ServerToBrowser } from '@shared/remote'
import { loadView, updateText, type LoadPhase } from '@shared/webLoading'
import type { MacToWeb } from '@shared/bridgeWire'
import { App } from '@renderer/App'
import { afterClose, approve, browserName, type Api, type Outcome, type Res } from './approval'
import { deleteKeys, deleteOtherAccounts, ensureKeys, saveKeys, StorageUnavailable, type KeyRec } from './keys'
import { createRemoteDeck } from './remoteDeck'

declare const __MD_API__: string
const API = __MD_API__
const WS = API.replace(/^http/, 'ws')

async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(API + path, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const api: Api = { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) }

class Cancelled extends Error {}

type Screen =
  | { s: 'loading' }
  | { s: 'signin' }
  | { s: 'storage' }
  | { s: 'error'; message: string }
  | { s: 'approve'; words: string[] | null; outcome: Outcome | 'revoked' | null }
  | { s: 'otherTab' }
  | { s: 'update'; mac: { appVersion?: string; protocol: number } }
  | { s: 'app' }

interface Conn {
  /** The socket's state: up (connected to the hub) or retrying. */
  up: boolean
  desktop: DesktopStatus | null
  /** Bumped per channel: App remounts on a fresh deck, so nothing stale shows. */
  gen: number
  /** How far this connection got, and since when: the loading screen names a reason when a phase lasts (#168). */
  phase: LoadPhase
  since: number
  /** The first state arrived on this channel: only then the app shows (never a bare "Loading sessions…"). */
  stateSeen: boolean
  /** The Mac said its state is too large to send. */
  tooLarge: { bytes: number } | null
}

const freshConn = (): Conn => ({ up: false, desktop: null, gen: 0, phase: 'socket', since: Date.now(), stateSeen: false, tooLarge: null })

/** Everything before the app renders (spec §5): sign in, this browser's keys, approval, the encrypted channel. */
export function Gate() {
  const [screen, setScreen] = useState<Screen>({ s: 'loading' })
  const [conn, setConn] = useState<Conn>(freshConn)
  const [now, setNow] = useState(Date.now())
  const [run, setRun] = useState(0)
  const ctx = useRef<{ userId: string; rec: KeyRec } | null>(null)
  /** Ends the current run: polling, socket, everything. */
  const cancel = useRef(() => {})

  useEffect(() => {
    let dead = false
    let stop = () => {}
    const wait = (ms: number) =>
      new Promise<void>((r) => setTimeout(r, ms)).then(() => {
        if (dead) throw new Cancelled()
      })
    const show = (s: Screen) => !dead && setScreen(s)
    ;(async () => {
      const sess = await api.get('/auth/get-session')
      const user = sess.status === 200 ? (sess.body?.user as { id: string } | undefined) : undefined
      if (dead) return
      if (!user?.id) return show({ s: 'signin' })
      let rec: KeyRec
      try {
        await deleteOtherAccounts(user.id)
        rec = await ensureKeys(user.id, () => generateStatic(false))
      } catch (e) {
        if (e instanceof StorageUnavailable) return show({ s: 'storage' })
        throw e
      }
      ctx.current = { userId: user.id, rec }
      show({ s: 'approve', words: null, outcome: null })
      const save = async (r: KeyRec) => {
        rec = r
        ctx.current = { userId: user.id, rec }
        await saveKeys(user.id, r)
      }
      const out = await approve({
        api, rec, name: browserName(navigator.userAgent), save, wait, generate: () => generateStatic(false),
        onWords: (words) => show({ s: 'approve', words, outcome: null }),
      })
      if (dead) return
      if (out !== 'approved') {
        // Try again starts a new request (with a new key).
        if (rec.browserId) await save({ browserId: null, pair: rec.pair })
        return show({ s: 'approve', words: null, outcome: out })
      }
      show({ s: 'app' })
      setConn(freshConn())
      stop = connect(rec, {
        conn: (f) => !dead && setConn(f),
        update: (mac) => show({ s: 'update', mac }),
        closed: async (code, reason, helloed) => {
          const next = await afterClose(api, rec.browserId!, code, reason, helloed)
          if (dead) return false
          if (next === 'retry') return true
          stop()
          // Revoked, signed out, or no longer approved: this key is done. Nothing is requested until the user asks.
          if (code === 4003 || next === 'revoked') await deleteKeys(user.id).catch(() => {})
          if (next === 'signin') show({ s: 'signin' })
          else if (next === 'otherTab') show({ s: 'otherTab' })
          else show({ s: 'approve', words: null, outcome: 'revoked' })
          return false
        },
      })
    })().catch((e) => {
      if (!(e instanceof Cancelled)) show({ s: 'error', message: e instanceof Error ? e.message : String(e) })
    })
    cancel.current = () => {
      dead = true
      stop()
    }
    return () => cancel.current()
  }, [run])

  const ready = screen.s === 'app' && conn.gen > 0 && conn.stateSeen
  // The loading screen's clock: a stage that lasts turns into its reason.
  useEffect(() => {
    if (screen.s !== 'app' || ready) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [screen.s, ready])

  const retry = () => {
    setScreen({ s: 'loading' })
    setRun((n) => n + 1)
  }
  const signOut = async () => {
    const c = ctx.current
    cancel.current()
    if (c?.rec.browserId) await call('DELETE', `/v1/browsers/${encodeURIComponent(c.rec.browserId)}`).catch(() => null)
    if (c) await deleteKeys(c.userId).catch(() => {})
    await call('POST', '/auth/sign-out', {}).catch(() => null)
    ctx.current = null
    setScreen({ s: 'signin' })
  }

  if (screen.s === 'app') {
    // The Loading card names the rest (Mac offline, no answer, …); this only says it was connected before.
    const banner = !conn.up && conn.desktop ? 'Reconnecting…' : null
    return (
      <>
        {banner && <div className="web-banner">{banner}</div>}
        {ready ? <App key={conn.gen} /> : <Loading conn={conn} now={Math.max(now, conn.since)} retry={retry} />}
        <button className="web-signout" onClick={() => void signOut()} title="Sign out of MasterDeck on this browser">
          Sign out
        </button>
      </>
    )
  }
  if (screen.s === 'loading') return <Card title="MasterDeck">Loading…</Card>
  if (screen.s === 'signin')
    return (
      <Card title="MasterDeck">
        <p>Control MasterDeck on your Mac from this browser.</p>
        <button className="btn primary" onClick={() => location.assign(`${API}/login?next=${encodeURIComponent(location.origin + '/')}`)}>
          Sign in
        </button>
      </Card>
    )
  if (screen.s === 'otherTab')
    return (
      <Card title="MasterDeck">
        <p>MasterDeck is open in another tab.</p>
        <button className="btn primary" onClick={retry}>
          Use here
        </button>
      </Card>
    )
  if (screen.s === 'storage') return <Card title="MasterDeck">This window can't be approved; use a normal window.</Card>
  if (screen.s === 'update')
    return (
      <Card title="Update MasterDeck">
        <p>{updateText(screen.mac)}</p>
        <button className="btn" onClick={() => location.reload()}>Reload</button>
      </Card>
    )
  if (screen.s === 'error')
    return (
      <Card title="Something went wrong">
        <p className="error">{screen.message}</p>
        <button className="btn" onClick={retry}>Try again</button>
      </Card>
    )
  const o = screen.outcome
  return (
    <Card title="Approve this browser">
      {o === 'notPaired' ? (
        <p>Sign in to MasterDeck on your Mac and turn on Remote (update MasterDeck if it's older).</p>
      ) : o === 'denied' ? (
        <p>Denied on your Mac.</p>
      ) : o === 'expired' ? (
        <p>The request expired.</p>
      ) : o === 'revoked' ? (
        <p>This browser no longer has access to your Mac.</p>
      ) : o === 'tooMany' ? (
        <p>Too many approval attempts — try again in a few minutes.</p>
      ) : screen.words ? (
        <>
          <p>Check MasterDeck on your Mac. Allow only if it shows these words:</p>
          <div className="web-words">{screen.words.join(' · ')}</div>
        </>
      ) : (
        <p>Waiting for your Mac… If it is offline, open MasterDeck to approve.</p>
      )}
      {o && (
        <button className="btn primary" onClick={retry}>
          {o === 'revoked' ? 'Request access again' : 'Try again'}
        </button>
      )}
      <button className="link-btn" onClick={() => void signOut()}>
        Sign out
      </button>
    </Card>
  )
}

/** Between approval and the first state: what is happening, and after a while why it is not (#168). */
function Loading({ conn, now, retry }: { conn: Conn; now: number; retry: () => void }) {
  const v = loadView({ up: conn.up, desktop: conn.desktop, phase: conn.phase, since: conn.since, now, tooLarge: conn.tooLarge })
  return (
    <Card title={v.title}>
      <p data-stage={v.stage}>{v.text}</p>
      {v.retry && (
        <button className="btn primary" onClick={retry}>
          Retry
        </button>
      )}
    </Card>
  )
}

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="web-card">
      <h2>{title}</h2>
      {children}
    </div>
  )
}

interface Hooks {
  conn(f: (c: Conn) => Conn): void
  update(mac: { appVersion?: string; protocol: number }): void
  /** The socket closed; resolves true to reconnect with backoff, false when the Gate took over. */
  closed(code: number, reason: string, helloed: boolean): Promise<boolean>
}

/**
 * The socket to the hub and the encrypted channel over it (spec §2): a fresh handshake whenever the Mac is
 * (back) online, `window.deck` on the Mac's hello, reconnect with backoff 1 s → 30 s. Returns stop().
 */
function connect(rec: KeyRec, h: Hooks): () => void {
  let stopped = false
  let backoff = 1000
  /** Re-auth (4006) retries once at once; again before a hello → the usual backoff. Reset on hello. */
  let quick = true
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let ws: WebSocket | null = null

  /** A new phase restarts the loading clock; the same one (a reconnect) keeps it running. */
  const phase = (p: LoadPhase, more?: Partial<Conn>) =>
    h.conn((c) => (c.phase === p && !more ? c : { ...c, ...more, phase: p, since: c.phase === p ? c.since : Date.now() }))

  const open = () => {
    phase('socket')
    const sock = new WebSocket(`${WS}/v1/browser?id=${encodeURIComponent(rec.browserId!)}`)
    ws = sock
    let q: Promise<void> = Promise.resolve()
    let online = false
    let hs: Awaited<ReturnType<typeof browserHandshake>> | null = null
    let hsTimer: ReturnType<typeof setTimeout> | undefined
    let ch: Channel | null = null
    let hello = false
    /** This socket reached the Mac's hello (hello itself resets when the channel ends). */
    let reached = false
    let onFrame: ((d: string) => void) | undefined
    let offState: (() => void) | undefined
    let onClose: (() => void) | undefined
    const ping = setInterval(() => sendRaw({ t: 'ping' }), 30_000)
    const sendRaw = (m: unknown) => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify(m))
    const sendFrame = (d: string) => sendRaw({ t: 'frame', d })
    const visible = () => ch && hello && ch.seal({ k: 'visible', on: !document.hidden }).then(sendFrame, () => {})

    /** The channel is over (Mac offline, socket closed): in-flight calls fail, the app unmounts. */
    const endChannel = () => {
      clearTimeout(hsTimer)
      hs = null
      ch = null
      if (hello) h.conn((c) => ({ ...c, gen: 0 }))
      hello = false
      offState?.()
      offState = undefined
      h.conn((c) => (c.stateSeen || c.tooLarge ? { ...c, stateSeen: false, tooLarge: null } : c))
      onClose?.()
      onFrame = onClose = undefined
    }
    const start = async () => {
      endChannel()
      phase('handshake')
      const x = await browserHandshake(rec.pair, rec.macPublicKey!)
      if (ws !== sock || !online) return
      hs = x
      sendFrame(JSON.stringify(x.hs1))
      // A Mac that never answers (it refused us, or dropped the frame): reconnect for a fresh try.
      hsTimer = setTimeout(() => sock.close(), 15_000)
    }
    const handle = async (raw: string) => {
      let m: ServerToBrowser
      try {
        m = JSON.parse(raw)
      } catch {
        return
      }
      if (m.t === 'desktop') {
        heard = true
        h.conn((c) => ({ ...c, desktop: m.desktop }))
        if (m.desktop.online && !online) {
          online = true
          await start()
        } else if (!m.desktop.online) {
          online = false
          endChannel()
        }
      } else if (m.t === 'frame') {
        if (hs) {
          const x = hs
          hs = null
          const { hs3, channel } = await x.finish(JSON.parse(m.d))
          sendFrame(JSON.stringify(hs3))
          // A frame that fails to open kills the channel: drop the socket and handshake afresh.
          ch = { seal: (v) => channel.seal(v), open: (d) => channel.open(d).catch((e) => (sock.close(), Promise.reject(e))) }
        } else if (ch && !hello) {
          clearTimeout(hsTimer)
          const first = (await ch.open(m.d)) as MacToWeb
          if (first.k !== 'hello') return void sock.close()
          if (first.protocol !== PROTOCOL_VERSION) {
            stop()
            return h.update({ appVersion: first.appVersion, protocol: first.protocol })
          }
          hello = true
          reached = true
          const io = { send: sendFrame, onFrame: (cb: (d: string) => void) => void (onFrame = cb), onClose: (cb: () => void) => void (onClose = cb) }
          window.deck = createRemoteDeck(io, ch, first, (n) => {
            if (n.why === 'tooLarge') h.conn((c) => (c.stateSeen ? c : { ...c, tooLarge: { bytes: n.bytes } }))
          })
          backoff = 1000
          quick = true
          phase('state', { gen: Date.now(), stateSeen: false, tooLarge: null })
          offState = window.deck.onState(() => h.conn((c) => (c.stateSeen ? c : { ...c, stateSeen: true, tooLarge: null })))
          if (document.hidden) void visible()
          // Tell the Mac what this is ("Chrome on macOS") for its remote indicator; an older Mac ignores the message.
          const device = deviceFrom(navigator.userAgent, (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform)
          if (device) void ch.seal({ k: 'device', device }).then(sendFrame, () => {})
        } else onFrame?.(m.d)
      }
    }
    // The hub says where the Mac is right after accepting; silence means it is not reachable: say offline.
    let heard = false
    const quiet = setTimeout(() => !heard && h.conn((c) => ({ ...c, desktop: { online: false, lastSeen: null, appVersion: null } })), 10_000)
    sock.onopen = () => h.conn((c) => ({ ...c, up: true }))
    sock.onmessage = (e) => {
      q = q.then(() => handle(String(e.data))).catch(() => sock.close())
    }
    sock.onclose = (e) => {
      clearInterval(ping)
      clearTimeout(quiet)
      document.removeEventListener('visibilitychange', onVis)
      endChannel()
      if (ws !== sock || stopped) return
      h.conn((c) => ({ ...c, up: false }))
      phase('socket')
      if (e.code === 4006 && quick) {
        quick = false
        retryTimer = setTimeout(open, 0)
        return
      }
      if (e.code === 4006) quick = false
      void h.closed(e.code, e.reason, reached).then(
        (again) => {
          if (!again || ws !== sock || stopped) return
          retryTimer = setTimeout(open, backoff)
          backoff = Math.min(backoff * 2, 30_000)
        },
        () => {},
      )
    }
    const onVis = () => void visible()
    document.addEventListener('visibilitychange', onVis)
  }

  const stop = () => {
    stopped = true
    clearTimeout(retryTimer)
    ws?.close()
  }
  open()
  return stop
}
