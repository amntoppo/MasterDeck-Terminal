# Linked sessions — design (#67)

Issue: https://github.com/amntoppo/MasterDeck-Terminal/issues/67

## Goal

Two MasterDeck sessions working on related things (frontend + backend of one feature, two
tickets touching the same code, master watching workers) should know about each other without
the user copying context by hand. The user links sessions; linked sessions then see a running
summary of each other, refreshed automatically and on demand.

Decisions taken with the user (2026-10-07):

| Question | Decision |
|---|---|
| Who can be linked | Any two sessions MasterDeck runs on this Mac: any repo, any account |
| What is shared | The existing per-session summary (Goal / Done / Decisions / Open / State) plus cheap facts (name, repo, branch, ticket, state) |
| When it syncs | Automatically when a linked session's turn ends (debounced), and on demand with **Sync now** |
| How it reaches a session | Claude Code hooks: the SessionStart context file plus a per-prompt delta via UserPromptSubmit. Fallback where hooks are absent (Windows): start-prompt block + Sync now typed in through `Sender` |

Sessions with no links behave exactly as today: no summaries are generated for them, no block
is added to their context.

## Naming

"Link" already means session ↔ ticket throughout the code (`linkSession`, `LinkStore`,
`LinkDialog`, `LinkedSteps`). The session ↔ session feature is called **peers** in code
(`PeerStore`, `peers.ts`, `AppState.peers`, `CH.peersSet`). The UI says "Linked sessions" as the
issue does.

## Data model and persistence

- New store `<MASTERDECK_HOME>/session-peers.json`:

  ```json
  {
    "version": 1,
    "edges": [["keyA", "keyB"], ["keyA", "keyC"]],
    "seen": { "keyA": { "keyB": 1759800000000 } }
  }
  ```

  - `edges`: pairwise, unordered, deduped. Keyed by `Session.key` (the bgId when there is one,
    so it survives resume; else the sessionId).
  - `seen[T][P]`: the `at` of P's summary that T last received (SessionStart file write or delta
    consumed). Drives the per-prompt delta.
  - Written temp+rename like `session-status.json`; a corrupt file is moved aside and treated as
    empty, like `ticket-links.json`.
- `app/src/shared/peers.ts`: pure graph logic — `addEdge`, `removeEdge`, `peersOf`, `prune(live)`,
  `carry(oldKey, newKey)`, `MAX_PEERS = 8`. Testable without I/O.
- `app/src/main/peers.ts`: `PeerStore` wrapping the file + the pure logic, same shape as the
  other small stores (`load`, `save`, `add`, `remove`, `of`, `prune`, `carry`, `markSeen`).
- `AppState.peers: Record<string, string[]>` — symmetric adjacency, keyed by `Session.key`, built
  in `Sources.build()`. Reaches the web app automatically (full AppState goes over the bridge).
- Carry across resume/copy: hook into the existing `carryCopy` / `noteCopy` path so a session that
  gets a new key keeps its edges.
- Pruning: in `build()`, any edge whose endpoint is not a live session, or whose session is
  `done`, is dropped; `stopSession`, `stopOtherSession`, `stopSessions` and `removeSession`
  (Janitor) prune explicitly as well. Pruning also deletes that session's pending delta files.

## UI

### Start dialogs

- `AssignDialog.tsx` ("Where it runs" section): a **Link to sessions** multi-select over live
  sessions (name, repo folder, ticket, state dot). `AssignRequest.peers?: string[]` (Session keys).
- `NewSessionDialog` (ticketless, in `NewMenu.tsx`): the same field; `NewSessionReq.peers?`.
- Main does not thread this through `master add` / spawn. It records an expectation keyed by the
  new session's name (like `SessionAccounts.expect`) and adds the edges when the session appears;
  the expectation expires after 10 minutes.

### Details panel

- `SessionDetails.tsx`: a **Linked sessions** section after Ticket, shown only when the session
  has peers or the user opens the picker:
  - each peer: state dot, name, repo folder, ticket; an × removes the edge;
  - **Add…** opens a picker (reuses `suggestSessions` / `resolveSession` from `shared/link.ts`,
    filters out self, done and already-linked sessions, refuses beyond `MAX_PEERS`);
  - **Sync now** button with "Synced <ago>" from `seen`.
- With no peers the section collapses to a single **Link sessions…** action in the actions row.

### IPC

