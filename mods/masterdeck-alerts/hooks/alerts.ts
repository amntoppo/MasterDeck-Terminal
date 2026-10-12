import type { Band } from './deck'

/** What changed between two reads that the person would want a toast for. */
export function bandEvents(prev: Band | null, next: Band | null): string[] {
  if (!prev || !next) return []
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
