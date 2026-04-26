/**
 * SpaceStatusChip — bottom-of-app-shell active-space indicator
 * (FEAT-3p10).
 *
 * Renders a small chip showing the active space's name with a
 * left-edge accent stripe coloured by the per-space `accent_color`.
 * Click forwards focus to the SpaceSwitcher in the sidebar so the
 * user can pick a different space without hunting for the dropdown
 * (matches the existing pattern of clicking a status indicator to
 * jump to the relevant control).
 *
 * Sits next to / replaces the existing sync chip so the sidebar
 * footer carries one cohesive "what is active" surface.
 *
 * Accessibility:
 *  - `aria-label` carries the active-space name + click affordance.
 *  - When no space is active (`availableSpaces` empty / unhydrated)
 *    the chip is hidden — no need to render an empty affordance.
 */

import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores/space'

interface SpaceStatusChipProps {
  /** Extra class names — composed via `cn()`. */
  className?: string
  /**
   * Optional click handler override. Defaults to focusing the
   * SpaceSwitcher trigger in the sidebar. Tests use the override
   * to assert behaviour without mounting the full sidebar.
   */
  onClick?: () => void
}

/**
 * Map a free-form accent token (e.g. `accent-emerald`) to its CSS
 * variable. Mirrors the helper in `SpaceAccentBadge` — kept private
 * to each module so a future re-architecture (extracted util) is a
 * non-event.
 */
function accentVar(token: string | null | undefined): string {
  if (token == null || token === '') return 'var(--accent-current)'
  return `var(--${token}, var(--accent-current))`
}

/**
 * Default click handler: focus the SpaceSwitcher trigger. The
 * switcher is a Radix Select whose trigger carries
 * `aria-label="Switch space"`; querying by that label keeps the
 * coupling shallow (no `data-testid`-style cross-component contract).
 * Falls back gracefully when the trigger isn't in the DOM (mobile
 * sidebar collapsed, sidebar not yet mounted).
 */
function focusSpaceSwitcher(): void {
  const trigger = document.querySelector<HTMLElement>(
    '[role="combobox"][aria-label="Switch space"]',
  )
  if (trigger == null) return
  trigger.focus()
  // Click opens the dropdown so the user can select directly without
  // a second key press. Browsers + jsdom both honour `.click()` on a
  // Radix Select trigger.
  trigger.click()
}

export function SpaceStatusChip({
  className,
  onClick,
}: SpaceStatusChipProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const activeSpace = availableSpaces.find((s) => s.id === currentSpaceId) ?? null
  const spaceName = activeSpace?.name ?? ''

  if (activeSpace == null || spaceName === '') {
    // Nothing to show — render nothing so the sidebar footer doesn't
    // carry a placeholder. The accent badge / SpaceSwitcher cover the
    // empty-state UX during boot.
    return null
  }

  const handleClick = () => {
    if (onClick) {
      onClick()
      return
    }
    focusSpaceSwitcher()
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={t('space.statusChip', { name: spaceName })}
      title={spaceName}
      data-testid="space-status-chip"
      data-space-id={activeSpace.id}
      style={{ borderLeftColor: accentVar(activeSpace.accent_color) }}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border-l-[3px]',
        'bg-muted/50 px-2 py-1 text-xs font-medium text-foreground/80',
        'border border-border/40',
        // Focus + hover affordance per AGENTS.md "Mandatory patterns".
        'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'hover:bg-muted/80',
        // Touch-target compliance.
        '[@media(pointer:coarse)]:min-h-11',
        className,
      )}
    >
      {/* Tiny dot mirroring the left-stripe colour — gives the chip a
       * second accent-colour anchor for users who run the app in a
       * theme where the bg-muted/50 borders blur the stripe. */}
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: accentVar(activeSpace.accent_color) }}
      />
      <span className="truncate">{spaceName}</span>
    </button>
  )
}
