## Session 955 — #290 editor drag dead-zone snap-to-grid shading (B4) (2026-06-02)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-02 |
| **Subagents** | orchestrator-only |
| **Items closed** | #290 |
| **Items modified** | #290 (split from #217 B4) |
| **Tests added** | +1 (frontend) |
| **Files touched** | 2 |

**Summary:** Shipped the parked #290 polish (split from #217 B4): faint indent-boundary
guides shown **only during a block drag**, so the 20px `DEAD_ZONE_PX` (the horizontal slop
before an indent level changes, in `tree-utils.getProjection`) reads as a deliberate
snap-to-grid and the indent width is legible. Frontend-only; no backend.

**Files touched:**
- `src/components/BlockListRenderer.tsx` (+~35) — a `DragIndentGuides` overlay component +
  a `maxDepth` memo. The `<ul>` is wrapped in a `relative` container; when `activeId !== null`
  (drag active) the overlay renders full-height vertical lines at each indent boundary
  (`calc(var(--indent-width) * level)`, levels `1..=maxDepth+1`), aligned to the same
  `--indent-width` that `SortableBlock` pads each depth by. Decorative: `aria-hidden`,
  `pointer-events-none`, painted behind the rows (`z-0`; the `<ul>` gets `relative z-10`).
- `src/components/__tests__/BlockListRenderer.test.tsx` (+~20) — guides absent without a
  drag; present with `activeId` set, one line per boundary (`maxDepth+1`), aria-hidden +
  pointer-events-none.

**Design decisions:**
- Sourced the "drag active" signal from the existing `activeId` prop (no new state) and the
  indent grid from `--indent-width` (responsive: 24/16/12px), so the guides stay aligned with
  block indentation and the drop indicator on every breakpoint.
- Container-level overlay (one element) rather than per-row shading — renders once, behind
  the rows, and never intercepts the drag (`pointer-events-none`).

**Verification:**
- `npx tsc` clean; `oxlint` clean for the changed files; `oxfmt --check` clean.
- `npx vitest run src/components/__tests__/BlockListRenderer.test.tsx` — 28 passed (incl. the
  new guide test).

**Commit plan:** single commit; pushed; PR against `main`; not merged. #290 closed as completed.
