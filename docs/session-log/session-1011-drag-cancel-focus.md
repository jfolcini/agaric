# Session 1011 — Drag-cancel restores focus (#923 finding 1)

Part of the overnight best-in-class UX pass (2026-06-11/12).

## Shipped

- **#923 finding 1 — drag-cancel / no-op drop no longer strands focus.** `handleDragStart`
  clears the focused block (flush + `setFocused(null)`), but `handleDragCancel` only reset the
  DnD state and never restored focus, and `handleDragEnd`'s `!over` early-return left focus
  cleared too — so aborting a drag (Esc) or releasing over nothing dropped the user out of the
  block they were editing. Now `handleDragStart` captures the pre-drag focused block, and both
  the Esc-cancel and released-over-nothing paths restore it (a successful move still restores
  focus on the dragged block, as before). Like Notion/Logseq returning you to where you were.

## Tests

`handleDragCancel` restores the pre-drag focused block (and no-ops when nothing was focused);
existing DnD tests unchanged (the no-over / same-block no-restore tests use a null pre-drag
focus so they still hold). 48 tests in the suite green; `tsc -b` clean.

The other #923 findings (drop-indicator above/below distinction, ghost-row overlay, drag-layer
e2e, sub-threshold self-drop test) are deferred with a comment — visual-polish / e2e additions.
