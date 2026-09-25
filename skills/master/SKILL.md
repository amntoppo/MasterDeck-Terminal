---
name: master
description: Use when the user types /master, asks what work is pending across their Claude sessions, wants issues/PRs/meeting action items delegated to sessions, asks to message or spawn a session for an issue, when a /loop sweep fires, or when a `master watch` Monitor event arrives. Runs only in the master session (configured masterName, default master-agent).
---

# master — delegate the user's work to their Claude sessions

This session reads the user's GitHub issues and PRs, their meeting action items (optional, if a Fathom MCP connector is available), and the list of live Claude sessions. It turns them into **proposals**, and it only messages or spawns a session **after the user says yes to that proposal**.

The CLI is `~/.claude/skills/master/master` (called `master` below). The ledger is `~/.claude/master/ledger.json`. Never edit the ledger by hand. Every write goes through the CLI so dedup holds.

## Configuration

Everything user-specific lives in one file, `~/.claude/master/config.json`, created by MasterDeck's Setup screen or by `master config save`. `master config show` prints it; `master config get <field>` prints one field. Fields:

- `owner` — the GitHub org or user that owns the repos.
- `issueRepo` — the repo holding the issues. Issue references read `<owner>/<issueRepo>#N`.
- `project` — GitHub Projects v2 number of the board (`0` = no board).
- `columns` — the board's status names, in order.
- `statuses.inProgress` (default `In Dev`), `statuses.prRaised` (default `PR Raised`), `statuses.devDone` (default `Dev Done`), and the lists `statuses.done`, `statuses.assignable`, `statuses.resumable`.
- `workspace` — the folder master runs in.
- `masterName` — this session's name (default `master-agent`).

Below, `master-agent` stands for the configured `masterName`; substitute it if the user changed it. "The user" is the person who owns this config.

## Guard

Run `ListAgents`. The first line says this session's name. If it is not the configured `masterName` (`master config get masterName`, default `master-agent`), stop and say: "Run /master from the session named <masterName> (`/rename <masterName>`)."

## Watching the app — keep this armed

The MasterBar app (and `master say` in any shell) writes to master's inbox and approves proposals. `master watch` turns both into events.

- On the first `/master` of a session, and whenever a Monitor notice says the `master inbox and approvals` watch expired, arm it: `Monitor` with command `~/.claude/skills/master/master watch`, description `master inbox and approvals`, `timeout_ms` 1800000. Only one watch at a time.
- Its first events are the backlog: everything queued while master was closed. Handle them in order.
- `inbox N say: <text>` → handle it as a chat message (next section).
- `inbox N sweep` → run the sweep below, then
  ```
  master reply N - <<'MASTER_EOF_7f3a'
  <the batch text, or 'no new proposals'>
  MASTER_EOF_7f3a
  master ack N
  ```
- `approved N …` → check that N is still listed by `master list --status approved`. If it is, dispatch it exactly as in "The user's answer — dispatch" step 2. If it isn't, ignore the event: it was already dispatched.
- `inbox N send → NAME: text` → this is the user messaging NAME directly (from the MasterBar app or `master say --to`), and that counts as their yes. Do this:
  1. ```
     master add --kind CHAT --issue <the issue of NAME's latest proposal, or 0> --source chat:N --session NAME \
       --message - <<'MASTER_EOF_7f3a'
     <text>

     (From the user via master-agent. Reply to master-agent with SendMessage.)
     MASTER_EOF_7f3a
     ```
  2. `master approve <id>`, then `master mark <id> sent`.
  3. `SendMessage` to NAME with that message, `notify_when_idle: true`. As soon as it succeeds, run `master mark <id> done --note delivered` — a CHAT never sits in `sent`, so it cannot mask the session's real work. (If it fails, mark it `held` as in dispatch step 2.)
  4. Find NAME's latest non-CHAT proposal. If it is `question` or `blocked`, run `master mark <that id> sent` — the user has answered it (`blocked → sent` is allowed). If it is `done` **and** this message gives NAME new work — not just a question like "any new comments?" — also run `master mark <that id> sent` (`done → sent` is allowed) so the app shows the session working again; a question alone leaves a `done` proposal as `done`. Say in the reply which of these happened, if either.
  5. `master reply N` with `sent to NAME (proposal <id>)`, then `master ack N`.

## Chat from the app

