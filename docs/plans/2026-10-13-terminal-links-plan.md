# Terminal links (#119): plan

Design: [2026-10-13-terminal-links-design.md](2026-10-13-terminal-links-design.md). All commands
from `app/`.

1. **Find addresses.** `src/shared/termLinks.ts` (`findUrls`, `isWebLink`). Test first:
   `src/shared/termLinks.test.ts` (localhost / IP / IPv6 with ports, paths, queries; offsets;
   trailing punctuation and brackets; a TUI border; other schemes refused; long and spaced
   addresses refused). Verify: `npx vitest run src/shared/termLinks.test.ts`.
2. **Read a wrapped line through its cells.** `src/renderer/src/termText.ts` (`logicalLine`,
   `cellRange`). Test first: `src/renderer/src/termText.test.ts` with `@xterm/headless` (a wrapped
   address maps to both rows from either row; wide characters before an address). Verify:
   `npx vitest run src/renderer/src/termText.test.ts`.
3. **`openLink` call.** `CH.openLink` and `DeckApi.openLink` (`src/shared/ipc.ts`), `DECK_ACCESS`
   `local` (`src/shared/remoteDeck.ts`), preload, main handler with `isWebLink`
   (`src/main/index.ts`), the web's local `window.open` (`src/web/remoteDeck.ts`), the preview stub.
   Test first: `src/web/remoteDeck.test.ts` ("openLink opens http and https only, locally").
   Verify: `npx vitest run src/web/remoteDeck.test.ts src/shared/remoteDeck.test.ts`.
4. **Link provider and OSC 8.** `src/renderer/src/components/TerminalView.tsx`: one provider for
   addresses and paths over `logicalLine`, decorations following the modifier, `linkHandler` for
   OSC 8. Verify: `npm run typecheck`, then the isolated app over CDP (hover with / without ⌘, ⌘
   down and up, plain click, ⌘-click on a plain, wrapped and OSC 8 link, a `file:` OSC 8 link).
5. **Docs.** GUIDE (Terminal), ARCHITECTURE (session tabs section), TODO (open points, Recently
   done, the #113 wide-character item removed), CLAUDE.md (Where things live, Current state).
6. **Full check.** `npm run typecheck` and `npm test` (no lint script in this project).
