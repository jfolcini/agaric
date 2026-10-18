# Session 2541 — a mouse press holds the edited block until it ends

#5807, option 2, which also fixes item 2 of #5723. On desktop the first click
on a control below an edited block was lost. Examples are the References
controls, the journal Due header, and a link or tag chip in the block below.
The press blurred the editor, and the formatting toolbar in the flow above the
text unmounted. Everything below moved up before the release, so the release
landed elsewhere. Reproduced first on the mock in Chromium. The chips, *Page
links*, *Filter by source page*, both reference headers and the Due header all
lost the click. *Add filter* still had its guard from #5808.

**Changed:** `useEditorBlur`. A primary mouse or pen press that blurs the
editor still saves at once, from the live doc, and rebases the baseline with
`markCommitted`. The `unmount()` and the `setFocused(null)` that swap the block
to static wait until the press ends. `unmount()` could not run on the blur,
because it empties the doc on screen.

- **How a press ends:** `pointerup` (a release outside the window included),
  `pointercancel`, `dragstart`, `contextmenu`, or the window's `blur`. The swap
  then runs one task later.
- **Stale guards:** the hold also ends as soon as focus leaves the block. From
  then on, whatever moved the focus owns it, even when it gives the focus back
  to this block with a new editor. On that early end, the hold unmounts an
  editor still on its block and leaves the focus alone. A block that unmounts
  mid-press swaps at once, and only once.
- **Unchanged:** keys (Tab, Escape) and touch. A tap blurs only after its
  release, so it never holds.

**Why one task later:** a probe in Chromium ran the swap synchronously inside
`pointerup` instead. The chip had already moved by the toolbar's height when
`mouseup` and `click` fired, and the click still landed. Chromium hit-tests the
release once, before it dispatches `pointerup`. WebKit's
`handleMouseReleaseEvent` should behave the same way: one hit test, then
pointerup, mouseup and click in one call. So the issue's premise that a
`pointerup` swap still loses the click is false in Chromium. The later task was
kept so the release's handlers see the layout and focus the press saw, which is
what the per-control guards gave them. A vitest pins that choice.

**Guards:**
- **Deleted:** *Add filter* (`BacklinkFilterBuilder.tsx`), and the vitest that
  pinned it. It existed only for this click.
- **Kept:** `AddBlockButton`. A tap is not held, and `handleAddBlock` reads
  which blank block is focused.
- **Kept:** `keepEditorUntilClick` in `EditableBlock`. It also governs touch
  taps, which #5723 item 1 owns.
- **Kept:** the Search controls (#5803). They guard the search input's blur,
  not the editor's.
- **Kept:** the gutter, inline-chip, property-chip, image, math, Mermaid and
  block-ref-peek guards. They keep the editor focused on purpose.

`e2e/AGENTS.md`'s pattern line now says this.

**Specs:**
- `references-add-filter-click.spec.ts` covers the five References controls,
  and a mobile tap on *Add filter*.
- `editor-lifecycle.spec.ts` covers:
  - the link and tag chip below the edited block;
  - Tab leaving at once;
  - a drag-select from inside the editor that ends outside it;
  - a press released outside the window;
  - a click into another journal day's block, after which typing lands there.
- `journal-panels.spec.ts` covers the Due header.
- The e2e-tauri twin is `chip-below-edited-block.e2e.ts`. It was type-checked
  only, since this machine cannot run that lane.

**Shown red:**
- Never holding fails every landing assertion. The mobile tap, Tab and
  drag-select tests stay green.
- `pointerup` not ending the press fails the release-outside test, the
  drag-select test at its Tab, and a control test at the static block.
- Holding on every blur fails the Tab test.
- Putting the touch toolbar in the flow fails the mobile tap.
- Fifteen mutations of the hook each fail their vitest.

**Ran:**
- vitest over `src/hooks`, `src/editor` and `src/components`. One unrelated
  failure, `QrScanner` focus, passes alone; it is a load flake.
- The touched specs, `search*`, and the references, unlinked and
  journal-panels specs.
- A sweep of every spec that opens a block editor. One placeholder-row flake
  (`diagram-legibility`, on its first focus click) passes 5 of 5 alone.
- `npm run typecheck`, `typecheck:e2e`, `typecheck:e2e-tauri`, `lint`, and
  `npx vitest run e2e-tauri`.

**Found in a second pass:** a cancelled handle drag lost its focus restore
(#923). The handle press blurred the edited block and the hold registered its
swap. `handleDragStart` then flushed the editor and cleared focus, and Escape
gave focus back to a new editor. The release's swap then closed that editor,
because the re-focus check only looked inside the old, detached wrapper. Ending
the hold when focus leaves the block fixes it. A vitest and a new
`block-dnd-mouse.spec.ts` test pin it, and both go red without the focus watch.
That test replaces the spec's NOTE, which said the restore could not hold with
a real pointer. It already held through the #966 snapshot before this change.

**Comments made true:**
- `focusBlockById` no longer advises Escape before moving between trees.
- The Escape step in `e2e-tauri/references-status-priority-filters.e2e.ts` is
  gone. It existed only to dodge the lost *Add filter* click. That spec was
  type-checked only.
- The `AddBlockButton` comment gives its remaining reason: a tap's blur is not
  held. Without the guard, a tap while an empty block is edited drops that
  block, adds none, and leaves no editor.
- The `keepEditorUntilClick` comment says what it still does. The click lands
  without it: the desktop and touch move tests passed 3 of 3 without its
  `preventDefault`.
- The #966 notes in `use-block-dnd.ts`, `pre-drag-focus.ts` and
  `BlockGutterControls.tsx`: the live editor now names the focus at
  `handleDragStart`, and the snapshot covers a press whose blur already
  cleared it.

**Review (requested changes):**
- **B1:** the held save compared the doc only with `originalMarkdown`. A block
  read as typed (#5834, the line an Enter split off) classifies against a
  placeholder, so a doc equal to it was dropped. The deferred `unmount()`
  found the change, and the release ignored it. The held save now compares as
  `unmount()` does: the stored text first, then `originalMarkdown`. A vitest
  and a `block-line-break.spec.ts` case (a press on the References header)
  are red without the fix.
- The in-place refocus check in the release had no flow that reaches it, and
  is deleted.
- `dragstart` stays. A WebKitGTK 2.52 probe (XTest under Xvfb) saw a native
  link drag end with `dragstart` and `dragend` only, with no `pointercancel`
  or `pointerup`. A plain click there fired `pointerup`, `mouseup` and
  `click`.
- A vitest pins that the focus watch stops when the hold ends.
- A touch test in `journal-add-block-while-editing.spec.ts` pins the
  *Add block* guard: without it, the tap leaves no editor.
- The `#1498` comments on the inline controls and property chips say their
  purpose: they keep the editor and its caret focused. The spec's docstring
  is true again.
