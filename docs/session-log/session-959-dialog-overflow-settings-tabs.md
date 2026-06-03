# Session 959 — Bug-report dialog horizontal overflow + settings tab polish

**Date:** 2026-06-03
**Scope:** Three user-reported UI fixes: (1) the Report-a-bug dialog body
overflowed to the right with no wrap or scroll, (2) the Settings tab bar
couldn't be scrolled with a mouse wheel, (3) the selected-tab underline was
thinner than the sidebar's active-item accent bar.

## Symptoms

Reported by the user (with screenshots):

1. In the Report-a-bug dialog, the form controls (title input, description
   textarea, preview) ran off the right edge of the dialog — no wrapping, no
   horizontal scrollbar.
2. The Settings tab strip ("Dashboard … Help") overflows horizontally but a
   plain mouse wheel (deltaY only) couldn't reach the off-screen tabs.
3. The red underline under the selected Settings tab was visibly thinner than
   the vertical accent bar on the left of the active sidebar item.

## Root cause

1. `src/components/ui/dialog.tsx` — `DialogBody` renders children inside a
   vertical-only `ScrollArea`. Radix's `ScrollArea` Viewport wraps its children
   in an inner `<div style="min-width:100%; display:table">`. `display:table`
   shrink-wraps to content width instead of being capped at the viewport, so
   wide content overflowed to the right; being a vertical-only scroller there
   was also no horizontal scrollbar. The `min-w-0` already on the body's own
   content div couldn't help because the offending `display:table` element is
   Radix's wrapper, one level above it.
2. `src/components/SettingsView.tsx` — the tab strip is a horizontal
   `ScrollArea`, but mouse wheels emit `deltaY`, which a horizontal scroller
   ignores by default. No `onWheel` translation existed.
3. `src/components/SettingsView.tsx` — the tab underline was `border-b-2`
   (2px), while the sidebar active item uses `border-l-[3px]` /
   `dark:border-l-4`.

## Fix

1. `viewportClassName="px-6 [&>div]:!block"` on `DialogBody`. Forcing the Radix
   wrapper to `display:block` (the `!` beats the non-important inline style)
   makes it honour the viewport width so children wrap normally. Fixes the
   latent issue for every dialog using `DialogBody`, not just bug-report.
2. Added an `onWheel` handler (via `viewportProps`) on the Settings tab
   `ScrollArea` that adds `deltaY` to `scrollLeft`, so a mouse wheel scrolls the
   strip horizontally.
3. Changed the tab underline to `border-b-[3px] dark:border-b-4`, mirroring the
   sidebar active-item bar's weight.

## Verification

- `tsc` clean.
- New e2e regression `body content does not overflow horizontally` in
  `e2e/bug-report-dialog.spec.ts` asserts `scrollWidth <= clientWidth` on the
  dialog body viewport. Both bug-report specs pass.
- `e2e/settings.spec.ts`: 7 pass / 0 fail (tab markup + viewportProps change).
