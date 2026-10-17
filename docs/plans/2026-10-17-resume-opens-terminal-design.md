# Resuming a session opens its terminal (#133): design

## Problem

The Resume buttons on a Board card, in the History dialog and in the Start (Assign) dialog run
`claude --bg --resume` and leave the user where they were: the card button says "Resumed", History
says "Resuming as …", the Start dialog closes. The user then finds the session in the list and
opens its terminal by hand.

## What changes

After a resume that succeeded, MasterDeck switches to the Terminals view, opens (or focuses) the
session's tab with its own **Terminal** tab active and keyboard focus in the terminal, and closes
the dialog the resume came from. A failed resume changes nothing but the error shown, as today.
**Resume all** (the restart banner) is not touched: it stays where it is.

## How the window finds the resumed session

`claude --bg --resume` prints the background id it runs under (`backgrounded · <id>`; a bare
resume also notes `woke session <id>`; a copy `started a copy as <id>`). That id is the session's
`Session.key`. `resumeBg` in main reads it from the output and answers
`{ ok: true, message: name, key }` (`key` null when the output named none). `ResumeResult` in
`shared/types.ts` is `CliResult & { key?: string | null }`; the field is optional, so a web tab
talking to an older Mac (no `key`) still works by the fallbacks below.

The renderer looks the session up with one pure rule, `resumedSession` (`shared/resumeOpen.ts`):

1. a background session with that `key`;
2. else a background session with the resumed `sessionId` (a bare resume keeps its ids);
3. else a background session of the resumed name that started after the resume was asked (a copy
   under a new name and ids when nothing else matched).

Only a session that is running counts (a live `pid`, or a state other than `done` / `suspended`):
the session list may still show the stopped row for a few seconds, and attaching a stopped row
would resume it a second time.

## In the window (`App.tsx`)

`openResumed(target)` (target: `key`, `sessionId`, `name`, `at`):

- the Terminals view is shown;
- when `resumedSession` finds the session now, its tab is opened as `openSession` does (an
  existing `tab:<key>` is reused, never a second one) and armed (attached);
- otherwise a "Resuming <name>…" pending tab (`kind: "pending"`, `resumed: target`) is shown until
  the session list has it; the existing "Starting…" resolver turns it into the session tab, using
  `resumedSession` for these tabs instead of the name match;
- either way the session's own tab row is put on its Terminal tab (`sessionTabs.activate(key,
  TERMINAL_ID)`) and the pane gets a wake mark (`wake`: tab id + time). The pane reattaches when
  its terminal had shown "Session ended" / "Detached", and `TerminalView`'s `focusAt` prop focuses
  the terminal even when the tab was already the visible one.

## Call sites

| Where | Today | Now |
|---|---|---|
| Board card `ResumeButton` (`BoardView.tsx`) | "Resumed" | `onResumed(target)`; error in the button's tooltip as today |
| History dialog (`HistoryDialog.tsx`) | "Resuming as …" | closes, `onResumed(target)`; error in its line as today |
| Start dialog (`AssignDialog.tsx`) | closes | closes, `onResumed(target)`; error in the dialog as today |
| Restart banner `Resume all` | message | unchanged |

## Web app

`resumeSession` already goes over the bridge (`DECK_ACCESS` `remote`); the answer's new `key`
travels with it. The phone's `activate` already switches to the main screen. Nothing else.

## Not doing

- A timeout on the "Resuming…" tab when the session never appears (as the other "Starting…"
  tabs): `ponytail:` comment where it would go.
- Resume all opening anything.
