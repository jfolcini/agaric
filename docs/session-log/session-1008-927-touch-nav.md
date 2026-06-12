# Session 1008 — #927 f3/f4/f6 (touch outline nav)

Three new touch-outline features.

- **#927 f3** (no tap-the-bullet zoom) — **NEW**: an always-present tappable zoom bullet on
  every block (leaves included) in `BlockInlineControls.tsx`; tap calls the existing
  `onZoomIn` (falls back to `useBlockActions().onZoomIn`), and a ring halo when collapsed so
  it doubles as the collapsed/has-children indicator. **Note: this adds a small visible dot
  to every block row on desktop too** (Logseq-style) — intentional per the finding, but a
  visible change worth eyeballing.
- **#927 f4** (indent/outdent buried; no swipe-to-indent) — **NEW**: `useBlockSwipeActions`
  gains `onIndent`/`onOutdent` with non-overlapping thresholds (right ≥60 → indent; short-left
  [60,110) → outdent; left ≥200 → delete, unchanged; reveal band shifts above outdent). Wiring
  to SortableBlock is left to the touch-dnd side; helper is backward-compatible.
- **#927 f6** (TabBar desktop-only; no mobile page-switch) — **NEW (low-risk reuse)**: removed
  the `isMobile → null` gate on the existing touch-friendly `QuickAccessBar` recents strip so
  mobile gets a reachable page-switch affordance (instead of adding a new bottom-nav).

Verification: `vitest` on all touched files (495) green; `tsc -b` clean. Desktop TabBar
untouched; the bullet is the only desktop-visible change.