- `CH.peersSet` `(a: string, b: string, on: boolean)` → add/remove one edge.
- `CH.peersSync` `(key: string)` → force a summary + context refresh for that session.
- Both classified `remote` in `shared/remoteDeck.ts` `DECK_ACCESS`. `RemoteSession` (phone wire
  copy) is unchanged.

## Sharing mechanics

### Producer: keeping a linked session's summary fresh

`app/src/main/peerSync.ts` `PeerSync`:

- On the **Stop** deck hook for session S: if S has ≥1 peer, and `summaryGet(S)` reports `stale`,
  and the last automatic make for S was ≥ 2 minutes ago, run the existing `summaryMake(S)`
  (haiku). One make at a time per session; a queued request collapses into the next one.
- Sessions with no peers are never summarised automatically.
- After a summary lands, `refresh(S)`: rewrite the context file of every peer T of S and write a
  delta for each T whose `seen[T][S] < summary.at`.
- Setting `peerSync.auto` (default `true`) in the deck config switches the automatic part off;
  Sync now still works.

### Consumer: how a session reads its peers

1. **SessionStart** — `ticketContext()` in `shared/deckHooks.ts` gains a `## Linked sessions`
   block: per peer (newest summary first, at most 5): name, repo folder, branch, ticket, state,
   then the summary text capped at 2500 characters, or "(no summary yet)". The block goes into
   the existing `deck/context/<sid>.json`, written by the 60 s `writeTicketContext` pass and
   immediately on edge change or summary change. Resume, compaction and `/clear` therefore get the
   current peers for free. Writing the file sets `seen[T][P] = P.summary.at` for each peer.
2. **Per-prompt delta** — the UserPromptSubmit hook script gets one more cheap check before its
   `/queue` fast path: if `deck/peers/<sid>.delta.json` exists, rename it to a temp name, print its
   `additionalContext`, delete it. Main writes the delta when a peer's summary is newer than
   `seen[T][P]`; content: "Linked session <name> updated (<ago>):" + the summary's Done /
   Decisions / Open / State sections. One file per consumer; a newer change overwrites it, so a
   session idle for hours gets one current delta, not a backlog. Consumption marks `seen`.
3. **Start prompt** — `composePrompt` gains a `peersBlock()` (same shape as `earlierBlock()`) so
   the first turn knows its peers before any hook fires, and on Windows.
4. **Sync now** — `CH.peersSync(key)`: make the summary now (ignoring the debounce), then
   `refresh`. Where deck hooks are not installed (Windows, or hooks disabled) the peers' block is
   delivered through `Sender.send` once `canDeliver` allows, the way `LinkedSteps` does.

### Unlink

Removing an edge: next `writeTicketContext` drops the block on both sides; any pending delta
mentioning the removed peer is deleted. Nothing already in a transcript is retracted.

## Edge cases

- Pairwise, not transitive: A–B and B–C do not make A see C.
- `MAX_PEERS = 8` per session; the picker and `peersSet` refuse more.
- A peer that ends: its edges are pruned on the next build; its last summary is no longer shown.
- Resume with a new sessionId but the same bgId: key unchanged, nothing to do. Copy/resume that
  changes the key: `carry`.
- Hooks are installed only on non-Windows; `ticketContext` writes are harmless there and the
  Sender fallback covers Sync now.
- Cost: haiku only, debounced per session, only for linked sessions; the existing outline cap in
  `summaryMake` bounds input size.

## Testing

vitest, tests next to their files:

- `shared/peers.test.ts` — add/remove symmetry, dedupe, self-edge refused, `MAX_PEERS`, prune,
  carry.
- `shared/deckHooks.test.ts` — Linked sessions block: ordering, caps, "(no summary yet)", absent
  when no peers.
- `shared/prompt.test.ts` — `peersBlock`.
- `main/peers.test.ts` — store round trip, corrupt file moved aside.
- `main/peerSync.test.ts` — debounce, stale check, refresh writes deltas only for unseen, Sync now
  ignores debounce, no work for unlinked sessions (fake summaryMake and clock).
- `shared/remoteDeck.test.ts` — passes with the two new `DeckApi` members classified.
- Hook script: a test for the delta fast path (rename + print + delete; missing file is a no-op).
- `npm test` and `npm run typecheck` green.

## Docs

ARCHITECTURE.md (store, AppState field, hooks, PeerSync), GUIDE.md (Linked sessions, Sync now),
TODO.md (done entry with commit).
