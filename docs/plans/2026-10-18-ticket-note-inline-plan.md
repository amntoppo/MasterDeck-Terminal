# The ticket's note in Session details (#164) — plan

Design: [2026-10-18-ticket-note-inline-design.md](2026-10-18-ticket-note-inline-design.md).

1. **Shared lookup.** Move `ticketNote` to `shared/notes.ts`, re-export it from
   `renderer/src/notes.ts`. Tests: primary repo by `null`, case-insensitive repo, another number,
   an `n-` note linked to the ticket is not it.
2. **Save logic.** `shared/ticketNoteInline.ts`: `TicketNoteDraft { ticket, base, body }`,
   `saveTicketNote(save, draft, force?)` → `saved` (with the `NoteChange`) / `clash` (note or null) /
   `refused` (message) / `failed` (no answer or `retry`); `reloadDraft(draft, note)`. Tests for each
   result, the sent input (ticket, `title: ''`, `base`, `force`), an empty save of a stored note
   (deleted), and a thrown call.
3. **Body hook.** `useNoteBody(id, version)` in `renderer/src/notes.ts` from `SessionNotes`'s
   effect; `SessionNotes` uses it.
4. **UI.** `components/TicketNote.tsx`: view (rendered, Show more, updated ago, Edit, Open in
   Notes), empty box, editor (textarea, Save, Cancel, Delete, ⌘/Ctrl+Enter, Esc), conflict and
   error lines, drafts kept per ticket. `TicketRow` uses it and shows a **Note** badge. CSS in
   `styles.css` with tokens only.
5. **Checks.** typecheck, vitest, the web preview (`/?preview`) at desktop and phone width.
6. **Docs.** GUIDE (Session details → GitHub → Ticket), ARCHITECTURE (notes), TODO (Recently done
   and open points), CLAUDE.md current state.
