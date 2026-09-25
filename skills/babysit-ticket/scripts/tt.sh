#!/usr/bin/env bash
# babysit-ticket — link a Claude Code session to an issue on your GitHub project board and
# move its Status as the work progresses.
#
#   tt.sh candidates            my open items: current sprint first, then in-flight elsewhere
#   tt.sh hints                 issue numbers guessed from branch name + recent commits
#   tt.sh link <issue#>         link this session (and its branch) to the issue, move to In Dev
#   tt.sh show                  what this session is linked to, and its live board status
#   tt.sh set "<Status>" [--force]   move the linked item (forward-only unless --force)
#   tt.sh branch <name>         create a branch linked under the issue's Development box
#   tt.sh pr <url>              record a PR, link it under Development, move to PR Raised
#   tt.sh sync [--quiet]        check recorded PRs; merged -> Dev Done
#   tt.sh unlink                forget this session's link
#   tt.sh hook                  PostToolUse/SessionStart handler (reads hook JSON on stdin)
#
# State: ~/.claude/babysit-ticket/state.json. Nothing here ever closes an issue directly —
# but a PR linked under Development closes it on merge (GitHub offers no non-closing PR
# link). That is fine: the board, not the issue's open/closed state, drives QA.
set -uo pipefail

# Org, issue repo, board ids and status names come from the shared config
# (~/.claude/master/config.json, written by MasterDeck's Setup or `master config save`).
MASTER_LIB="${MASTER_LIB:-$HOME/.claude/skills/master/lib}"
CFG_SH="$(PYTHONPATH="$MASTER_LIB" python3 -m master.cli config shell 2>/dev/null)" || CFG_SH=""
if [ -n "$CFG_SH" ]; then eval "$CFG_SH"; else CFG_CONFIGURED=0; fi

# GitHub goes through the shared cache (master's `ghc`) when it is installed: reads are reused
# across sessions for a short time, writes pass straight through, and every caller backs off
# together on a rate limit. Without it, plain gh.
GHC="${GHC:-$HOME/.claude/skills/master/ghc}"
gh() {
  if [ -x "$GHC" ] && [ "${TT_NO_GH_CACHE:-}" != 1 ]; then "$GHC" "$@"; else command gh "$@"; fi
}

STATE_DIR="${TT_STATE_DIR:-$HOME/.claude/babysit-ticket}"
STATE="$STATE_DIR/state.json"
mkdir -p "$STATE_DIR"
[ -s "$STATE" ] || echo '{"sessions":{},"branches":{}}' > "$STATE"

SESSION="${TT_SESSION:-${CLAUDE_CODE_SESSION_ID:-}}"
CWD="${TT_CWD:-$PWD}"

# rank <status> and option_id <status> come from the config (board order; forward-only moves).

die() { echo "babysit-ticket: $*" >&2; exit 1; }

# Serialise writes: two sessions can finish a tool call at the same moment.
with_state() {  # with_state <jq filter> [jq args...]
  local lock="$STATE_DIR/.lock" i=0
  until mkdir "$lock" 2>/dev/null; do i=$((i+1)); [ $i -gt 50 ] && break; sleep 0.1; done
  local tmp; tmp="$(mktemp "$STATE_DIR/.state.XXXXXX")"
  if jq "$@" "$STATE" > "$tmp"; then mv "$tmp" "$STATE"; else rm -f "$tmp"; fi
  rmdir "$lock" 2>/dev/null || true
}

branch_key() {  # <owner>/<repo>@<branch>, or empty when the branch must not carry a link
  local dir="${1:-$CWD}" url br def
  br="$(git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null)" || return 0
  # Long-lived branches are shared by every session; keying one would hand this ticket
  # to all of them. Only feature branches carry a link.
  def="$(git -C "$dir" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
  case "$br" in main|master|dev|dev2|develop|stage|staging|prod|production|"${def#origin/}") return 0 ;; esac
  url="$(git -C "$dir" remote get-url origin 2>/dev/null)" || return 0
  # git@github.com-alias:Owner/repo.git and https://github.com/Owner/repo -> Owner/repo
  url="$(sed -E 's#\.git$##; s#^[a-z+]+://[^/]+/##; s#^[^@/]+@[^:]+:##' <<<"$url")"
  echo "$url@$br"
}

