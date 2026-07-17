/**
 * useTooltipDelay — the app's single global tooltip hover-open latency knob
 * (#2851).
 *
 * Perceived hover responsiveness is governed by the *delay before a tooltip
 * opens*, a separate axis from animation duration (`useMotionPreference` /
 * `--motion-scale`). The app-level `TooltipProvider` in `src/main.tsx` sets
 * one baseline delay that the large majority of tooltips inherit; this hook
 * resolves the user's chosen `TooltipDelay` enum to that baseline's numeric
 * ms value.
 *
 * Choices (`TooltipDelay`, defined in the preferences registry):
 *   - `'default'` — DEFAULT. `300` ms, the existing baseline. Existing users
 *     are unaffected.
 *   - `'fast'` — `150` ms, snappier.
 *   - `'instant'` — `0` ms, no hover dwell.
 *
 * Persistence, cross-window and cross-instance sync all come from the shared
 * `usePreference` primitive (`PREFERENCES.tooltipDelay`, key
 * `agaric-tooltip-delay`), the same machinery behind motion / theme /
 * font-size.
 *
 * This only resolves the inherited baseline. The deliberate per-surface
 * deviations (sidebar `0`, toolbars `200`, block gutter `500`) set their own
 * `delayDuration` on their own `<Tooltip>` and are untouched by this hook.
 */

import { useCallback } from 'react'

import { PREFERENCES, readPreference, type TooltipDelay, usePreference } from '@/lib/preferences'

export type { TooltipDelay } from '@/lib/preferences'

/** Numeric hover-open delay (ms) for each `TooltipDelay` choice. */
export const TOOLTIP_DELAY_MS: Record<TooltipDelay, number> = {
  instant: 0,
  fast: 150,
  default: 300,
}

/**
 * Read + write the tooltip-delay preference. Returns the current enum
 * value, its resolved ms number (for the app-level `TooltipProvider`), and a
 * setter.
 */
export function useTooltipDelay(): {
  tooltipDelay: TooltipDelay
  delayMs: number
  setTooltipDelay: (pref: TooltipDelay) => void
} {
  const [tooltipDelay, setValue] = usePreference(PREFERENCES.tooltipDelay)

  const setTooltipDelay = useCallback((pref: TooltipDelay) => setValue(pref), [setValue])

  return { tooltipDelay, delayMs: TOOLTIP_DELAY_MS[tooltipDelay], setTooltipDelay }
}

/** Non-hook getter for early/imperative reads. Never throws. */
export function getTooltipDelayMs(): number {
  return TOOLTIP_DELAY_MS[readPreference(PREFERENCES.tooltipDelay)]
}
