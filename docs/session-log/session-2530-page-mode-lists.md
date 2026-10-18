# Session 2530

Page mode shows and edits bullet and numbered blocks. Slice 5 of #5743, after
the properties slice (#5822). A page holding a block with a `listStyle` now
opens in page mode, and the `- ` and `1. ` input rules, an item of #5743's
editing differences, are page mode's too.

**Design** (`src/editor/page-mode/page-lists.ts`):
- A block's list style stays its `listStyle` property. `PageLists` holds the
  styles the page's property read found (`readPageFit`, at open and on every
  reload page mode brings in), and the styles given since whose write has not
  settled. A style given shows at once, so the next key reads it, as block
  mode's optimistic marker does (#4552).
- The marker is block mode's: the `.list-marker` span with the
  `list-marker-glyph` text, plain DOM as `ListMarkerDecoration` draws it, in
  the `pageBlock` node view outside the editable text. Ordinals are
  `computeListOrdinals` over the document's flat run of blocks, now typed to
  read only ids and depths. A plugin view lays the run out again when the
  document changes, and only when its ids or depths changed. Only blocks whose
  marker text changed are told, so typing redraws no marker.
- The marker floats left of the text's first line. The text wraps under it,
  as block mode's inline marker does; the screenshots match block mode's to
  the eye, wrapped line included. A click on it passes through to that line
  (`pointer-events: none`): without that the caret did not move. An empty
  item's paragraph is a formatting context of its own, so its placeholder
  starts after the marker. Each block is one too (`display: flow-root`): with
  the 500 floats in the editor's one context, key to paint was 0.7 ms higher.
- The keys are a page-mode extension ahead of `PageKeys`:
  - Enter on a list block splits it with page mode's own split, and the block
    whose id is new takes the style. On an empty list block it takes the style
    off instead.
  - Backspace at a list block's start takes the style off, on the page's first
    block too, as block mode's does. The next Backspace joins.
  - An open picker keeps its keys.
- The input rules are block mode's two steps folded into one, on the text:
  `- `, `* ` or `+ ` (or `N. `) at the start of the block's first paragraph,
  then a character, a bullet's not `[`. The prefix leaves the text and the
  character stays. The stock list rules stay off: they make an in-block list,
  whose one-character unwrap in block mode replaces the paragraph's text after
  the caret.
- Each write goes through block mode's `setListStyle`, after the save on the
  save chain (`afterSave`, which now resolves when its step has run), so a new
  empty block is created first (`keep`). A refused write toasts block mode's
  message, and the block shows the style last read.
- A peer's style comes in with the reload's property read, outside the
  document and its undo.

**Undo, against block mode.** The style is a property, outside the document's
history, as the task toggle is. TipTap 3 inserts the typed character in its own
transaction before the rule's. So the first Ctrl+Z after `- a` gives `- a` back
as text, the next takes the typing back, and the style stays. Block mode's
first Ctrl+Z gives back its transient one-item list, also with the style kept.
Backspace right after the rule deletes the character (`undoable: false`); block
mode's Backspace gives back the one-item list. Both differences are in
`docs/features/editor.md`.

**Tests, each shown red first by a one-command mutation (backup, trap, `! cmp -s`):**
- vitest `PageModeEditor.test.tsx`, a `lists` describe:
  - Markers numbered by sibling runs, restarting after a plain block and at a
    depth, outside the text, and axe. Red twice: no ordinal (`1.` everywhere),
    and the marker inside the text.
  - `- a` and `1. b` set the styles and strip the prefixes, and the backend
    holds both. Red twice: the prefix kept, and no style set.
  - `- [ ] ` stays a task marker and becomes TODO. Red: the bullet rule taking
    `[`.
  - Enter continues the list into a new block and leaves it on the empty one;
    Enter splitting a block's text gives the new-id half the style. Red: no
    style on the new block (both tests), and the empty check gone (a fourth
    block).
  - Backspace takes the style off, the next joins, the first block leaves its
    list too. Red: the handler gone.
  - A refused write toasts and shows the backend's style. Red twice: no revert,
    and no toast.
  - Ctrl+Z gives the prefix back, then the typing, with the style kept. Red: a
    written style not kept as read (the Backspace test went red too: its second
    Backspace cleared again instead of joining).
  - A peer's set and cleared styles show on reload, outside undo. Red: no
    `take` in `bringIn`.
  - Typing, a save and two reloads make no marker mutation and keep the same
    nodes. Red: every marker told on each change.
