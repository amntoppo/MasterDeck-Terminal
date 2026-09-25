---
name: babysit-worktree
description: Create an isolated git worktree and switch this session into it so all further changes happen there, keeping the main checkout clean. Use when the user says "/babysit-worktree", "work in a worktree", or wants this session's changes isolated from the main working copy. Pair with kill-worktree to fold the work back.
---

# babysit-worktree — isolate this session's changes in a worktree

Goal: everything this session edits from now on lands in a dedicated worktree under
`.claude/worktrees/`, not in the main checkout. The main working copy stays untouched
for other sessions, editors, or running services.

## Steps

1. **Check current state first.** Run `git status` in the current repo:
   - Uncommitted changes the user wants in the worktree will NOT follow automatically —
     the worktree branches fresh. Either commit them first, or carry them over with
     `git stash push -u` now and `git stash pop` inside the worktree after entering
     (stashes are shared repo-wide, visible from every worktree).
   - Already inside a worktree session? Say so and stop — one at a time; run
     kill-worktree (or ExitWorktree) first.

2. **Enter.** Use the **EnterWorktree tool** with a task-descriptive `name`
   (e.g. `fix-coupon-rounding`). Do not use raw `git worktree add` — the tool also
   switches the session's working directory and registers exit-time cleanup.
   - Note the base ref: with default settings (`worktree.baseRef: fresh`) the new
     branch starts from `origin/<default-branch>` — NOT from the local HEAD. If the
     task must build on unpushed local commits, tell the user and either push them
     first or ask them to set `worktree.baseRef: "head"` in settings.

3. **Confirm.** Report the worktree path and branch (`git worktree list`,
   `git branch --show-current`). All subsequent edits, commits, test runs, and PR
   creation in this session happen here.

4. **Work as normal.** The babysit-pr hooks and skill still apply — `gh pr create`
   from inside the worktree triggers the self-review gate and the comment monitor
   exactly as in the main checkout (same repo, same `.git`).

## Rules

- Do not edit files in the main checkout while the worktree session is active —
  the whole point is isolation. If the user asks for a change to the main checkout,
  flag the conflict and let them decide.
- The worktree shares the repo's object database: commits, branches, and stashes made
  here are visible from the main checkout immediately. Only the *working files* are
  isolated.
- If your workspace has several repos: worktrees are per-repo. A cross-repo task needs a
  worktree in each affected sub-repo — say so before starting, and only isolate the repo(s)
  actually being changed.
- To leave: use **kill-worktree** (fold branch + stash back to the main repo and drop
  the worktree) or ExitWorktree `keep` (park it to resume later).
