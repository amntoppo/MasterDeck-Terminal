/**
 * The workflow a ticket goes through (issue → session → PR → merge), the hooks that run at each
 * point, and custom steps: a skill the user attaches to a point, run by a Claude Code hook.
 */

export type TriggerId = 'session-start' | 'linked' | 'after-push' | 'before-pr' | 'pr-created' | 'pr-merged'

export interface Trigger {
  id: TriggerId
  label: string
  /** The Claude Code hook event. */
  event: 'SessionStart' | 'PreToolUse' | 'PostToolUse'
  /** For tool events: an extended regex a Bash command must match (a command that runs it, not text that mentions it). */
  command?: string
  /** PostToolUse: only when the command succeeded (its output shows it). */
  success?: string
  /** Once per session and commit (a PR can be tried twice), or once per session. */
  once: 'commit' | 'session' | 'always'
}

/** Start of a shell command: the line start, or after ; & | or a parenthesis. */
const RUNS = '(^|[;&|(])[[:space:]]*(command[[:space:]]+)?'

export const TRIGGERS: Trigger[] = [
  { id: 'session-start', label: 'When a session starts or resumes', event: 'SessionStart', once: 'session' },
  { id: 'linked', label: 'When a session is linked to its issue', event: 'PostToolUse', command: `tt\\.sh"?[[:space:]]+link`, success: 'linked session to #', once: 'session' },
  { id: 'after-push', label: 'After a git push', event: 'PostToolUse', command: `${RUNS}git[[:space:]]+push`, once: 'commit' },
  { id: 'before-pr', label: 'Just before a PR is created', event: 'PreToolUse', command: `${RUNS}gh[[:space:]]+pr[[:space:]]+create`, once: 'commit' },
  { id: 'pr-created', label: 'When a PR is created', event: 'PostToolUse', command: `${RUNS}gh[[:space:]]+pr[[:space:]]+create`, success: '/pull/[0-9]', once: 'commit' },
  { id: 'pr-merged', label: 'When a PR is merged (gh pr merge)', event: 'PostToolUse', command: `${RUNS}gh[[:space:]]+pr[[:space:]]+merge`, once: 'commit' },
]

export interface CustomStep {
  id: string
  trigger: TriggerId
  /** skill: run a skill; instruction: hand the session the instructions as they are. */
  kind: 'skill' | 'instruction'
  /** The skill to run ('' for an instruction). */
  skill: string
  /** background: a subagent runs it while the session carries on; session: the session runs it. */
  mode: 'background' | 'session'
  instructions: string
}

export const STEP_MARK = 'masterdeck-workflow:'

/** The note a custom step's hook hands the session. */
export function stepNote(s: CustomStep): string {
  const t = TRIGGERS.find((x) => x.id === s.trigger)
  const extra = s.instructions.trim() ? ` ${s.instructions.trim().replace(/\s+/g, ' ')}` : ''
  if (s.kind === 'instruction') return `Workflow instruction (${t?.label ?? s.trigger}):${extra}`
  if (s.mode === 'session')
    return `Workflow step (${t?.label ?? s.trigger}): now use the ${s.skill} skill for this session's work.${extra} Then carry on with what you were doing.`
  return (
    `Workflow step (${t?.label ?? s.trigger}): launch a subagent with the Agent tool (general-purpose, run in the background, ` +
    `do not wait for it) with this prompt, filled in: Use the ${s.skill} skill for the work on branch <branch> in <worktree path>, ` +
    `linked to issue <#N>.${extra} Do not commit, push or switch branches unless the skill says to; at the end, report what you did. ` +
    `Then carry on here without waiting, and pass on its report when it arrives.`
  )
}

/** Single-quote for sh. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
const q = shellQuote

/**
 * awk: a Bash command without its heredoc bodies, so text written to a file (a script, a test that
 * mentions `gh pr create`) is not taken for a command that runs.
 */
export const STRIP_HEREDOCS =
  'd != "" { if ($0 == d) d = ""; next } { print } ' +
  'match($0, /<<-?[ \\t]*[\\047"]?[A-Za-z_][A-Za-z0-9_]*/) { s = substr($0, RSTART, RLENGTH); sub(/^<<-?[ \\t]*[\\047"]?/, "", s); d = s }'

