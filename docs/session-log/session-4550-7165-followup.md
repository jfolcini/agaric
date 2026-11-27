# Session 4550 — #7165 round 3 follow-up: review notes on #7166, #7167, #7169, #7170

One batched follow-up for the non-blocking notes left on the merged round 3 PRs, and a survey of today's CI for flakes.

**Phone batch bar (#7167 review)**

- Premise held. `ul.block-tree` is `relative z-10`, a stacking context after the sticky batch bar (also z-10) in the DOM, so every row scrolled under the bar painted over it, gutter controls and chevrons included, and took its taps; `bg-background/95 backdrop-blur` let the rows read through.
- `BlockBatchActionMenu` is now `z-20` and `bg-background`. `batch-operations.spec.ts` "the batch bar paints over the rows scrolled under it" (Pixel 7) scrolls 30 headings under the bar and asserts every bar button is its own `elementFromPoint` at its centre, and that the background has no alpha. Red with z-10 (Clear was not the hit target) and red with `/95` (`oklab(… / 0.95)`).

**Cursor ring (#7167 review)**

- Premise held: the ring rode `group-focus/row`, so the last Ctrl+Clicked row and a bare phone drew it. `:focus-visible` does not hold, as the old comment said: Chromium does not count a Ctrl chord as keyboard use, so Ctrl+Space or Ctrl+Arrow after a click would move an unringed cursor.
- `syncPointerAttribute` (`src/lib/input-modality.ts`, called beside `syncTouchAttribute` in `main.tsx`) sets `<html data-pointer>` on a pointer press and clears it on any key press but a bare modifier. The `key-led` variant (`index.css`) requires no `data-pointer` and not `bare-touch`; the ring classes take it.
- `block-select-cursor.spec.ts`: "no ring after Ctrl+Click; a key rings the cursor" (ArrowDown, Ctrl+ArrowDown, Shift+ArrowUp) red without `key-led`; "a phone without a keyboard draws no ring" stubs `navigator.keyboard` (Chromium's phone emulation still reports a layout, which latches `data-keyboard`) and clears `data-pointer` itself, so only the bare-touch clause holds it; red with that clause removed. `input-modality.test.ts` red when Control no longer counts as a bare modifier.
- Edited old assertion: `batch-operations.spec.ts` "the cursor's focus ring wraps the block's row" read the ring right after two Ctrl+Clicks; it now presses Ctrl+ArrowUp first.

**Toasts over a desktop modal (#7169 review)**

- Premise held. The `index.css` rule now also gives the toaster pointer events while `body:has()` a `dialog-content` or `alert-dialog-content`. Sheets are left out, so a bottom toast over a phone's nav drawer still lets taps through (`android-phone.spec.ts`, the case session 4549 met; the brief's #6546 is that spec's tag, not the cause). `keepOpenOnToast` (`dialog-shared.ts`) is the guard `SheetContent` had inline, now shared with `DialogContent`; Radix's AlertDialog never dismisses on an outside press.
- `capture-deep-link.spec.ts` "its close button dismisses the toast and leaves the dialog open" (`@mock-only`, it injects the failure): red without the CSS (the toast stayed) and red without the dialog guard (the dialog closed). It waits for the toast's slide-in before measuring the button; the first draft did not and clicked the scrim mid-slide. `dialog.test.tsx` red without the guard.

**Graph (#7166 notes)**

- (a) `LocalGraphControl` sits beside the filter bar again, outside its `FeatureErrorBoundary`, in a wrapping row: the end of the actions row on the desktop (screenshots pixel-identical to before), its own row on a phone, as before #7166. Putting it beside the bar without wrapping squeezed the phone bar onto three rows; caught in the screenshots. `GraphView.localMode.test.tsx` "keeps the toggle when the filter bar crashes" red with the control back inside the boundary.
- (b) `GraphFilterBar` passes `trailing` only while a notice shows and loses its own `trailing` prop. `GraphFilterBar.test.tsx` red when the slot is always passed.
- Edited old assertion: `filter-bar-layout.spec.ts` measured Graph's trailing control against the bar's actions row inside `graph-filter-bar`; it now measures against `graph-tag-filter` and accepts the control on a row below the actions row.

**Phone nested chevron (#7167 note)**

- Premise false: `--block-gap` is 0.25rem, as is `max-sm:gap-x-1`; the chevron ends at the first glyph. The §6 test now pins the chevron icon's right edge to the first glyph within 1 px; red at 4 px with 0.25rem added to the offset.

**Flakes**

- None. Today's runs (291) hold no job that failed and then passed on a rerun. Three failures, none a flake: `advanced-query-group.spec.ts` on the bridge on main at `ddefca5`, already root-caused and fixed by `a3bdd95`; eight Due-panel bridge specs on `claude/7155-journal-day` at `30589269`, that branch's own bug, fixed by its next commits (`0cf9690e`, `0cf1e4ce`); e2e-tauri on #7171, which fails every time the lane runs: #7162 moved the journal day's Delete page into its Page actions menu and Overdue under a Due-panel tab, and two smoke specs still used the old UI.
- Fixed here at the orchestrator's request: `settings-desktop-integration.e2e.ts` opens the day's Page actions and picks Delete page from the menu; `sync-two-device.e2e.ts` "an overdue task the peer marks DONE leaves Overdue (#5256)" selects the Overdue tab (`due-panel-tab-overdue`) and reads the Due panel while it is selected. Each asserts what it did.

**Item 7, after #7173 (merged as `58e23a4`, merged into this branch)**

- `button.test.tsx` covers the `link` variant beside `ghost` in the compound variant that keeps a frameless icon button 44 px on touch; red for the three `link` sizes with `link` dropped from the variant. `items.test.ts` says its 44 px comes from the toolbar's buttons being ghost.
- #7173 bot notes: `control-heights.spec.ts`'s probe takes any CSS colour (`resolvedColor`) and the off-track grey uses it instead of repeating it; `switch.test.tsx`'s header loses one of its two blank lines.

**Verification**

- `npm run typecheck`, `just check-fe` (331 files, 8914 tests). The range touches `main.tsx`, so `just e2e-related` picks the whole lane, which is CI's; run locally were the specs touching toasts, dialogs, the graph bar, selection and rings.
- Screenshots, before and after, light and dark: Pixel 7 batch bar scrolled under (rows over and through the bar, a ring on a bare phone → clean opaque bar), desktop after Ctrl+Click (ring → none) and after Ctrl+ArrowUp (ring), Graph bar on desktop (identical) and phone (Focus on this page on its own row at the end, as before; "Showing 5 of 6 pages" now fits on the Add filter row).
