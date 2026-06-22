# Session 1001 — block gutter tighten (#1968)

Follow-up to the mobile-responsiveness work (session 1000 / #1966 / #1967). On a 2025
Pixel the block row wasted horizontal space: a fixed 68px gutter (stays 68px on touch) plus
an always-rendered chevron placeholder on childless blocks. Agreed redesign with @jfolcini
across three rounds of design Q&A.

## Shipped (#1968)

Replaced the fixed 68px gutter + reserved chevron placeholder with one tight, right-aligned
**control lane**:

- **Desktop:** reserves exactly two control slots (drag handle + chevron). The chevron is
  conditional (no placeholder); on a childless block the hover-revealed drag handle fills
  the text-adjacent slot via `justify-end`, so sibling text stays aligned with no empty gap.
- **Mobile (touch):** one 44px slot — the chevron (parent) or a small drag bullet (leaf),
  glyph hugging the text. This single control **is the drag activator**: long-press to
  reorder (dnd-kit 250ms touch sensor), tap the chevron to collapse/expand. The dedicated
  touch drag grip is gone (`BlockGutterControls` renders only the select checkbox on touch).
- **Multi-select** checkbox behavior unchanged (inserted only while a selection is active).
- Context menu still opens on long-press of the block text; `capturePreDragFocus` is
  mirrored onto the touch activator (#966); #1243/#1498/#1236 chevron behaviors preserved.

## Files

- `editor/SortableBlock.tsx` — new `.block-control-lane` (`min-w-12` desktop / `min-w-11`
  touch, `justify-end`); co-locates `BlockCollapseControl` with the drag handle; passes
  `attributes`/`listeners` to the chevron only on touch. Removed `GUTTER_WIDTH`.
- `editor/BlockInlineControls.tsx` — extracted `BlockCollapseControl` (conditional chevron /
  touch leaf-bullet / desktop-leaf-null + touch drag-activator wiring); `BlockInlineControls`
  now renders only the task marker.
- `editor/BlockGutterControls.tsx` — removed the touch drag grip.

## testid scheme

`collapse-toggle` is desktop-only in e2e and `drag-handle`-on-touch is used only by
`block-dnd-touch`, so the touch activator carries `data-testid="drag-handle"` while desktop
keeps `collapse-toggle` / `drag-handle` unchanged.

## Verification

- Unit: `editor/__tests__` + `mobile-a11y-216` → 1076 passed (tests updated for the new
  layout: lane width/gap, placeholder removed, `BlockCollapseControl` touch-activator +
  leaf-bullet).
- E2e: `block-dnd-touch/mouse/parent-child/multi-select`, `block-keyboard-select-collapse`,
  `gutter-control-clicks`, `mobile-editor`, `toolbar-and-blocks`, `journal-block-controls`
  → all green. `block-dnd-multi-select`'s `ctrlSelect` was clicking the block centre, which
  the tighter gutter shifted onto an inline link chip → re-targeted to the leading-text
  corner (test brittleness, not a product bug).
- `oxlint` + `oxfmt` + `tsc -b` clean.
