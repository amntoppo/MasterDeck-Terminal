---
name: babysit-pr
description: Pre-PR self-review plus post-create review-comment babysitting. Use before creating a PR (review the branch diff, fix findings, write the self-review marker) and after creating one (poll review threads, fix, reply, resolve, until merged or all threads resolved). Triggered automatically by the gh pr create hooks, installed globally in ~/.claude/settings.json (MasterDeck Settings > Install hooks) or per workspace in .claude/settings.local.json.
---

# babysit-pr — self-review before, comment babysitting after

Two phases. The PreToolUse hook on `gh pr create` asks for the **Prep** phase when no
self-review marker exists for HEAD; the PostToolUse hook asks for the **Monitor** phase
once the PR exists. Either phase can also be run by hand (`/babysit-pr`).

The hooks can live in either of two places:

- **Globally, in `~/.claude/settings.json`** — MasterDeck's Setup does this for you
  ("Install hooks" in MasterDeck Settings), so every workspace on this machine gets them.
- **Per workspace, in `.claude/settings.local.json`** (gitignored, so per machine and per
  workspace) — not in a shared, committed `.claude/settings.json`, which at most carries the
  `Bash(gh pr create:*)` permission.

No hooks in either place means no automatic trigger: run `/babysit-pr` by hand, or install them.

All `gh` commands run from the repo the PR belongs to — check `pwd` first; if your workspace
holds several repos, the marker/branch/PR are per-repo.

## Phase 1 — Prep (pre-PR self-review)

Goal: find what **CI will find**, before the PR exists — so the GitHub review lands clean.

When the repo has a CI auto reviewer — typically a Claude Code GitHub Action such as
`.github/workflows/claude-code-review.yml`, on opened/ready_for_review/reopened, running the
marketplace plugin `/code-review:code-review --comment` — Phase 1 runs **that same recipe**
against the branch diff. (No CI reviewer? Run the same recipe anyway; it is a good bar.) Matching it is the whole point: a different
recipe reviewed locally is why CI keeps suggesting changes after a clean local pass.

**Run it from the PR's own repo** (`cd` there first). CI checks out that repo alone, so the
CLAUDE.md it judges against is the repo's, not the workspace root's.

1. Diff scope: confirm the base (`main`/`dev`/`stage` — don't guess), then `git diff <base>...HEAD`.
2. Collect the CLAUDE.md files CI would read: the **repo root** one, plus any in the
   directories the diff touches. Paths only — the lenses read them.
3. Launch **five parallel review agents**, one lens each, each returning findings with the
   reason it flagged them:
   - **CLAUDE.md adherence** — does the change comply? CLAUDE.md is guidance for writing
     code, so not every line applies to review.
   - **Shallow bug scan** — read only the changed hunks, no extra context. Big bugs only.
   - **Git history** — `git log`/`git blame` the modified lines; bugs visible only in light
     of why the code got that way.
   - **Prior PR comments** — earlier PRs touching these files, and whether their review
     comments apply again here. Find them by commit, not by search (`gh pr list --search
     "<path>"` searches *text* and returns nothing for a path — verified):
     ```bash
     git log --format='%H' -10 -- <path> | while read sha; do
       gh api "repos/<owner>/<repo>/commits/$sha/pulls" --jq '.[].number' 2>/dev/null
     done | sort -u        # then: gh pr view <n> --comments
     ```
   - **Code comments** — does the change respect guidance written in the surrounding comments?
4. **Score every finding 0–100** for "is this real", in a separate pass from the one that
   found it, and **drop everything below 80.** A CLAUDE.md-based finding only scores high if
   that CLAUDE.md says so *specifically*. This filter is why CI's list is short — without it
   you will fix things CI never asks about.
5. Fix what survives. Commit normally (no caveman). Re-run once on the new diff, **cap 2
   passes**, and report anything left unfixed before the PR goes up.
6. Write the marker, keyed to the final HEAD:
   ```bash
   touch ".git/pr-selfreview-$(git rev-parse HEAD)"
   ```
   (`.git/` is never committed; stale markers are harmless — `rm -f .git/pr-selfreview-*`.)
7. Create the PR. The marker silences the soft gate for this HEAD.

**Not findings** — CI discards these, so fixing them locally buys nothing and costs a pass:
pre-existing issues; anything a linter, typechecker, compiler or test would catch; missing
test coverage, docs or general code quality (unless a CLAUDE.md demands it); pedantic nits a
senior engineer would not raise; intentional changes that are part of the broader change;
real issues on lines this PR did not touch; and anything silenced in code on purpose.
Do **not** build or typecheck as part of the review — CI runs those separately. Run the
repo's own checks before pushing anyway, just don't report their output as review findings.

**Beyond the CI bar (optional).** If your workspace defines specialist reviewer agents
(e.g. a migration-safety reviewer, per-stack reviewers, a silent-failure hunter, an API
contract checker, or a cross-repo regression grep), they catch things CI's five lenses do not
(a backend change breaking a separate client repo is invisible to a single-repo review). Run
them when the diff touches migrations, payments/billing, or an API contract.
Their findings are **extra**, not part of matching CI: judge them on merit, and never let
them lengthen the two-pass cap.

The gate is **soft**: if the user explicitly said to skip review, create the PR and say
the review was skipped on their instruction.

⚠ **CI reviews the PR as opened, not what you reviewed.** Every commit pushed after the
local pass is unreviewed by Phase 1 — re-run it (or expect CI to find what you skipped).

⚠ **`@claude review` is a different, noisier reviewer.** That comment triggers
`claude.yml`, a free-form run with no 80-point filter that also reports reuse, simplification
and efficiency cleanups. Phase 2's stall nudge uses it deliberately (it is what unsticks a
hung review), but do not treat its extra suggestions as a Phase 1 miss.

