import type { Channel } from '@shared/e2e'
import type { DeckApi } from '@shared/ipc'
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

/** `window.deck` for the web app (spec §3): calls and events travel sealed to the Mac; local members run here. */
export function createRemoteDeck(io: Io, ch: Channel, hello: Hello): DeckApi {
  let next = 1
  let closed = false
  const waiting = new Map<number, { ok(v: unknown): void; no(e: Error): void }>()
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>()
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
      for (const fn of listeners.get(m.arg ? `${m.ev}:${m.arg}` : m.ev) ?? []) {
        try {
          fn(...m.v)
        } catch (e) {
          console.error(e) // one broken listener must not starve the others
        }
      }
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
            out({ k: 'sub', ev: a.ch, ...(arg ? { arg } : {}) }).catch(() => {})
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
