/**
 * What a session wrote itself, for the PR watch (#158): a review, thread or comment by the watch's
 * own GitHub account is the session's reply only when the session posted that text: a body it
 * passed to gh (`--body`, `-b`, `-f body=`, a heredoc), a file it wrote (`--body-file`), or a
 * text it gave a tool (an MCP call). Same account, other text: the user reviewing their own PR, or
 * a review session posting as the user, so it is feedback.
 */

/** Text kept per session, newest last: a reply older than this many normalized characters is not recognised by its start. */
export const OWN_MAX = 1_000_000
/** Whole texts kept per session, newest last. */
export const POSTS_MAX = 2_000
/** A comment at least this long (normalized) may match anywhere in what the session wrote; a shorter one only a whole text. */
export const MIN_PROBE = 40
/** How much of a long comment's start has to match. */
const PROBE = 200
/** Literal characters a body with shell-filled parts needs before it is kept. */
const SHAPE_MIN = 8
/** One kept text at most (normalized): longer ones are compared by their start. */
const POST_MAX = 20_000

export interface OwnPostScan {
  /** Every tool call's input, normalized, joined (the fallback for long comments). */
  text: string
  /** Whole texts the session may have posted, normalized. */
  posts: string[]
  /** Bodies with parts the shell filled in (`$(...)`, `$VAR`): their literal pieces, normalized, in order. */
  shapes: string[][]
}

export const newOwnPostScan = (): OwnPostScan => ({ text: '', posts: [], shapes: [] })

/** Shell quoting and markdown escapes add backslashes, and wrapping changes whitespace: both go. */
export const normPost = (t: string): string => t.replace(/\\/g, '').replace(/\s+/g, '').toLowerCase()

function strings(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out)
}

/** The quoted (or bare) word at `i`, as the shell would pass it, with `$(...)` spans kept as written. */
function shellWord(cmd: string, i: number): string {
  const q = cmd[i]
  if (q === "'") {
    const end = cmd.indexOf("'", i + 1)
    return cmd.slice(i + 1, end < 0 ? undefined : end)
  }
  if (q === '"') {
    let out = ''
    let depth = 0
    for (let j = i + 1; j < cmd.length; j++) {
      const c = cmd[j]
      if (c === '\\' && j + 1 < cmd.length) {
        out += cmd[++j]
        continue
      }
      if (c === '$' && cmd[j + 1] === '(') depth++
      else if (c === ')' && depth > 0) depth--
      else if (c === '"' && depth === 0) return out
      out += c
    }
    return out
  }
  return /^[^\s;&|]*/.exec(cmd.slice(i))![0]
}

const BODY_FLAG = /(?:--body|(?<=\s)-b|(?:-f|-F|--field|--raw-field)\s+body)(?:=|\s+)(?=["'\w$])/g
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2(?=\s|$|\))/g
const DYNAMIC = /\$\((?:[^()]|\([^()]*\))*\)|\$\{[^}]*\}|\$[A-Za-z_]\w*/g

/** Texts a shell command may post: the values of body flags and every heredoc. */
export function commandBodies(cmd: string): string[] {
  const out: string[] = []
  for (const m of cmd.matchAll(BODY_FLAG)) out.push(shellWord(cmd, m.index! + m[0].length))
  for (const m of cmd.matchAll(HEREDOC)) out.push(m[3])
  return out.filter((b) => b.trim())
}

function keep(scan: OwnPostScan, raw: string): void {
  // A heredoc inside a body (`--body "$(cat <<'EOF' ... EOF)"`) is kept on its own as well.
  const parts = raw.split(DYNAMIC)
  if (parts.length > 1 && !/^\s*\$\(\s*cat\s*<</.test(raw)) {
    const shape = parts.map(normPost)
    // `--body "$MSG"` would fit any text: a shape needs some words of its own.
    if (shape.join('').length >= SHAPE_MIN) scan.shapes.push(shape)
  } else if (parts.length === 1) {
    const n = normPost(raw).slice(0, POST_MAX)
    if (n) scan.posts.push(n)
  }
}

/** Feed complete transcript lines in file order: what each tool call could have posted is kept. */
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
      const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {}
      const parts: string[] = []
      strings(input, parts)
      for (const p of parts) add.push(normPost(p))
      // A shell command posts what its body flags and heredocs say; any other tool, its whole texts.
      if (typeof input.command === 'string') for (const body of commandBodies(input.command)) keep(scan, body)
      else for (const p of parts) keep(scan, p)
    }
  }
  if (scan.posts.length > POSTS_MAX) scan.posts.splice(0, scan.posts.length - POSTS_MAX)
  if (scan.shapes.length > POSTS_MAX) scan.shapes.splice(0, scan.shapes.length - POSTS_MAX)
  if (!add.length) return
  // ponytail: one capped string searched with includes(); an index of comment-sized pieces if it gets slow.
  const text = `${scan.text}\u0001${add.join('\u0001')}`
  scan.text = text.length > OWN_MAX ? text.slice(-OWN_MAX) : text
}

/** The literal pieces in order, with anything between them, covering the whole text. */
function fits(n: string, shape: string[]): boolean {
  if (!n.startsWith(shape[0]) || !n.endsWith(shape[shape.length - 1])) return false
  let at = shape[0].length
  for (const piece of shape.slice(1, -1)) {
    const i = n.indexOf(piece, at)
    if (i < 0) return false
    at = i + piece.length
  }
  return at <= n.length - shape[shape.length - 1].length
}

/** Whether the session posted this text. An empty text tells nothing apart: counted as its own. */
export function isOwnPost(body: string, scan: OwnPostScan): boolean {
  const n = normPost(body)
  if (!n) return true
  const whole = n.slice(0, POST_MAX)
  if (scan.posts.includes(whole) || scan.shapes.some((s) => fits(n, s))) return true
  return n.length >= MIN_PROBE && scan.text.includes(n.slice(0, PROBE))
}
