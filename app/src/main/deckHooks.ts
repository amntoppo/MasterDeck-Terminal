import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyEventLine, parseRequest, type HookRequest, type HookSessionState } from '@shared/deckHooks'
import { readNewLines, type FollowState } from './files'
import { queueAnswer, queueDir, readQueue, shiftQueue } from './queue'

/** events.jsonl is emptied at launch once it grows past this. */
const EVENTS_MAX = 4 * 1024 * 1024

/**
 * The master reports guard, as a jq program (no single quote in it: it sits in a quoted bash
 * string; `$q` is one). A SendMessage is a report when the first non-empty line of its message (or of
 * its summary) reads `#12: done`, `name#12: question — …` and so on. A report passes only to the
 * master (config masterName, also in the ListAgents form `name [ref]`) or from the master session
 * itself; with master turned off it passes to nobody. Anything else, and anything unreadable,
 * prints nothing: the call goes on as usual.
 */
const MASTER_REPORT_JQ = String.raw`
def line: if type == "string" then ([splits("\r?\n") | select(test("\\S"))][0] // "") else "" end;
def report: line | capture("^\\s*(?<label>#\\d+|[A-Za-z0-9._-]+#\\d+)\\s*:\\s*(?<kind>done|blocked|question|answered)\\b"; "i");
(try ($cfg | fromjson) catch {}) as $raw
| (if ($raw | type) == "object" then $raw else {} end) as $c
| (if ($c.masterName | type) == "string" and ($c.masterName | test("\\S")) then ($c.masterName | gsub("^\\s+|\\s+$"; "")) else "master-agent" end) as $name
| ($c.masterEnabled != false) as $on
| (.session_id) as $sid
| ($sids | split("\n") | any(. != "" and . == $sid)) as $me
| (.tool_input // {}) as $t
| ([($t.message | report), ($t.summary | report)][0]) as $r
| if $r == null or ($t.to | type) != "string" then empty else
    ($t.to | ascii_downcase | gsub("^\\s+|\\s+$"; "")) as $to
    | ($name | ascii_downcase) as $n
    | "\($q)\($r.label): \($r.kind | ascii_downcase)\($q)" as $what
    | if $on and ($me or $to == $n or (($to | startswith($n + " [")) and ($to | ltrimstr($n + " [") | test("^[^\\[\\]]*\\]$")))) then empty
      else {hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: (
        if $on then "MasterDeck: reports like \($what) go only to \($name). It is not reachable, so do not send this to any other session; ask the user here instead."
        else "MasterDeck: \($name) is turned off, so reports like \($what) go to no session; say it to the user here instead." end)}}
      end
  end
`.trim()

/**
 * The hook script, one for every event (its name is $1). It never blocks a session for long:
 * - PermissionRequest: while MasterDeck runs (it touches `alive`), leaves the request in
 *   `pending/<id>.json` and waits for `answers/<id>.json`, which it prints as the hook's answer.
 *   The terminal shows the prompt meanwhile and can be answered there too. It gives up when
 *   MasterDeck withdraws the request (deletes the pending file) or after ~9 minutes.
 * - SessionStart: prints `context/<session id>.json` when MasterDeck left one (the ticket's context).
 * - MasterReport (PreToolUse on SendMessage): a report meant for master (`#12: done`, see
 *   MASTER_REPORT_JQ) is denied unless it goes to the master, whose name is read from the config
 *   file (`configPath`, baked in) on every call. The sessions in `master-sids` (the master
 *   itself, setMasterSessions) may send anything. No `#<digit>` in the input, no jq, or input
 *   that does not parse: nothing is printed and the call goes on.
 * - MonitorCall (PreToolUse on Monitor): only with Settings → Monitors run by MasterDeck (the
 *   `monitors-by` file) and while MasterDeck runs. Leaves the call in `watch-requests/<id>.json`
 *   and waits up to 10s for `watch-answers/<id>.json` (MasterDeck took it over: the call is
 *   denied with why). No answer: Claude Code runs the monitor as usual.
 * - UserPromptSubmit: `/queue <prompt>` is stored in `<queueDir>/<session id>.jsonl` and the
 *   prompt blocked (`/queue` lists, `/queue clear` empties); any other prompt returns at once,
 *   unread and unlogged.
 * - Stop: one line in `events.jsonl` (only its session id); then, with prompts queued, hands the
 *   next one over. While MasterDeck runs it leaves `queue-requests/<id>.json` and waits up to 4s
 *   for MasterDeck to claim it (rename to `.taken`) and write `queue-answers/<id>.json`. Not
 *   claimed: the hook takes the request back by renaming it itself and drains one item; claimed:
 *   it waits until 7s after its start for the answer. One rename wins, so exactly one of them
 *   takes the item. Deadlines are by the clock: at most ~7s, under the 10s hook timeout.
 * - `queue-off` (the queue skill's hooks installed by hand): both leave /queue to those hooks.
 * - `legacy-sids` (one session id a line, or `*`): sessions alive when the migration took the queue
 *   skill's hooks out still run them (Claude Code reads hooks at session start), so the hook does no
 *   queue work for them (markLegacy, pruneLegacy).
 * - The rest: one line in `events.jsonl`.
 */
