/**
 * useFontSize — the app-wide editor font-size preference.
 *
 * The persisted value keeps the existing bare-string contract under
 * `agaric-font-size`. Applying it as `--agaric-font-size` on `<html>` lets
 * both the roving editor and static block content consume one shared value.
 * Mounting this hook in the app shell applies the preference at boot; the
 * Appearance tab mounts the same hook for its Select control.
 */

import { useCallback, useEffect } from 'react'

import { type FontSize, PREFERENCES, usePreference } from '@/lib/preferences'

export type { FontSize } from '@/lib/preferences'

/** Pixel value written to the design-system custom property. */
export const FONT_SIZE_PX: Record<FontSize, string> = {
  small: '14px',
  medium: '16px',
  large: '18px',
}

/** Apply the preference to the document root. Idempotent and SSR-safe. */
export function applyFontSize(size: FontSize): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--agaric-font-size', FONT_SIZE_PX[size])
}

/** Read, write, and apply the shared font-size preference. */
export function useFontSize(): {
  fontSize: FontSize
  setFontSize: (size: FontSize) => void
} {
  const [fontSize, setValue] = usePreference(PREFERENCES.fontSize)

  useEffect(() => {
    applyFontSize(fontSize)
  }, [fontSize])

  const setFontSize = useCallback((size: FontSize) => setValue(size), [setValue])

  return { fontSize, setFontSize }
}
