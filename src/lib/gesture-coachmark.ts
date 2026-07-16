/**
 * First-run mobile-gesture coach-mark flag helpers (#1422).
 *
 * The `agaric-gesture-coachmark-seen` localStorage key marks that the
 * one-time mobile gesture coach-mark overlay has been dismissed. Reads /
 * writes live here — mirroring the `@/lib/onboarding` pattern (#754) —
 * so the App shell can gate-mount the lazy coach-mark chunk WITHOUT
 * pulling it over the wire on every boot. Both helpers tolerate a
 * missing / disabled `localStorage` (private mode, sandboxed iframe).
 *
 * The shared, ordered gesture list (`GESTURE_ENTRIES`) is also exported
 * here so the first-run overlay and the persistent "Touch gestures" help
 * section render the SAME copy from a single source of truth.
 */

import type { LucideIcon } from 'lucide-react'
import { Hand, PanelLeft, PenLine, Pointer } from 'lucide-react'

import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'

/** True once the user has dismissed the first-run gesture coach-mark. */
export function isGestureCoachMarkSeen(): boolean {
  return readPreference(PREFERENCES.gestureCoachmarkSeen)
}

/** Persist the dismissal so the coach-mark never re-opens. */
export function markGestureCoachMarkSeen(): void {
  writePreference(PREFERENCES.gestureCoachmarkSeen, true)
}

/**
 * One gesture row, keyed by i18n. The icon is a `lucide-react`
 * component reused across the coach-mark overlay and the help section.
 */
export interface GestureEntry {
  readonly icon: LucideIcon
  readonly titleKey: string
  readonly descKey: string
}

/**
 * Ordered list of the hidden mobile touch gestures Agaric already ships
 * (the gestures themselves are implemented elsewhere — see #927 swipe,
 * #926 long-press, the sidebar edge-swipe, and the quick-capture FAB).
 * Single source of truth for both the first-run overlay and the
 * persistent help reference.
 */
export const GESTURE_ENTRIES: readonly GestureEntry[] = [
  {
    icon: Hand,
    titleKey: 'gestures.swipe.title',
    descKey: 'gestures.swipe.desc',
  },
  {
    icon: Pointer,
    titleKey: 'gestures.longPress.title',
    descKey: 'gestures.longPress.desc',
  },
  {
    icon: PanelLeft,
    titleKey: 'gestures.edgeSwipe.title',
    descKey: 'gestures.edgeSwipe.desc',
  },
  {
    icon: PenLine,
    titleKey: 'gestures.quickCapture.title',
    descKey: 'gestures.quickCapture.desc',
  },
] as const