# Prints the linked issue number for this session, adopting a branch link when the
# session itself has none (a /branch or a fresh session on the same feature branch).
current_issue() {
  local n bk
  [ -n "$SESSION" ] && n="$(jq -r --arg s "$SESSION" '.sessions[$s].issue // empty' "$STATE")"
  if [ -z "${n:-}" ]; then
    bk="$(branch_key)"
    [ -n "$bk" ] && n="$(jq -r --arg b "$bk" '.branches[$b] // empty' "$STATE")"
    if [ -n "${n:-}" ] && [ -n "$SESSION" ]; then
      with_state --arg s "$SESSION" --argjson n "$n" --arg b "$bk" \
        '.sessions[$s] = ((.sessions[$s] // {}) + {issue:$n, branch:$b, adopted:true, prs:(.sessions[$s].prs // [])})'
    fi
  fi
  echo "${n:-}"
}

issue_info() {  # -> {"title","state","item","status"} for the item on the configured project
  gh api graphql -F n="$1" -f query='query($n:Int!){repository(owner:"'"$OWNER"'",name:"'"$ISSUE_REPO"'"){issue(number:$n){title state projectItems(first:20){nodes{id project{number} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}' \
    --jq '.data.repository.issue | {title, state, item: ([.projectItems.nodes[] | select(.project.number=='"$PROJECT_NUMBER"')][0])} | {title, state, item: .item.id, status: (.item.fieldValueByName.name // "")}'
}

move() {  # move <issue#> <Status> [force] -> prints what happened
  local n="$1" target="$2" force="${3:-}" info item cur opt
  opt="$(option_id "$target")" || die "unknown status '$target'"
  info="$(issue_info "$n")" || die "could not read #$n"
  item="$(jq -r '.item // empty' <<<"$info")"
  cur="$(jq -r '.status' <<<"$info")"
  [ -n "$item" ] || die "#$n is not on project $PROJECT_NUMBER"
  if [ "$cur" = "$target" ]; then echo "#$n already $target"; return 0; fi
  if [ -z "$force" ] && [ "$(rank "$cur")" -ge "$(rank "$target")" ]; then
    echo "#$n left at $cur (not moving back to $target)"; return 0
  fi
  gh project item-edit --project-id "$PROJECT_ID" --id "$item" \
    --field-id "$STATUS_FIELD_ID" --single-select-option-id "$opt" >/dev/null \
    || die "board update failed for #$n"
  echo "#$n: ${cur:-no status} -> $target"
}

# --- GitHub "Development" links -----------------------------------------------------
# The Development box on an issue holds two kinds of link, and GitHub only offers
# CLOSING references for pull requests — there is no non-closing PR link, in any repo.
# So a linked PR closes the ticket when it merges. That is accepted: a closed issue's board
# item still moves (dev done, QA, ...), so QA is unaffected. Both link kinds work
# cross-repo: one board can track PRs from any repo of the owner.
issue_node_id() {
  gh api graphql -F n="$1" -f query='query($n:Int!){repository(owner:"'"$OWNER"'",name:"'"$ISSUE_REPO"'"){issue(number:$n){id}}}' \
    --jq '.data.repository.issue.id' 2>/dev/null
}

