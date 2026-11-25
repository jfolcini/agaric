/**
 * useKeyboardHints — whether to show keyboard-only UI: shortcut hints, picker
 * key footers, the Keyboard settings tab and the Quick reference sheet.
 *
 * Always on a fine pointer. On a touch device only once a hardware keyboard has
 * shown itself (`useHasHardwareKeyboard`), so a phone with a Bluetooth keyboard
 * gets them back while a bare phone shows no keys it cannot press.
 */

import { useHasHardwareKeyboard } from '@/hooks/useHasHardwareKeyboard'
import { useIsTouch } from '@/hooks/useIsTouch'

export function useKeyboardHints(): boolean {
  const isTouch = useIsTouch()
  const hasKeyboard = useHasHardwareKeyboard()
  return !isTouch || hasKeyboard
}