A chat message is the user talking, the same as typing here. Always answer, then ack:
```
master reply N - <<'MASTER_EOF_7f3a'
<text>
MASTER_EOF_7f3a
master ack N
```
`⏎` in the text marks a line break.

- **An instruction that names what to send and to whom** ("tell paywall to skip the web half") is the user's yes. Run
  ```
  master add --kind CHAT --issue <the issue, or 0 if none applies> --source chat:N --session <name> \
    --message - <<'MASTER_EOF_7f3a'
  <the message, first line self-contained>
  MASTER_EOF_7f3a
  ```
  then `master approve <id>`, dispatch it, and reply `sent to <name> (proposal <id>)`.
- **An open-ended request** ("deal with the paywall stuff") becomes a `CHAT` proposal. Add it the same way but do not approve it, and reply `proposal <id> is waiting for your approval`.
- **A question** ("what is paywall doing?") gets an answer in the reply. Use `master status`, `ListAgents` and the transcripts as needed.
- **An approval or rejection in words** ("approve 3 and 5") → `master approve` / `master reject`, and dispatch as usual.

## /master or /master sweep — find work

1. Run `master sweep`. It prints `no new proposals` or a numbered batch. It also prints `sources missing: …` if gh, the board, or `claude agents` failed. Always pass that line on to the user.
2. **Meetings (optional).** Only if a Fathom MCP connector is available in this session; otherwise skip this step without comment. Run `master cursor` to get `meetings_since`. It is null on the first run; use 24 hours ago in that case. Call Fathom `list_meetings` since then. For each meeting, call `get_meeting_summary`. Take only action items that name the user or an issue number (`#N`, `<issueRepo>#N`), or that clearly match the title of an in-scope issue (`master snapshot` lists them).
   - Item matches an issue that has an owner session: compute a collision-free source key from the item text (verbatim, not truncated), then add the proposal with the message piped in:
     ```
     master key <<'MASTER_EOF_7f3a'
     <item text>
     MASTER_EOF_7f3a
     ```
     ```
     master add --kind MEETING --issue N --source fathom:<recording_id>:<key from master key> \
       --session <owner> --message - <<'MASTER_EOF_7f3a'
     #N: from <meeting title> <date> — <item>

     <one or two sentences of context from the summary>

     When you are done, blocked or have a question, tell master-agent with SendMessage. First line: '#N: done', '#N: blocked — <reason>' or '#N: question — <question>'. When you have a question, ALSO ask the user directly in this session (so they see it here too), and wait for the answer from either place. If the user answers you here, tell master-agent '#N: answered — <answer>'.
     MASTER_EOF_7f3a
     ```
   - Item matches an issue with no owner: do not add it. Mention it under the batch; `ASSIGN` covers spawning.
   - Item matches no issue: list it for the user under "unmatched action items". Never create an issue.
   - Fetch a transcript (`get_meeting_transcript`) only when the summary is too vague to write the message.
   - When done, move the cursor to the start time of the **latest meeting you fully processed** — never past a meeting whose summary is not ready yet; leave that one for the next sweep. `master cursor --meetings-since <that meeting's start time, UTC, %Y-%m-%dT%H:%M:%SZ>`.
   - If the Fathom connector is present but fails, say "meetings: unavailable (<error>)" and skip this step. Do not move the cursor.
3. Show the user one combined batch. Use the sweep output, plus a line per added MEETING in the same format (`master list --status proposed` gives the ids). Then stop and wait for the user's answer. **Do not dispatch anything before the user answers.**
4. If there is nothing to report and this was a `/loop` fire, say nothing beyond one line: `sweep: nothing new`.

## The user's answer — dispatch

The user answers in free text, for example `1 3 yes, 2 no`, `all yes`, or `2 yes but tell it to skip the web half`.

1. `master approve <ids>` and `master reject <ids>`. Ids the user didn't mention stay `proposed`. Ask about them once, at the end.
2. For each approved proposal, `master list --status approved` gives its target and message:
   - **Session target:** run `master mark <id> sent` **first**, so the watch never offers it twice. If `master mark <id> sent` fails, do not send. Then `SendMessage` to `target.session` with `message` exactly as stored, plus any extra instruction the user gave, appended as a final paragraph. Pass `notify_when_idle: true`. If the proposal's kind is `CHAT`, run `master mark <id> done --note delivered` right after `SendMessage` succeeds.
   - **Spawn target:** `master spawn <id>`. On success it prints the background id. The new session appears in `ListAgents` under its name. On failure it prints the error and the proposal becomes `held` with a note. Never retry on your own; tell the user, and run `master spawn <id>` again only when they say retry.
   - If `SendMessage` fails or says the name doesn't match a live session, run:
     ```
     master mark <id> held --note - <<'MASTER_EOF_7f3a'
     <why>
     MASTER_EOF_7f3a
     ```
     and tell the user. `sent → held` is allowed.
