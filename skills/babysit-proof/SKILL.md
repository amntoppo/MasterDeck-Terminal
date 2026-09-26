---
name: babysit-proof
description: Prove a feature works - run its end-to-end tests once (Playwright for web, Maestro for Expo) while taking a screenshot of every step, then post a summary with the screenshots and what the session changed on the GitHub issue linked to the session. Use when the user types /babysit-proof, asks for screenshots or proof of what was built, or wants the linked issue updated with test results.
---

# babysit-proof — test it once, screenshot every step, report on the issue

Screenshots are taken **while the tests run**. Never replay steps, open the app by hand, or run a
test again just to get pictures. A re-run is only for a fix (code or test), and its screenshots
replace the old ones.

**Started by the hook** (MasterDeck Setup → Hooks → babysit-proof): just before `gh pr create`, the
session launches this skill in a background subagent and creates the PR without waiting. As that
subagent you share the worktree with a session that keeps working in it, so:
- never commit, push, stash, reset or switch branches; `publish` pushes only the babysit-proof branch;
- add test files, but don't edit the session's other files; if a test finds a bug, report it with
  the screenshots and leave the fix to the session;
- use your own ports for anything you start, and stop what you started when you are done;
- finish with: the issue comment URL, the test result, and the test files you added (the session
  asks the user before committing them).

The script: `P="$HOME/.claude/skills/babysit-proof/scripts/proof.py"` (`python3 "$P" --help`).
Everything lands in a run folder in the worktree, `.proof/<stamp>/` (git-ignored through
`.git/info/exclude`; never commit it).

## 1. Start a run and see what changed

```bash
python3 "$P" init        # prints the new run folder
python3 "$P" changes     # commits, files and PRs of this branch -> changes.md; prints the linked issue
```

Read the diff (`git diff $(git merge-base HEAD origin/HEAD)`) and list the user-facing flows this
session added or changed. Each one needs a test that walks it; that test is the proof.

## 2. Pick the runner

- **Web** (a browser app; Playwright config or `@playwright/test` in package.json): Playwright.
- **Expo / React Native** (`expo` in package.json, `app.json` / `app.config.*`): Maestro, on the iOS
  simulator by default (`--platform android` for a device/emulator).

A repo without the tool: ask the user before adding `@playwright/test` (and its browsers) or
Maestro, and say where it would go. Don't install anything silently.

## 3. Make sure the tests cover the change

**Playwright.** Copy the fixture next to the specs and import from it in the specs that cover this
feature — it screenshots after every page and locator action (goto, click, fill, press, check,
select, ...) and at the end of each test:

```bash
python3 "$P" fixture e2e/          # or wherever the repo keeps its Playwright specs
```
```ts
import { test, expect } from './proof.fixture'   // instead of '@playwright/test'
```

Existing specs for these flows: switch their import. None: write focused specs for the flows from
step 1, in the repo's style (its config, base URL, login helpers). Name tests by what the user does
("adds a todo") — the names head each group of screenshots.

**Maestro.** Use the repo's flows (`.maestro/`, or the flows folder the team uses); add flows for the
changed screens when there are none. No `takeScreenshot` steps are needed: the simulator screen is
recorded during the run and one frame is cut at the end of every step. Needs Java 17+, `ffmpeg`, and a
booted simulator (`xcrun simctl list devices booted`) or `adb devices`.

Start what the tests need first (dev server, Metro, backend), in the background, unless the
Playwright config has a `webServer`.

## 4. Run once

```bash
python3 "$P" web -- e2e/todos.spec.ts            # extra args go to `npx playwright test`
python3 "$P" expo .maestro/login.yaml --platform ios
```

Screenshots: `<run>/steps/<test or flow>/NN-<step>.png` (a failed Maestro step is marked `FAILED`).
Test output: `tests-web.log` / `tests-expo.log`; results: `results.json`.

A failure is part of the proof: don't hide it. If it's a real bug in this session's work, fix it
and run again; if the test is wrong, fix the test and run again. Otherwise report it as is.

## 5. Check the pictures, write the summary

Open a few screenshots (the Read tool shows images) and check they show the feature, not a login
wall, a blank page or an error. Then write `<run>/summary.md` — the top of the issue comment, 3–8
lines:

- what was built, for the user, in plain words;
- which flows the tests walked, and the result;
- what is not covered, and any failure, honestly.

## 6. Post it on the issue

```bash
python3 "$P" publish --dry-run   # preview: <run>/comment.md
python3 "$P" publish             # the issue linked to this session (babysit-ticket); or --issue N
```

`publish` commits the screenshots to a `babysit-proof` branch of the repo's origin — without
touching the working tree or the checked-out branch — pushes that branch, and comments on the issue
(in the configured issue repo) with the summary, test results, what changed and every step's
screenshot (the first 40). People who can see the repo see the images. Tell the user the comment's
URL.

Not linked to an issue: say so and suggest `/babysit-ticket`, or `--issue N`. Never push anywhere
but the `babysit-proof` branch, never commit `.proof/`, never merge.