export function hookScript(dir: string, queueDir: string, configPath = join(dir, 'config.json')): string {
  const esc = (p: string) => p.replace(/'/g, `'\\''`)
  return `#!/bin/bash
# MasterDeck hook: written by MasterDeck at each launch; edits are overwritten.
D='${esc(dir)}'
Q='${esc(queueDir)}'
C='${esc(configPath)}'
ev="$1"
in=$(cat)
sid=$(printf '%s' "$in" | sed -n 's/.*"session_id" *: *"\\([^"]*\\)".*/\\1/p' | head -n 1)
now=$(date +%s)
# Sessions that still run the queue skill's hooks (alive at the migration; "*": not known yet).
legacy() { [ -f "$D/legacy-sids" ] && grep -qxF -e "$sid" -e '*' "$D/legacy-sids"; }
if [ "$ev" = MasterReport ]; then
  # Fast path: a report carries a ticket number (#12); most messages go no further (no jq).
  case "$in" in *'#'[0-9]*) ;; *) exit 0 ;; esac
  command -v jq >/dev/null 2>&1 || exit 0
  printf '%s' "$in" | jq -c --arg cfg "$(cat "$C" 2>/dev/null)" --arg sids "$(cat "$D/master-sids" 2>/dev/null)" --arg q "'" '${MASTER_REPORT_JQ}' 2>/dev/null
  exit 0
fi
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
  UserPromptSubmit)
    # Fast path: only /queue prompts go further (no jq, nothing logged, for the rest).
    case "$in" in *'"prompt":"/queue'*|*'"prompt": "/queue'*) ;; *) exit 0 ;; esac
    [ -f "$D/queue-off" ] && exit 0
    command -v jq >/dev/null 2>&1 || exit 0
    case "$sid" in *[!0-9a-fA-F-]*|'') exit 0 ;; esac
    legacy && exit 0
    prompt=$(printf '%s' "$in" | jq -r '.prompt // ""')
    case "$prompt" in /queue|/queue[[:space:]]*) ;; *) exit 0 ;; esac
    mkdir -p "$Q" 2>/dev/null
    f="$Q/$sid.jsonl"
    arg=$(printf '%s' "\${prompt#/queue}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    case "$arg" in
      ''|list)
        if [ -s "$f" ]; then r="Queue ($(wc -l < "$f" | tr -d ' ')):
