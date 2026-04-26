/**
 * SpaceAccentBadge — collapsed-sidebar identity affordance (FEAT-3p10).
 *
 * Renders a 32px (44px on touch) circular button with the first letter
 * of the active space's name centred on top of its `accent_color`.
 * Clicking the badge cycles to the next space alphabetically (matching
 * the FEAT-3p11 cycle-shortcut concept). When the sidebar is collapsed
 * to its icon-only rail, this is the only visual cue the user has of
 * which space is active — without it, the rail is identical across
 * every space.
 *
 * Accessibility:
 *  - `aria-label` carries the space name + click affordance.
 *  - `title` (tooltip) shows the bare name.
 *  - 44px touch target on `[@media(pointer:coarse)]` per AGENTS.md.
 *  - `focus-visible:ring-[3px] ring-ring/50` matches the Button /
 *    Input focus pattern.
 *
 * The accent background is sourced from the per-space `--accent-…`
 * CSS variable (e.g. `var(--accent-emerald)`), with a fallback to
 * `var(--accent-current)` so an unset / unknown token still renders.
 */

import { useTranslation } from 'react-i18next'
import type { SpaceRow } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores/space'

interface SpaceAccentBadgeProps {
  /** The space whose initial + accent the badge renders. */
  space: SpaceRow
  /**
   * Optional click override. Defaults to "cycle to next space
   * alphabetically" — the parent rarely needs to override this, but
   * tests pass an explicit handler to assert behaviour.
   */
  onClick?: () => void
  /** Extra class names — composed via `cn()`. */
  className?: string
}

/**
 * Map a free-form `accent_color` token (e.g. `accent-emerald`) to the
 * matching CSS custom property. Returns the brand-default
 * `var(--accent-current)` for tokens we don't recognise so a synced
 * peer that introduced a new palette token doesn't render a blank
 * badge — visual fallback over hard error.
 */
function accentVar(token: string | null | undefined): string {
  if (token == null || token === '') return 'var(--accent-current)'
  // The token shape is `accent-<name>` and matches the CSS variable
  // names defined in `index.css` directly. A future custom-palette
  // surface can extend this without touching the rest of the
  // component — the fallback keeps it forward-compatible.
  return `var(--${token}, var(--accent-current))`
}

/**
 * Cycle to the next space alphabetically (wrapping around). Pulled
 * out so tests + the default `onClick` can share a single source of
 * truth — the parent SidebarHeader binds it on render and unit tests
 * stub it out via the `onClick` prop. Does nothing when there is one
 * (or zero) space, matching the spec ("click cycles to the next
 * space" — N=1 has no "next").
 */
function cycleToNextSpace(currentId: string | null): void {
  const { availableSpaces, setCurrentSpace } = useSpaceStore.getState()
  if (availableSpaces.length <= 1) return
  const currentIdx = availableSpaces.findIndex((s) => s.id === currentId)
  // `findIndex` returns -1 when `currentId` is null / unknown — wrap
  // to index 0 in that case so the user still gets a deterministic
  // outcome (jumps to the alphabetical first space).
  const nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % availableSpaces.length
  const nextSpace = availableSpaces[nextIdx]
  if (nextSpace == null) return
  if (nextSpace.id === currentId) return
  setCurrentSpace(nextSpace.id)
}

export function SpaceAccentBadge({
  space,
  onClick,
  className,
}: SpaceAccentBadgeProps): React.JSX.Element {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)

  // First letter of the space name, uppercased. Empty / whitespace
  // names get a `?` placeholder so the badge always shows something
  // — defensive against a sync peer with a bare-empty name.
  const firstChar = space.name.trim().charAt(0).toUpperCase() || '?'

  const handleClick = () => {
    if (onClick) {
      onClick()
      return
    }
    cycleToNextSpace(currentSpaceId)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={t('space.accentBadge', { name: space.name })}
      title={space.name}
      data-testid="space-accent-badge"
      data-space-id={space.id}
      style={{ backgroundColor: accentVar(space.accent_color) }}
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
        'text-sm font-semibold text-white shadow-sm',
        // Touch target — bumps the hit area to 44px on coarse pointers
        // without changing the 32px visual footprint, matching
        // AGENTS.md "Mandatory patterns" for touch-target sizing.
        '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
        // Focus ring matches the Button / Input pattern in the design
        // system — see AGENTS.md "Mandatory patterns".
        'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        // Subtle hover affordance — the colour stays the same; only
        // the ring widens so the click target remains visually
        // anchored to the accent colour.
        'transition-shadow duration-fast hover:ring-2 hover:ring-ring/30',
        className,
      )}
    >
      <span aria-hidden="true">{firstChar}</span>
    </button>
  )
}
