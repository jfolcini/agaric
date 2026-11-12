# Session 3859 — Phone toolbar: TODO keeps its slot, Indent and Outdent on the bar

Issue #6532, its first two checkboxes. On a phone the formatting toolbar folded *Toggle TODO state* into More while *Cycle priority*, *Undo* and *Redo* stayed, and there was no indent button at all.

## What changed

- `items.ts`: *Cycle priority* is 75, as the `toolbar-config` comment already said; at 80 it tied with the TODO toggle, and `computeOverflow` drops the later button on a tie, which was TODO.
- `createHistoryButtons(editor, touch)`: on touch *Undo* and *Redo* are 55, below the page link, tag and TODO (60–80). With a fine pointer they stay 100.
- `createIndentButtons(onIndent, onOutdent)`, priority 78: just below TODO, so a 360 px bar keeps TODO and Indent and folds Outdent into More; a 412 px bar keeps all three.
- `FormattingToolbar` takes an `indent` prop and adds the two buttons to the structure group only on touch (`useIsTouch`). Block mode passes the row's `BlockActions` `onIndent` / `onDedent` from `EditorSurface` (the swipe gesture's path, `handleIndentById`); page mode passes Tab's and Shift+Tab's commands (`indentBlocks` / `outdentBlocks`).

## Decisions and traps

- Not a new block-command-bus event: adding `INDENT_BLOCK` to `BLOCK_EVENTS` would change the key list `src/lib/__tests__/block-events.test.ts` pins exactly, and the props reach both editors without it.
- The `indent` object is a `useMemo` dependency in `FormattingToolbar`; the React Compiler (on in builds, off under Vitest) keeps the callers' inline objects stable. A ref plus `useLayoutEffect` instead trips oxlint's `react(refs)` rule inside `useMemo`.
- Page mode's touch bar also carries *Block actions* (85), so there Outdent sits under More at 412 px.
- *Edit as Markdown* is unchanged: its touch bar is a separate item list and already reaches Indent and Dedent through its block menu.
- `e2e/page-mode-touch.spec.ts` "on a narrow phone › Block actions under the toolbar's More…" now fails: at 320 px *Undo* and *Redo* no longer hold the slots, so *Block actions* sits on the bar rather than under More. The spec is an existing contract and was left unedited; it needs re-premising.

## Checks run

- `npx vitest run src/components/FormattingToolbar/__tests__/items.test.ts`: red first (5 failed: TODO dropped before Cycle priority at 355 px, before Undo on touch), then 11 passed; each priority mutation (cycle priority 80, touch Undo 100, indent 80, fine-pointer Undo 55) reddens its own assertions.
- `e2e/phone-toolbar.spec.ts` (Pixel 7 at 412 px, Galaxy S8 at 360 px, desktop): red first (TODO and Indent not found), then 5 passed. Falsified by a no-op block-mode indent (aria-level stays 1), a no-op page-mode indent (data-depth stays 0), dropping the touch gate (Indent on the desktop bar), and reverting the two slot priorities (TODO not on the bar).
- Related specs: `formatting-toolbar-mobile`, `block-line-break`, `page-mode-touch`, `phone-bottom-sheets`, `mobile-editor`, `toolbar-controls`: 67 passed, 1 failed (the `page-mode-touch` test above).
- Targeted vitest over the toolbar, page-mode toolbar, source-toolbar parity and i18n suites (46 files, 1402 tests) and `npm run typecheck`: green.
