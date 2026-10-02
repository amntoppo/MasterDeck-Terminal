import { applyPatch, type Operation } from 'fast-json-patch'
import type { Channel } from '@shared/e2e'
import { CH, type DeckApi } from '@shared/ipc'
import type { MacToWeb, WebToMac } from '@shared/bridgeWire'
import { ARG_FIX, DECK_ACCESS } from '@shared/remoteDeck'

export interface Io {
  send(d: string): void
  onFrame(cb: (d: string) => void): void
  onClose(cb: () => void): void
}
export type Hello = Extract<MacToWeb, { k: 'hello' }>

const BLOCKED = 'Not available on the web yet'
const OFFLINE = 'Your Mac went offline — not sent'
/** A JSON pointer through `__proto__` or `constructor/prototype` (fast-json-patch bans these too; belt and braces). */
const PROTO = /(^|\/)(__proto__|constructor\/prototype)(\/|$)/
const bad = (p: unknown) => typeof p !== 'string' || PROTO.test(p)
const unsafe = (ops: unknown[]) =>
  ops.some((o) => !o || typeof o !== 'object' || bad((o as Operation).path) || ('from' in o && bad((o as { from: unknown }).from)))
/** Still no full this long after a resync (dropped by the Mac's rate limit, say): the next patch asks again. */
const RESYNC_RETRY_MS = 3000

/** `window.deck` for the web app (spec §3): calls and events travel sealed to the Mac; local members run here. */
export function createRemoteDeck(io: Io, ch: Channel, hello: Hello): DeckApi {
  let next = 1
  let closed = false
  const waiting = new Map<number, { ok(v: unknown): void; no(e: Error): void }>()
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>()
  const fire = (key: string, v: unknown[]) => {
    for (const fn of listeners.get(key) ?? []) {
      try {
        fn(...v)
      } catch (e) {
        console.error(e) // one broken listener must not starve the others
      }
    }
  }
  /**
   * The last state and its number, the base for the next `evp`; null until a numbered full (or while resyncing).
   * A private copy: listeners get their own, so one that mutates its state cannot corrupt the base.
   */
  let base: { n: number; v: unknown } | null = null
  let resyncAt: number | null = null
  const resync = () => {
    base = null
    if (resyncAt !== null && Date.now() - resyncAt < RESYNC_RETRY_MS) return
    resyncAt = Date.now()
    out({ k: 'resync', ev: CH.state }).catch(() => {})
  }
  io.onFrame(async (d) => {
    let m: MacToWeb
    try {
      m = (await ch.open(d)) as MacToWeb
    } catch {
      return // the channel is dead; the Gate closes the socket
    }
    if (m.k === 'ret') {
      const w = waiting.get(m.id)
      waiting.delete(m.id)
      if (w) m.ok ? w.ok(m.v) : w.no(new Error(m.e))
    } else if (m.k === 'ev' && Array.isArray(m.v)) {
      if (m.ev === CH.state) {
        base = typeof m.n === 'number' ? { n: m.n, v: structuredClone(m.v[0]) } : null
        resyncAt = null
      }
      fire(m.arg ? `${m.ev}:${m.arg}` : m.ev, m.v)
    } else if (m.k === 'evp' && m.ev === CH.state) {
      // Ordered channel, no acks: apply n === last+1 onto a copy; anything else waits for a full.
      if (resyncAt !== null) return resync() // waiting for the full; re-asks once the retry time passed
      if (!base || m.n !== base.n + 1 || !Array.isArray(m.ops) || unsafe(m.ops)) return resync()
      let v: unknown
      try {
        v = applyPatch(structuredClone(base.v), m.ops, true).newDocument
      } catch {
        return resync()
      }
      base = { n: m.n, v }
      fire(CH.state, [structuredClone(v)])
    }
  })
  io.onClose(() => {
    closed = true
    for (const w of waiting.values()) w.no(new Error(OFFLINE))
    waiting.clear()
  })
  const out = (msg: WebToMac) => (closed ? Promise.reject(new Error(OFFLINE)) : ch.seal(msg).then(io.send))
  const local: Record<string, unknown> = {
    platform: 'web',
    home: hello.home,
    // Only https: a javascript:/data: URL from the Mac (or a page) must never run in this origin.
    openExternal: (url: string) => void (/^https:\/\//i.test(url) && window.open(url, '_blank', 'noopener,noreferrer')),
    copy: (t: string) => void navigator.clipboard.writeText(t),
    setFocus: () => {},
    setVisible: () => {},
    setBoardOpen: () => {},
  }
  return new Proxy({} as DeckApi, {
    get(_t, name) {
      const a = typeof name === 'string' && Object.hasOwn(DECK_ACCESS, name) ? DECK_ACCESS[name as keyof DeckApi] : undefined
      if (!a) return undefined // e.g. `then` when the deck is awaited
      if (a.kind === 'blocked') return /^on[A-Z]/.test(name as string) ? () => () => {} : () => Promise.reject(new Error(BLOCKED))
      if (a.kind === 'local') return local[name as string]
      if (a.kind === 'event')
        return (...args: unknown[]) => {
          const cb = args[args.length - 1] as (...v: unknown[]) => void
          const arg = a.perId ? (args[0] as string) : undefined
          const key = arg ? `${a.ch}:${arg}` : a.ch
          let set = listeners.get(key)
          if (!set) {
            set = new Set()
            listeners.set(key, set)
            if (a.ch === CH.state) base = null
            out({ k: 'sub', ev: a.ch, ...(arg ? { arg } : {}), ...(a.ch === CH.state ? { patches: 1 as const } : {}) }).catch(() => {})
          }
          set.add(cb)
          return () => {
            set.delete(cb)
            if (set.size === 0 && listeners.get(key) === set) {
              listeners.delete(key)
              out({ k: 'unsub', ev: a.ch, ...(arg ? { arg } : {}) }).catch(() => {})
            }
          }
        }
      return (...raw: unknown[]) => {
        const args = ARG_FIX[name as keyof DeckApi]?.(raw) ?? raw
        const id = next++
        const msg: WebToMac = { k: 'call', id, m: name as string, a: args }
        if (a.mode === 'send') return void out(msg).catch(() => {})
        return new Promise((ok, no) => {
          if (closed) return no(new Error(OFFLINE))
          waiting.set(id, { ok, no })
          out(msg).catch(() => {
            waiting.delete(id)
            no(new Error(OFFLINE))
          })
        })
      }
    },
  })
}
