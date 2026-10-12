# Terminal links (#119): design

## Goal

⌘-click (Ctrl-click off a Mac) on an `http://` or `https://` address in a session terminal opens it
in the default browser: plain addresses (localhost, `127.0.0.1`, IP with ports, paths, queries),
addresses that wrap across rows, and OSC 8 links. Underline and pointer while the key is held; a
plain click still selects. Only http/https. Desktop and web app.

## Approaches considered

1. **`@xterm/addon-web-links`.** Ready-made, but reads one row at a time with its own regex and
   always underlines on hover; it would sit beside the path provider and the two would overlap
   (a path inside an address). Rejected.
2. **Widen `openExternal` to http.** One channel, but `openExternal` is https only on purpose
   (Markdown links, notes: text that may come from a session). Rejected.
3. **Chosen: one link provider for addresses and paths, and a new `openLink` call.** The provider
   in `TerminalView.tsx` reads the whole logical line (wrapped rows joined) through its cells,
   finds addresses (`findUrls`) and then paths that are not inside an address (`findPaths`), and
   maps text offsets back to cells (`cellRange`), so wraps and wide characters are handled for both.
   OSC 8 links go through xterm's `linkHandler`, which already drops non-http schemes.

## Pieces

- `shared/termLinks.ts`: `findUrls(text)` (offsets; drops trailing `.,;:!?*` and a closing bracket
  the address did not open; stops at spaces, quotes, angle brackets, control characters, box
  drawing), `isWebLink(url)` (http/https, a host, no whitespace or control characters, ≤ 2048).
- `renderer/src/termText.ts`: `logicalLine(buffer, y)` (≤ 40 rows, one cell per UTF-16 unit) and
  `cellRange(line, start, end)`.
- `deck.openLink(url)`, channel `app:openLink`, `DECK_ACCESS` `local`: main checks `isWebLink`
  then `shell.openExternal`; the web app checks `isWebLink` then `window.open(…, 'noopener,noreferrer')`.
- Modifier: tracked from mouse moves and window key events (capture), cleared on blur; the hovered
  link's decorations are set to follow it (xterm swaps in its own decorations object after hover,
  so it is set again in a microtask).

## Limits

- OSC 8 links are underlined on hover by xterm whatever the key (its decorations are not ours).
- In the web app a `localhost` address is the browser's machine, not the Mac's.
- A phone has no modifier key, so nothing opens there.
