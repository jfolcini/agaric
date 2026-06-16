# Session 1040 — audit fix #1267: stop drag re-rendering every block row

2026-06-16. From the 2026-06 Opus quality audit (performance). `/loop /batch-issues` run.

## Problem
`useBlockDnD`'s `handleDragMove` updates `offsetLeft` every pointer tick, so the
`projected` `useMemo` returns a fresh object reference each move. `BlockListRenderer`
forwarded `projected`/`activeId`/`overId`/`dropAfter` verbatim to every
`SortableBlockWrapper` in its `.map`, defeating the row-level `React.memo` on **all N
visible rows** every frame — even the (N−2) bystander rows recomputed and re-rendered.

## Fix (mirrors the #1067 viewport-store pattern)
- New `drag-state-store.ts` — a ref-backed store with **per-id subscription**, deriving a
  tiny referentially-stable per-row snapshot (`isActiveDragRow`, `projectedDepthOverride`,
  `showDropIndicator`, `dropAfter`, `dropIndicatorDepth`); idle rows share a singleton.
  `dropAfter`/`dropIndicatorDepth` are zeroed when the indicator is hidden so a bystander's
  snapshot never churns on a depth-only move.
- New `use-row-drag-state.ts` — `useSyncExternalStore` keyed on `block.id`, with a
  props-fallback when no provider is mounted (preserves the standalone/test contract).
- `SortableBlockWrapper` reads drag state via `useRowDragState(block.id)` (the 4 props are
  now optional fallbacks); `BlockListRenderer` creates the store, provides context,
  **applies state during render** (fresh data same-pass, no mount race) and **notifies
  changed rows in `useLayoutEffect`**. `SentinelDropZone` still gets the props directly.

A move that changes the over-row notifies only the prior + new over-row (and the active
row when its depth preview changes); all other rows keep an equal snapshot and stay
memoized. Drag/drop visuals unchanged.

## Verification
New `BlockListRendererDragRerender.test.tsx`: a bystander row does NOT re-render on an
over-row/depth change while the over-rows do (fails under the old verbatim-prop approach).
Reviewer verified snapshot completeness (old props ↔ new snapshot table), no render-loop /
tearing, and visual parity (the unchanged standalone `SortableBlockWrapper` tests exercise
the fallback path). Full frontend suite 12721 passed; tsc + oxlint clean.
