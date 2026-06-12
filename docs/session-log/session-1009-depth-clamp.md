# Session 1009 — Frontend MAX_BLOCK_DEPTH awareness (#928 findings 3+4)

Part of the overnight best-in-class UX pass (2026-06-11/12).

## Shipped

- **#928 — depth-aware projection + indent guard (2 of 7 findings).** The backend enforces a
  depth-20 limit in `move_block_inner`, but the frontend had no matching constant, so an
  over-deep drop/indent was reachable and only rejected *after* the IPC with an error toast.
  - Added `MAX_BLOCK_DEPTH = 20` to `tree-utils.ts`, mirroring the Rust
    `domain/block_ops.rs` value (0-based here → deepest legal depth `MAX_BLOCK_DEPTH - 1`).
  - `getProjection` now takes a `subtreeHeight` arg and clamps the offered depth (both the
    normal and end-sentinel branches) to `MAX_BLOCK_DEPTH - 1 - subtreeHeight`, so a drop is
    never projected to a depth whose dragged descendants would exceed the limit.
  - `useBlockDnD` computes the dragged subtree's height (max descendant depth − active depth)
    and threads it in.
  - `page-blocks.indent()` short-circuits (silent no-op, no IPC) when
    `prevSibling.depth + 1 + subtreeHeight > MAX_BLOCK_DEPTH - 1`, so the user gets a no-op
    instead of an error toast.

## Tests

`getProjection` leaf-clamp + subtree-height-clamp (deep 19-level chain), `indent()` depth
short-circuit (no `move_block` IPC), and the updated `useBlockDnD` call-arity assertion. 4525
tests in the touched areas green; `tsc -b` clean.

## Deferred (commented on #928)

The other five findings are test-coverage / conformance additions (cross-parent & multi-level
move fixtures, undo-move reprojection integration test, undo/redo-move e2e, reorder no-op
boundary test, FE/engine tail-slot parity) — valuable but lower-urgency and partly Rust-side;
left open on #928.
