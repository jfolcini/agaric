# Session 1958 — Escape keeps a new block that holds only a `key:: value` line (#5448)

Pressing Escape on a new block whose only text was a `key:: value` line
deleted the block, not undoably. The property commit writes the block's text
only after `set_property` answers; meanwhile the focus change ran the
empty-block cleanup, which saw the old blank content and no property yet.
That hit both a refused value (the line should stay as text) and an accepted
one (the property is stored, the line stripped).

What shipped:

- `src/lib/unmount-flush.ts`: a per-block registry of saves that defer their
  text write past an IPC (the checkbox and property branches);
  `settlePendingSaves(blockId)` waits until none is pending. Each entry is
  released when its save settles.
- `src/lib/empty-block-cleanup.ts`: after the local guards and before the
  probes, the cleanup waits for the block's pending saves; its existing
  re-checks then decide on the settled state. A rejected wait keeps the
  block.
- `e2e/properties-table-and-refusals.spec.ts`: the pinned `test.fail` is now
  a normal test, with an accepted-value arm next to the refused one.
- `e2e-tauri/escape-property-line.e2e.ts`: a blank block is cleaned by the
  same sequence (control); a block holding only a property line keeps its
  property after a round trip.

Verified: red with the wait made fire-and-forget (4 vitest, 2 Playwright)
and with the registration removed (4 vitest), each on a copy, restored and
`cmp`-checked. Full vitest 20,810 passed (one order-dependent
`SearchPanel` failure outside this change passes alone); Playwright 15/15 on
the pinned and picker specs; typecheck (including e2e-tauri), oxlint and
oxfmt clean.