## Phase 2 — Monitor (babysit review comments)

Goal: keep resolving reviewer feedback until the PR is merged/closed or nothing is open.

Get coordinates once:

```bash
gh pr view --json number,state,headRefName,url
```

### Arm the monitor (event-driven, not scheduled wakeups)

Use the **Monitor tool** with `timeout_ms: 1800000` (30 min, the maximum). The script
polls GitHub every ~45s inside the shell (GitHub pushes nothing to a CLI), but the session
wakes **only when a new comment or a terminal state appears** — reaction in under a minute,
no idle wakeups. Do not use ScheduleWakeup/`/loop` for this.

⚠ **There is no `persistent: true`.** Every monitor is killed at `timeout_ms` and you get
an expiry notice naming the event count. A PR outlives that, so **re-arm on each expiry**
(same command, unchanged) until the PR is merged/closed or the user says stop, and say so
when you do. An expiry is not a terminal state: only `PR-MERGED`/`PR-TERMINAL` ends a watch.
Re-arming is safe — the script remembers what it has already emitted in `$SEEN_FILE`
(see below), so a fresh arm does not replay the whole comment history as new wakes.

**Multiple PRs**: arm **one monitor per PR** — each Monitor call is an independent
background watch, so babysitting several PRs at once is just several arms. Every event
line is prefixed `<repo>#<num>` so wakes are attributable; on a wake, act only on the PR
named in the event. List/stop individual watches via `/tasks` or TaskStop.

Fill in owner/repo/number, then arm. **No author filter** — comments authored by bots
or Claude-identity accounts (`claude`, `claude[bot]`, `github-actions[bot]`) must fire
too, and PRs are often created under those identities. The `comm` dedup is what prevents
loops: each comment wakes the session exactly once, including replies this session
posted itself — on such a wake, recognize your own reply and do nothing.

