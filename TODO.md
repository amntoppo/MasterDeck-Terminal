# TODO

## Support other coding CLIs (Codex, Copilot)

MasterDeck only runs Claude Code today. Both Codex CLI and GitHub Copilot CLI now have hook systems
close to Claude Code's; what ties MasterDeck to Claude is its background sessions and transcript
format.

### Where MasterDeck depends on Claude Code

| Layer | What it relies on | Where |
|---|---|---|
| Session lifecycle | `claude --bg` to start, `claude agents` to list, `--resume`, `claude stop`, attaching to the daemon's terminal | `sources.ts`, `index.ts`, `masterCli.ts`, `restore.ts` |
| Transcripts | `~/.claude/projects/*.jsonl` (`tool_use` / `tool_result`, `pr-link`, …) | ~12 shared modules: `activity`, `ask`, `prscan`, `worktrees`, `stats`, `history`, `summary`, `flowTrack`, `pastSessions`… |
| Hooks | `~/.claude/settings.json`, Claude's event names and output (`hookSpecificOutput`, `decision: block`) | `hooks.ts`, `deckHooks.ts`, `flow.ts`, `workflow.ts` |
| Screen reading | Claude's terminal layout for menus and permission prompts | `ask.ts` |
| Claude-only features | AskUserQuestion answers, the status line (cost), `/compact`, model list, `~/.claude/skills` | `statusline.ts`, `models.ts`, `skills.ts`, `deckHooks.ts` |
| master-agent | A Claude session running `/master` | `masterCli.ts` |

### What the other CLIs offer (checked Sept 2026)

| Capability | Claude Code | Codex CLI | Copilot CLI |
|---|---|---|---|
| Background daemon (start, list, stop, attach) | ✅ `--bg` / `agents` | ❌ | ❌ |
| Resume a session | ✅ | ✅ `codex resume`, `exec resume` | ✅ `--resume`, `--continue` |
| Transcript on disk | `~/.claude/projects/*.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `~/.copilot/session-state/…/events.jsonl` |
| Hooks | ✅ | ✅ Nearly the same events: PreToolUse, PostToolUse, SessionStart, Stop, PermissionRequest, Pre/PostCompact… (TOML or hooks.json) | ⚠️ Smaller set: sessionStart/End, userPromptSubmitted, preToolUse (allow/deny), postToolUse, errorOccurred |
| Answer permissions from MasterDeck | ✅ | ✅ PermissionRequest | ⚠️ Only allow/deny in preToolUse |
| Feed workflow steps in mid-session | ✅ `additionalContext` | ✅ Probably (schema mirrors Claude's); verify | ⚠️ Unclear; probably only at session start |
| Skills (SKILL.md) | ✅ | ✅ | ✅ |

### Architecture changes

1. **Provider interface** (`main/providers/`). One adapter per CLI:

   ```ts
   interface AgentProvider {
     id: 'claude' | 'codex' | 'copilot'
     detect(): Promise<{ installed: boolean; version: string }>
     capabilities: { background: boolean; permissionHook: boolean; contextInjection: boolean; askQuestions: boolean; cost: boolean; … }
     sessions: { list(); start(opts); resume(id); stop(id); terminal(id): PaneSpec }
     transcripts: { locate(sessionId): string[]; parse(lines): AgentEvent[] }
     hooks: { install(events, script); uninstall(); formatDecision(kind, payload): string }
     skillsDirs(): string[]
     models(): Model[]
   }
   ```

   `Session` gets a `provider` field; session keys become `provider:id`.

2. **One shared event format** (the biggest refactor). Each adapter turns its transcript lines
   into common events: `user`, `assistant`, `tool_call {name, command}`,
   `tool_result {ok, output}`, `question`, `turn_end`, `pr_link`, `tokens`. The ~12 modules that
   read transcripts switch to these. The Claude adapter is today's parsing, moved behind the
   interface; the existing tests are the safety net.

3. **A session host for CLIs without a daemon.**
   - First version: run Codex / Copilot sessions in MasterDeck's own terminals (node-pty, like
     shells). The SessionStart hook gives the session id and transcript path. After a restart,
     resume them with `codex resume <id>` / `copilot --resume <id>`. Trade-off: they stop while
     MasterDeck is closed.
   - Later: a small detached host process (or tmux) that keeps terminals alive when the app
     quits; the app reconnects, like Claude background sessions.

4. **Hooks per provider.** The deck hook script stays shared (reads JSON, writes files). Each
   provider adds where hooks are installed (`~/.codex/config.toml` / `hooks.json`,
   `~/.copilot/hooks/*.json`), the event name mapping (e.g. Codex `PermissionRequest` ↔ Copilot
   `preToolUse`) and the response format. The workflow compiler is shared; only the output wrapper
   differs.

5. **UI adapts to capabilities.** Hide or grey out what a provider can't do: the Needs you
   permission card (`permissionHook`), the question form (`askQuestions`), Costs (`cost`; Codex
   tokens can come from its transcript), workflow triggers. Add a **CLI** picker in the Start
   dialog and a provider badge on session rows.

6. **Supporting pieces.** Install skills into each tool's skills folder (SKILL.md is shared, so the
   babysit skills mostly carry over). Screen reading (`ask.ts`) becomes per provider, or is dropped
   where hooks cover it. master-agent can stay a Claude session and manage sessions from any CLI.

### Order

1. Provider interface + Claude adapter: a refactor with no behaviour change. Largest effort.
2. Codex: closest hooks and transcripts. Sessions in MasterDeck's own terminals, resumed after a
   restart.
3. Copilot: reduced feature set (sessions, Board/PRs, status, triggers at session start and before
   tools).
4. Session host process, so non-Claude sessions survive closing MasterDeck.

### Risks

- Format drift: both CLIs change fast (Codex hook regression in May 2026; Copilot `events.jsonl`
  corruption issues). Add fixture tests per CLI version and a minimum supported version for each.
- Uneven features: Copilot will be thinner; capability flags must make that clear instead of
  looking broken.

### Sources

- [Codex hooks reference](https://agenticcontrolplane.com/blog/codex-cli-hooks-reference)
- [Codex hooks guide (2026)](https://knightli.com/en/2026/06/11/codex-hooks-advanced-usage/)
- [Codex advanced configuration](https://developers.openai.com/codex/config-advanced)
- [Codex hook regression, issue #21639](https://github.com/openai/codex/issues/21639)
- [Codex session lifecycle and rollout files](https://codex.danielvaughan.com/2026/06/08/codex-cli-session-lifecycle-archive-resume-fork-rollout-persistence-management/)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Using hooks with GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks)
- [About hooks for GitHub Copilot](https://docs.github.com/en/copilot/concepts/agents/hooks)
- [Using Copilot CLI session data](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/chronicle)
- [Copilot `events.jsonl` resume issue #4098](https://github.com/github/copilot-cli/issues/4098)
