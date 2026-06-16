# Session 1006 — persistent at-rest gutter cue for expanded parents (#1348)

`/loop /batch-issues` run (2026-06-16), one of a 3-issue parallel batch (#1322 Rust recovery,
#1348 this, #1351 docs).

## Shipped

- **#1348 — expanded parent block had no at-rest "has children" cue.** On fine pointers an
  expanded parent's zoom bullet was `opacity-0` at rest (revealed only on hover/focus), and the
  bullet halo was gated on `isCollapsed` only — so structure was invisible until hover. Fixed:
  the zoom bullet at-rest class in `BlockInlineControls.tsx` is now `hasChildren`-gated —
  `opacity-30` (a faint dot) for blocks WITH children on fine pointers (collapsed or expanded),
  firming to `opacity-100` on hover/focus/active via the existing interaction line; leaves
  (no children) keep `opacity-0` (hover-only); touch pointers keep the always-visible bullet
  (the whole at-rest expression stays gated on `!isTouch`). The chevron (#1243) and the
  collapsed halo cue are untouched.

## Precedent considered

#217-B2 previously added `opacity-30`-at-rest to the **drag handle** and it was deliberately
reverted (guard tests at `BlockGutterControls.test.tsx`, `SortableBlock.test.tsx`) because it
"painted a grip on *every* row." This change is materially different and does not violate that
precedent: the bullet's `opacity-30` is gated on `hasChildren`, so it appears only on **parent**
rows (the minority) as a structural cue — exactly what maintainer-authored #1348 requests — not
ambient chrome on every row.

## Tests

`BlockInlineControls.test.tsx`: expanded parent → bullet lacks `opacity-0`, has `opacity-30`,
retains hover-firm classes; collapsed parent → `opacity-30`; leaf → still `opacity-0`, no
`opacity-30`; `axe` clean. 92 tests green; `tsc` clean. Independent reviewer confirmed correct
gating (no regression to leaves/touch/chevron/collapsed) and discriminating tests.