```bash
owner=<owner>; repo=<repo>; pr=<num>
tag="$repo#$pr"
# Through master's shared GitHub cache when it is installed (`ghc`): sessions watching the same
# PR share one fetch every ~40s, and every caller backs off together on a rate limit.
if command -v ghc >/dev/null 2>&1; then gh() { ghc --ttl 40 "$@"; }; fi
meta=$(gh pr view "$pr" --repo "$owner/$repo" --json title,url --jq '"\(.title)\t\(.url)"')
title=${meta%%$'\t'*}; url=${meta#*$'\t'}
# Survives re-arming after a timeout expiry: without it, a fresh arm replays every
# existing comment as a new wake.
SEEN_FILE="${TMPDIR:-/tmp}/babysit-pr-$owner-$repo-$pr.seen"
seen=$(cat "$SEEN_FILE" 2>/dev/null || true)
while true; do
  # One GraphQL call per poll: state, mergeability and review threads together.
  pull=$(gh api graphql -f query='
      query($owner:String!, $repo:String!, $pr:Int!) {
        repository(owner:$owner, name:$repo) { pullRequest(number:$pr) {
          state mergeable baseRefName
          reviewThreads(first:100) { nodes {
            isResolved
            comments(last:1) { nodes { databaseId updatedAt author { login } body } } } } } } }' \
      -f owner="$owner" -f repo="$repo" -F pr="$pr") || { sleep 60; continue; }
  state=$(jq -r '.data.repository.pullRequest.state // empty' <<<"$pull")
  [ -n "$state" ] || { sleep 60; continue; }
  case "$state" in
    MERGED) echo "PR-MERGED: \"$title\" $url"; exit 0;;
    CLOSED) echo "PR-TERMINAL: $tag CLOSED"; exit 0;;
  esac
  # One REST call for the PR's conversation comments, read twice below.
  comments=$(gh api "repos/$owner/$repo/issues/$pr/comments") || { sleep 60; continue; }
  cur=$( {
      jq -r --arg tag "$tag" '
        .data.repository.pullRequest.reviewThreads.nodes[]
        | select(.isResolved | not) | .comments.nodes[]
        | "\($tag) THREAD \(.databaseId) \(.updatedAt) \(.author.login): \(.body | gsub("\\s+"; " ") | .[0:180])"' <<<"$pull" ;
      jq -r --arg tag "$tag" '
        .[] | "\($tag) ISSUE \(.id) \(.updated_at) \(.user.login): \(.body | gsub("\\s+"; " ") | .[0:180])"' <<<"$comments" ;
      # Stalled Claude review: a claude[bot] status comment that never reached "Claude
      # finished", still shows an unchecked task box (or "is reviewing"), and has not been
      # edited for 10+ minutes. The "finished" test comes FIRST and is what makes this
      # usable: the bot routinely finishes while leaving boxes unchecked, so an unchecked
      # box alone is not a stall.
      jq -r '
        map(select(.user.login | test("^claude(\\[bot\\])?$"; "i")))
        | .[] | select((.body | test("claude finished|finished the review"; "i")) | not)
        | select((.body | test("(^|\n)\\s*- \\[ \\]")) or (.body | test("is reviewing"; "i")))
        | select((now - (.updated_at | fromdateiso8601)) > 600)
        | "STALLED-REVIEW \(.id)"' <<<"$comments" | sed "s/^/$tag /" ;
      # Merge conflicts. Only CONFLICTING counts: GitHub computes mergeability lazily and
      # answers UNKNOWN until it has (asking is what triggers the recompute), so UNKNOWN
      # means "ask again next poll", never "no conflict". The line is stable, so one wake
      # per conflict episode; it reappears if the base conflicts again later.
      jq -r '.data.repository.pullRequest | select(.mergeable=="CONFLICTING") | "CONFLICT with \(.baseRefName)"' <<<"$pull" \
        | sed "s/^/$tag /" ; } \
      2>/dev/null | sort ) || { sleep 60; continue; }
  comm -13 <(printf '%s\n' "$seen") <(printf '%s\n' "$cur")
  seen=$cur
  printf '%s\n' "$cur" > "$SEEN_FILE"
  sleep 45
done
```

Each poll costs **one GraphQL and one REST call** (it was three GraphQL and two REST), and with
`ghc` installed, sessions watching the same PR within ~40s share them.

`$SEEN_FILE` is keyed by owner/repo/PR, so parallel watches never share state. Delete it
(or the whole `babysit-pr-*.seen` set) only to deliberately replay a PR's comments.

⚠ `gh api --jq` takes a bare expression and **rejects `--arg`** ("accepts 1 arg(s), received 4") —
the tag is shell-interpolated into a double-quoted jq string for that reason. A silent `2>/dev/null`
failure here looks exactly like "no comments yet", so sanity-check the query once by hand before
trusting a quiet monitor.

