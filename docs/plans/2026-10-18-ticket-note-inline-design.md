# The ticket's note, read and written in Session details (#164) — design

## Problem

Session details → GitHub → **Ticket** shows a 120-character preview of the ticket's note and an
**Add note** / **Edit note** link that leaves the panel for the Notes panel. While working in a
session you cannot read the note, or jot one down, where you are.

## Decision from the requester (issue comment, 2026-10-18)

One note per ticket, edited in place. The section shows the ticket's single note
(`t-owner~repo~N`), never other notes linked to the ticket, and the panel never makes `n-…` notes.
This replaces the issue's "Multiple notes per ticket" item.

## What the user sees

Inside the Ticket row (GitHub tab), where the preview and link were, a **Note** block:

- **No note:** a "Write a note…" box. Typing and **Save** (or ⌘/Ctrl+Enter) saves it as the
  ticket's note; **Cancel** or Esc drops the text. Saving nothing does nothing.
- **A note:** its text rendered (`MarkdownView html={false}`), with when it was last updated. A long
  note is cut to about twelve lines with **Show more** / **Show less**. Clicking the text (or
  **Edit**) opens the same Markdown text in a box in place; **Save** / ⌘⌃Enter saves, **Cancel** /
  Esc drops the changes. Saving it empty removes the note, as everywhere else.
- **Delete** (while editing a stored note) asks first: the Mac's native dialog in the window,
  `webConfirm` in a browser (the `notes:delete` handler already does both).
- **Open in Notes** (shown while not editing) opens the full Notes panel on the note, as the old link did.
- A save that meets a version saved elsewhere shows **Changed elsewhere.** with **Reload** (take the
  stored text, go on editing) and **Keep mine** (write over it, `force`); a note deleted elsewhere
  shows **Deleted elsewhere.** with **Discard** and **Keep**. Nothing is overwritten without
  **Keep mine** / **Keep**. A refused save shows the store's reason; a save with no answer or a
  failed disk write says **Not saved** and keeps the text for another Save.
- The Ticket row's badges get a small **Note** badge when the ticket has one, so a closed row still
  says so.
- Live: the list of notes (`useNotes`, `NoteChange` events) carries the note's `updated`; when it
  moves, the text is read again (`notes:get`, after the 1.5 s pause `SessionNotes` already uses), so
  a save in the Notes panel, on the Board or in a browser shows here without a reload.
- Hidden when `notesList` is not available (`can("notesList")`) or `onNote` is absent, as today;
  sessions without a ticket show no block (v1).

## How

- **Explicit save, not autosave.** The Notes panel's `NoteEditor` autosaves and is the window's one
  editor. The inline box has its own short life (open → Save / Cancel), so it does not share that
  editor: it holds the text and the `base` it started from, and each Save is one `notes:save` with
  that `base`. Two editors on one note are kept apart by `base` alone: whichever saves second gets
  the conflict. The Notes panel's editor already looks at the list's row (`seen`) and reloads or
  asks when the inline save moved the note.
- Pure logic in `shared/ticketNoteInline.ts`: `saveTicketNote(save, draft, force)` turns a
  `SaveResult` (or a thrown call) into one outcome (`saved` with its `NoteChange`, `clash`,
  `refused`, `failed`), and `afterClash` / draft helpers. Tested in `ticketNoteInline.test.ts`.
- `ticketNote(metas, repo, number)` moves from `renderer/src/notes.ts` to `shared/notes.ts`
  (re-exported) and gets tests.
- `useNoteBody(id, version)` in `renderer/src/notes.ts`: the read-on-pick-and-on-change logic that
  `SessionNotes` had inline; both use it.
- A draft survives switching Details tabs or sessions while the window lives (a module-level map per
  ticket key, like `openRows`); Save or Cancel clears it.
- UI in `renderer/src/components/TicketNote.tsx`, used by `TicketRow` in `GitHubDetails.tsx`.

## Not in v1

- Notes linked to a session without a ticket (the Notes tab already lists them).
- Inline editing in the Details → Notes tab (it still opens the panel).
