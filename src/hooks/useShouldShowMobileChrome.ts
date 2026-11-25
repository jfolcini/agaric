/**
 * useShouldShowMobileChrome — whether the touch-only entry points show
 * (`SearchSheetTrigger`, the quick-capture button, the gesture coach-mark).
 *
 * On a touch device only (`useIsTouch()`): a narrow mouse window keeps the
 * desktop chrome.
 *
 *   - A phone (`usePhoneLayout`): always.
 *   - A tablet (under 1024 px wide): only while no hardware keyboard has been
 *     detected this session.
 *   - Wider: never.
 *
 * The 1024 px bound is a tablet's, not a phone's, so it stays out of
 * `usePhoneLayout`: a tablet keeps its dialogs and its pinned sidebar.
 */

import { useEffect, useState } from 'react'

import { useHasHardwareKeyboard } from '@/hooks/useHasHardwareKeyboard'
import { useIsTouch } from '@/hooks/useIsTouch'
import { usePhoneLayout } from '@/hooks/usePhoneLayout'

const TABLET_BREAKPOINT = 1024

function readIsTablet(): boolean {
  return window.innerWidth < TABLET_BREAKPOINT
}

export function useShouldShowMobileChrome(): boolean {
  const isTouch = useIsTouch()
  const phoneLayout = usePhoneLayout()
  const hasKeyboard = useHasHardwareKeyboard()
  const [isTablet, setIsTablet] = useState<boolean>(readIsTablet)

  // The tablet breakpoint, tracked as `useIsMobile` tracks its own.
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${TABLET_BREAKPOINT - 1}px)`)
    const onChange = () => setIsTablet(readIsTablet())
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isTouch && (phoneLayout || (isTablet && !hasKeyboard))
}
