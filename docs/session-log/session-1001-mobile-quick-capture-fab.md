# Session 1001 — Mobile quick-capture FAB (#920)

Part of the overnight best-in-class UX pass (2026-06-11/12).

## Shipped

- **#920 — mobile quick-capture entry point.** QuickCaptureDialog was only openable
  via the OS global-shortcut chord (`useQuickCaptureShortcut`), which is a no-op on
  phones/touch tablets — leaving the headline feature unreachable there. Added
  `QuickCaptureFab` (`src/components/layout/QuickCaptureFab.tsx`): a primary, elevated,
  rounded floating action button pinned bottom-right, lifted above the TabBar and clear
  of the iOS home indicator (`bottom-[calc(5rem+env(safe-area-inset-bottom))]`,
  `z-40` so the dialog Sheet still covers it). Self-gates on `useShouldShowMobileChrome()`
  (renders nothing on desktop), reuses the SAME `setQuickCaptureOpen` setter the chord and
  dialog share (no parallel state), mounted in `App.tsx` inside a `FeatureErrorBoundary`.
  i18n `aria-label`, `data-testid="quick-capture-fab"`, `PenLine` icon.

## Tests

- `src/components/layout/__tests__/QuickCaptureFab.test.tsx` — 6 cases: renders when mobile
  chrome on, renders nothing when off, accessible labelled button, click opens once, no
  setter call when off, `axe(container)` clean. `npx vitest run src/components/layout` →
  139 passed; `npx tsc -b` clean.
