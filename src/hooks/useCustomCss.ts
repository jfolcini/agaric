/**
 * useCustomCss — the user stylesheet and its off switch (#6558).
 *
 * The stylesheet goes into one `<style>` element at the end of `<head>`, after
 * the app's own, so a rule there wins a tie. The switch is read first: while it
 * is off nothing is applied, so a sheet that hides the UI can still be turned
 * off (Settings › Appearance, or the `agaric://settings/safe-mode` link, which
 * `useDeepLinkRouter` handles). Both are device preferences, never synced.
 * Mounted in the app shell, which applies it at boot, and in the Appearance tab.
 */

import { useEffect } from 'react'

import { PREFERENCES, usePreference } from '@/lib/preferences'

export const CUSTOM_CSS_ELEMENT_ID = 'agaric-custom-css'

/** Write `css` into the user stylesheet, or remove it when `enabled` is off. */
export function applyCustomCss(css: string, enabled: boolean): void {
  const existing = document.getElementById(CUSTOM_CSS_ELEMENT_ID)
  if (!enabled || css.trim().length === 0) {
    existing?.remove()
    return
  }
  const style = existing ?? document.createElement('style')
  style.id = CUSTOM_CSS_ELEMENT_ID
  style.textContent = css
  document.head.append(style)
}

export function useCustomCss(): {
  css: string
  setCss: (css: string) => void
  enabled: boolean
  setEnabled: (enabled: boolean) => void
} {
  const [enabled, setEnabled] = usePreference(PREFERENCES.customCssEnabled)
  const [css, setCss] = usePreference(PREFERENCES.customCss)

  useEffect(() => {
    applyCustomCss(css, enabled)
  }, [css, enabled])

  return { css, setCss, enabled, setEnabled }
}
