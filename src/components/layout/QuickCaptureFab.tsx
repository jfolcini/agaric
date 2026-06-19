/**
 * QuickCaptureFab — mobile entry point for quick-capture (#920).
 *
 * On desktop, QuickCaptureDialog is reachable only via the OS global
 * shortcut chord (`useQuickCaptureShortcut`). That chord is a no-op on
 * phones / touch tablets, leaving the headline quick-capture feature
 * completely unreachable on those devices. This floating action button
 * is the touch affordance: a primary-coloured, elevated, rounded button
 * pinned to the bottom-right that opens the same dialog.
 *
 * Gating mirrors the other touch-only entry points (`SearchSheetTrigger`):
 * it renders only when `useShouldShowMobileChrome()` is true (phone, or
 * tablet without a hardware keyboard) and renders nothing on desktop, so
 * it never subscribes / paints for keyboard-driven sessions.
 *
 * It reuses the SAME `setQuickCaptureOpen` setter that the chord and the
 * `QuickCaptureDialog` share (owned by `useAppDialogs`, threaded from
 * `App.tsx`) — no parallel open-state path.
 *
 * Positioning: pinned `fixed bottom-right`. There is no TabBar/bottom-nav
 * to clear on these viewports (it early-returns null), but the touch
 * FormattingToolbar IS a bottom-fixed surface: when a block is focused it
 * pins `fixed inset-x-0 bottom-0` (~47px tall, measured at the iPhone-13
 * viewport) and its right-aligned "More" overflow button lands in the same
 * bottom-right column as this FAB. At a ~1rem offset the size-14 FAB (z-40)
 * overlaps that toolbar (z-30) and swallows the "More" tap
 * (`formatting-toolbar-mobile` e2e). So the FAB sits a 5rem (80px) offset
 * above the edge — enough to clear the 47px toolbar with margin — stacked
 * on the iOS home-indicator inset via `safe-area-inset-bottom`. (This
 * restores the offset #1747 removed: it was never reserving space for a
 * non-existent TabBar, it was clearing the FormattingToolbar.)
 */

import { PenLine } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useShouldShowMobileChrome } from '@/hooks/useShouldShowMobileChrome'

export function QuickCaptureFab({
  setQuickCaptureOpen,
}: {
  setQuickCaptureOpen: (open: boolean) => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const shouldShowMobileChrome = useShouldShowMobileChrome()

  // Desktop (or tablet-with-keyboard) sessions use the OS chord — no FAB.
  if (!shouldShowMobileChrome) return null

  return (
    <Button
      variant="default"
      size="icon-lg"
      data-testid="quick-capture-fab"
      aria-label={t('quickCapture.fabLabel')}
      onClick={() => setQuickCaptureOpen(true)}
      // Pinned bottom-right. The 5rem (80px) offset clears the bottom-fixed
      // touch FormattingToolbar (~47px) so the FAB never overlaps its
      // right-aligned "More" button, stacked on the iOS home-indicator inset.
      className="fixed right-4 z-40 size-14 rounded-full shadow-(--shadow-overlay) bottom-[calc(5rem+env(safe-area-inset-bottom))]"
    >
      <PenLine className="size-6" aria-hidden="true" />
    </Button>
  )
}
