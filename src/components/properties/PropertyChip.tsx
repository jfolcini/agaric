import { ExternalLink } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { badgeVariants } from '@/components/ui/badge'
import { IconButton } from '@/components/ui/icon-button'
import { openUrl } from '@/lib/open-url'
import { BUILTIN_PROPERTY_ICONS, formatPropertyName } from '@/lib/property-utils'
import { isLinkablePropertyUrl } from '@/lib/url-validation'
import { cn } from '@/lib/utils'

interface PropertyChipProps {
  propKey: string
  value: string
  className?: string
  onClick?: () => void
  onKeyClick?: () => void
}

/**
 * PropertyChip renders a pill with two independent interactive zones:
 *   - the key label (e.g. "Effort:") — opens the property-key rename flow
 *   - the value (e.g. "2h")         — opens the property-value edit flow
 *
 * The pill itself is a non-interactive `<div role="group">` wrapper. Each
 * zone is a real `<button>` sibling so both keep native keyboard semantics
 * Without producing a `<button>` nested inside a `<button>`.
 *
 * Event isolation: the wrapper has no click handler. Clicking the key
 * button fires `onKeyClick` only; clicking the value button fires
 * `onClick` only. Nothing bubbles between the two.
 *
 * Focus ring: the wrapper carries a `focus-within` ring so tabbing into
 * either inner button lights up the whole pill instead of two overlapping
 * rings.
 *
 * URL values: a value that parses as http/https/mailto gets a trailing
 * open-link control. The decision is made on the VALUE, not on the key's
 * declared `url` type — a chip carries no property definition, and fetching
 * one per chip would cost an IPC per rendered property. The value zone itself
 * stays the edit trigger, so a URL property is still editable from the chip.
 *
 * Chrome: the pill shares the design-system Badge primitive's chrome via
 * `badgeVariants()` (#1678) — base flex/shape/size tokens come from Badge so
 * the chip stays in the pill family; the muted tone and tighter padding/gap
 * are PropertyChip-specific overrides (Badge has no `muted` tone).
 */
export function PropertyChip({
  propKey,
  value,
  className,
  onClick,
  onKeyClick,
}: PropertyChipProps): React.ReactElement {
  const { t } = useTranslation()
  const Icon = BUILTIN_PROPERTY_ICONS[propKey]
  const displayName = formatPropertyName(propKey)
  const chipLabel = t('property.selectValue', { key: displayName, value })

  const keyLabel = onKeyClick ? (
    <button
      type="button"
      className={cn(
        'property-key-label opacity-60 hover:underline cursor-pointer rounded-sm',
        'focus-ring-visible',
        Icon && 'inline-flex items-center gap-0.5',
      )}
      // #1498: the chip lives outside the contenteditable. With the block's
      // editor focused, a plain click would blur it first (flush →
      // re-render/remount) and swallow the click. preventDefault on mousedown
      // retains editor focus so the edit-key flow opens and the caret stays put.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onKeyClick}
      aria-label={t('property.editKeyLabel', { key: displayName })}
    >
      {Icon && <Icon className="h-2.5 w-2.5 shrink-0" />}
      {displayName}:
    </button>
  ) : (
    <span
      className={cn('property-key-label opacity-60', Icon && 'inline-flex items-center gap-0.5')}
    >
      {Icon && <Icon className="h-2.5 w-2.5 shrink-0" />}
      {displayName}:
    </span>
  )

  const valueNode = onClick ? (
    <button
      type="button"
      className={cn(
        'property-chip-value cursor-pointer hover:underline rounded-sm',
        'focus-ring-visible',
      )}
      // #1498: keep editor focus on click so the value-edit flow opens (see the
      // key-label note above for the blur/flush rationale).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={chipLabel}
    >
      {value}
    </button>
  ) : (
    <span className="property-chip-value">{value}</span>
  )

  const openLinkLabel = t('pageProperty.openLinkLabel', { url: value })
  const openLink = isLinkablePropertyUrl(value) ? (
    <IconButton
      size="icon-xs"
      variant="ghost"
      tooltip={openLinkLabel}
      ariaLabel={openLinkLabel}
      // #1498: keep editor focus on click (see the key-label note above).
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        // `StaticBlock.handleOuterClick` focuses the block on any bubbled
        // click; opening a link must not move the roving editor there.
        e.stopPropagation()
        void openUrl(value)
      }}
    >
      <ExternalLink aria-hidden="true" />
    </IconButton>
  ) : null

  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- generic labelled grouping; the suggested tags (fieldset/details/hgroup/optgroup) carry unwanted semantics and would break the inline-flex chip layout
      role="group"
      aria-label={chipLabel}
      className={cn(
        // Compose the shared Badge primitive's pill chrome (base flex layout,
        // rounded-full shape, font-medium, text-xs size, transition) so the
        // chip stays in sync with the rest of the pill family (#1678).
        badgeVariants({ size: 'default', shape: 'pill' }),
        'property-chip',
        // PropertyChip overrides: Badge has no `muted` tone, and the chip uses a
        // tighter gap/padding than the default Badge. twMerge (via `cn`) resolves
        // these against the recipe's tokens deterministically (last wins).
        'gap-0.5 px-1.5 leading-none select-none touch-target [@media(pointer:coarse)]:px-2 [@media(pointer:coarse)]:py-0.5',
        'bg-muted text-muted-foreground',
        'focus-within:ring-[3px] focus-within:ring-ring/50',
        onClick && 'hover:bg-accent/50 active:bg-accent/70 transition-colors',
        className,
      )}
      data-testid="property-chip"
    >
      {keyLabel}
      {valueNode}
      {openLink}
    </div>
  )
}
