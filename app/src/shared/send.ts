import type { Session } from './types'

export type SendRoute = 'pane' | 'attach' | 'master'

/**
 * How text can reach a session as if the user typed it, or why it can't:
 * - never into needs-input (it would answer the permission prompt) or an ended session
 * - a background session: its open tab's PTY, else a short hidden `claude attach`
 *   (not for a suspended one: attaching would resume it)
 * - an interactive session (another terminal): relayed by master-agent (`master say --to`)
 */
export function canSend(s: Session, paneAlive: boolean, masterUp: boolean): { ok: true; via: SendRoute } | { ok: false; reason: string } {
  if (s.state === 'done') return { ok: false, reason: 'the session has ended' }
  if (s.state === 'needs-input') return { ok: false, reason: 'it is waiting on a prompt; open it to answer' }
  if (s.kind === 'background' && s.bgId) {
    if (paneAlive) return { ok: true, via: 'pane' }
    if (s.state === 'suspended') return { ok: false, reason: 'it is parked; sending would resume it (open it first)' }
    return { ok: true, via: 'attach' }
  }
  return masterUp ? { ok: true, via: 'master' } : { ok: false, reason: 'it runs in another terminal and master-agent is offline' }
}

/**
 * Bytes that enter `text` into a Claude Code prompt: a bracketed paste (multi-line text stays one
 * message), then Enter as a separate write.
 */
export function pasteSequence(text: string): { paste: string; enter: string } {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\x1b\[20[01]~/g, '').trim()
  return { paste: `\x1b[200~${clean}\x1b[201~`, enter: '\r' }
}
