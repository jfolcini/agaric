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
 * Positioning: pinned `fixed bottom-right`, lifted above the TabBar /
 * mobile chrome and clear of the iOS home indicator via
 * `safe-area-inset-bottom`.
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
      // Pinned bottom-right, above the TabBar / mobile chrome. The bottom
      // offset stacks a base gap on top of the iOS home-indicator inset so
      // the button clears both the home indicator and the bottom chrome.
      className="fixed right-4 z-40 size-14 rounded-full shadow-lg bottom-[calc(5rem+env(safe-area-inset-bottom))]"
    >
      <PenLine className="size-6" aria-hidden="true" />
    </Button>
  )
}
