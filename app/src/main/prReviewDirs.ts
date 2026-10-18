import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { PR_REVIEW_NAME, type PrReviewContext } from '@shared/prReview'
import { TICKET_TAB } from '@shared/ticketBuilder'

/**
 * The Pull requests view's review sessions (Review with Claude): one folder per PR tab,
 * `<home>/pr-review/tab-<tabId>/`, with CLAUDE.md (how to review), context.json (the tab, its
 * filters, the selected PR, the account) and project settings. With two or more accounts its
 * session runs as the tab's account. Its post script and guard live outside it (prReviewGuard).
 */
export function prReviewDir(home: string, tab: string | null | undefined): string {
  if (!tab || !TICKET_TAB.test(tab)) throw new Error(`refusing a PR review for tab ${JSON.stringify(tab)}`)
  return join(home, 'pr-review', `tab-${tab}`)
}

/**
 * What the post script checks against: the selected PR and the account, kept outside the review
 * folder (`<home>/pr-review-guard/tab-<tabId>.json`), where the session's unasked edits don't reach.
 */
export function prReviewGuard(home: string, tab: string): string {
  if (!TICKET_TAB.test(tab)) throw new Error(`refusing a PR review for tab ${JSON.stringify(tab)}`)
  return join(home, 'pr-review-guard', `tab-${tab}.json`)
}

/** Where the review session's hooks say whether its turn is over (idle, busy): next to its guard. */
export const prReviewTurn = (guard: string): string => guard.replace(/\.json$/, '.turn')

/**
 * The PRs Automate Review queued for this tab (#157), written by main only, outside the folder:
 * the post script's `--auto` posts a comment review to these and nothing else.
 */
export const prReviewAuto = (guard: string): string => guard.replace(/\.json$/, '.auto.json')

/**
 * The tab's batch (Review selected, #176), written by main only, outside the folder: `[{url, id}]`
 * of the PRs the post script may still post to (its `--batch` form, and the asked form).
 */
export const prReviewBatchFile = (guard: string): string => guard.replace(/\.json$/, '.batch.json')

/** What the post script did for each batch PR, one JSON line each (`shared/reviewBatch.ts` parseLogLines); main reads it. */
export const prReviewBatchLog = (guard: string): string => guard.replace(/\.json$/, '.batch-log.jsonl')

/**
 * The tab's post script, beside its guard. Never in the session's folder: there acceptEdits lets
 * the session rewrite files without asking (cp, sed…), and the script is what the user approves.
 */
export function prReviewPost(home: string, tab: string): string {
  if (!TICKET_TAB.test(tab)) throw new Error(`refusing a PR review for tab ${JSON.stringify(tab)}`)
  return join(home, 'pr-review-guard', `post-review-${tab}.sh`)
}

/** A review folder MasterDeck may write: one not made yet, or a real (not symlinked) folder directly inside the real `<home>/pr-review`. */
export function prReviewDirOk(home: string, dir: string): boolean {
  try {
    if (!lstatSync(dir).isDirectory()) return false
  } catch {
    return true
  }
  try {
    return dirname(realpathSync(dir)) === realpathSync(join(home, 'pr-review'))
  } catch {
    return false
  }
}

/** The account a tab's session works as, from its guard (not context.json, which the session can edit); null if none or a bad tab. */
export function prReviewFolderAccount(home: string, tab: string): string | null {
  try {
    const a = JSON.parse(readFileSync(prReviewGuard(home, tab), 'utf8')).account
    return typeof a === 'string' ? a : null
  } catch {
    return null
  }
}

type SettingsArgs = (login?: string) => { ok: true; args: string[] } | { ok: false; message: string }

/**
 * Where a pr-review pane runs and as whom: always its tab's folder. One account: no settings (gh's
 * active account, as the ticket builder). Several: the tab's account, or refused (never run as
 * gh's active account by accident).
 */