# link_pr <issue#> <pr url> — add the PR to the issue's Development box.
link_pr() {
  local n="$1" url="$2" o r p iid pid
  [[ "$url" =~ ^https://github\.com/([^/]+)/([^/]+)/pull/([0-9]+) ]] || return 1
  o="${BASH_REMATCH[1]}"; r="${BASH_REMATCH[2]}"; p="${BASH_REMATCH[3]}"
  iid="$(issue_node_id "$n")"; [ -n "$iid" ] || return 1
  pid="$(gh api graphql -F p="$p" -f query='query($p:Int!){repository(owner:"'"$o"'",name:"'"$r"'"){pullRequest(number:$p){id}}}' \
    --jq '.data.repository.pullRequest.id' 2>/dev/null)"
  [ -n "$pid" ] || return 1
  gh api graphql -f query='mutation($i:ID!,$p:[ID!]!){addCloseIssueReferences(input:{issueId:$i,pullRequestIds:$p}){clientMutationId}}' \
    -f i="$iid" -f p="$pid" >/dev/null 2>&1
}

# tt branch <name> — create a feature branch that shows under Development, then check it
# out. It must be created through the API: createLinkedBranch silently returns null for a
# branch that already exists, so linking an existing branch is impossible.
cmd_branch() {
  local name="$1" n iid rid oid url o r
  n="$(current_issue)"; [ -n "$n" ] || die "session not linked — run link first"
  url="$(git -C "$CWD" remote get-url origin 2>/dev/null)" || die "no origin remote in $CWD"
  url="$(sed -E 's#\.git$##; s#^[a-z+]+://[^/]+/##; s#^[^@/]+@[^:]+:##' <<<"$url")"
  o="${url%%/*}"; r="${url##*/}"
  oid="$(git -C "$CWD" rev-parse HEAD 2>/dev/null)" || die "no HEAD in $CWD"
  iid="$(issue_node_id "$n")" || die "could not read #$n"
  rid="$(gh api graphql -f query='{repository(owner:"'"$o"'",name:"'"$r"'"){id}}' --jq .data.repository.id)" \
    || die "could not read $o/$r"
  local got
  got="$(gh api graphql -f query='mutation($i:ID!,$r:ID!,$n:String!,$o:GitObjectID!){createLinkedBranch(input:{issueId:$i,repositoryId:$r,name:$n,oid:$o}){linkedBranch{ref{name}}}}' \
    -f i="$iid" -f r="$rid" -f n="$name" -f o="$oid" --jq '.data.createLinkedBranch.linkedBranch.ref.name' 2>&1)"
  [ "$got" = "$name" ] || die "branch not linked (does '$name' already exist on $o/$r? an existing branch cannot be linked): $got"
  git -C "$CWD" fetch origin "$name" >/dev/null 2>&1 || die "created $name on $o/$r but could not fetch it"
  git -C "$CWD" checkout -B "$name" "origin/$name" >/dev/null 2>&1 || die "created $name but could not check it out"
  with_state --arg s "$SESSION" --arg b "$(branch_key)" --argjson n "$n" \
    'if $b != "" then .branches[$b] = $n | .sessions[$s].branch = $b else . end'
  echo "#$n: branch $name created, linked under Development, checked out"
}

cmd_candidates() {
  local me today
  me="$(gh api user --jq .login)" || die "gh not authenticated"
  today="$(date +%F)"
  # Filter server-side: paging the whole board is ~25s, this is ~4s.
  gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --limit 500 --format json \
    --query "assignee:$me is:issue $ST_DONE_QUERY" |
  jq -r --arg me "$me" --arg today "$today" --argjson donelist "$ST_DONE_JSON" --argjson pick "$ST_PICKABLE_JSON" '
    def done: . as $s | $donelist | index($s);
    def cur: .sprint and .sprint.startDate <= $today and
             ((.sprint.startDate | strptime("%Y-%m-%d") | mktime) + .sprint.duration*86400
               > ($today | strptime("%Y-%m-%d") | mktime));
    [.items[] | select((.assignees // []) | index($me)) | select(.content.type == "Issue")
      | select((.status // "") | done | not)]
    | (map(select(cur)) | sort_by(.status) | map("CURRENT  #\(.content.number)  [\(.status // "-")]  \(.title)  (\(.sprint.title))")[]),
      (map(select(cur | not) | select(.status as $s | $pick | index($s)))
        | map("OTHER    #\(.content.number)  [\(.status)]  \(.title)  (\(.sprint.title // "no sprint"))")[])'
}

cmd_hints() {
  local br
  br="$(git -C "$CWD" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  echo "branch: ${br:-<none>}"
  # Branch segments that are a bare number or start with one (feat/879-ask-ai, 879_fix),
  # plus explicit <issueRepo>#N references in recent commits. Plain #N in a product repo's
  # commits is that repo's own issue, not a board ticket, so it is ignored.
  { tr '/' '\n' <<<"$br" | grep -oE '^(issue-|gh-)?[0-9]{2,4}([-_]|$)' | grep -oE '[0-9]+';
    git -C "$CWD" log -30 --format='%s%n%b' 2>/dev/null | grep -oiE "$ISSUE_REPO#[0-9]+" | grep -oE '[0-9]+'; } |
    sort | uniq -c | sort -rn | awk '{print "hint: #" $2 " (" $1 ")"}' || true
}

cmd_link() {
  local n="${1:-}" info title bk
  [[ "$n" =~ ^[0-9]+$ ]] || die "usage: link <issue number>"
  [ -n "$SESSION" ] || die "no CLAUDE_CODE_SESSION_ID in the environment"
  info="$(issue_info "$n")" || die "could not read $OWNER/$ISSUE_REPO#$n"
  [ -n "$(jq -r '.item // empty' <<<"$info")" ] || die "#$n is not on project $PROJECT_NUMBER"
  title="$(jq -r .title <<<"$info")"
  bk="$(branch_key)"
  with_state --arg s "$SESSION" --argjson n "$n" --arg t "$title" --arg b "$bk" --arg at "$(date -u +%FT%TZ)" '
    .sessions[$s] = {issue:$n, title:$t, branch:$b, linked_at:$at, prs:(.sessions[$s].prs // [])}
    | if $b != "" then .branches[$b] = $n else . end'
  echo "linked session to #$n $title"
  move "$n" "$ST_IN_PROGRESS"
}

cmd_show() {
  local n; n="$(current_issue)"
  [ -n "$n" ] || { echo "not linked"; return 0; }
  issue_info "$n" | jq -r --argjson n "$n" '"#\($n) \(.title)\nboard: \(.status)   issue: \(.state)"'
  jq -r --arg s "$SESSION" '.sessions[$s].prs // [] | .[] | "pr: \(.)"' "$STATE"
}

cmd_set() {
  local n; n="$(current_issue)"; [ -n "$n" ] || die "session not linked — run link first"
  move "$n" "$1" "${2:+force}"
}

cmd_pr() {
  local url="$1" n; n="$(current_issue)"; [ -n "$n" ] || die "session not linked"
  # The feature branch often exists only by now (linked on main, branched later): key it.
  with_state --arg s "$SESSION" --arg u "$url" --arg b "$(branch_key)" --argjson n "$n" '
    .sessions[$s].prs = ((.sessions[$s].prs // []) + [$u] | unique)
    | if $b != "" then .branches[$b] = $n | .sessions[$s].branch = $b else . end'
  if link_pr "$n" "$url"; then echo "#$n: $url linked under Development"
  else echo "#$n: could not link $url under Development (board status still moves)"; fi
  move "$n" "$ST_PR_RAISED"
}

cmd_sync() {
  local quiet="${1:-}" n prs url state merged=0 open=0
  n="$(current_issue)"; [ -n "$n" ] || { [ -z "$quiet" ] && echo "not linked"; return 0; }
  prs="$(jq -r --arg s "$SESSION" '.sessions[$s].prs // [] | .[]' "$STATE")"
  # Adopted links carry no PRs; fall back to the PR open on this branch, if any.
  if [ -z "$prs" ]; then
    url="$(cd "$CWD" && gh pr view --json url -q .url 2>/dev/null || true)"
    [ -n "$url" ] && { cmd_pr "$url" >/dev/null; prs="$url"; }
  fi
  [ -n "$prs" ] || { [ -z "$quiet" ] && echo "#$n: no PR yet"; return 0; }
  while read -r url; do
    [ -n "$url" ] || continue
    state="$(gh pr view "$url" --json state -q .state 2>/dev/null || echo UNKNOWN)"
    case "$state" in MERGED) merged=$((merged+1)) ;; OPEN) open=$((open+1)) ;; esac
    [ -z "$quiet" ] && echo "$url  $state"
  done <<<"$prs"
  # Dev Done only once every PR for the ticket has landed — a web PR merged while the
  # backend one is still open is not dev complete.
  if [ "$merged" -gt 0 ] && [ "$open" -eq 0 ]; then move "$n" "$ST_DEV_DONE"
  elif [ -z "$quiet" ]; then echo "#$n: $open PR(s) still open"; fi
}

cmd_unlink() {
  local bk; bk="$(jq -r --arg s "$SESSION" '.sessions[$s].branch // empty' "$STATE")"
  with_state --arg s "$SESSION" --arg b "$bk" 'del(.sessions[$s]) | if $b != "" then del(.branches[$b]) else . end'
  echo "unlinked"
}

# Hook output: a line for the user and the same line for the model.
emit() {
  local event="$1" msg="$2"
  jq -nc --arg e "$event" --arg m "babysit-ticket: $msg" \
    '{systemMessage:$m, hookSpecificOutput:{hookEventName:$e, additionalContext:$m}}'
}

cmd_hook() {
  local in event cmd out n url res arg
  in="$(cat)"
  # Runs after every Bash call: bail before spawning jq unless this could matter.
  case "$in" in *SessionStart*|*"gh pr "*) ;; *) return 0 ;; esac
  event="$(jq -r '.hook_event_name // empty' <<<"$in")"
  SESSION="$(jq -r '.session_id // empty' <<<"$in")"
  CWD="$(jq -r '.cwd // empty' <<<"$in")"; [ -n "$CWD" ] || CWD="$PWD"

  if [ "$event" = "SessionStart" ]; then
    n="$(current_issue)"; [ -n "$n" ] || exit 0
    res="$(cmd_sync quiet 2>&1 | tail -1)"
    emit SessionStart "session linked to $OWNER/$ISSUE_REPO#$n${res:+ — $res}"
    exit 0
  fi

  [ "$(jq -r '.tool_name // empty' <<<"$in")" = "Bash" ] || exit 0
  cmd="$(jq -r '.tool_input.command // empty' <<<"$in")"
  grep -qE '(^|[;&|( ])gh pr (create|merge)\b' <<<"$cmd" || exit 0
  out="$(jq -r '[.tool_response.stdout?, .tool_response.stderr?, (.tool_response | strings)] | map(select(. != null)) | join("\n")' <<<"$in" 2>/dev/null)"
  n="$(current_issue)"

  if grep -qE '(^|[;&|( ])gh pr create\b' <<<"$cmd"; then
    url="$(grep -oE 'https://github\.com/[^ ]+/pull/[0-9]+' <<<"$out" | tail -1)"
    [ -n "$url" ] || exit 0                      # create failed: nothing to move
    if [ -z "$n" ]; then
      emit PostToolUse "PR $url opened but this session is not linked to a board ticket. Run /babysit-ticket to link it."
      exit 0
    fi
    res="$(cmd_pr "$url" 2>&1 | tail -1)"
    emit PostToolUse "$res (PR $url)"
    exit 0
  fi

  # gh pr merge [<number|url|branch>] — confirm the merge actually happened.
  [ -n "$n" ] || exit 0
  arg="$(sed -nE 's/.*gh pr merge[[:space:]]+([^-[:space:]][^[:space:]]*).*/\1/p' <<<"$cmd" | head -1)"
  url="$(cd "$CWD" && gh pr view ${arg:+"$arg"} --json url -q .url 2>/dev/null || true)"
  [ -n "$url" ] && cmd_pr "$url" >/dev/null 2>&1
  res="$(cmd_sync quiet 2>&1 | tail -1)"
  emit PostToolUse "${res:-#$n: merge not confirmed yet (auto-merge?) — run sync later}"
}

sub="${1:-show}"; shift || true
if [ "${CFG_CONFIGURED:-0}" != 1 ]; then
  # Not set up yet: hooks stay silent, commands say how to fix it.
  [ "$sub" = hook ] && exit 0
  die "no board configured. Run MasterDeck's Setup, or: ~/.claude/skills/master/master config save <<< '{\"owner\":\"<org>\",\"issueRepo\":\"<repo>\",...}'"
fi
case "$sub" in
  candidates) cmd_candidates ;;
  hints) cmd_hints ;;
  link) cmd_link "${1:-}" ;;
  show) cmd_show ;;
  set) [ -n "${1:-}" ] || die 'usage: set "<Status>" [--force]'; cmd_set "$1" "$([ "${2:-}" = "--force" ] && echo 1)" ;;
  branch) [ -n "${1:-}" ] || die "usage: branch <name>"; cmd_branch "$1" ;;
  pr) [ -n "${1:-}" ] || die "usage: pr <url>"; cmd_pr "$1" ;;
  sync) cmd_sync "$([ "${1:-}" = "--quiet" ] && echo quiet)" ;;
  unlink) cmd_unlink ;;
  hook) cmd_hook || true; exit 0 ;;   # a hook must never fail the tool call
  *) die "unknown command '$sub' (candidates|hints|link|branch|show|set|pr|sync|unlink|hook)" ;;
esac
