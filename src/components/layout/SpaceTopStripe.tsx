/**
 * SpaceTopStripe — full-width 3px accent stripe pinned to the top of
 * the viewport (PEND-11).
 *
 * Replaces the FEAT-3p10 sidebar-footer `SpaceStatusChip` with a
 * higher-signal indicator that is always visible, regardless of
 * sidebar state (expanded, collapsed-rail, mobile-drawer-closed).
 * The colour is sourced from the active space's `accent_color`
 * token (e.g. `accent-emerald` -> `var(--accent-emerald)`), with a
 * fallback to `var(--accent-current)` so an unknown token (e.g. a
 * sync peer that introduced a new palette) still renders something.
 *
 * Decorative — `aria-hidden="true"`. The active-space identity is
 * still announced via the SpaceSwitcher trigger's `aria-label`, the
 * `SpaceAccentBadge` (collapsed rail), and the OS window title
 * (`<SpaceName> · Agaric`). The stripe is a *visual* anchor only.
 *
 * Android safe-area: the body has `padding-top:
 * env(safe-area-inset-top)`, but `position: fixed` is relative to
 * the viewport — not the body — so a bare `top-0` would render
 * behind the OS status bar on devices with a notch. Pinning to
 * `env(safe-area-inset-top)` (which resolves to `0` on desktop)
 * lets the stripe clear the inset everywhere. Mirrors the pattern
 * already used by App.tsx for the bottom inset
 * (`pb-[calc(1rem+env(safe-area-inset-bottom))]`).
 */

import type React from 'react'

import { useSpaceStore } from '@/stores/space'

export function SpaceTopStripe(): React.JSX.Element | null {
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const active = availableSpaces.find((s) => s.id === currentSpaceId)
  if (active == null) return null
  // Fall back to `var(--accent-current)` when `accent_color` is unset
  // or an empty string — defensive against malformed sync payloads.
  const token = active.accent_color
  const backgroundColor =
    token == null || token === ''
      ? 'var(--accent-current)'
      : `var(--${token}, var(--accent-current))`
  return (
    <div
      data-testid="space-top-stripe"
      data-space-id={active.id}
      aria-hidden="true"
      className="fixed top-[env(safe-area-inset-top)] left-0 right-0 h-[3px] z-40 pointer-events-none"
      style={{ backgroundColor }}
    />
  )
}