$(jq -r 'input_line_number as $n | "\\($n). \\(.)"' "$f" 2>/dev/null)"; else r="Queue empty."; fi ;;
      clear) rm -f "$f"; r="Queue cleared." ;;
      *) jq -cn --arg p "$arg" '$p' >> "$f"; r="Queued #$(wc -l < "$f" | tr -d ' '): $arg" ;;
    esac
    jq -n --arg r "$r" '{decision: "block", reason: $r}'
    exit 0 ;;
  Stop)
    printf '{"at":%s000,"event":"Stop","data":{"session_id":"%s"}}\\n' "$now" "$sid" >> "$D/events.jsonl"
    case "$sid" in *[!0-9a-fA-F-]*|'') exit 0 ;; esac
    [ -f "$D/queue-off" ] && exit 0
    legacy && exit 0
    f="$Q/$sid.jsonl"
    [ -s "$f" ] || exit 0
    m=$(stat -f %m "$D/alive" 2>/dev/null || stat -c %Y "$D/alive" 2>/dev/null || echo 0)
    if [ $((now - m)) -lt 30 ]; then
      # MasterDeck runs: it picks the next prompt. It claims the request by renaming it, so only
      # one of us ever takes this turn's item.
      mkdir -p "$D/queue-requests" "$D/queue-answers" 2>/dev/null
      id="$now-$$-$RANDOM"
      r="$D/queue-requests/$id"
      a="$D/queue-answers/$id.json"
      printf '{"id":"%s","sid":"%s"}' "$id" "$sid" > "$r.tmp" && mv "$r.tmp" "$r.json"
      # Deadlines by the clock (from the hook's start), so a slow machine never meets the 10s kill.
      while [ "$(date +%s)" -lt $((now + 4)) ]; do
        if [ -f "$a" ]; then cat "$a"; rm -f "$a" "$r.taken"; exit 0; fi
        sleep 0.25
      done
      if mv "$r.json" "$r.gone" 2>/dev/null; then
        rm -f "$r.gone"   # never claimed: drain it here
      else
        while [ "$(date +%s)" -lt $((now + 7)) ]; do
          if [ -f "$a" ]; then cat "$a"; rm -f "$a" "$r.taken"; exit 0; fi
          sleep 0.25
        done
        rm -f "$r.taken"
        exit 0
      fi
    fi
    command -v jq >/dev/null 2>&1 || exit 0
    next=$(head -n 1 "$f" | jq -r '.')
    tail -n +2 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    [ -s "$f" ] || rm -f "$f"
    left=0
    [ -f "$f" ] && left=$(wc -l < "$f" | tr -d ' ')
    jq -n --arg p "$next" --arg left "$left" '{decision: "block", reason: ("Next queued user prompt (" + $left + " more after this). Treat it as a new user request and handle it fully:\\n\\n" + $p), systemMessage: ("▶ queue: " + $p)}'
    exit 0 ;;
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
  /** What master-sids holds (null: not written by this run yet). */
  private masterSids: string | null = null

  constructor(
    home: string,
    private queues = queueDir(),
    /** The shared config file (masterName, masterEnabled): the hook reads it on every report. */
    private config = join(home, 'deck', 'config.json'),
  ) {
    this.dir = join(home, 'deck')
    this.script = join(this.dir, 'hook.sh')
    this.follow = { path: join(this.dir, 'events.jsonl'), offset: 0, rest: '' }
  }

  /** Write the script (every launch: it follows this version) and the folders it uses. */
  setup(): void {
    for (const d of ['', 'pending', 'answers', 'context', 'watch-requests', 'watch-answers', 'queue-requests', 'queue-answers']) mkdirSync(join(this.dir, d), { recursive: true })
    writeFileSync(this.script, hookScript(this.dir, this.queues, this.config))
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

  /** Stops waiting for MasterDeck to pick the next queued prompt (request files left by the hook). */
  queueRequests(now = Date.now()): { id: string; sid: string }[] {
    const dir = join(this.dir, 'queue-requests')
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const out: { id: string; sid: string }[] = []
    for (const n of names.sort()) {
      const p = join(dir, n)
      const id = n.replace(/\.(json|taken)$/, '')
      // Leftovers of a hook that was killed: the hook gives up after 7 s.
      if (now - Number(id.split('-')[0]) * 1000 > 60_000) {
        rm(p)
        continue
      }
      if (!n.endsWith('.json') || !/^[0-9]+-[0-9]+-[0-9]+$/.test(id)) continue
      // Past the hook's wait (7 s from its start): nobody would read an answer.
      if (!(now - Number(id.split('-')[0]) * 1000 < 8_000)) continue
      try {
        const r = JSON.parse(readFileSync(p, 'utf8')) as { sid?: unknown }
        if (typeof r.sid === 'string' && /^[0-9a-f-]{36}$/i.test(r.sid)) out.push({ id, sid: r.sid })
      } catch {
        // half-written or taken back
      }
    }
    return out
  }

  /**
   * A session's turn ended with prompts queued: hand each waiting hook the next one (once). The
   * hook must be there (its pid is in the id) when we claim; the item goes once the hook read the
   * answer or still runs to read it. Peek, answer, then take it off: a crash, or a hook that died
   * before reading, repeats a prompt rather than losing it.
   */
  pumpQueue(now = Date.now(), isAlive = alive): void {
    for (const r of this.queueRequests(now)) {
      const pid = Number(r.id.split('-')[1])
      if (!isAlive(pid) || !this.claimQueue(r.id)) continue
      const items = readQueue(r.sid, this.queues)
      this.answerQueue(r.id, items.length ? queueAnswer(items[0], items.length - 1) : {})
      if (!items.length) continue
      // Alive: it will read the answer. Gone: the hook removes its answer right after reading it,
      // so an answer still there was never read. Checked in this order, the file can't change after.
      const unread = join(this.dir, 'queue-answers', `${r.id}.json`)
      if (isAlive(pid) || !existsSync(unread)) shiftQueue(r.sid, this.queues)
      else rm(unread)
    }
    // Answers nobody read (the hook was killed after its claim).
    const dir = join(this.dir, 'queue-answers')
    try {
      for (const n of readdirSync(dir)) if (now - Number(n.split('-')[0]) * 1000 > 60_000) rm(join(dir, n))
    } catch {
      // none yet
    }
  }

  /** Take this Stop: false when the hook took it back first (it drains the queue itself then). */
  claimQueue(id: string): boolean {
    try {
      renameSync(join(this.dir, 'queue-requests', `${id}.json`), join(this.dir, 'queue-requests', `${id}.taken`))
      return true
    } catch {
      return false
    }
  }

  answerQueue(id: string, answer: object): void {
    const dir = join(this.dir, 'queue-answers')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.tmp`), JSON.stringify(answer))
    renameSync(join(dir, `${id}.tmp`), join(dir, `${id}.json`))
  }

  /** The live master sessions (ids): the reports guard lets them send anything. Written on change. */
  setMasterSessions(ids: string[]): void {
    const p = join(this.dir, 'master-sids')
    const text = [...new Set(ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))].sort().join('\n')
    if (text === this.masterSids) return
    try {
      if (!text) rm(p)
      else {
        mkdirSync(this.dir, { recursive: true })
        writeFileSync(`${p}.tmp`, text + '\n')
        renameSync(`${p}.tmp`, p)
      }
      this.masterSids = text
    } catch {
      // next state
    }
  }

  /** Queue hooks installed by hand handle /queue: MasterDeck's hook leaves it to them. */
  setQueueOff(off: boolean): void {
    const p = join(this.dir, 'queue-off')
    try {
      if (off) writeFileSync(p, '')
      else rm(p)
    } catch {
      // next launch
    }
  }

  /** The migration took the queue skill's hooks out: sessions alive now keep running them. Their
   * ids are not known yet (the session list comes later), so every session is skipped until then. */
  markLegacy(): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, 'legacy-sids'), '*\n')
  }

  /** With the session list in: `*` becomes the live sessions; the file goes once none of them is alive. */
  pruneLegacy(live: Set<string>): void {
    const p = join(this.dir, 'legacy-sids')
    let ids: string[]
    try {
      ids = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    } catch {
      return // none
    }
    const left = ids.includes('*') ? [...live] : ids.filter((id) => live.has(id))
    try {
      if (!left.length) return rm(p)
      if (left.length === ids.length && !ids.includes('*')) return
      writeFileSync(`${p}.tmp`, left.join('\n') + '\n')
      renameSync(`${p}.tmp`, p)
    } catch {
      // next state
    }
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
