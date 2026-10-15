# MasterDeck messages never mix with the user's draft (#123)

## Problem

Every message MasterDeck sends to a session (PR watch, monitors, workflow steps, linked-session
deltas, loop nudges, queue Send next, Needs-you replies, `/reload-plugins`, the send box) goes
through `Sender.send` (`main/send.ts`), which types a bracketed paste and Enter into the session's
PTY. Claude Code puts the paste after whatever the user had typed, and Enter submits both: the
user's half-written prompt goes out inside MasterDeck's message, and their draft is gone.

## What each option can and cannot do

Checked against Claude Code 2.1.301 with a throwaway haiku session in a trusted folder and a probe
mod loaded with `--plugin-dir` (2026-10-16).

| Option | Starts a turn on an idle session? | Touches the draft? | Where it works | Verdict |
|---|---|---|---|---|
| `$.prompt.submit` in MasterDeck's core mod | **Yes**: "a turn of its own, once the session is idle"; queued while busy | **No**. Probe: draft `refactor the login`, cursor 15; submit → the turn ran (PONG), draft and cursor unchanged, before, after and at `turn.complete` | every session the core mod runs in (user-scope install, `claude --bg` and interactive), any OS | **Primary path** |
| Stop hook answering `decision: block` (the deck hook's queue handshake) | No: only at the end of a turn | No | sessions with MasterDeck's hooks (macOS), busy ones | **Second path** for held messages of a busy session |
| `UserPromptSubmit` / `additionalContext`, `prompt.context` | No: rides on the next prompt the user sends | No | — | Not a delivery path (nothing happens until the user types) |
| `/queue` | Stop hook only (as above) | No, but it is the user's own list | — | Not used: MasterDeck messages are not the user's queue |
| `master say --to` (master-agent → `SendMessage`) | Yes (Claude Code's inbox) | No | sessions in another terminal, master-agent up | Already safe; kept as is |
| PTY paste, prompt read off the screen | Yes | Only if it types over a draft | everywhere a PTY reaches | **Fallback**, guarded: hold when the box has text |

Clearing the box (Ctrl+U), stashing it or retyping it is never done: it cannot keep the draft
"exactly as typed, cursor included".

## Decision

One order for every message, whatever its kind (no urgent/informational split is needed: the
primary path has no downside, and the fallback's hold is visible and has **Send now**):

1. **The core mod** when the session's heartbeat says it can deliver (`deliver: 1`, core 0.6.0)
   and the text is not a command (`/…`, `!…`, which `prompt.submit` would send as words). Handshake
   in `deck/deliver/<session id>/`: the app writes `<id>.json`; the mod (2 s timer) writes
   `<id>.claim`; the app answers `<id>.go` if the claim came in time (5 s); the mod submits once and
   writes `<id>.done` (`{ok}`); the app removes the files. `$.fs` has no rename or delete, so the
   app alone decides who delivers: no `.go`, no submit; a late claim finds the request gone. Not
   claimed in time (no mod after all, a reload) → the next path. A `.done` that never comes after
   `.go` counts as delivered (the mod has it), never typed again.
2. **The existing routes, guarded.**
   - *Open pane*: before typing, the pane's output is rendered (headless xterm at the pane's size)
     and the prompt box read (`promptDraft`): the line under the top rule that starts with `❯`,
     dim cells (the placeholder, suggestions) dropped. Text in it, the user typed into the pane in
     the last 4 s, or no box found → **held**. After the paste, if the user typed during the 150 ms
     before Enter, Enter is not sent: the text stays in the box, unsent (never a mixed submit).
   - *Hidden `claude attach`*: the same check on the attach's own screen; a draft or no box →
     held (the attach detaches without typing).
   - *`master say --to`*: unchanged; it never types.
3. **Held messages** (`HeldStore`, `<home>/held-messages.json`, atomic, survives a restart) are
   kept per session in order; a new message to a session with messages held waits behind them.
   - Every 2 s MasterDeck tries the first one again (an attach at most every 20 s): mod first,
     then the guarded route, so it goes once the box is empty and the user has stopped typing.
   - A busy session's Stop hook asks MasterDeck (`deck/held/<sid>` mark, the queue handshake) and
     gets the held message as `decision: block` before any queued prompt.
   - The session row shows a ✉ badge; the session's pane a bar with the message, who sent it, why
     it waits, **Send now** (types it now if the box is empty, even if the user just typed or the
     box can't be read; never over a draft: it says so) and **Discard**.
   - Messages of a session that ended or is gone are dropped (logged).

## Out of scope

Windows' guarded PTY path is the same code, untested there. Slash commands MasterDeck sends
(`/compact`, `/reload-plugins`) take the guarded PTY path only (`$.command.run` could run them;
later). `answerMenu` types keys into a menu, not the prompt box: unchanged.
