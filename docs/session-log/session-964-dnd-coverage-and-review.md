# Session 964 — Drag-and-drop: exhaustive test coverage + UX/engineering review

**Date:** 2026-06-04
**Scope:** Audit and test the block drag-and-drop + keyboard-move feature
("it doesn't work well"). Unit + e2e coverage for mouse and keyboard, plus a
UX/engineering review. No product code changed in this session — tests + doc
only; fixes are tracked as follow-up issues.

## What prompted it

User report that block drag-and-drop "doesn't work well." A grounding
investigation (faithful backend model in a throwaway test) confirmed the
feature has **four correctness bugs**, all from one design flaw.

## Root cause (verified in `src-tauri`)

Blocks use a **gapless 1-based integer `position`** per parent:

- new blocks are created at `MAX(position)+1` — consecutive, no gaps
  (`commands/blocks/crud.rs`).
- `move_block` does a bare `UPDATE blocks SET parent_id=?, position=?` with **no
  sibling renumbering**, and **rejects `position <= 0`**
  (`commands/blocks/move_ops.rs`).
- `list` orders siblings by `position ASC, id ASC` — equal positions tie-break
  by **ULID (creation order), not drop intent** (`commands/blocks/queries.rs`).

So the frontend hands the backend either a **colliding** integer (→ wrong place
via ULID) or a **non-positive** one (→ rejected with an error toast).

## The four bugs (each locked in by a passing test)

1. **Downward drag off-by-one** — dragging down onto the adjacent sibling
   computes the block's own position → no-op (`computePosition` receives the raw
   over-index; `useBlockDnD.handleDragEnd`).
2. **Upward-drag collision** — dragging up between siblings returns the target's
   exact position → lands in the wrong place / no-ops.
3. **Drop / move to TOP rejected** — `firstPos - 1 = 0` → backend rejects.
   Breaks the everyday "move 2nd block above the 1st" (drag and `Ctrl+Shift+↑`).
4. **Nest as first child rejected** — same `0` rejection nesting before an
   existing child.

Also found: a likely-dead optimistic `reorder()` splice path (every pointer drag
routes through `moveToParent` → full `load()` refetch), and an a11y bug where
keyboard moves announce success *before* the move promise resolves.

## Testing-gap risk

The web/Tauri **mock is more permissive than the real backend** — it accepts
`position <= 0` (`tauri-mock/handlers.ts` `move_block`) and sorts by position
only with no id tiebreak (`list_blocks`). So these bugs are partly **hidden**
from mock-based e2e at the visual layer. New e2e specs therefore assert the
recorded `move_block` IPC payloads as the primary, deterministic signal.

## Added tests (all green)

- `src/lib/__tests__/dnd-pipeline.test.ts` (new, 14) — drop pipeline
  (`getProjection` + `computePosition`) against a faithful backend model. Each
  bug encoded as a passing `it.fails(...)` (asserts the *desired* outcome) plus
  a characterization `it(...)` (locks in today's behaviour). When a bug is fixed
  the `it.fails` flips red → delete it.
- `src/stores/__tests__/page-blocks.test.ts` (+6) — position-safety invariant
  markers for `moveUp` / `moveDown` / `reorder` / `dedent`.
- `e2e/block-keyboard-move.spec.ts` (new, 7) — indent/dedent/move-up/down,
  boundaries, subtree integrity. IPC-payload assertions.
- `e2e/block-dnd-mouse.spec.ts` (new, 5) — reorder, off-by-one, drag-to-indent,
  no-op, and a `test.fail()` desired-swap marker.
- `e2e/helpers.ts` — new `dragBlockWithOffset` helper (indent/dedent via
  horizontal drag).

## Review doc

`docs/dnd-ux-review.md` — four bugs with fixes, three position-scheme options
with op-log/sync tradeoffs, interaction/visual/a11y review, testing-gap section,
and a P0–P2 recommendations table (R1–R9). Fixes tracked as follow-up issues.

## Verification

- `vitest run` (touched + related): 204/204.
- `playwright test` (new specs): keyboard 7/7, mouse 5/5; existing dnd/org
  e2e unaffected.
- `tsc -b` clean; `oxlint` clean.