export function prReviewPane(
  home: string,
  multi: boolean,
  spec: { tab?: string; account?: string },
  settingsArgs: SettingsArgs,
): { cwd: string; settings: string[] } | { error: string } {
  let cwd: string
  try {
    cwd = prReviewDir(home, spec.tab)
  } catch (e) {
    return { error: (e as Error).message }
  }
  if (!prReviewDirOk(home, cwd)) return { error: 'refusing a PR review folder that is a link' }
  if (!multi) return { cwd, settings: [] }
  if (!spec.account) return { error: 'refusing a PR review without its tab account' }
  const s = settingsArgs(spec.account)
  if (!s.ok) return { error: s.message }
  return s.args.length ? { cwd, settings: s.args } : { error: 'GitHub accounts are still loading; try again in a few seconds' }
}

/** MasterDeck's own review sessions, not the user's work: hidden from the session list. */
export function isPrReviewSession(s: { name?: string; cwd?: string }, home: string): boolean {
  if (s.name?.startsWith(`${PR_REVIEW_NAME}-`)) return true
  const root = resolve(join(home, 'pr-review'))
  const cwd = resolve(s.cwd || '/')
  return dirname(cwd) === root && basename(cwd).startsWith('tab-')
}

/** Every review folder there is (for the account check of a browser's pane). */
export function prReviewDirs(home: string): string[] {
  try {
    return readdirSync(join(home, 'pr-review'))
      .filter((n) => n.startsWith('tab-') && TICKET_TAB.test(n.slice(4)))
      .map((n) => join(home, 'pr-review', n))
  } catch {
    return []
  }
}

/**
 * The project settings: reading PRs without asking; the post script is asked for each time, but for
 * `--auto` and `--batch` (Automate Review's and Review selected's PRs only, checked by the script);
 * other writes blocked.
 */
export const PR_REVIEW_SETTINGS = {
  permissions: {
    allow: [
      'Bash(gh pr view:*)',
      'Bash(gh pr diff:*)',
      'Bash(gh pr checks:*)',
      'Bash(gh pr list:*)',
      'Bash(gh run view:*)',
      'Bash(gh run list:*)',
      'Bash(gh issue view:*)',
    ],
    // The post script (outside this folder) is the one way to write, and only its --auto form is
    // allowed (prReviewSettings: Automate Review's queue, checked by the script): Claude Code asks the
    // user before every other run, after the session showed what it will post.
    deny: [
      'Edit(./context.json)',
      'Edit(./CLAUDE.md)',
      'Edit(./.claude/**)',
      'Bash(gh pr review:*)',
      'Bash(gh pr comment:*)',
      'Bash(gh pr merge:*)',
      'Bash(gh pr close:*)',
      'Bash(gh pr edit:*)',
      'Bash(gh pr ready:*)',
      'Bash(gh issue comment:*)',
    ],
  },
}

