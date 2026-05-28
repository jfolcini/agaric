/**
 * useShouldShowMobileChrome — PEND-68 composite gate.
 *
 * `useIsMobile()` returns true only below 768 px (phone). That leaves
 * iPad portrait (768 px) and tablet-with-keyboard cases in a UX dead
 * zone for touch-only entry points like `SearchSheetTrigger`: the icon
 * doesn't render, and on a touch-only iPad there's no keyboard
 * shortcut either.
 *
 * This hook composes the existing breakpoint with a hardware-keyboard
 * probe:
 *
 *   - Phones (< 768 px): always show the mobile chrome.
 *   - Tablets (768 ≤ width < 1024): show the mobile chrome ONLY if no
 *     hardware keyboard has been detected this session.
 *   - Desktop (≥ 1024 px): never show the mobile chrome — the keyboard
 *     probe is irrelevant; the device is desktop-shaped.
 *
 * `useIsMobile` stays single-purpose (it's consumed by 20+ sites for
 * pure layout decisions like Dialog ↔ Sheet swap). This hook is
 * dedicated to entry-point discoverability — mount-or-not gates for
 * touch-only triggers.
 */

import { useEffect, useState } from 'react'

import { useHasHardwareKeyboard } from './useHasHardwareKeyboard'
import { useIsMobile } from './useIsMobile'

const TABLET_BREAKPOINT = 1024

function readIsTablet(): boolean {
  return window.innerWidth < TABLET_BREAKPOINT
}

export function useShouldShowMobileChrome(): boolean {
  const isMobile = useIsMobile()
  const hasKeyboard = useHasHardwareKeyboard()
  const [isTablet, setIsTablet] = useState<boolean>(readIsTablet)

  // Track the tablet breakpoint with the same matchMedia pattern that
  // `useIsMobile` uses for its 768 px breakpoint. Separate state from
  // `isMobile` because they have different thresholds (768 vs 1024).
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${TABLET_BREAKPOINT - 1}px)`)
    const onChange = () => setIsTablet(readIsTablet())
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  // Parenthesised explicitly so a future reader doesn't have to
  // remember JS operator precedence — `&&` binds tighter than `||`,
  // and that's what we want, but spelling it out is cheap insurance.
  return isMobile || (isTablet && !hasKeyboard)
}
