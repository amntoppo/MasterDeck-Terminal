# Master starts sessions on demand (#126): plan

Design: [2026-10-16-master-start-design.md](2026-10-16-master-start-design.md). All tasks are in
commit a1551af.

Verify commands:
- Python: `PYTHONPATH=skills/master/lib python3 -m pytest skills/master/tests -q`
- App: `cd app && npm run typecheck && npm test`

1. **Spawn target fields** — `skills/master/lib/master/spawn.py`: `validate_worktree`, `assignMe`
   must be a bool, `command()` adds `--worktree <name>`. Test first: `test_start.py`
   `test_scratch_options_reach_the_spawn_command`, `test_bad_options_are_refused_before_anything_is_added`.
2. **Issue reads** — `collect.py`: `Live.issue`, `Live.sub_issues` (REST), fixture versions
   (`issues.json`, `sub_issues.json`). Test: the ticket tests in `test_start.py`.
3. **Pure helpers** — `start.py`: `scratch_name`, `unique_name`, `issue_from_api`,
   `subs_from_api`, `context_block`, `ticket_prompt`, `scratch_prompt`, `board_match`,
   `owner_problem`, `pending_assign`, `folder_warnings`, `describe`. Test: `StartHelpersTest`.
4. **`master start` from scratch** — `cli.py`: parser, `_plan_scratch`, `cmd_start`, `start` in
   `WRITE_CMDS`, `_is_write` with `--dry-run`. Tests: `test_scratch_*`, `test_needs_a_task_or_tickets`,
   `test_dry_run_adds_nothing_and_is_a_read`, `test_a_running_name_gets_a_suffix`.
5. **Tickets by reference** — `_issue_reader`, `_ticket_refs`, `_plan_ticket` (refusals,
   replacing a waiting ASSIGN). Tests: `test_ticket_start_is_an_assign_with_the_ticket_context`,
   `test_ticket_failures_are_reported_and_not_added`, `test_a_batch_adds_each_and_keeps_the_good_ones`,
   `test_the_sweeps_proposal_for_the_ticket_is_replaced`, `test_an_approved_proposal_for_the_ticket_refuses_the_start`.
6. **Tickets by board filter** — `_board_cards` (boards and boardless accounts), `--limit`.
   Tests: `test_board_filters_*`, `test_board_filter_limit`, `test_board_filter_with_no_match`.
7. **Start it now** — `--yes`: approve, spawn under one lock each, failures held and said;
   `_started` line with `claude attach`, also from `master spawn`. Tests: `test_yes_*`.
8. **App: parse and label** — `shared/types.ts`, `shared/derive.ts` (`assignMe`, `worktree`,
   `proposalLabel`), `shared/inbox.ts`, `Sidebar.tsx`, `deck.ts` (START colour). Tests:
   `derive.test.ts`.
9. **App: assign after link** — `main/boardFlow.ts` (`assignMe` dep, newest proposal of the name),
   `main/index.ts` (the dep), `main/sources.ts` (agents read when a start turns sent). Tests:
   `boardFlow.test.ts`.
10. **Docs** — `skills/master/SKILL.md`, `docs/ARCHITECTURE.md`, `docs/GUIDE.md`, `docs/TODO.md`,
    `CLAUDE.md`.