/** sh: exit unless the Bash command in $cmd runs something matching `pattern` (an extended regex). */
export function runsOrExit(pattern: string): string {
  return `printf '%s\\n' "$cmd" | awk ${q(STRIP_HEREDOCS)} | grep -Eq ${q(pattern)} || exit 0`
}

/** The hook command for a custom step: match, run once, then hand the note to the session. */
export function stepCommand(s: CustomStep): string {
  const t = TRIGGERS.find((x) => x.id === s.trigger)
  if (!t) throw new Error(`unknown trigger ${s.trigger}`)
  const lines = [`input=$(cat)`]
  if (t.command) {
    lines.push(`cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')`)
    lines.push(runsOrExit(t.command))
  }
  if (t.success) lines.push(`printf '%s' "$input" | jq -r '.tool_response | tostring' | grep -q ${q(t.success)} || exit 0`)
  if (t.once !== 'always') {
    lines.push(`sid=$(printf '%s' "$input" | jq -r '.session_id // "none"')`)
    const key = t.once === 'commit' ? `$sid-$(git rev-parse HEAD 2>/dev/null || echo none)` : '$sid'
    lines.push(`m="\${TMPDIR:-/tmp}/masterdeck-workflow-${s.id}-${key}"; [ -f "$m" ] && exit 0; touch "$m"`)
  }
  lines.push(`jq -n --arg c ${q(stepNote(s))} '{hookSpecificOutput:{hookEventName:${JSON.stringify(t.event)},additionalContext:$c}}'`)
  // The mark lets MasterDeck find its own hooks again.
  return `${lines.join('; ')} # ${STEP_MARK}${s.id}`
}

export function parseSteps(raw: unknown): CustomStep[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { steps?: unknown }).steps) ? (raw as { steps: unknown[] }).steps : []
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .filter((x) => typeof x.id === 'string' && /^[a-z0-9-]{1,40}$/.test(x.id) && TRIGGERS.some((t) => t.id === x.trigger))
    // A skill step needs a skill; an instruction step needs its text.
    .filter((x) =>
      x.kind === 'instruction'
        ? typeof x.instructions === 'string' && x.instructions.trim() !== ''
        : typeof x.skill === 'string' && /^[\w:.-]{1,80}$/.test(x.skill),
    )
    .map((x): CustomStep => {
      const instruction = x.kind === 'instruction'
      return {
        id: x.id as string,
        trigger: x.trigger as TriggerId,
        kind: instruction ? 'instruction' : 'skill',
        skill: instruction ? '' : (x.skill as string),
        // An instruction is handed to the session itself.
        mode: instruction || x.mode === 'session' ? 'session' : 'background',
        instructions: typeof x.instructions === 'string' ? x.instructions.slice(0, 2000) : '',
      }
    })
}

/** A hook Claude Code runs, wherever it is defined. */
export interface HookEntry {
  /** user: ~/.claude/settings.json; project: a repo's .claude/settings(.local).json; plugin: an enabled plugin. */
  source: 'user' | 'project' | 'plugin'
  /** The plugin, or the repo folder name. */
  where: string | null
  event: string
  matcher: string | null
  command: string
  /** What it is, when we know: a MasterDeck skill's hook, a custom step, the status line... */
  owner: string | null
}

/** Name a hook by the markers of the hooks MasterDeck installs. */
export function hookOwner(command: string): string | null {
  const step = new RegExp(`${STEP_MARK}([a-z0-9-]+)`).exec(command)
  if (step) return `custom step ${step[1]}`
  if (command.includes('babysit-ticket/scripts/tt.sh')) return 'babysit-ticket'
  if (command.includes('pr-selfreview-')) return 'babysit-pr (self-review gate)'
  if (command.includes('Monitor phase of the babysit-pr')) return 'babysit-pr (watch the PR)'
  if (command.includes('queue-submit.sh')) return 'queue (store /queue prompts)'
  if (command.includes('queue-drain.sh')) return 'queue (run the next prompt)'
  if (command.includes('statusline_tee')) return 'MasterDeck status line (costs)'
  return null
}

