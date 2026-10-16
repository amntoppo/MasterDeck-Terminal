# Clone a session: plan (#136)

Design: [2026-10-17-clone-session-design.md](2026-10-17-clone-session-design.md).

## 1. Pure logic: `app/src/shared/clone.ts` (+ `clone.test.ts`)

- `CLONE_NAME`, `cloneNameError(name)`, `cloneName(name, taken)` (default and numbering, strips an
  old ` (clone N)`, replaces characters the rule refuses, fits 100 characters).
- `cloneBlock(s, menuShown)`: the reason Clone is refused, or null.
- `cloneOptions(text, fromStart)`: `{ model, permissionMode }` from a transcript tail, validated.
- `checkFirstMessage(raw, remote)`: trimmed text, ≤ 20 000 characters, not starting with `-`,
  `noEscape` for a browser.
- `cloneArgs(o)`: the argv.
- `CloneRecord`, `parseClones(raw)`, `clonedLine(line, at)`, `cloneOwnsBranch(rec, branch)`.

## 2. Store: `app/src/main/clones.ts` (+ test)

`CloneStore(file)`: `get(bg)`, `add(bg, rec)`, `expect(name, rec)`, `claim(sessions)`,
`toLink()`, `markLinked(bg)`; atomic writes, KEEP 500, re-read when the file changed.

## 3. `Sources`

- `setClones(store)`; claim in `pollAgents`.
- `followPrs(path, key)`: for a clone, drop lines `clonedLine` refuses before the scanners.
- `branchDir`: a clone's folder branch only when `cloneOwnsBranch`.
- `build()`: `clonedFrom` and `noConversation` on each session (`withClones`).
- `carryLinks()`: link clones with a kept ticket once listed.
- `transcriptOf(sessionId)` for main.

## 4. Main: `CH.cloneSession` (`main/index.ts`)

Validate the request, find the session by key in `latest.sessions`, `cloneBlock` + transcript
check, name (`cloneNameError`, not live), first message, account (`settingsFor`), options
(`cloneOptions` on `readTail`), branch (`git rev-parse --abbrev-ref HEAD`), run, record account and
clone, `refreshAgents`. `DeckApi.cloneSession`, preload, `DECK_ACCESS: remote`, `RemoteDeck`.

## 5. Renderer

- `SessionMenu`: **Clone…** (disabled with reason) → `onClone`.
- `CloneDialog.tsx`: name, first message, Keep ticket link (only when the session has a ticket),
  errors inline.
- `App`: `cloneSession(req)` → pending tab (`clone` on the pending tab, Try again).
- `SessionDetails`: "Cloned from <name>".
- Web preview: `cloneSession` adds a listed clone.

## 6. Checks and docs

typecheck, vitest, `build:web`; the web preview (menu, dialog, disabled item, pending tab, Details
line); the isolated app with a real throwaway haiku session cloned (`claude agents`, transcript,
first message, account file, no PRs taken). GUIDE, ARCHITECTURE, TODO, CLAUDE.md.
