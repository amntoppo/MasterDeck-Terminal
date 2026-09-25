---
name: kill-worktree
description: Tear down the session's worktree while preserving all work — stash uncommitted changes, keep the branch, return the session to the main repo, check the branch out there, pop the stash, and delete the worktree directory. Use when the user says "/kill-worktree", "drop the worktree", or wants worktree work moved back to the main checkout.
---

# kill-worktree — drop the worktree, keep every change

Goal: the worktree directory is gone; its branch and any uncommitted work live on in
the main checkout. Nothing is lost.

⚠ Never use `ExitWorktree action:"remove"` here — that deletes the **branch** along
with the directory. This skill exits with `keep` and removes the directory with git,
so the branch survives.

## Steps

1. **Preserve uncommitted work (inside the worktree).**
   ```bash
   git status --porcelain
   ```
   If dirty:
   ```bash
   git stash push -u -m "kill-worktree: <branch>"
   ```
   (`-u` includes untracked files; stashes live in the shared repo, so this stash is
   visible from the main checkout.) Record the branch name:
   `branch=$(git branch --show-current)` and the worktree path (`pwd`).

2. **Exit the session back to the main repo.** ExitWorktree with `action: "keep"` —
   restores the session's working directory to the original checkout, leaves the
   worktree and branch on disk untouched.

3. **Check the main checkout is safe to receive the branch.**
   ```bash
   git status --porcelain
   ```
   If the main checkout itself is dirty, STOP and ask the user — checking out the
   worktree branch and popping a stash onto unrelated local changes can conflict.
   Options to offer: commit/stash main's changes first, or keep the worktree instead.

4. **Remove the worktree directory, keep the branch.**
   ```bash
   git worktree remove <worktree-path>
   git worktree prune
   ```
   (Refuses if the worktree is still dirty — step 1 should have made it clean. Use
   `--force` only with explicit user approval, never to skip step 1.)

5. **Move the branch into the main checkout.**
   ```bash
   git checkout <branch>
   ```
   (Possible only now — a branch cannot be checked out in two worktrees at once.)

6. **Restore the stash, if one was made in step 1.**
   ```bash
   git stash list   # find the "kill-worktree: <branch>" entry
   git stash pop <that-entry>
   ```
   Pop only the stash this skill created — do not pop unrelated stashes. On conflict,
   resolve it and tell the user which files conflicted.

7. **Report.** Branch now checked out in the main repo, uncommitted changes restored,
   worktree gone. Show `git status` as proof.

## Rules

- If the user says the work is **abandoned** (explicitly), the flow is different:
  ExitWorktree `remove` with `discard_changes: true` after confirming — that deletes
  directory, branch, and changes in one step. Only on an explicit "discard it".
- If the branch was already pushed / has an open PR, removing the local worktree
  changes nothing remotely — the babysit-pr monitor keeps running.
- Worktree entered via `path` (not created this session): ExitWorktree cannot remove
  it anyway; same flow works — `keep`, then `git worktree remove`.