**Edits fire too.** Each compared line carries the comment's `updatedAt`, so an
**in-place edit** — e.g. the Claude bot updating its first status comment with new
Findings instead of posting a new comment — changes the line and wakes the session
like a new comment. On such a wake, fetch the FULL current body (the event line is
truncated to 180 chars): `gh api repos/<owner>/<repo>/issues/comments/<id>` for an
issue comment, or the thread GraphQL below — then act on the findings it now lists.

`description`: `"review comments on <repo>#<num>"`. Each emitted line is one new
or newly-edited unresolved comment.

### Merge conflict → resolve it

The monitor emits, once per conflict episode:

```
<repo>#<num> CONFLICT with <base>
```

Resolve it by **merging the base into the PR branch** — never rebase, because the skill's
no-force-push rule stands and a rebase would need one.

```bash
cd <the PR's repo>                      # multi-repo workspace? check pwd
gh pr checkout <num>                    # lands on the PR branch, tracking the PR
git fetch origin <base>
git merge origin/<base>                 # conflicts stop here
git diff --name-only --diff-filter=U    # exactly what is conflicted
```

Resolve each file, then `git add` it, `git commit` (default merge message is fine),
run the repo's checks, and `git push`. Confirm GitHub agrees before reporting success —
it answers `UNKNOWN` for a moment after the push:

```bash
gh pr view <num> --repo <owner>/<repo> --json mergeable --jq .mergeable   # want MERGEABLE
```

Then reply on the PR in one line saying the base was merged in and conflicts resolved.

**Resolve yourself only where intent is unambiguous:**

| Conflict | Do |
|---|---|
| Both sides added separate items (imports, routes, test cases, list entries) | Keep both, in a sensible order |
| Base changed a file this PR never meant to touch | Take the base side |
| Only formatting/whitespace differs | Take the base side, re-apply this PR's real change |
| **Lockfiles** (`uv.lock`, `package-lock.json`, `bun.lock*`, `Podfile.lock`) | Never hand-merge. Take base, re-run the tool (`uv lock`, `npm install`, `bun install`) and commit the result |
| **Generated files** (mirrors, codegen output) | Never hand-merge — take base and re-run the repo's generator |
| **Database migrations** (e.g. Alembic: `migrations/`, two heads, `down_revision`) | **Stop.** Hand to the user (or a migration-safety reviewer if the workspace has one); a wrong `down_revision` chain breaks the deploy silently |

**Stop and tell the user** — do not guess — when: both sides changed the same logic and only
the author knows which wins; the conflict is in a migration, a payments/billing path, or
generated native code; the merge touches files outside this PR's scope; or the same PR
conflicts a **third** time (the base is moving faster than the PR — it needs a human, or the
PR needs splitting). Say what conflicted and what you left unresolved; leave the merge
in progress or `git merge --abort`, but never invent a resolution to clear the wake.

**Preconditions.** Only push when the PR's head is in this org (a fork's branch is not
yours to push) and the working tree was clean before you started — a conflict resolution
on top of unrelated local edits is unreviewable. If the tree is dirty, say so and stop.
Run the repo's own checks before pushing (e.g. `uv run pytest`, `npm test`, `bun run typecheck`),
plus any end-to-end verification the workspace provides for changes touching the running stack.

### Stalled Claude review → nudge with `@claude review`

The `@claude` reviewer posts one status comment ("Claude is reviewing this PR" + a
**Tasks** checklist) and **edits that same comment** as it ticks boxes, finishing with
"Claude finished the review". Sometimes it stops partway and the comment sits with
`- [ ]` boxes open forever (or at the bare "Claude is reviewing this PR" line, before any
checklist is rendered) — the review never lands. Posting `@claude review` on the PR
retriggers it — a status comment that sat unchecked typically finishes within minutes of
a manual `@claude review`.

The monitor line above emits, once per stuck comment:

```
<repo>#<num> STALLED-REVIEW <comment_id>
```

That line carries no timestamp, so it wakes the session **once** per stuck comment, not
every poll. On such a wake:

1. Confirm it is still stuck — the bot may have finished between poll and wake:
   ```bash
   gh api repos/<owner>/<repo>/issues/comments/<comment_id> --jq '.updated_at, .body' | head -20
   ```
   Body now says "Claude finished" anywhere → done, no nudge, even if boxes are still
   unchecked (it often finishes that way).