const quote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`

/**
 * The settings with hooks that tell MasterDeck when the session's turn is over (`turn`): Automate
 * Review types its next PR only then. A prompt or a tool call is busy, a stop idle, a start start.
 */
export function prReviewSettings(turn: string, post: string): object {
  const put = (v: string) => [{ hooks: [{ type: 'command', command: `printf ${v} > ${quote(turn)}` }] }]
  const any = (v: string) => [{ matcher: '*', hooks: put(v)[0].hooks }]
  return {
    ...PR_REVIEW_SETTINGS,
    // Automate Review's and Review selected's forms run unasked: the script posts only a comment,
    // only to what MasterDeck queued or the user ticked.
    permissions: { ...PR_REVIEW_SETTINGS.permissions, allow: [`Bash(${post} --auto:*)`, `Bash(${post} --batch:*)`, ...PR_REVIEW_SETTINGS.permissions.allow] },
    hooks: { SessionStart: put('start'), Stop: put('idle'), UserPromptSubmit: put('busy'), PreToolUse: any('busy'), PostToolUse: any('busy') },
  }
}

const atomic = (file: string, text: string) => {
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

/** The guard file's answer to "which PR, as whom" (see prReviewGuard). */
function writeGuard(guard: string, ctx: PrReviewContext): void {
  mkdirSync(dirname(guard), { recursive: true })
  atomic(guard, JSON.stringify({ url: ctx.selected?.url ?? null, account: ctx.account }) + '\n')
}

/** Write a tab's folder (briefing, context, settings), its guard and its post script `post` (each atomically). */
export function writePrReviewDir(dir: string, ctx: PrReviewContext, briefing: string, guard: string, post: string): void {
  writePrReviewFiles(dir, briefing, guard, post)
  writePrReviewContext(dir, ctx, guard)
}

/** Everything but the context: briefing, settings, post script (Automate Review starting a session keeps the window's context). */
export function writePrReviewFiles(dir: string, briefing: string, guard: string, post: string): void {
  mkdirSync(dir, { recursive: true })
  // A `.claude` that is a link (to ~/.claude, say) would have MasterDeck overwrite the user's settings.
  try {
    if (lstatSync(join(dir, '.claude')).isSymbolicLink()) throw new Error('refusing a PR review folder whose .claude is a link')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  mkdirSync(join(dir, '.claude'), { recursive: true })
  mkdirSync(dirname(guard), { recursive: true })
  atomic(join(dir, 'CLAUDE.md'), briefing)
  atomic(join(dir, '.claude', 'settings.json'), JSON.stringify(prReviewSettings(prReviewTurn(guard), post), null, 2) + '\n')
  atomic(post, prReviewScript(dir, guard))
  chmodSync(post, 0o755)
  // The script once lived in the folder, where the session could rewrite it: never leave that copy.
  try {
    unlinkSync(join(dir, 'post-review.sh'))
  } catch {
    /* none */
  }
}

/** Automate Review's queue for a tab (see prReviewAuto). */
export function writePrReviewAuto(guard: string, urls: string[]): void {
  mkdirSync(dirname(guard), { recursive: true })
  atomic(prReviewAuto(guard), JSON.stringify(urls) + '\n')
}

/** The tab's batch file (see prReviewBatchFile). */
export function writePrReviewBatch(guard: string, entries: { url: string; id: string }[]): void {
  mkdirSync(dirname(guard), { recursive: true })
  atomic(prReviewBatchFile(guard), JSON.stringify(entries) + '\n')
}

/** Only the context changed (another PR picked, the filters): the rest stays as written. */
export function writePrReviewContext(dir: string, ctx: PrReviewContext, guard: string): void {
  mkdirSync(dir, { recursive: true })
  writeGuard(guard, ctx)
  atomic(join(dir, 'context.json'), JSON.stringify(ctx, null, 2) + '\n')
}

/**
 * Only the batch changed: context.json's `batch` replaced, the rest kept. Never the guard (what the
 * session may have written into the file never reaches what the script trusts). No context yet: nothing.
 */
export function writePrReviewContextBatch(dir: string, batch: PrReviewContext['batch']): void {
  let ctx: Record<string, unknown>
  try {
    ctx = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'))
  } catch {
    return
  }
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return
  atomic(join(dir, 'context.json'), JSON.stringify({ ...ctx, batch: batch ?? [] }, null, 2) + '\n')
}

/**
 * The review session's one write to GitHub: one review on the PR selected in MasterDeck, or on a PR
 * of the tab's batch (and no other), as the tab's account, from files inside the folder `dir`. It and
 * the files it checks against (`guard`, the queue, the batch) sit outside that folder (prReviewPost).
 * `--auto` (Automate Review) and `--batch` (Review selected) run unasked: a comment review only, to a
 * PR MasterDeck queued or the user ticked; `--batch` posts once per batch entry and logs each step
 * (prReviewBatchLog). Runs gh directly (the session's environment carries the tab's account). macOS
 * bash 3.2; jq is one of MasterDeck's tools.
 */
export function prReviewScript(dir: string, guard: string): string {
  const esc = (p: string) => p.replace(/'/g, `'\\''`)
  return `#!/usr/bin/env bash
# Written by MasterDeck: post one review on the PR selected in the Pull requests view, or on a PR of its batch.
d='${esc(dir)}'
g='${esc(guard)}'
q='${esc(prReviewAuto(guard))}'
b='${esc(prReviewBatchFile(guard))}'
l='${esc(prReviewBatchLog(guard))}'
out() { printf '%s\\n' "$1"; }
err() { jq -cn --arg e "$1" '{ok: false, error: $e}'; exit 1; }
usage() { err 'usage: post-review.sh [--auto | --batch] --pr <url> --event comment|approve|request-changes --body-file <file> [--comments-file <file.json>] [--dry-run]; post-review.sh --batch (--start | --skip <why> | --fail <why>) --pr <url>'; }
command -v jq >/dev/null 2>&1 || { out '{"ok":false,"error":"jq is not installed"}'; exit 1; }
pr=''; event=''; body=''; comments=''; dry=''; auto=''; batch=''; mark=''; why=''
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) pr="\${2:-}"; [ $# -ge 2 ] || usage; shift 2 ;;
    --event) event="\${2:-}"; [ $# -ge 2 ] || usage; shift 2 ;;
    --body-file) body="\${2:-}"; [ $# -ge 2 ] || usage; shift 2 ;;
    --comments-file) comments="\${2:-}"; [ $# -ge 2 ] || usage; shift 2 ;;
    --dry-run) dry=1; shift ;;
    --auto) auto=1; shift ;;
    --batch) batch=1; shift ;;
    --start) [ -z "$mark" ] || usage; mark=reviewing; shift ;;
    --skip) [ -z "$mark" ] || usage; mark=skipped; why="\${2:-}"; [ $# -ge 2 ] || usage; shift 2 ;;
    --fail) [ -z "$mark" ] || usage; mark=failed; why="\${2:-}"; [ $# -ge 2 ] || usage; shift 2 ;;
    *) usage ;;
  esac
done
[ -z "$auto" ] || [ -z "$batch" ] || usage
[ -z "$mark" ] || [ -n "$batch" ] || usage
# The batch entry (its id) a PR has, if MasterDeck still lets it be posted.
entry() { jq -r --arg pr "$1" 'if type == "array" then (map(select(.url == $pr)) | .[0].id // empty) else empty end' "$b" 2>/dev/null; }
# A review of this entry was already posted.
posted() { [ -f "$l" ] && jq -R -s -e --arg id "$1" 'split("\\n") | map(fromjson? // empty) | any(.[]; .id == $id and .status == "posted")' "$l" >/dev/null 2>&1; }
# One line for MasterDeck: what happened to a batch PR.
logline() {
  [ -n "$bid" ] || return 0
  jq -cn --arg id "$bid" --arg url "$pr" --arg st "$1" --arg note "\${2:-}" --arg rev "\${3:-}" --argjson c "\${4:-0}" \\
    '{at: (now | floor), id: $id, url: $url, status: $st} + (if $note != "" then {note: $note} else {} end) + (if $rev != "" then {review: $rev, comments: $c} else {} end)' >> "$l"
}
# A refusal after the batch PR was taken: logged as failed, then said.
fail() { [ -n "$dry" ] || logline failed "$1"; err "$1"; }
bid=''
if [ -n "$batch" ]; then
  [ -n "$pr" ] || usage
  bid="$(entry "$pr")"
  [ -n "$bid" ] || err "refusing: $pr is not in the batch MasterDeck holds (not ticked, or cancelled); ask the user"
  posted "$bid" && err "refusing: a review of $pr was already posted for this batch"
  if [ -n "$mark" ]; then
    logline "$mark" "$why"
    jq -cn --arg pr "$pr" --arg st "$mark" '{ok: true, pr: $pr, status: $st}'
    exit 0
  fi
fi
# Automate Review and Review selected: a comment review, only on a PR MasterDeck queued or the user ticked.
if [ -n "$auto" ] || [ -n "$batch" ]; then
  [ -z "$event" ] || [ "$event" = comment ] || err 'an automated or batch review is a comment: it never approves or requests changes'
  event=comment
fi
[ -n "$pr" ] && [ -n "$event" ] && [ -n "$body" ] || usage
case "$event" in
  comment) ev=COMMENT ;;
  approve) ev=APPROVE ;;
  request-changes) ev=REQUEST_CHANGES ;;
  *) usage ;;
esac
if [ -n "$auto" ]; then
  jq -e --arg pr "$pr" 'type == "array" and any(.[]; . == $pr)' "$q" >/dev/null 2>&1 \\
    || err "refusing: $pr is not a PR Automate Review queued; ask the user"
  sel="$pr"
elif [ -n "$batch" ]; then
  sel="$pr"
else
  # Asked of the user: the selected PR, or one of the batch.
  sel="$(jq -r '.url // empty' "$g" 2>/dev/null)"
  bid="$(entry "$pr")"
  if [ "$pr" != "$sel" ]; then
    [ -n "$bid" ] || { [ -n "$sel" ] || err 'no PR is selected in MasterDeck: ask the user to click one'; err "refusing: $pr is not the PR selected in MasterDeck ($sel) nor in its batch; ask the user"; }
    sel="$pr"
  fi
fi
root="$(cd "$d" && pwd -P)" || err 'the review folder is gone'
# A file this review reads: a regular file really inside the folder (links resolved).
inside() {
  [ -f "$1" ] || return 1
  case "$1" in /*) f="$1" ;; *) f="$d/$1" ;; esac
  p="$(cd "$(dirname "$f")" 2>/dev/null && pwd -P)" || return 1
  [ -L "$f" ] && return 1
  case "$p/" in "$root"/*) return 0 ;; esac
  return 1
}
(cd "$d" && inside "$body") || err 'the body file must be a file in the review folder'
[ -z "$comments" ] || (cd "$d" && inside "$comments") || err 'the comments file must be a file in the review folder'
case "$body" in /*) bf="$body" ;; *) bf="$d/$body" ;; esac
cf=''
n=0
if [ -n "$comments" ]; then
  case "$comments" in /*) cf="$comments" ;; *) cf="$d/$comments" ;; esac
  jq -e 'type == "array" and all(.[]; (.path | type == "string") and (.body | type == "string") and (.line | type == "number"))' "$cf" >/dev/null 2>&1 \\
    || err 'the comments file must be a JSON array of {"path", "line", "body"}'
  n="$(jq 'length' "$cf")"
fi
path="$(printf '%s' "$sel" | sed -n 's#^https://github\\.com/\\([A-Za-z0-9-]*\\)/\\([A-Za-z0-9._-]*\\)/pull/\\([0-9]*\\)/*$#repos/\\1/\\2/pulls/\\3/reviews#p')"
[ -n "$path" ] || err "not a GitHub PR: $sel"
tmp="$d/.review-$$.json"
trap 'rm -f "$tmp"' EXIT
if [ -n "$cf" ]; then
  jq -n --rawfile body "$bf" --arg ev "$ev" --slurpfile c "$cf" '{body: $body, event: $ev, comments: $c[0]}' > "$tmp" || err 'could not build the review'
else
  jq -n --rawfile body "$bf" --arg ev "$ev" '{body: $body, event: $ev}' > "$tmp" || err 'could not build the review'
fi
if [ -n "$dry" ]; then
  jq -c --arg pr "$pr" '{ok: true, dryRun: true, pr: $pr, review: .}' "$tmp"
  exit 0
fi
acct="$(jq -r '.account // empty' "$g" 2>/dev/null)"
if [ -n "$acct" ]; then
  who="$(gh api user --jq .login 2>/dev/null)" || fail 'could not ask GitHub who this session is'
  a="$(printf '%s' "$acct" | tr '[:upper:]' '[:lower:]')"
  w="$(printf '%s' "$who" | tr '[:upper:]' '[:lower:]')"
  [ "$a" = "$w" ] || fail "refusing: this session is $who on GitHub, the tab's account is $acct"
fi
res="$(gh api -X POST "$path" --input "$tmp" 2>&1)" || fail "GitHub refused the review: $(printf '%s' "$res" | head -c 400)"
url="$(printf '%s' "$res" | jq -r '.html_url // empty' 2>/dev/null)"
logline posted '' "\${url:-$pr}" "$n"
printf '%s' "$res" | jq -c '{ok: true, url: .html_url, state: .state}' 2>/dev/null || out '{"ok":true}'
`
}
