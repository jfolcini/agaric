# Session 4510 — callouts as tinted cards, tables in the code block's frame, one height for the references controls

Part of the #7040 UI review, item P4 (the maintainer's 2026-11-26 decision: keep all four defaults).

**What shipped**

- **Properties as a section header.** The page's Properties toggle reads "Properties 1", its count a metadata badge through `SectionCount`, like every other section header; with none it reads "Properties".
- **Callouts.** The note palette had no hue in the default light and dark themes, so a note read as a grey bar beside the quote's; `--alert-note*` now take hue 305 (violet, which no other style uses) in `:root`, `.dark` and both prefers-contrast blocks. The editor (the focused block and page mode) draws the style's icon as a mask before its name, as the static block already did, and paints it `CanvasText` under forced colours. The quote stays a plain bar. IntegrityCheckSection's "ids" chip, which uses the note tokens, turns violet with it.
- **Tables.** The static and the editor table take the code block's `rounded-md` corners and a frame in the border token, with inner rules at 60 %; header corner cells round with the frame so the fill stays inside.
- **One height for the references controls.** `ToggleGroup` gains a `size` variant; the kind toggle uses `sm` (28 px on a fine pointer, 36 on a coarse one, as the other controls paint). The source filter's trigger paints 36 on a phone with the rest of its 44 px from `touch-hit-area`. On a phone the advanced-filters row sits 8 px lower: at 4 px the 44 px targets overlapped, so a tap on the bottom of "All" landed on "Add filter".

**Left as they are**

- The mask glyphs are data URIs copied from lucide-react's icons for `CALLOUT_CONFIG`; a lucide redraw would leave the editor on the old glyph.
- The callout's icon and label padding are physical (`left`, `padding-left`), as the static callout's `border-l pl-4` is; no right-to-left locale ships.
- The solarized, Dracula and One Dark Pro themes keep their own near-grey note; the note still has its fill and icon there.
- The "1 reference" header keeps its wording; P4 didn't cover it.

**Tests**

- e2e (mock lane): new `page-editor-polish` — the Properties name and badge, the tinted callout and its icon in page mode (light and dark), the icon under forced colours, the table's corners and rules, the references controls at one height on desktop and phone with no overlapping targets. Each red on the old code with the predicted assertion.
- vitest: `theme-contrast` pins every callout label (the style's foreground on its fill, 4.5:1) in every theme, normal and high contrast; `PagePropertyTable`'s name and badge.
- Falsified one mutation at a time: the old header, a header without the badge, the grey note (light and dark), the missing mask, a light note label, each table without its corners, inner rules at full strength, the toggle without `sm`, the old coarse source trigger, the phone row without its gap, the forced-colours rule.
- **Edited to the new markup:** `properties-table-and-refusals` and `property-types-happy-paths` ("Properties (n)" → "Properties n"), `PagePropertyTable.test` (the name and the metadata badge), `usePageProperties.test` (the refetched header named "Properties 1"), the bridge spec `rename-invalidation` (it finds the header by `/^Properties \d/`, apart from the toolbar's Properties button), `SourcePageFilter.test` (the trigger's classes), `table-editor-styling` (a separate-borders table with a rounded frame and right rules, not `border-collapse`).
