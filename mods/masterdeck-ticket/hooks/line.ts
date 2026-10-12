import { ago, type Band } from './deck'

/** Below this many columns the line is short. */
export const NARROW_COLS = 90

/** One piece of the line. */
export type Segment = { text: string; color?: string; bold?: boolean; dim?: boolean }

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
 * The line for a width: short under NARROW_COLS, with the title when there is room.
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