3. Report in one short list: what was sent to whom, what spawned (with `claude attach <id>`), and what failed.

## Messages and notices from sessions

- A `<cross-session-message from="X">` whose first line is `#N: done` or `#N: blocked — …`: find the `sent` proposal for that session and issue (`master list --status sent`), then `master mark <id> done` or:
  ```
  master mark <id> blocked --note - <<'MASTER_EOF_7f3a'
  <reason>
  MASTER_EOF_7f3a
  ```
  Tell the user in one line. For `blocked`, include the reason.
- A `<cross-session-message from="X">` whose first line is `#N: question — …`: find that session's latest non-CHAT proposal for issue N in **any** of `sent` / `question` / `done` / `blocked` (`master list --status sent`, then `--status question`, then `--status done`, then `--status blocked` — a second question before an answer replaces the first, and `done → question` reopens a finished one), then
  ```
  master mark <id> question --note - <<'MASTER_EOF_7f3a'
  <the question>
  MASTER_EOF_7f3a
  ```
  and tell the user the question in one line. It then appears in MasterBar automatically.
- A `<cross-session-message from="X">` whose first line is `#N: answered — …`: the session is reporting that the user answered its question directly, in that session — find the same proposal (as above) and run
  ```
  master mark <id> sent --note - <<'MASTER_EOF_7f3a'
  <the answer>
  MASTER_EOF_7f3a
  ```
  tell the user the answer in one line, and do **not** run `master reply` — there is no inbox entry to answer, this only came in as a cross-session message.
- Any other message from a session: tell the user what it said in one or two lines. Reply only if they ask you to.
- A `[Cross-session delivery notice]` saying delivery was held or refused: run
  ```
  master mark <id> held --note - <<'MASTER_EOF_7f3a'
  <notice>
  MASTER_EOF_7f3a
  ```
  and tell the user. Never treat silence as agreement.
- A `[Cross-session idle notice]` for a session with a `sent` non-CHAT proposal and no reply yet: send one message, `"#N: master-agent here — you went idle; are you done, blocked or stuck on a question? Reply with '#N: done', '#N: blocked — <reason>' or '#N: question — <question>'. When you have a question, ALSO ask the user directly in this session (so they see it here too), and wait for the answer from either place. If the user answers you here, tell master-agent '#N: answered — <answer>'."`, with `notify_when_idle: true`. CHAT proposals are marked `done` on delivery, so idle notices never apply to them. If the next idle notice also arrives with no reply, tell the user: "<session> went idle twice without reporting on #N."

## /master status

Run `master status`. Show the roster as printed. Sessions with status `blocked` show "needs input — claude attach <id>" — that command reattaches to them. Then list proposals that are `sent`, `held` or `blocked` (`master list --status …`).

## /master loop

Start the sweep loop: invoke the `loop` skill with `20m /master sweep`. Tell the user it stops when this session closes and expires after 7 days.

## Rules that never bend

- Nothing is sent or spawned without the user's yes on that specific proposal id.
- The CLI refuses write commands from any Claude session other than the master session by design; never work around it (no editing the ledger by hand, no faking `CLAUDE_CODE_SESSION_ID`).
- Never create issues, comment on GitHub, move board status, push, or merge from this session. Sessions do that under their own skills (`babysit-ticket`, `babysit-worktree`, `babysit-pr`), after the user gives them instructions.
- Never pass `--dangerously-skip-permissions` or `--allow-dangerously-skip-permissions` to anything.
- Never ask a session to do something that was denied or blocked in this session.
- Send message text inline. `@file` references attach nothing across sessions.
- For ad-hoc GitHub reads in this session, use `ghc` (same arguments as `gh`) instead of `gh`. It shares one cache and one rate-limit pause with the sweep, MasterDeck and the babysit skills. `ghc --status` shows whether GitHub is paused.
- Never store meeting transcripts. The ledger gets only the meeting id and the action item text.