/** Which stage of the workflow a hook belongs to (a custom step: its trigger's stage). */
export function stageOf(h: { event: string; command: string }, steps: CustomStep[] = []): StageId {
  const c = h.command
  const step = new RegExp(`${STEP_MARK}([a-z0-9-]+)`).exec(c)
  const own = step && steps.find((s) => s.id === step[1])
  if (own) return STAGES.find((x) => x.trigger === own.trigger)?.id ?? 'work'
  const has = (...xs: string[]) => xs.some((x) => c.includes(x))
  if (h.event === 'SessionStart') return 'session'
  if (['UserPromptSubmit', 'UserPromptExpansion', 'Stop', 'StopFailure', 'Notification', 'PermissionRequest', 'SubagentStop', 'PreCompact'].includes(h.event)) return 'instructions'
  if (h.event === 'PreToolUse' && has('pr create', 'pr[[:space:]]+create')) return 'before-pr'
  if (h.event === 'PostToolUse' && has('pr create', 'pr[[:space:]]+create', 'Monitor phase', 'babysit-ticket/scripts/tt.sh')) return 'pr-created'
  if (h.event === 'PostToolUse' && has('pr merge', 'pr[[:space:]]+merge')) return 'merged'
  return 'work'
}

export type StageId = 'issue' | 'session' | 'linked' | 'instructions' | 'work' | 'before-pr' | 'pr-created' | 'merged'

export interface Stage {
  id: StageId
  title: string
  /** Who acts. */
  actor: string
  what: string
  /** Where custom steps attach. */
  trigger?: TriggerId
  /** What MasterDeck and its skills do here, beyond hooks (hooks are listed live). */
  builtin: string[]
}

export const STAGES: Stage[] = [
  {
    id: 'issue',
    title: 'Issue',
    actor: 'GitHub',
    what: 'A ticket on the board, ready to pick up.',
    builtin: ['master-agent proposes it (ASSIGN) when it is yours and in the current sprint, if master is on', 'Or you press Start on the card or in the Start dialog'],
  },
  {
    id: 'session',
    title: 'Claude session',
    actor: 'MasterDeck',
    what: '`claude --bg` starts a background session with the drafted prompt: link the ticket, make a worktree, then ask you.',
    trigger: 'session-start',
    builtin: ['master spawn / Start: `claude --bg -n <name> [--model] "<prompt>"`', 'Resumes keep the same session (restart banner, Resume on a card)'],
  },
  {
    id: 'linked',
    title: 'babysit-ticket',
    actor: 'the session',
    what: 'The session links itself to the issue and moves into its own worktree.',
    trigger: 'linked',
    builtin: ['babysit-ticket: `tt.sh link <#N>` records the link and moves the card to In progress', 'babysit-worktree: a git worktree for the ticket, so your checkout stays clean'],
  },
  {
    id: 'instructions',
    title: 'Your instructions',
    actor: 'you',
    what: 'The session stops and asks; you plan the work with it, answer questions, or queue prompts.',
    builtin: ['Needs you: a card when a session waits on you; its question and options, a reply, Continue', 'Queue: prompts you line up run one by one'],
  },
  {
    id: 'work',
    title: 'Work',
    actor: 'the session',
    what: 'Edits, tests, commits and pushes.',
    trigger: 'after-push',
    builtin: ['Tokens, cost and context are tracked from the status line and the transcript'],
  },
  {
    id: 'before-pr',
    title: 'babysit-PR: before the PR',
    actor: 'the session',
    what: 'Just before `gh pr create`.',
    trigger: 'before-pr',
    builtin: ['babysit-pr: self-review of the branch diff, fixes, then a marker for this commit'],
  },
  {
    id: 'pr-created',
    title: 'PR hooks',
    actor: 'the session',
    what: 'Right after `gh pr create` succeeds.',
    trigger: 'pr-created',
    builtin: ['babysit-ticket: links the PR under Development and moves the card to PR raised', 'babysit-pr: watches the PR; fixes review comments and CI until it is merged or closed'],
  },
  {
    id: 'merged',
    title: 'Merged',
    actor: 'GitHub / the session',
    what: 'The PR is merged.',
    trigger: 'pr-merged',
    builtin: ['babysit-ticket sync: the card moves to Dev done once every PR of the ticket is merged', 'Janitor: Clean up removes worktrees whose PR is merged'],
  },
]
