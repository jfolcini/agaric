# Session 2883 — the block-focus helpers wait for the editor's own focus to settle

`e2e/background-tabs.spec.ts` › "Alt+Enter with the caret right after a link in a block follows it" failed in CI on #6068, #6075 and #6078. `md-reveal-chip-marker` received no `[[` `]]` within 15 s. Each time, CI's stop-after jobs then cancelled the run's real-backend shards, so `e2e-tauri-gate` went red too.

**Cause, a race in the helpers, not the app.**
- `focusBlock` and `focusBlockById` (`e2e/helpers.ts`) returned the editor before its own focus sequence had run.
- The mount focuses the editor one frame later: `mount()` in `src/editor/use-roving-editor.ts` → TipTap's delayed `focus` → `requestAnimationFrame` → `view.focus()`.
- ProseMirror's focus handler (`handlers.focus`, `prosemirror-view`) then arms a 20 ms timer. The timer writes ProseMirror's selection back over the DOM's.
- Chrome holds `selectionchange` back while keys stream in, so ProseMirror never reads the arrow keys' moves as they happen.
- On a loaded runner the timer fires mid-stream and undoes the arrows sent so far. The caret lands a few characters right of the link, where no syntax is drawn.

A user would have to press an arrow within about a frame plus 20 ms of the click, so the app is unchanged.

**Fix.** The two helpers share `editBlock`. After the click and `editor.focus()`, it waits for `requestAnimationFrame(() => setTimeout(resolve, 20))`. The frame callback runs after the mount's, and a 20 ms timer queued inside it runs after ProseMirror's. This is the `caret` helper's technique (`e2e/page-mode.spec.ts`) plus the frame hop. It is in the shared helper because about 35 call sites press caret keys straight after it.

**Shown red,** with rAF callbacks delayed after the click by an init script, swapping `e2e/helpers.ts` inside one trap-restoring command:
- **Builder:** origin/main's helpers failed 11 of 178 runs; the fixed helpers failed 0 of 90.
- **Reviewer, re-run with a 30 ms delay:** main's helpers failed 16 of 30, the fixed helpers 0 of 30.
- **Control, at a 100 ms delay:** a bare `setTimeout(20)` failed 9 of 30, and the frame-then-timer wait failed 0 of 30.

**Suites run:**
- The real Alt+Enter describe block, repeated 30 times: 180 of 180 passed.
- Every spec using the two helpers, 797 tests: 787 passed and 7 were skipped.

The 4 failures fail the same way with main's helpers in this container: `block-line-break.spec.ts:292` on iPhone 13, and `diagram-legibility.spec.ts:144` and `:380`. They pass in CI's shard 1 on main (run 39861004847: 374 passed, 0 skipped).
