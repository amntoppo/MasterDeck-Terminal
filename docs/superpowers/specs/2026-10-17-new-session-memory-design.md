# New Claude session: account first, remembered choices (#153)

## Problem

The **New Claude session** dialog (`NewSessionDialog`, `renderer/.../NewMenu.tsx`) lists the
account third and remembers nothing: Workspace, Model, Workflow and Permissions start from the
defaults every time, so a user with several accounts picks the same things again on each start.

## Decisions

1. **Account first.** `AccountSelect` moves to the top of the dialog, shown only with two or more
   accounts (as today).
2. **What is remembered, per account**: the folder (`cwd`), model, workflow and permission mode.
   Name, first message and linked sessions are per session and never remembered. The dialog has no
   worktree options, so there are none to keep.
3. **Where**: `localStorage` (`deck.load` / `deck.save`) under one key, `newSessionPrefs`, like the
   Start dialog's "Remember these choices" (`startPrefs:*`). It survives restarts; the Mac's window
   and each browser keep their own copy. ponytail: per browser, not synced; a store on the Mac
   (a `prefs:*` channel) is the upgrade if users want one memory everywhere.
4. **Shape**: `{ last: string | null, by: { [login]: { cwd, model, workflow, mode } } }`. With one
   account the choices are kept under the key `""` (one set); with two or more, under the login.
   `last` is the account of the last start. Everything read back is checked (`parseNewSessionPrefs`):
   anything not ours is dropped, at most 20 accounts are kept.
5. **Opening**: the account is `last` when it is still a healthy connected account; otherwise
   today's rule (the folder's account). The other fields come from that account's choices,
   falling back to today's defaults. A remembered account holds only until the user picks another
   folder: then the account follows the folder again (`accountFor`), so a session never runs as the
   remembered account in another account's repository (review on PR #155). An account picked in
   this dialog stays whatever folder is chosen after it, as before.
6. **Switching account** (the user picks another): the fields the user has not touched in this
   dialog take the new account's choices (or the defaults when it has none). A field the user
   changed stays. The account the dialog derives from the folder (no `last`) does not reload
   fields: only a pick does.
7. **Saving**: on **Start session**, the choices used become that account's and `last` becomes it.
   Cancel saves nothing.
8. **Gone values** fall back to the field's default with a short note under the account (one per field, gone once that field is changed):
   a folder that no longer exists ("The last folder, …, is gone: using the workspace."), a model
   not in the list, a workflow template that was deleted, a mode no longer offered. A folder is
   checked by a new read, `folderExists(path)` (`CH.folderExists`, open to the web: `startClaude`
   already tells a browser whether a folder exists, so nothing new is revealed). A remembered model
   equal to the configured default becomes the Default option (the list hides it). When the
   workflow list is not readable (no templates), the workflow stays the default without a note.

## Pieces

- `shared/newSessionPrefs.ts` (pure): `NewSessionPrefs`, `NewSessionChoice`, `parseNewSessionPrefs`,
  `prefsAccountKey`, `choiceFor`, `rememberChoice`, `resolveChoice` (validates a choice against the
  dialog's lists, gives values and notes), `initialAccount`. Tests in `newSessionPrefs.test.ts`.
- `CH.folderExists` + `DeckApi.folderExists` + preload + `DECK_ACCESS` (`remote`); the handler
  takes an absolute path string of at most 4096 characters, else false.
- `NewSessionDialog`: account first, load on open, apply on account pick (touched fields kept),
  save on start, notes.
- Docs: GUIDE (New Claude session), ARCHITECTURE (renderer storage keys), TODO, CLAUDE.md state.

## Not done

- Syncing the memory between the window and browsers (see 3).
- The Start dialog (Assign) keeps its own per-repository memory; unchanged.
