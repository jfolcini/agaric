# Session 1960 — skip the e2e-tauri specs that need window focus (#5457)

The control case of `e2e-tauri/attachment-only-block-survives-blur.e2e.ts`
(#5412) failed on the first per-PR run after it merged: the blank control
block survived the click-away. The empty-block cleanup returns early when
`document.hasFocus()` is false (`src/lib/empty-block-cleanup.ts:218`), and in
the CI WebView under WebDriver on Xvfb it is. The control did its job: it
showed the spec's attachment case was passing without the cleanup ever
running. `e2e-tauri/escape-property-line.e2e.ts` (#5448) has the same shape.

Both `describe` blocks are skipped, pointing at #5457, which gives the lane a
focused window and makes the boot helper fail loudly without one. The vitest
and Rust arms of #5412 and #5448 still block merges.
