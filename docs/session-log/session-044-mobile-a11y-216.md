# Session 044 — Mobile & accessibility (#216 items A, B, C4)

**Date:** 2026-05-31
**Branch:** `batch-216-mobile-a11y`
**Issue:** #216 (Mobile & accessibility) — maintainer-decided items A, B, C4

## Summary

Shipped the three decided sub-items of #216. C1–C3 already landed in #279;
C5/C6 were skipped per the maintainer decision.

- **A — keyboard-aware inline popovers:** on coarse pointers the inline date
  editor (the agenda due-date chip in `BlockListItem`, which wraps
  `DateChipEditor`) and the add-property picker (`AddPropertyPopover`, used by
  both `BlockPropertyDrawer` and `PagePropertyTable`) now render as a bottom
  `Sheet` instead of an anchored `Popover`, so the on-screen keyboard can't
  cover the inputs. The desktop `Popover` path is unchanged. Coarse-pointer
  detection reuses the existing `useIsTouch()` hook
  (`window.matchMedia('(pointer: coarse)')`).
- **B — swipe & drag-handle a11y:** the swipeable block row (`SortableBlock`,
  where `useBlockSwipeActions` attaches its touch handlers) gains an
  `aria-description` of the swipe-to-delete gesture on coarse pointers; the
  drag handle (`BlockGutterControls`, both desktop and touch variants) gains
  `aria-keyshortcuts`. The naming tooltip wording was updated to
  "Reorder — Ctrl+Shift+↑/↓" via `block.reorderTip`. The resting low-opacity
  drag-handle visual is shared with #217 and left untouched.
- **C4 — colour-blind collapse cue:** the collapse chevron
  (`BlockInlineControls`, using `ChevronToggle`) previously signalled state by
  rotation only; it now also shows a faint background + ring when collapsed
  (`data-collapsed` exposed for testing).

## Changes

- `src/components/BlockListItem.tsx` — due-date chip editor in a bottom Sheet on touch.
- `src/components/AddPropertyPopover.tsx` — add-property picker in a bottom Sheet on touch.
- `src/components/SortableBlock.tsx` — swipe-row `aria-description` on touch.
- `src/components/BlockGutterControls.tsx` — drag-handle `aria-keyshortcuts` (both variants).
- `src/components/BlockInlineControls.tsx` — collapse-chevron colour-blind cue.
- `src/lib/i18n/block.ts` — `block.reorderTip` reworded; new `block.reorderKeyshortcuts`, `block.swipeRowDescription`.
- `src/components/__tests__/mobile-a11y-216.test.tsx` — new coverage (Sheet vs Popover, drag-handle aria, collapse cue, axe).
- `src/components/__tests__/SortableBlock.test.tsx` — added the swipe-row `aria-description` assertion (reuses the file's existing coarse-pointer + provider mocks).

## Testing

- `npx vitest run src/components/__tests__/mobile-a11y-216.test.tsx` — 9 passed
- `npx vitest run src/components` — 6055 passed (142 files), 0 failed
- `npx tsc -b --noEmit` — clean
- `npx oxlint <touched>` — clean (only the pre-existing `SortableBlockInner` complexity warning, unchanged from main)
- `npx oxfmt --check <touched>` — formatted

## Notes

- Item A needs a real-device soft-keyboard spot-check by the maintainer — CI
  cannot drive a soft keyboard.
- The task description named `DateChipEditor.tsx` for item A, but that file only
  defines the editor body; the inline `Popover` wrapper that needed the Sheet
  treatment lives in `BlockListItem`'s `DueDateChip` (the agenda date chip per
  `DateChipEditor`'s F-22 docstring). `AddPropertyPopover` owns its own
  trigger/surface, so the switch lives inside it.
