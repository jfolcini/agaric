/**
 * useMotionPreference — the app's single global animation-speed knob.
 *
 * The whole design system times its motion off the `--duration-*` CSS tokens,
 * and each of those is `base * var(--motion-scale)` (see `src/index.css`). So
 * ONE inline `--motion-scale` on `<html>` re-times every token-driven
 * transition and keyframe at once — no per-component wiring.
 *
 * Choices (`MotionPreference`, defined in the preferences registry):
 *   - `'system'` — DEFAULT. Writes NO inline scale, so the CSS
 *     `prefers-reduced-motion` media query governs: full motion normally,
 *     none when the OS asks for reduced motion. Existing users are unaffected.
 *   - `'full'` — scale 1, forcing full motion even if the OS flag is set.
 *   - `'fast'` — scale 0.5 (snappier).
 *   - `'off'`  — scale 0 plus `data-motion='off'`, which also hard-kills
 *     non-token motion (tw-animate-css enter/exit, spinners).
 *
 * Persistence, cross-window and cross-instance sync all come from the shared
 * `usePreference` primitive (`PREFERENCES.motion`, key `agaric-motion`), the
 * same machinery behind theme / font-size. The applying effect is idempotent,
 * so mounting the hook in more than one place (App shell for boot-time apply,
 * AppearanceTab for the Select) is harmless — every instance converges on the
 * same DOM state.
 */

import { useCallback, useEffect } from 'react'

import {
  type MotionPreference,
  PREFERENCES,
  readPreference,
  usePreference,
} from '@/lib/preferences'

export type { MotionPreference } from '@/lib/preferences'

/** Numeric `--motion-scale` for the explicit (non-`system`) choices. */
const MOTION_SCALE: Record<Exclude<MotionPreference, 'system'>, string> = {
  full: '1',
  fast: '0.5',
  off: '0',
}

/**
 * Apply a motion preference to `document.documentElement`. Idempotent and
 * SSR-safe (no-op without a `document`).
 *
 * - `system`   → remove any inline override; the media query decides.
 * - `full/fast`→ inline `--motion-scale`; clear the `off` attribute.
 * - `off`      → inline `--motion-scale: 0` + `data-motion='off'` so the
 *                CSS blanket reset also stops non-token motion.
 */
export function applyMotionPreference(pref: MotionPreference): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (pref === 'system') {
    root.style.removeProperty('--motion-scale')
    root.removeAttribute('data-motion')
    return
  }
  root.style.setProperty('--motion-scale', MOTION_SCALE[pref])
  if (pref === 'off') {
    root.setAttribute('data-motion', 'off')
  } else {
    root.removeAttribute('data-motion')
  }
}

/**
 * Read + write the motion preference and keep the DOM in sync. Returns the
 * current value and a setter. Mount once at the app root so the choice applies
 * app-wide from boot; the Settings Select mounts it too for the control.
 */
export function useMotionPreference(): {
  motion: MotionPreference
  setMotion: (pref: MotionPreference) => void
} {
  const [motion, setValue] = usePreference(PREFERENCES.motion)

  useEffect(() => {
    applyMotionPreference(motion)
  }, [motion])

  const setMotion = useCallback((pref: MotionPreference) => setValue(pref), [setValue])

  return { motion, setMotion }
}

/** Non-hook getter for early/imperative reads. Never throws. */
export function getMotionPreference(): MotionPreference {
  return readPreference(PREFERENCES.motion)
}
