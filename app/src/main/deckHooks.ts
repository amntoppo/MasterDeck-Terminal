import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyEventLine, parseRequest, type HookRequest, type HookSessionState } from '@shared/deckHooks'
import { readNewLines, type FollowState } from './files'

/** events.jsonl is emptied at launch once it grows past this. */
const EVENTS_MAX = 4 * 1024 * 1024

/**
 * The hook script, one for every event (its name is $1). It never blocks a session for long:
 * - PermissionRequest: while MasterDeck runs (it touches `alive`), leaves the request in
 *   `pending/<id>.json` and waits for `answers/<id>.json`, which it prints as the hook's answer.
 *   The terminal shows the prompt meanwhile and can be answered there too. It gives up when
 *   MasterDeck withdraws the request (deletes the pending file) or after ~9 minutes.
 * - SessionStart: prints `context/<session id>.json` when MasterDeck left one (the ticket's context).
 * - MonitorCall (PreToolUse on Monitor): only with Settings → Monitors run by MasterDeck (the
 *   `monitors-by` file) and while MasterDeck runs. Leaves the call in `watch-requests/<id>.json`
 *   and waits up to 10s for `watch-answers/<id>.json` (MasterDeck took it over: the call is
 *   denied with why). No answer: Claude Code runs the monitor as usual.
 * - The rest: one line in `events.jsonl`. Stop writes only its session id.
 */
export function hookScript(dir: string): string {
  const q = dir.replace(/'/g, `'\\''`)
  return `#!/bin/bash
# MasterDeck hook: written by MasterDeck at each launch; edits are overwritten.
D='${q}'
ev="$1"
in=$(cat)
sid=$(printf '%s' "$in" | sed -n 's/.*"session_id" *: *"\\([^"]*\\)".*/\\1/p' | head -n 1)
now=$(date +%s)
mkdir -p "$D/pending" "$D/answers" "$D/context" 2>/dev/null
case "$ev" in
  MonitorCall)
    [ "$(cat "$D/monitors-by" 2>/dev/null)" = masterdeck ] || exit 0
    m=$(stat -f %m "$D/alive" 2>/dev/null || stat -c %Y "$D/alive" 2>/dev/null || echo 0)
    [ $((now - m)) -lt 30 ] || exit 0
    mkdir -p "$D/watch-requests" "$D/watch-answers" 2>/dev/null
    id="$now-$$-$RANDOM"
    printf '{"id":"%s","at":%s000,"data":%s}\n' "$id" "$now" "$in" > "$D/watch-requests/$id.tmp" && mv "$D/watch-requests/$id.tmp" "$D/watch-requests/$id.json"
    i=0
    while [ $i -lt 40 ]; do
      if [ -f "$D/watch-answers/$id.json" ]; then cat "$D/watch-answers/$id.json"; rm -f "$D/watch-answers/$id.json" "$D/watch-requests/$id.json"; exit 0; fi
      [ -f "$D/watch-requests/$id.json" ] || exit 0
      sleep 0.25
      i=$((i + 1))
    done
    rm -f "$D/watch-requests/$id.json"
    exit 0 ;;
  PermissionRequest)
    m=$(stat -f %m "$D/alive" 2>/dev/null || stat -c %Y "$D/alive" 2>/dev/null || echo 0)
    [ $((now - m)) -lt 30 ] || exit 0
    id="$now-$$-$RANDOM"
    printf '{"id":"%s","pid":%s,"at":%s000,"data":%s}\\n' "$id" "$$" "$now" "$in" > "$D/pending/$id.tmp" && mv "$D/pending/$id.tmp" "$D/pending/$id.json"
    i=0
    while [ $i -lt 1080 ]; do
      if [ -f "$D/answers/$id.json" ]; then cat "$D/answers/$id.json"; rm -f "$D/answers/$id.json" "$D/pending/$id.json"; exit 0; fi
      [ -f "$D/pending/$id.json" ] || exit 0
      sleep 0.5
      i=$((i + 1))
    done
    rm -f "$D/pending/$id.json"
    exit 0 ;;
  Stop)
    printf '{"at":%s000,"event":"Stop","data":{"session_id":"%s"}}\\n' "$now" "$sid" >> "$D/events.jsonl" ;;
  SessionStart)
    printf '{"at":%s000,"event":"%s","data":%s}\\n' "$now" "$ev" "$in" >> "$D/events.jsonl"
    case "$sid" in *[!0-9a-fA-F-]*|'') ;; *) [ -f "$D/context/$sid.json" ] && cat "$D/context/$sid.json" ;; esac ;;
  *)
    printf '{"at":%s000,"event":"%s","data":%s}\\n' "$now" "$ev" "$in" >> "$D/events.jsonl" ;;
