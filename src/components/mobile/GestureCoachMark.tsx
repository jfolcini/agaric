/**
 * GestureCoachMark — one-time, first-run mobile coach-mark overlay (#1422).
 *
 * Agaric ships rich touch UX (swipe-to-delete/indent #927, long-press
 * context menu #926, edge-swipe sidebar, quick-capture FAB) that is
 * discoverable only by accident. This overlay surfaces those gestures
 * once, on the first mobile/touch launch, then never again.
 *
 * Gating mirrors the other touch-only entry points (`QuickCaptureFab`,
 * `SearchSheetTrigger`): it self-gates on `useShouldShowMobileChrome()`
 * so it renders NOTHING on desktop — no overlay, no paint, no focus
 * trap. The one-time-ness is persisted via the `@/lib/gesture-coachmark`
 * flag (same localStorage pattern as the #754 onboarding flag), read
 * once into open-state at mount.
 *
 * Accessibility: built on the Radix `Dialog`, which provides a focus
 * trap, restores focus on close, labels the surface via `DialogTitle` /
 * `DialogDescription`, and dismisses on Esc / outside-click / the Close
 * button. The gesture list carries an explicit `role="list"` (Safari +
 * VoiceOver strip the implicit role from `list-none` lists — see
 * WelcomeModal).
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useShouldShowMobileChrome } from '@/hooks/useShouldShowMobileChrome'
import {
  GESTURE_ENTRIES,
  isGestureCoachMarkSeen,
  markGestureCoachMarkSeen,
} from '@/lib/gesture-coachmark'

export function GestureCoachMark(): React.ReactElement | null {
  const { t } = useTranslation()
  const shouldShowMobileChrome = useShouldShowMobileChrome()
  // Start CLOSED and only open once the responsive mobile chrome is
  // genuinely active. Seeding open-state directly from the persisted
  // flag at mount latched `open=true` even on a desktop-width boot,
  // so a later resize to mobile mid-session popped the coach-mark on
  // every render — not just on a true first mobile launch (#1749).
  const [open, setOpen] = useState(false)

  // Open exactly once, the first time the mobile chrome turns on and
  // the user hasn't dismissed it before. Re-checking the persisted flag
  // here (rather than at mount) keeps the open-state in sync with the
  // responsive chrome across resize / breakpoint / keyboard changes.
  useEffect(() => {
    if (shouldShowMobileChrome && !isGestureCoachMarkSeen()) {
      setOpen(true)
    }
  }, [shouldShowMobileChrome])

  const handleDismiss = useCallback(() => {
    setOpen(false)
    markGestureCoachMarkSeen()
  }, [])

  // Desktop (or tablet-with-keyboard) sessions never see the coach-mark.
  // Checked AFTER hooks so hook order stays stable across renders.
  if (!shouldShowMobileChrome) return null

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) handleDismiss()
      }}
    >
      <DialogContent data-testid="gesture-coachmark">
        <DialogHeader>
          <DialogTitle>{t('gestures.coachmark.title')}</DialogTitle>
          <DialogDescription>{t('gestures.coachmark.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {/*
            oxlint-disable-next-line jsx-a11y/no-redundant-roles -- explicit
            role="list" is required because Safari + VoiceOver strip the
            implicit list role from a <ul> with `list-style: none`
            (Tailwind `list-none`). Matches WelcomeModal / .
          */}
          <ul role="list" className="grid list-none gap-4 py-2 pl-0">
            {GESTURE_ENTRIES.map((entry) => (
              <li key={entry.titleKey} className="flex items-start gap-3">
                <entry.icon
                  className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div>
                  <p className="text-sm font-medium">{t(entry.titleKey)}</p>
                  <p className="text-sm text-muted-foreground">{t(entry.descKey)}</p>
                </div>
              </li>
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button onClick={handleDismiss}>{t('gestures.coachmark.dismiss')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
