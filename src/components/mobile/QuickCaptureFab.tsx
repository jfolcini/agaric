/**
 * QuickCaptureFab — mobile entry point for quick-capture (#920).
 *
 * On desktop, QuickCaptureDialog is reachable only via the OS global
 * shortcut chord (`useQuickCaptureShortcut`). That chord is a no-op on
 * phones / touch tablets, leaving the headline quick-capture feature
 * completely unreachable on those devices. This floating action button
 * is the touch affordance: a brand-red, elevated, rounded button pinned
 * to the bottom-right that opens the same dialog.
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
 * Behaviour (Material's extended FAB): it hides while an editing toolbar is
 * pinned to the bottom edge (a block or *Edit as Markdown* being edited on
 * touch, `pinned-toolbar.ts`) and while the user scrolls down, and returns on a
 * scroll up, so it never sits on the control under it mid-scroll. That frees it
 * to sit 1rem from the bottom,
 * stacked on the bottom safe-area inset via `var(--safe-area-bottom)` (see
 * `index.css` — every consumer reads the variable, never `env()` directly).
 */

import { PenLine } from 'lucide-react'
import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { usePinnedToolbarShown } from '@/components/FormattingToolbar/pinned-toolbar'
import { Button } from '@/components/ui/button'
import { useShouldShowMobileChrome } from '@/hooks/useShouldShowMobileChrome'
import { cn } from '@/lib/utils'

/** Scroll travel (px) that counts as a direction, so jitter does not flicker it. */
const SCROLL_SLOP = 8

/** False after a scroll down in the view's content, true after a scroll up or at the top. */
function useScrolledUp(enabled: boolean): boolean {
  const [up, setUp] = useState(true)
  useEffect(() => {
    if (!enabled) return
    const last = new WeakMap<EventTarget, number>()
    const onScroll = (e: Event) => {
      // A popup's own list (a Select scrolling to its chosen option) is not the
      // user reading down the screen, so only the view's content counts.
      const el = e.target
      if (!(el instanceof Element) || !el.closest('#main-content')) return
      const top = el.scrollTop
      const prev = last.get(el) ?? 0
      if (top <= 0) setUp(true)
      else if (Math.abs(top - prev) < SCROLL_SLOP) return
      else setUp(top < prev)
      last.set(el, top)
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', onScroll, { capture: true })
  }, [enabled])
  return up
}

export function QuickCaptureFab({
  setQuickCaptureOpen,
}: {
  setQuickCaptureOpen: (open: boolean) => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const shouldShowMobileChrome = useShouldShowMobileChrome()
  const toolbarPinned = usePinnedToolbarShown()
  const scrolledUp = useScrolledUp(shouldShowMobileChrome)
  const shown = scrolledUp && !toolbarPinned

  // Desktop (or tablet-with-keyboard) sessions use the OS chord — no FAB.
  if (!shouldShowMobileChrome) return null

  return (
    <Button
      variant="default"
      // No size variant: each one sets a coarse-pointer 44 px that beats `size-14`.
      size={null}
      data-testid="quick-capture-fab"
      data-shown={shown}
      aria-label={t('quickCapture.fabLabel')}
      onClick={() => setQuickCaptureOpen(true)}
      // Brand red: one of the two marks that wear it (#5332). `invisible` takes
      // a hidden FAB out of the tab order and the accessibility tree too.
      className={cn(
        'fixed right-4 z-40 size-14 rounded-full bg-brand text-brand-foreground hover:bg-brand/90 active:bg-brand/80 shadow-(--shadow-floating) bottom-[calc(1rem+var(--safe-area-bottom))] transition-[opacity,translate,visibility] duration-normal ease-smooth motion-reduce:transition-none',
        !shown && 'invisible translate-y-4 opacity-0',
      )}
    >
      <PenLine className="size-6" aria-hidden="true" />
    </Button>
  )
}
