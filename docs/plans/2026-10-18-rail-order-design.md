# Left rail: drag icons to reorder them (#170): design

## Decisions

1. **One list, two fixed marks.** The order is one list of rail ids with two marks that never move:
   `separator` (between the views and the tools) and `spacer` (the flexible gap; the Remote
   indicator is drawn right after it). Icons move around them, so the rail keeps three groups
   (above the line, between the line and the gap, below the gap) and an icon can move into any of
   them. Default:
   `terminals board prs tasks | costs janitor notes meetings workflow schedules record ~ broadcast standup skills palette settings`.
2. **Stored in Settings** as `railOrder: string[]`. Empty means the default, and Reset writes `[]`,
   so a user who never moved anything follows later defaults exactly. `normalizeSettings` keeps only
   strings, without repeats, at most 64 (`cleanRailOrder`); ids this version does not know are kept
   in the file (a newer version's icon survives a downgrade) and skipped when drawing.
3. **What is drawn** (`railOrder(saved)`): the saved list without unknown ids; each default id that
   is missing (an icon added in a later version, or a mark) goes in after the id before it in the
   default, else first. If the marks come out of order (a hand-edited file) the default is used.
   Hidden icons (`screenOk` / `toolOk` / no Record on this platform) stay in the list and are only
   skipped when drawing, so they keep their place.
4. **The separator** is drawn when both groups above the gap have a shown icon (as today: no tools,
   no line).
5. **Dragging uses pointer events, not HTML5 drag and drop**: the drag starts after 4 px of
   movement, so a press without movement is a click; the rail captures the pointer; the dragged icon
   follows the pointer (`translateY`), the others stay put and an accent **drop line** shows where it
   lands (in the gap between two icons, or at the top of the spacer for the end of the middle
   group). The drop target is the first drawn entry (icon or mark) whose middle is below the
   pointer (`dropBefore`). A click that ends a drag is swallowed. **Esc** and a lost capture cancel.
   Icons are `-webkit-app-region: no-drag` already, so a drag that starts on an icon never moves
   the window; tooltips are hidden while dragging.
6. **Keyboard**: ⌥/Alt+↑/↓ on a focused icon moves it one step past the next drawn icon or mark
   (`moveStep`), so a press at a group's edge moves it into the next group. Focus stays on the icon.
7. **Reset**: right-click on the rail (not inside the Record popout or the remote card) opens a menu
   with **Reset icon order**; Settings → General has a **Rail icons** row with the same button
   (disabled while the order is the default).
8. **Saving**: the rail draws the new order at once (local state) and writes it with
   `setSettings`; the next state replaces the local one. An order equal to the default is saved as
   `[]`.
9. **The web app** shares the Mac's order (a browser may change it: `remoteSettings` passes it on,
   like the other settings). The phone's bottom bar is out of scope and unchanged.
10. Badges, dots and tooltips are children of the icon's button, so they move with it. Record is
    wrapped in a `data-rail="record"` element so its popout moves with it too.

## Code

- `shared/railOrder.ts`: `RAIL_DEFAULT`, `RAIL_SEP`, `RAIL_SPACER`, `cleanRailOrder`, `railOrder`,
  `moveTo`, `moveStep`, `dropBefore`, `toSaved`, `isDefaultOrder`; tests in `railOrder.test.ts`.
- `shared/settings.ts`: `railOrder` field, default `[]`.
- `renderer/.../Rail.tsx`: draw from the order, the pointer drag, the keyboard move, the menu.
- `renderer/src/App.tsx`: passes `state.settings.railOrder` and saves.
- `renderer/.../SettingsView.tsx`: General → Rail icons → Reset icon order.
- `styles.css`: `.rail.dragging`, `.rail-lift`, `.rail-drop`, `.menu.rail-menu`.