2. Check you have not already nudged for **this** stuck run: list recent issue comments
   and look for an `@claude review` posted *after* that comment's `updated_at`.
3. Not yet nudged → post it:
   ```bash
   gh api repos/<owner>/<repo>/issues/<num>/comments -f body='@claude review'
   ```
   Say in chat that the review stalled and you retriggered it. The bot's next edit wakes
   the monitor normally, and its findings are handled like any other review comment.
4. Already nudged once and it is stuck again → **stop nudging** and tell the user the
   reviewer is not completing (with the job link from the comment). Two `@claude review`
   comments per stuck run is the cap; a nudge loop spams the PR and burns Actions minutes.

This only fires for `claude`/`claude[bot]` comments. A human's unchecked to-do list is
never nudged, and a review still actively ticking boxes updates `updated_at`, so the
10-minute window never sees it.

**The `PR-MERGED:` line ends that PR's watch.** When it arrives, render this banner as
the final message for that PR — a fenced code block, exactly this shape, with the title
and URL on plain lines *below* the box (never inside it, so long values cannot break
the border; keep the emoji out of the box too — emoji width misaligns borders in many
terminals):

    ```
    ╔══════════════════════════════════════════════╗
    ║                                              ║
    ║          P R   M E R G E D !                 ║
    ║                                              ║
    ║          GREAT WORK!                         ║
    ║                                              ║
    ╚══════════════════════════════════════════════╝
    ```
    🎉 **<title>**
    <url>

(`PR-TERMINAL: <repo>#<num> CLOSED` = closed unmerged; report that plainly, no banner.)
Other PRs' watches keep running. Stop a watch early with TaskStop if the user asks, or
once its every thread is resolved and no review is pending.

**Then, on the same merge wake, arm the Phase 3 deploy watch below** (skip it only if
the repo visibly has no deploy workflows).

## Phase 3 — Deploy watch (after merge)

Goal: after the merge banner, keep watching until the merge commit's GitHub Actions
deploy runs finish, then announce the changes are live on the target tier.

Tier = the environment the PR's **base branch** deploys to, per the repo's workflows — for
example `dev` → **dev**, `stage` → **stage**, `main` → **prod**. (Repos that deploy nowhere,
such as docs or config-only repos — say so and skip.)

Arm a second Monitor (`timeout_ms: 1800000`, description `"deploy of <repo>#<num>"`). A deploy
usually finishes inside one window; if it expires first, re-arm it the same way:

```bash
owner=<owner>; repo=<repo>; pr=<num>; tag="$repo#$pr"
sha=$(gh pr view "$pr" --repo "$owner/$repo" --json mergeCommit --jq .mergeCommit.oid)
waited=0
while true; do
  runs=$(gh run list --repo "$owner/$repo" --commit "$sha" \
    --json name,status,conclusion 2>/dev/null) || { sleep 60; continue; }
  n=$(jq length <<<"$runs")
  if [ "$n" -eq 0 ]; then
    waited=$((waited+30))
    [ "$waited" -ge 300 ] && { echo "DEPLOY-NONE: $tag no workflow runs for $sha"; exit 0; }
    sleep 30; continue
  fi
  if jq -e 'all(.status=="completed")' <<<"$runs" >/dev/null; then
    if jq -e 'all(.conclusion=="success")' <<<"$runs" >/dev/null; then
      echo "DEPLOY-COMPLETE: $tag $sha"
    else
      jq -r ".[] | select(.conclusion!=\"success\")
        | \"DEPLOY-FAILED: $tag \(.name): \(.conclusion)\"" <<<"$runs"
    fi
    exit 0
  fi
  sleep 30
done
```

On `DEPLOY-COMPLETE`, render the live banner (same conventions: fenced block, details
below the box, tier name from the base branch):

    ```
    ╔══════════════════════════════════════════════╗
    ║                                              ║
    ║       C H A N G E S   A R E   L I V E        ║
    ║                                              ║
    ║              ON  <TIER> !                    ║
    ║                                              ║
    ╚══════════════════════════════════════════════╝
    ```
    🚀 **<title>** deployed (<workflow names>, commit <short sha>)
    <url>

