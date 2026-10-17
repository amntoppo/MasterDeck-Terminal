import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { PR_REVIEW_NAME, type PrReviewContext } from '@shared/prReview'
import { TICKET_TAB } from '@shared/ticketBuilder'

/**
 * The Pull requests view's review sessions (Review with Claude): one folder per PR tab,
 * `<home>/pr-review/tab-<tabId>/`, with CLAUDE.md (how to review), context.json (the tab, its
 * filters, the selected PR, the account), post-review.sh and project settings. With two or more
 * accounts its session runs as the tab's account.
 */
export function prReviewDir(home: string, tab: string | null | undefined): string {
  if (!tab || !TICKET_TAB.test(tab)) throw new Error(`refusing a PR review for tab ${JSON.stringify(tab)}`)
  return join(home, 'pr-review', `tab-${tab}`)
}

/**
 * What post-review.sh checks against: the selected PR and the account, kept outside the review
 * folder (`<home>/pr-review-guard/tab-<tabId>.json`), where the session's unasked edits don't reach.
 */
export function prReviewGuard(home: string, tab: string): string {
  if (!TICKET_TAB.test(tab)) throw new Error(`refusing a PR review for tab ${JSON.stringify(tab)}`)
  return join(home, 'pr-review-guard', `tab-${tab}.json`)
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

/** The account a tab folder's context.json names; null if none or a bad tab. */
export function prReviewFolderAccount(home: string, tab: string): string | null {
  try {
    const a = JSON.parse(readFileSync(join(prReviewDir(home, tab), 'context.json'), 'utf8')).account
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

/** The project settings: reading PRs without asking; the post script is asked for each time; other writes blocked. */
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
    // ./post-review.sh is the one way to write, and is not allowed above: Claude Code asks the user
    // before each run, after the session showed what it will post. Its own files stay MasterDeck's.
    deny: [
      'Edit(./post-review.sh)',
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

const atomic = (file: string, text: string) => {
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

/** The guard file's answer to "which PR, as whom" (see prReviewGuard). */
function writeGuard(guard: string, ctx: PrReviewContext): void {
  mkdirSync(dirname(guard), { recursive: true })
  atomic(guard, JSON.stringify({ url: ctx.selected?.url ?? null, account: ctx.account }) + '\n')
}

/** Write a tab's folder: briefing, context, script, settings, and its guard (each atomically). */
export function writePrReviewDir(dir: string, ctx: PrReviewContext, briefing: string, guard: string): void {
  mkdirSync(dir, { recursive: true })
  // A `.claude` that is a link (to ~/.claude, say) would have MasterDeck overwrite the user's settings.
  try {
    if (lstatSync(join(dir, '.claude')).isSymbolicLink()) throw new Error('refusing a PR review folder whose .claude is a link')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeGuard(guard, ctx)
  atomic(join(dir, 'CLAUDE.md'), briefing)
  atomic(join(dir, 'context.json'), JSON.stringify(ctx, null, 2) + '\n')
  atomic(join(dir, '.claude', 'settings.json'), JSON.stringify(PR_REVIEW_SETTINGS, null, 2) + '\n')
  const script = join(dir, 'post-review.sh')
  atomic(script, prReviewScript(dir, guard))
  chmodSync(script, 0o755)
}

/** Only the context changed (another PR picked, the filters): the rest stays as written. */
export function writePrReviewContext(dir: string, ctx: PrReviewContext, guard: string): void {
  mkdirSync(dir, { recursive: true })
  writeGuard(guard, ctx)
  atomic(join(dir, 'context.json'), JSON.stringify(ctx, null, 2) + '\n')
}

/**
 * The review session's one write to GitHub: one review on the PR selected in MasterDeck (and no
 * other), as the tab's account, from files inside the folder. Both checks read `guard`, outside the
 * folder. Runs gh directly (the session's environment carries the tab's account). macOS bash 3.2;
 * jq is one of MasterDeck's tools.
 */
export function prReviewScript(dir: string, guard: string): string {
  const d = dir.replace(/'/g, `'\\''`)
  const g = guard.replace(/'/g, `'\\''`)
  return `#!/usr/bin/env bash
# Written by MasterDeck: post one review on the PR selected in the Pull requests view.
d='${d}'
g='${g}'
out() { printf '%s\\n' "$1"; }
err() { jq -cn --arg e "$1" '{ok: false, error: $e}'; exit 1; }
usage() { err 'usage: ./post-review.sh --pr <url> --event comment|approve|request-changes --body-file <file> [--comments-file <file.json>] [--dry-run]'; }
command -v jq >/dev/null 2>&1 || { out '{"ok":false,"error":"jq is not installed"}'; exit 1; }
pr=''; event=''; body=''; comments=''; dry=''
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) pr="\${2:-}"; [ $# -ge 2 ] || usage; shift 2 ;;
    --event) event="\${2:-}"; [ $# -ge 2 ] || usage; shift 2 ;;
    --body-file) body="\${2:-}"; [ $# -ge 2 ] || usage; shift 2 ;;
    --comments-file) comments="\${2:-}"; [ $# -ge 2 ] || usage; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$pr" ] && [ -n "$event" ] && [ -n "$body" ] || usage
case "$event" in
  comment) ev=COMMENT ;;
  approve) ev=APPROVE ;;
  request-changes) ev=REQUEST_CHANGES ;;
  *) usage ;;
esac
sel="$(jq -r '.url // empty' "$g" 2>/dev/null)"
[ -n "$sel" ] || err 'no PR is selected in MasterDeck: ask the user to click one'
[ "$pr" = "$sel" ] || err "refusing: $pr is not the PR selected in MasterDeck ($sel); ask the user"
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
if [ -n "$comments" ]; then
  case "$comments" in /*) cf="$comments" ;; *) cf="$d/$comments" ;; esac
  jq -e 'type == "array" and all(.[]; (.path | type == "string") and (.body | type == "string") and (.line | type == "number"))' "$cf" >/dev/null 2>&1 \\
    || err 'the comments file must be a JSON array of {"path", "line", "body"}'
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
  who="$(gh api user --jq .login 2>/dev/null)" || err 'could not ask GitHub who this session is'
  a="$(printf '%s' "$acct" | tr '[:upper:]' '[:lower:]')"
  w="$(printf '%s' "$who" | tr '[:upper:]' '[:lower:]')"
  [ "$a" = "$w" ] || err "refusing: this session is $who on GitHub, the tab's account is $acct"
fi
res="$(gh api -X POST "$path" --input "$tmp" 2>&1)" || err "GitHub refused the review: $(printf '%s' "$res" | head -c 400)"
printf '%s' "$res" | jq -c '{ok: true, url: .html_url, state: .state}' 2>/dev/null || out '{"ok":true}'
`
}
