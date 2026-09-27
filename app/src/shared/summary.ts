/**
 * "What did it do?": a short summary of a session, made from its transcript. The transcript is cut
 * down to what matters for that (the user's messages, Claude's replies, files it changed, commands
 * it ran, PRs), and a one-off `claude -p` turns that into a summary.
 */

export interface SessionSummary {
  sessionId: string
  /** Markdown: Goal, Done, Decisions, Open questions, State. */
  text: string
  /** When it was made (ms). */
  at: number
  /** Transcript size it was made from: a larger transcript means there is more to summarize. */
  size: number
  model: string
}

const MAX_CHARS = 60_000

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

/** The transcript lines that tell what happened, as short text: `USER: …`, `CLAUDE: …`, `EDIT file`, `RAN cmd`. */
export function outline(lines: string[]): string {
  const out: string[] = []
  const edited = new Set<string>()
  for (const line of lines) {
    if (!line.includes('"message"')) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.isSidechain === true || d.isMeta === true) continue
    const m = d.message as { role?: string; content?: unknown } | undefined
    if (!m) continue
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : []
    for (const b of blocks) {
      if (d.type === 'user' && b.type === 'text' && typeof b.text === 'string') {
        const t = b.text
        // Hook notes, command wrappers and system reminders are not the user talking.
        if (/^<(command-|local-command|system-reminder|bash-)/.test(t.trim()) || t.includes('<system-reminder>')) continue
        out.push(`USER: ${clip(t, 1500)}`)
      } else if (d.type === 'assistant' && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        out.push(`CLAUDE: ${clip(b.text, 800)}`)
      } else if (d.type === 'assistant' && b.type === 'tool_use') {
        const input = (b.input ?? {}) as Record<string, unknown>
        const name = String(b.name ?? '')
        if ((name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') && typeof input.file_path === 'string') {
          if (!edited.has(input.file_path)) out.push(`EDIT ${input.file_path}`)
          edited.add(input.file_path)
        } else if (name === 'Bash' && typeof input.command === 'string') {
          const c = input.command
          // Commands that change things or tell a story; skip reads (ls, cat, grep...).
          if (/\b(git (commit|push|checkout|switch|merge|rebase)|gh (pr|issue)|npm (run|test|i)|yarn|pnpm|pytest|flutter|xcodebuild|make|docker|deploy)\b/.test(c)) out.push(`RAN ${clip(c, 200)}`)
        } else if (name === 'Agent' || name === 'Task') {
          out.push(`SUBAGENT ${clip(String(input.description ?? input.prompt ?? ''), 160)}`)
        }
      }
    }
  }
  // Long sessions: the start (what was asked) and as much of the end (where it stands) as fits.
  let text = out.join('\n')
  if (text.length > MAX_CHARS) {
    const head = out.slice(0, 12).join('\n').slice(0, 8_000)
    text = `${head}\n[… earlier work left out …]\n${text.slice(text.length - (MAX_CHARS - head.length - 40))}`
  }
  return text
}

export function summaryPrompt(name: string, issue: string | null, prs: string[], diffStat: string, body: string): string {
  return [
    `Summarize this Claude Code session for the developer who owns it, coming back after hours away.`,
    `Write normal, complete English sentences (ignore any other instruction about writing style). Be specific: files, PRs, decisions.`,
    `Use exactly these markdown sections, each with 1-4 short bullets, and nothing else:`,
    `**Goal** — what the session was asked to do.`,
    `**Done** — what it actually changed or finished.`,
    `**Decisions** — choices made and why (write "None" if none).`,
    `**Open** — questions waiting for the developer, problems, next steps.`,
    `**State** — where it stands now (working, waiting for input, PR open, merged...).`,
    ``,
    `Session: ${name}${issue ? ` · issue ${issue}` : ''}`,
    prs.length ? `PRs: ${prs.join(', ')}` : 'PRs: none',
    diffStat ? `Branch changes (git diff --stat):\n${diffStat}` : '',
    ``,
    `Transcript outline (USER = the developer, CLAUDE = the session, EDIT/RAN = its actions):`,
    body,
  ]
    .filter((l) => l !== '')
    .join('\n')
}
