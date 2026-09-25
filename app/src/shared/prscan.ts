/**
 * Finds the PRs a session opened, from its transcript. A session usually creates its PR from
 * inside a worktree (or a subagent does), so asking gh about the session's own cwd misses it.
 * Claude Code writes a `pr-link` entry for every PR a session opens; as a backup, a `gh pr create`
 * call (tool_use) is paired with its output (tool_result), which ends with the new PR URL.
 */

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g
const CREATE = /\bgh\s+pr\s+create\b|create_pull_request/i

export interface PrScanState {
  /** tool_use ids of PR-creating calls whose result has not been seen yet. */
  pending: Set<string>
  /** PR URLs, least recently linked first, no duplicates. */
  urls: string[]
}

export function newPrScanState(): PrScanState {
  return { pending: new Set(), urls: [] }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('\n')
  }
  return ''
}

/** Feed complete transcript lines in file order. Returns true when a new PR URL was found. */
export function scanLines(lines: string[], state: PrScanState): boolean {
  let found = false
  const link = (url: string) => {
    const i = state.urls.indexOf(url)
    if (i >= 0) state.urls.splice(i, 1)
    else found = true
    state.urls.push(url)
  }
  for (const line of lines) {
    const isLink = line.includes('"pr-link"')
    if (!isLink && !line.includes('tool_use') && !line.includes('tool_result')) continue
    let o: { type?: unknown; prUrl?: unknown; message?: { content?: unknown } }
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.type === 'pr-link') {
      if (typeof o.prUrl === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(o.prUrl)) link(o.prUrl)
      continue
    }
    const content = o.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as Record<string, unknown>[]) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        const input = JSON.stringify(b.input ?? '')
        if (CREATE.test(input) || (typeof b.name === 'string' && CREATE.test(b.name))) state.pending.add(b.id)
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && state.pending.has(b.tool_use_id)) {
        state.pending.delete(b.tool_use_id)
        if (b.is_error === true) continue
        // gh prints the new PR's URL last; `git push` hints (…/pull/new/branch) don't match \d+.
        const urls = textOf(b.content).match(PR_URL) ?? []
        const url = urls[urls.length - 1]
        if (url) link(url)
      }
    }
  }
  return found
}
