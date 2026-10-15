/**
 * MasterDeck messages that wait so they never mix with what the user is typing (#123). A message
 * goes through MasterDeck's core mod (`$.prompt.submit`, which never touches the prompt box) when
 * the session runs it; else it is typed in only while the prompt box is empty. Otherwise it is
 * held here, shown on the session, and sent once the box is empty, at the session's next turn end
 * (the Stop hook), or by the user's Send now.
 */

/** Why a message waits. */
export type HeldReason = 'draft' | 'typing' | 'unknown'

export interface HeldMessage {
  id: string
  /** The session's `Session.key`. */
  key: string
  text: string
  /** Who sent it, in words (PR watch, Monitor…). */
  from: string
  at: number
  reason: HeldReason
}

/** What the UI gets (AppState.held): no full text, a preview. */
export interface HeldView {
  id: string
  sessionKey: string
  from: string
  at: number
  reason: HeldReason
  preview: string
}

export const HELD_PREVIEW = 240

export function heldViews(list: HeldMessage[]): HeldView[] {
  return list.map((m) => ({
    id: m.id,
    sessionKey: m.key,
    from: m.from,
    at: m.at,
    reason: m.reason,
    preview: m.text.length > HELD_PREVIEW ? `${m.text.slice(0, HELD_PREVIEW - 1)}…` : m.text,
  }))
}

export function heldReasonText(r: HeldReason): string {
  if (r === 'draft') return 'Your prompt has text: it goes once the prompt is empty.'
  if (r === 'typing') return 'You were typing in it: it goes once you stop.'
  return "MasterDeck can't read its prompt: Send now if the prompt is empty."
}

/** Typed only (a command or shell line): `$.prompt.submit` would send it to the model as words. */
export function isCommand(text: string): boolean {
  return /^\s*[/!]/.test(text)
}

/**
 * Keys a terminal view sent are the user typing, not only the terminal's own reports: focus in/out,
 * mouse, device attributes, cursor position, OSC replies (Claude Code turns on focus and mouse
 * reporting, so a click or a window switch sends those).
 */
export function isTyping(data: string): boolean {
  const rest = data
    .replace(/\x1b\[[IO]/g, '')
    .replace(/\x1b\[<[\d;]*[Mm]/g, '')
    .replace(/\x1b\[M[\s\S]{3}/g, '')
    .replace(/\x1b\[[?>]?[\d;]*[cnR]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  return rest.length > 0
}

const RULE = /^─{8,}.*─$/
// Claude Code puts a no-break space after the glyph.
const GLYPH = /^([❯>!])(?:[ \u00a0]|$)/

/**
 * What the user has typed in Claude Code's prompt box, from the screen's lines (dim cells already
 * blanked: the placeholder and suggestions are dim). The box is the last pair of rules whose first
 * line inside starts with the prompt glyph (`❯`; `!` in shell mode, which is text of its own).
 * '' for an empty box; null when no box is on screen (a dialog, a screen still drawing).
 */
export function promptDraft(lines: string[]): string | null {
  const rows = lines.map((l) => l.replace(/\s+$/, ''))
  for (let bottom = rows.length - 1; bottom > 1; bottom--) {
    if (!RULE.test(rows[bottom])) continue
    let top = bottom - 1
    while (top >= 0 && !RULE.test(rows[top])) top--
    if (top < 0) return null
    const inside = rows.slice(top + 1, bottom)
    const g = inside.length ? GLYPH.exec(inside[0]) : null
    if (!g) continue
    const first = (g[1] === '!' ? '!' : '') + inside[0].slice(g[0].length)
    const rest = inside.slice(1).map((l) => l.replace(/^ {1,2}/, ''))
    return [first, ...rest].join('\n').trim()
  }
  return null
}

/** The Stop hook's answer that hands a held message to a session at the end of its turn. */
export function heldAnswer(text: string, left: number): object {
  const more = left ? ` (${left} more waiting)` : ''
  return {
    decision: 'block',
    reason: `A MasterDeck message for this session${more}. It waited so it would not mix with what the user is typing. Handle it as if it had been sent as a prompt:\n\n${text}`,
    systemMessage: `▶ MasterDeck: ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`,
  }
}
