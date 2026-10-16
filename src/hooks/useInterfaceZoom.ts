/**
 * useInterfaceZoom — the device's interface zoom (#5646), applied as the
 * webview's page zoom so the whole app scales and reflows, chrome included.
 * Note text size (`useFontSize`) scales on top of it.
 *
 * App mounts this hook to apply the stored level at boot and every change
 * after it; the Ctrl+= / Ctrl+- / Ctrl+0 shortcuts (`useAppKeyboardShortcuts`)
 * and the Appearance control only write the preference.
 */

import { useEffect, useRef } from 'react'

import { setWebviewZoom } from '@/lib/platform/window'
import {
  INTERFACE_ZOOM_LEVELS,
  type InterfaceZoom,
  PREFERENCES,
  readPreference,
  usePreference,
  writePreference,
} from '@/lib/preferences'

export type { InterfaceZoom } from '@/lib/preferences'

/** The level one step in `direction` from `zoom`, held at the ends of the range. */
export function stepInterfaceZoom(zoom: InterfaceZoom, direction: 1 | -1): InterfaceZoom {
  const index = INTERFACE_ZOOM_LEVELS.indexOf(zoom) + direction
  const clamped = Math.min(Math.max(index, 0), INTERFACE_ZOOM_LEVELS.length - 1)
  return INTERFACE_ZOOM_LEVELS[clamped] as InterfaceZoom
}

/** Step the stored zoom in or out, or reset it to 100% (`direction` 0). */
export function changeInterfaceZoom(direction: 1 | -1 | 0): void {
  const current = readPreference(PREFERENCES.interfaceZoom)
  const next = direction === 0 ? 1 : stepInterfaceZoom(current, direction)
  writePreference(PREFERENCES.interfaceZoom, next)
}

/** Apply the stored zoom to the webview. Mount once, in the app shell. */
export function useInterfaceZoom(): void {
  const [zoom] = usePreference(PREFERENCES.interfaceZoom)
  // The webview starts every launch at 100%, so the default needs no call.
  const applied = useRef<number>(1)

  useEffect(() => {
    if (zoom === applied.current) return
    applied.current = zoom
    void setWebviewZoom(zoom)
  }, [zoom])
}