- `page-mode-fit.test.ts`: list blocks are let in, their rows handed over. Red:
  the `listStyle` check back.
- The blocker tests in `PageModeEditor.test.tsx`, `PageEditor.test.tsx` and
  `page-mode-setting.spec.ts` now block on an attachment. Red: the attachments
  check off.
- fast-check (`page-mode.property.test.ts`): three steps, a list prefix typed
  at a block's start, Enter in a list block (and, half the time, at its end and
  again in the empty block it made), and Backspace at a list block's start.
  The existing Enter and Backspace steps go through the same keys. Each press
  is checked as it happens, then the backend's `listStyle` rows equal the
  document's styles, and each marker is block mode's for those rows over the
  document's blocks. Red five times: Enter not continuing (after 79 runs),
  Backspace keeping the style (6), the prefix setting none (12), clears never
  written (12), and Enter on an empty item splitting (29, once the end-and-again
  step was added; 132 before it).
- Playwright `page-mode.spec.ts`: a page of a bullet, a nested numbered list
  and a plain block opens in page mode with markers `• 1. 1. 2.`. The marker
  shares the text's baseline. `1. first`, Enter, `second`, Enter makes `3.`,
  whose placeholder starts after the marker, and Enter again leaves the list.
  The backend holds `ordered, ordered, none`; a click on a marker puts the
  caret in its block. Away, back, Page again: the same markers, and axe. Red
  four times: the click taken by the marker (caret stayed in block 7), the
  placeholder under the marker (418 against 438 px), the marker not floated
  (10 px left of the text), and every write clearing. 20 of 20 at 8 workers.
- e2e-tauri `page-mode-lists.e2e.ts`: a bullet set through the real IPC opens
  in page mode. Enter continues it, `1. first` turns the new block numbered,
  Enter, `second`, Enter, and Enter on the empty item leaves the list. The
  stored styles read `bullet, ordered, ordered, none` and stay after a round
  trip. Type-checked only; it runs in CI.

**The intermittent property failure.** A 4,000-run copy of the property found
it: the properties check reads `assignee` on a kept-as-new block. The steps
are a `key:: value` line typed, then a peer deleting the block, then a tag
typed into it later. The same counterexample, replayed through HEAD's property
file, fails the same way, so it predates this slice. 12,000 further runs found
only that class.

**Measurement.** `AGARIC_PERF=1 AGARIC_PERF_REPEATS=5 e2e/perf.spec.ts -g 'page
mode'`, sizes held to 500, unthrottled, median and band. The harness now gives
every block a list style too: runs of seven numbered, then three bullets. The
baseline is the same build with that seeding skipped, run in the same session:

| Measure | Block mode | Page mode, no lists | Page mode, lists | Lists, again |
| --- | --- | --- | --- | --- |
| Open | 58 [50–79] ms | 370 [351–372] ms | 373 [362–387] ms | 372 [366–390] ms |
| Worst frame while opening | 60 [51–78] ms | 70 [57–85] ms | 78 [62–86] ms | 75 [71–90] ms |
| Key to paint, p50 | 2.9 [2.8–3.2] ms | 5.3 [5.2–5.5] ms | 5.6 [5.5–5.9] ms | 5.7 [5.4–5.8] ms |
| Key to paint, p95 | 8.4 [8.2–10] ms | 7 [6.4–8] ms | 8.5 [6.4–9.3] ms | 7.9 [6.8–9.8] ms |

Lists cost about 0.3 ms of key to paint, the bands touching. With the markers
in the editor's one formatting context it was 6.0 [5.7–6.1] against
5.3 [5.3–5.4]; hidden markers measured 5.3, so the cost was their layout, not
the script. Layout containment instead of `flow-root` measured the same 5.6.
The opening frame stays within the band of the baseline and of the last
slice's 69 ms.

**Gates:** vitest over `src/editor src/stores src/components src/lib src/hooks
src/__tests__`, `npm run typecheck`, `npm run typecheck:e2e-tauri`, `npx vitest
run e2e-tauri`, `npm run lint`, and the page-mode, page-mode-setting,
list-style-keyboard, nested-list-blur, slash-commands, toolbar-structural and
references-sort Playwright specs on a private port.
