# Session 4058 — CI flakes of 2026-11-13: seven causes fixed, one filed

The maintainer asked for every CI flake to be fixed, because each one costs the PR queue a re-run. This session took the candidates on the handover issue (#6667), the axe audit #6553 left open, and what three days of failed runs showed (796 runs of `CI`, `e2e-tauri` and `Scheduled deep checks` from 2026-11-11, 119 failed job logs read). One PR, one commit per flake, each reproduced before it was touched.

## What was fixed

- **`e2e/page-mode-bubbles.spec.ts`, the image dialog cases: a product bug.** A toolbar button acts on `pointerdown`, and the image bubble's Open button opens the lightbox over itself, so the release and the click land on the dialog. Nothing cancelled the tooltip's pending hover timer (Radix does it on the click) or the press-and-hold timer (cancelled on the button's own `pointerup`), so the tooltip opened above the lightbox and took the Escape. Now a press on a tooltip trigger closes the tooltip and keeps it closed until the pointer leaves or focus arrives (`src/components/ui/tooltip.tsx`), and a hold ends on a release anywhere (`useLongPress`).
- **`e2e-tauri/trash-bulk-noncanonical-ids.e2e.ts`:** it rewrote `notes.db` from Node with no busy timeout while the app could hold the write lock.
- **`compute-content-delta-canonicalization.test.ts`, the 500-block ceiling:** it timed the wall clock, which under CPU contention measures the wait for a core. It now sums `process.cpuUsage()`.
- **`PageSourceToolbar.test.tsx` and its two sibling suites:** the first test of each file waited for the lazily imported `PageSourceBuffer` inside its 8 s `findByRole`. The suites import it with the file.
- **Every axe run (`runAxe` in `e2e/helpers.ts`):** it waits for the view pane to finish fading in. `closed-task-contrast` and `code-comment-contrast` had the #6636 race; the specs that only assert no violations passed without measuring anything while the pane was at opacity 0.
- **`e2e/page-mode-reveal.spec.ts`, the double click:** see the trap below.
- **`e2e-tauri/week-cross-day-clipboard.e2e.ts`:** it read today from the clock a second time, after adding its block; a run across midnight named the next day.

## Decisions and traps

- **Two wrong fixes for the tooltip before the right one.** A guard on "the trigger has left the document" passed a deterministic probe and then failed more often under load than the unfixed code. Two things explain it. Under load the hover timer fires in the 30 ms between the press and the bubble leaving the document. And refusing an open through the controlled `open` prop leaves Radix's `TooltipProvider` in its skip-delay state (its `onOpen` has run, its `onClose` never does), so the next tooltip opens with no delay at all. An event timeline from failing runs, not the snapshot Playwright saves 15 s later, showed both.
- **A tooltip mounted when a dialog opens can still take one Escape.** Radix's `DismissableLayer` attaches its Escape listener while a layer is the highest at its last render, and re-renders the others from a document event at default priority. For that tick the tooltip and the dialog both listen, the tooltip first. No person can press Escape that fast; a spec can. The bubbles spec waits for the closing tooltip to leave before it presses Escape.
- **The reveal double click passed only by outrunning the editor.** `page.mouse.dblclick` sends both presses 1 to 2 ms apart, before the first click's markers are drawn. A person's second press comes after: the word has moved right by the width of `**`, and near the word's start the pointer is on the marker, so nothing is selected. That is a product defect needing a design choice (#6694). The spec now sends the second press after the markers are drawn, on the word's last letter, where the selection works.
- **`performance.now()` in a unit test is a load meter.** The same call took 23 ms of CPU at every load and 22, 95 and 385 ms of wall time with 0, 16 and 64 busy processes on four cores.
- **Not reproduced, not patched:** the `JournalPage` calendar tests (120 of 120 twice under 64 busy processes, three more runs under 16, and one full-suite run under 12; no run or error text exists for the sighting on #6667). `e2e/list-style-keyboard.spec.ts`'s Backspace case (run 43186429184) passed 40 of 40 under load on `main`; its one red was on a PR that was changing the click code it uses.
- **Already fixed on `main` when this session looked:** `App.test.tsx` "defaults to Journal view" (#6600), `table-cell-link-backlink` (#6638), the Shift+Arrow and editor-keyboard specs (#6635, #6650), the bookmarks sort spec (#6644), page-link-drag (#6649), export-roundtrip (#6597).

## What ran

On a four-core cloud container, with the load each flake needed (busy-loop processes, a stretched timer, a delayed import):

- vitest: the full suite once under 12 busy processes with the first four commits (1097 files, 26,682 tests passed), and once more on the tree merged with `main`; the tooltip, `useLongPress`, content-delta and Edit as Markdown suites many times over while falsifying.
- `npm run typecheck`, `npm run lint`, `npm run typecheck:e2e-tauri`, `npx vitest run e2e-tauri`, `prek run --hook-stage manual --all-files`.
- Playwright on a bundle built from the branch: the five touched specs with `--repeat-each=10` (370 passed), all 18 specs that call axe (220), and the 38 specs that mention a tooltip or are named for a toolbar, bubble, gutter or touch (217). The whole lane is CI's: it takes about an hour here.
- Not run here: the real-backend lane (no `tauri-driver` in the container). The two `e2e-tauri` changes were type-checked, and the lane on the PR is their first run. No Rust changed.
