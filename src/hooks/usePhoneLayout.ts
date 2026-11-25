/**
 * usePhoneLayout — whether the app is laid out as on a phone: overlays are
 * bottom sheets, long menus are sheet lists, the sidebar is a drawer and, on
 * touch (`useIsTouch() && usePhoneLayout()`), the header is the phone's.
 *
 * True in a window under 768 px wide (`useIsMobile`), and on a touch screen
 * under 500 px tall: a phone on its side is wider than that and no roomier.
 * The height is the screen's, not the viewport's: on Android the soft keyboard
 * shrinks the viewport (`MainActivity.kt`, #6790), and a tablet must not swap
 * the dialog being typed in for a sheet.
 */

import { useEffect, useState } from 'react'

import { useIsMobile } from '@/hooks/useIsMobile'
import { useIsTouch } from '@/hooks/useIsTouch'

const SHORT_SCREEN_QUERY = '(max-device-height: 499px)'

function useIsShortScreen(): boolean {
  const [isShort, setIsShort] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(SHORT_SCREEN_QUERY).matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(SHORT_SCREEN_QUERY)
    const onChange = () => setIsShort(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return isShort
}

export function usePhoneLayout(): boolean {
  const isNarrow = useIsMobile()
  const isTouch = useIsTouch()
  const isShort = useIsShortScreen()
  return isNarrow || (isTouch && isShort)
}
