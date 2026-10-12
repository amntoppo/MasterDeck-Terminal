---
name: masterdeck-notes
description: Write to the user's MasterDeck notes (the Notes panel in MasterDeck) — a new note, more text on a note you made, or the note of a ticket. Use when the user asks to "write it to a note", "save this in notes", "add to the ticket's note", "make a note of …", or wants something kept in MasterDeck's notes.
---

# masterdeck-notes — write to MasterDeck's notes

MasterDeck keeps the user's notes: global notes (a title and text) and one note per ticket. You can
**add** to them; you cannot read them or change what the user wrote. Write the note in Markdown
(headings, lists, `- [ ]` task lists, links, code): MasterDeck shows it rendered. HTML is shown as
plain text, so do not use it.

The script is next to this file: `~/.claude/skills/masterdeck-notes/scripts/note.sh`. The text goes
on stdin; use a quoted heredoc so nothing in it is expanded.

## A new note

```bash
~/.claude/skills/masterdeck-notes/scripts/note.sh new "Release checklist" <<'EOF'
- [ ] Tag v1.2
- [ ] Write the release notes
EOF
```

It prints the new note's id (`n-…`). Each `new` makes another note: write several when the user
asks for separate notes. Keep the id if you will add to the same note later.

## More text on a note you made

```bash
~/.claude/skills/masterdeck-notes/scripts/note.sh append n-0123456789abcdef0123456789abcdef <<'EOF'
Done: tagged v1.2.
EOF
```

## A ticket's note

```bash
~/.claude/skills/masterdeck-notes/scripts/note.sh ticket acme/widgets#12 <<'EOF'
Waiting on the API review before the migration.
EOF
```

The text is added at the end of the ticket's note (the note is made when there is none). Name the
ticket in full (`owner/name#12`); `#12` alone means MasterDeck's primary repository. When this
session was started for a ticket, that is usually the one to use.

## Rules

- Only write what the user asked to keep, or what they agreed to. Never put secrets or tokens in a note.
- Text is only ever added. To change or remove a note, ask the user to do it in Notes.
- If the script says MasterDeck is not running, or reports an error, tell the user; do not retry in a loop.
- A note is 50,000 characters at most.
