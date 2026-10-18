# Left rail reorder (#170): plan

Design: [2026-10-18-rail-order-design.md](2026-10-18-rail-order-design.md).

1. `shared/railOrder.ts` + tests (TDD): default, clean, merge of new / unknown / hidden ids, marks
   out of order, `moveTo` (within and across groups, marks refuse), `moveStep` (skips hidden icons,
   crosses a mark, stops at the ends), `dropBefore`, `toSaved` / `isDefaultOrder`.
2. `Settings.railOrder` (default `[]`, cleaned in `normalizeSettings`) + settings tests (an old file
   reads as `[]`, junk is cleaned, the remote patch passes it).
3. `Rail.tsx`: render every item from `railOrder(saved)` with `data-rail` ids and marks, the
   separator rule, Record wrapped; local order state; pointer drag with threshold, capture, line,
   Esc, swallowed click; Alt+↑/↓ with focus kept; the context menu.
4. `App.tsx` wiring, `SettingsView` Rail icons row, CSS.
5. Check: typecheck, vitest, the web preview (`npm run dev:web`, `/?preview`) driven over CDP: a
   click still opens a view, a drag moves an icon across the gap, Esc cancels, Alt+↓, reset from
   the menu and from Settings; the isolated Electron app: the order kept after a restart.
6. Docs: GUIDE (rail section), ARCHITECTURE (rail), TODO (Recently done + open points), CLAUDE.md
   current state.
