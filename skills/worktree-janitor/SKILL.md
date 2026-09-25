---
name: worktree-janitor
description: Sweep .claude/worktrees/ across every repo in the workspace — list each worktree's branch, dirtiness, age, and merge state; remove the safe ones, flag the rest. Use when the user says "/worktree-janitor", "clean up worktrees", or a checkout fails with "already used by worktree".
---

# worktree-janitor — sweep stale Claude worktrees

Goal: reclaim disk and unblock branch checkouts by removing worktrees that are safe to
remove, while never deleting work. Report-then-delete, not delete-then-apologize.

## Steps

### 1. Inventory

Find every repo with worktrees under the configured workspace (`workspace` in
`~/.claude/master/config.json`) — the workspace root itself, if it is a repo, plus the
repos directly inside it:

```bash
ws=$(~/.claude/skills/master/master config get workspace)
# A workspace that is itself a repo sits next to its sibling repos: sweep the folder around it.
root="$ws"; [ -e "$ws/.git" ] && root=$(dirname "$ws")
for r in "$root"/*/.git "$root"/.git; do
  [ -e "$r" ] || continue
  repo=$(dirname "$r")
  [ -d "$repo/.claude/worktrees" ] && echo "== $repo" && git -C "$repo" worktree list
done
```

For each worktree collect, via `git -C <wt>`:
- **branch** (`branch --show-current`; empty = detached HEAD)
- **dirty?** (`status --porcelain` non-empty, untracked included)
- **age** (last commit date, `log -1 --format=%cr`)
- **merged?** (`git -C <repo> branch --merged <default-branch>` contains it, or
  `gh pr list --head <branch> --state merged` shows its PR merged)
- **pushed?** (`git -C <repo> ls-remote --heads origin <branch>` non-empty)

### 2. Classify

| Class | Criteria | Action |
|---|---|---|
| **SAFE** | clean AND (branch merged into default, or detached with no unique commits) | remove |
| **PUSHED** | clean, unmerged, but branch exists on origin | remove worktree, branch survives locally + remotely — say so |
| **DIRTY** | uncommitted changes | never auto-remove — list files, offer kill-worktree-style rescue (stash → remove → checkout in main repo) |
| **UNPUSHED** | clean but has commits on no remote and not merged | flag with commit list; remove only on explicit per-item approval |

Detached-HEAD worktrees (e.g. random-named session leftovers): check
`git log --oneline <sha> --not --branches` — empty means every commit is reachable
from a branch → SAFE; non-empty means orphaned commits → UNPUSHED class.

### 3. Report first

Print the classification table (repo, worktree, branch, class, reason) BEFORE
removing anything. Then:

```bash
git -C <repo> worktree remove <path>      # SAFE + PUSHED rows
git -C <repo> worktree prune
```

Never `worktree remove --force` on a DIRTY row without the user naming it explicitly.
Never delete branches — this skill removes worktree *directories* only; branch
cleanup is a separate ask.

### 4. Summary

Removed / kept / needs-decision counts per repo, disk freed if easily available
(`du -sh` before/after is optional, skip if slow), and the exact command for any
row left for the user.

## Rules

- A worktree currently in use by a live Claude session may refuse removal or break
  that session — if a removal errors with "is locked" or the user says a session is
  active there, skip it.
- The workspace root repo (if the workspace folder is itself a git repo) gets swept too,
  not just the repos inside it.
- One-shot skill: no monitor, no schedule. For recurring hygiene, wrap it in a
  `/loop` or a scheduled routine explicitly.
