# Session 3009 — Returning from Edit as Markdown shows the saved page (#5691)

Set out to fix a lost edit found by the three-modes code review (#5691, PR-0).

**The bug, on main:**
1. Type in page mode.
2. Open Edit as Markdown from the kebab.
3. Cancel, or Save with nothing changed.
4. Page mode reopens on the page store as it was before the switch, so the next keystroke writes that stale text back over the edit from step 1.

A block made during the session was also missing, and one deleted came back. The cause: `PageEditor.handleEditSource` flushes through `afterFlush` and swaps the surface without the store reload that `changeMode('blocks')` and `onBlocked` do. `PageModeEditor` only loads the store when it is empty.

**Shipped.** One file, `use-page-mode.ts`, so the rule "save, reload, swap" lives in one place.
- `afterFlush` now runs in `changeMode('blocks')`'s order: save, reload the store, retake the cursor, then swap. It still swaps nothing if the save failed.
- `opening` is reset during render when the page changes, using React's "store information from previous renders" pattern. Going page A → B → A had put the caret back where A's earlier switch first opened, and taken the focus.

**Decisions:**
- **F2 is narrowed.** From the kebab, the document has already lost the focus before Markdown opens, so no caret is restored. After Cancel the focus stays on the kebab, as block mode's `handleCloseSource` leaves it, and the scroll position is kept.
- **One existing test** (`PageEditor.test.tsx`, "saves page mode's text before Edit as Markdown loads the page") gained a `load_page_subtree` stub for the new reload. Under the red-first rule, the reviewer decided it is setup only: every assertion passed unchanged, and the test-setup afterEach that rejects unstubbed commands was the only failure.
- **Left alone:** a reload that fails after a successful save still swaps, so page mode would reopen on the old store. It is rare and visible through a retry toast.

**Suites:**
- vitest over `src/components/pages`, `src/editor/page-mode` and `src/components/journal` (2026 tests);
- typecheck and lint;
- Playwright: `page-mode.spec.ts` (43), `page-source-edit`, `journal-page-mode` and `page-kebab` (29).

The new `e2e-tauri/page-mode-markdown-return.e2e.ts` type-checks, but could not run here because there is no Tauri binary; the real-backend lane runs it.
