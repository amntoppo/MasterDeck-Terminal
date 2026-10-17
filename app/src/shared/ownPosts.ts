/**
 * What a session wrote itself, for the PR watch (#158): a review, thread or comment by the watch's
 * own GitHub account is the session's reply only when its text is in one of the session's tool
 * calls (a `gh ... --body "..."`, a body file it wrote, an MCP call). Same account, other text: the
 * user reviewing their own PR, or a review session posting as the user, so it is feedback.
 */

/** Text kept per session, newest last: a reply older than this many normalized characters is not recognised. */
export const OWN_MAX = 1_000_000
/** How much of a comment's start has to match. */
const PROBE = 200

export interface OwnPostScan {
  text: string
}

export const newOwnPostScan = (): OwnPostScan => ({ text: '' })

/** Shell quoting and markdown escapes add backslashes, and wrapping changes whitespace: both go. */
export const normPost = (t: string): string => t.replace(/\\/g, '').replace(/\s+/g, '').toLowerCase()

function strings(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out)
}

/** Feed complete transcript lines in file order: every tool call's input text is kept (normalized). */
export function scanOwnPosts(lines: string[], scan: OwnPostScan): void {
  const add: string[] = []
  for (const line of lines) {
    if (!line.includes('"tool_use"')) continue
    let o: { message?: { content?: unknown } }
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const content = o.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as Record<string, unknown>[]) {
      if (b?.type !== 'tool_use') continue
      const parts: string[] = []
      strings(b.input, parts)
      for (const p of parts) add.push(normPost(p))
    }
  }
  if (!add.length) return
  // ponytail: one capped string searched with includes(); an index of comment-sized pieces if it gets slow.
  const text = `${scan.text}\u0001${add.join('\u0001')}`
  scan.text = text.length > OWN_MAX ? text.slice(-OWN_MAX) : text
}

/** Whether the session wrote this text in a tool call. An empty text tells nothing apart: counted as its own. */
export function isOwnPost(body: string, scan: OwnPostScan): boolean {
  const n = normPost(body)
  return !n || scan.text.includes(n.slice(0, PROBE))
}