On `DEPLOY-FAILED`: no banner — report which workflow failed, fetch its log
(`gh run view <id> --log-failed`), diagnose, and surface to the user (a deploy fix is
beyond this skill's push authorization; do not auto-fix deploy scripts).
`DEPLOY-NONE`: say the repo triggered no workflows for the merge commit and stop.

⚠ Workflow success ≠ endpoint live when part of the stack is configured by hand (e.g. a
reverse proxy or API gateway maintained outside CI): a green deploy can still leave a route
404ing. If that applies to your stack, mention this caveat with the banner when the change
added or moved a route.

### On each wake

A monitor notification means new comment(s) landed. The `<repo>#<num>` prefix names the
PR — with several watches armed, act only on that PR. Then:

1. Re-read full thread context — the event line is truncated. GraphQL for threads
   (REST has no thread resolution):
   ```bash
   gh api graphql -f query='
     query($owner:String!, $repo:String!, $pr:Int!) {
       repository(owner:$owner, name:$repo) {
         pullRequest(number:$pr) {
           reviewThreads(first:100) {
             nodes {
               id isResolved isOutdated path line
               comments(first:20) { nodes { databaseId author { login } body } }
             }
           }
         }
       }
     }' -f owner=<owner> -f repo=<repo> -F pr=<num>
   ```
2. **Also check** requested-changes reviews (`gh pr view <num> --json reviews`) —
   not everything arrives as a thread or issue comment.
3. Handle each thread (below), then let the monitor keep running.

### Handling a thread

Per unresolved thread, decide the comment's type:

- **Code defect / requested change** → make the fix, commit, push to the PR branch.
  Reply on the thread saying what changed (commit SHA).
- **Question / judgment call** ("why this approach?") → answer on the thread. Do **not**
  change code to dodge a question.
- **Out of scope / disagree** → reply with reasoning; leave the thread for the reviewer.
  Never resolve a thread you argued against.

Reply into a thread:
```bash
gh api repos/<owner>/<repo>/pulls/<num>/comments/<comment_id>/replies -f body='...'
```

Resolve only threads you actually addressed (fix pushed, or question answered and the
answer is self-evidently sufficient):
```bash
gh api graphql -f query='
  mutation($id:ID!) { resolveReviewThread(input:{threadId:$id}) { thread { isResolved } } }' \
  -f id=<thread_node_id>
```

### Stale-thread sweep (auto-close resolved conversations)

On each wake, after handling new comments, sweep the remaining unresolved threads and
resolve any conversation that is already settled:

- The requested change is verifiably in HEAD (the thread's `path`/`line` diff shows the
  fix landed) — typically `isOutdated: true` after a fix push.
- The reviewer's last reply acknowledges completion ("done", "thanks", "LGTM",
  a thumbs-up-style sign-off) with no follow-up ask.
- The thread duplicates another thread that was fixed and resolved.

Before resolving, verify against HEAD — `isOutdated` alone is not proof (an unrelated
push also outdates threads). If the fix cannot be confirmed in the current code, leave
the thread open. Never sweep-resolve a thread with an unanswered question or an
unaddressed objection.

### Rules

- Pushing fixes is authorized by this skill's flow — but stay on the PR branch, never
  force-push, and keep each fix commit scoped to the comment it answers.
- If a comment demands a design change beyond the PR's scope, stop the loop and surface
  it to the user instead of implementing it.
- A push to the PR branch changes HEAD — the self-review marker is per-SHA and does not
  need refreshing for monitor-phase fixes (the PR already exists).
- Report at the end of each active wake: threads fixed / answered / left open, and why.
- A conflict resolution is a merge commit on the PR branch, never a rebase or a force-push,
  and never a change to the base branch.
- Never post `@claude review` except on a `STALLED-REVIEW` wake, and at most once per
  stuck run (see above). Do not use it to ask for a re-review of new commits.
- The monitor emits **every** new comment regardless of author — bot and Claude-identity
  authors (`claude[bot]`, `github-actions[bot]`) included, since PRs are often created
  under those. A wake for a comment you posted yourself needs no action. If the watch
  goes noisy or gets auto-stopped for volume, re-arm with a tighter filter.
