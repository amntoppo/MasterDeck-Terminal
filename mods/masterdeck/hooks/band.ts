import type { Band } from '../types'

/** `deck/alive` older than this: MasterDeck is not running (the app touches it every 5 s; note.sh uses 30 s too). */
export const ALIVE_MS = 30_000

/** Below this many columns the band is one short line. */
export const NARROW_COLS = 90

/** One piece of the band's line. */
export type Segment = { text: string; color?: string; bold?: boolean; dim?: boolean }

/** The band file's text, when it is one this version reads. */
export function parseBand(text: string): Band | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const b = o as Partial<Band>
  if (b.v !== 1 || typeof b.name !== 'string' || !Array.isArray(b.peers)) return null
  return b as Band
}

export function ago(ms: number): string {
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`
  return `${Math.round(ms / 3_600_000)} h ago`
}

function clip(text: string, max: number): string {
  if (max < 8) return ''
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function ciPart(ci: string | null): Segment | null {
  if (ci === 'success') return { text: '✓ CI', color: 'green' }
  if (ci === 'failure') return { text: '✗ CI', color: 'red' }
  if (ci === 'pending') return { text: '… CI', color: 'yellow' }
  return null
}

/**
 * The band's line for a width: short under NARROW_COLS, with the title when there is room.
 * `staleFor`: MasterDeck is closed and the data is that old (ms); null while it runs.
 */
export function segments(band: Band, cols: number, staleFor: number | null): Segment[] {
  const head: Segment = { text: band.ticket?.label ?? band.name, bold: true }
  if (staleFor !== null) return [head, { text: `MasterDeck is closed · ticket data from ${ago(staleFor)}`, dim: true }]
  const pr = band.pr
  const prState = pr?.state === 'MERGED' ? { text: 'merged', color: 'magenta' } : pr?.state === 'CLOSED' ? { text: 'closed', dim: true } : null
  const threads: Segment | null = pr && pr.threads > 0 ? { text: `${pr.threads} thread${pr.threads === 1 ? '' : 's'}`, color: 'yellow' } : null
  const linked: Segment | null = band.peers.length ? { text: `${band.peers.length} linked`, dim: true } : null
  if (cols < NARROW_COLS) {
    const out: (Segment | null)[] = [
      head,
      band.status ? { text: band.status, color: 'yellow' } : null,
      pr ? { text: `PR #${pr.number}${pr.ci === 'success' ? ' ✓' : pr.ci === 'failure' ? ' ✗' : ''}`, color: pr.ci === 'failure' ? 'red' : 'green' } : null,
      prState,
      threads,
    ]
    return out.filter((s): s is Segment => !!s)
  }
  const rest: (Segment | null)[] = [
    band.status ? { text: `● ${band.status}`, color: 'yellow' } : null,
    pr ? { text: `PR #${pr.number}${pr.draft ? ' (draft)' : ''}`, dim: true } : null,
    pr ? prState ?? ciPart(pr.ci) : null,
    threads,
    linked,
  ]
  const parts = rest.filter((s): s is Segment => !!s)
  // Room for the buttons drawn after the line ([ Details ] [ Hide ]) and the band's own mark.
  const used = head.text.length + parts.reduce((n, s) => n + s.text.length + 1, 0) + 30
  const title = band.ticket?.title ? clip(band.ticket.title, cols - used) : ''
  return [head, ...(title ? [{ text: title }] : []), ...parts]
}

/** What changed between two reads that the person would want a toast for. */
export function bandEvents(prev: Band | null, next: Band | null): string[] {
  if (!prev || !next || prev.off || next.off) return []
  const out: string[] = []
  const label = next.ticket?.label ?? next.name
  if (prev.ticket?.ref === next.ticket?.ref && prev.status && next.status && prev.status !== next.status)
    out.push(`${label} moved: ${prev.status} → ${next.status}`)
  const a = prev.pr
  const b = next.pr
  if (b && (!a || a.url !== b.url)) out.push(`PR #${b.number} is linked to this session`)
  if (a && b && a.url === b.url) {
    if (b.threads > a.threads) {
      const n = b.threads - a.threads
      out.push(`PR #${b.number}: ${n} new review thread${n === 1 ? '' : 's'}`)
    }
    if (b.ci !== a.ci && b.ci === 'failure') out.push(`PR #${b.number}: CI failed`)
    if (b.ci !== a.ci && b.ci === 'success' && a.ci !== null) out.push(`PR #${b.number}: CI passed`)
    if (b.state !== a.state && b.state === 'MERGED') out.push(`PR #${b.number} merged`)
  }
  return out
}

/** What the commands answer while the mod is switched off in this session. */
export const OFF_TEXT = 'The MasterDeck mod is off in this session. Turn it on in MasterDeck: Session details → Turn mod on.'

/** The id of a note request, as MasterDeck's pump takes it (digits-digits-digits). */
export function noteRequestId(nowMs: number, rand: number): string {
  return `${Math.floor(nowMs / 1000)}-0-${Math.floor(rand * 1_000_000_000)}`
}

/** MasterDeck's answer to a note request, as one line for the transcript. */
export function noteAnswerText(text: string): string {
  try {
    const a = JSON.parse(text) as { ok?: boolean; message?: string; error?: string }
    if (a.ok === true) return a.message ?? 'Added to the note.'
    return `Not saved: ${a.error ?? 'MasterDeck refused it.'}`
  } catch {
    return 'MasterDeck answered something this mod cannot read; look in Notes.'
  }
}