esac
exit 0
`
}

/**
 * MasterDeck's side of the hook: writes the script, says it is running (`alive`), reads events and
 * pending permission requests, answers or withdraws them, and leaves SessionStart context.
 */
export class DeckHooks {
  readonly dir: string
  readonly script: string
  private follow: FollowState
  /** By session id (the full one). */
  readonly sessions: Record<string, HookSessionState> = {}

  constructor(home: string) {
    this.dir = join(home, 'deck')
    this.script = join(this.dir, 'hook.sh')
    this.follow = { path: join(this.dir, 'events.jsonl'), offset: 0, rest: '' }
  }

  /** Write the script (every launch: it follows this version) and the folders it uses. */
  setup(): void {
    for (const d of ['', 'pending', 'answers', 'context', 'watch-requests', 'watch-answers']) mkdirSync(join(this.dir, d), { recursive: true })
    writeFileSync(this.script, hookScript(this.dir))
    chmodSync(this.script, 0o755)
    try {
      if (statSync(this.follow.path).size > EVENTS_MAX) truncateSync(this.follow.path, 0)
    } catch {
      // none yet
    }
    // Events from before this launch still say what sessions did last (a failure, a compaction).
    this.follow.offset = 0
    this.touch()
  }

  /** Tell the hook MasterDeck is running: permission requests wait for it only then. */
  touch(): void {
    const p = join(this.dir, 'alive')
    try {
      const t = new Date()
      if (existsSync(p)) utimesSync(p, t, t)
      else writeFileSync(p, '')
    } catch {
      // next tick
    }
  }

  /** Read new events; the ids of the sessions they changed. */
  readEvents(): Set<string> {
    const changed = new Set<string>()
    for (const line of readNewLines(this.follow, Infinity)) {
      if (!line.trim()) continue
      const sid = applyEventLine(this.sessions, line)
      if (sid) changed.add(sid)
    }
    return changed
  }

  /** Requests whose hook still waits, oldest first. */
  pending(): HookRequest[] {
    const dir = join(this.dir, 'pending')
    const out: HookRequest[] = []
    let names: string[] = []
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.json'))
    } catch {
      return out
    }
    for (const n of names) {
      const path = join(dir, n)
      let text = ''
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      const r = parseRequest(text)
      if (!r || !alive(r.pid)) {
        rm(path)
        continue
      }
      out.push(r)
    }
    return out.sort((a, b) => a.at - b.at)
  }

  /** Give the hook its answer (it prints it, and the session goes on). */
  answer(id: string, decision: object): boolean {
    if (!existsSync(join(this.dir, 'pending', `${id}.json`))) return false
    const tmp = join(this.dir, 'answers', `${id}.tmp`)
    writeFileSync(tmp, JSON.stringify(decision))
    renameSync(tmp, join(this.dir, 'answers', `${id}.json`))
    return true
  }

  /** The request is over (answered elsewhere): the hook stops waiting. */
  withdraw(id: string): void {
    rm(join(this.dir, 'pending', `${id}.json`))
  }

  /** Settings → Monitors run by: the hook reads this before handing a Monitor call over. */
  setMonitorsBy(by: 'claude' | 'masterdeck'): void {
    try {
      writeFileSync(join(this.dir, 'monitors-by'), by)
    } catch {
      // next change
    }
  }

  /** Monitor calls the hook is waiting on, oldest first (raw text; see parseWatchRequest). */
  watchRequests(): { id: string; text: string }[] {
    const dir = join(this.dir, 'watch-requests')
    let names: string[] = []
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
    const out: { id: string; text: string }[] = []
    for (const n of names.sort()) {
      try {
        out.push({ id: n.slice(0, -5), text: readFileSync(join(dir, n), 'utf8') })
      } catch {
        // taken meanwhile
      }
    }
    return out
  }

  /** Answer a Monitor call (the hook prints it); or, with null, let Claude Code run it. */
  answerWatch(id: string, answer: object | null): void {
    const req = join(this.dir, 'watch-requests', `${id}.json`)
    if (!answer) return rm(req)
    mkdirSync(join(this.dir, 'watch-answers'), { recursive: true })
    const tmp = join(this.dir, 'watch-answers', `${id}.tmp`)
    writeFileSync(tmp, JSON.stringify(answer))
    renameSync(tmp, join(this.dir, 'watch-answers', `${id}.json`))
  }

  /** What SessionStart tells this session (null: nothing). */
  setContext(sessionId: string, json: object | null): void {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return
    const p = join(this.dir, 'context', `${sessionId}.json`)
    if (!json) return rm(p)
    const text = JSON.stringify(json)
    try {
      if (existsSync(p) && readFileSync(p, 'utf8') === text) return
    } catch {
      // rewrite
    }
    writeFileSync(`${p}.tmp`, text)
    renameSync(`${p}.tmp`, p)
  }

  /** Context files of sessions no longer live. */
  pruneContext(live: Set<string>): void {
    try {
      for (const n of readdirSync(join(this.dir, 'context'))) if (n.endsWith('.json') && !live.has(n.slice(0, -5))) rm(join(this.dir, 'context', n))
    } catch {
      // none
    }
  }
}

function alive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function rm(p: string): void {
  try {
    unlinkSync(p)
  } catch {
    // gone
  }
}
