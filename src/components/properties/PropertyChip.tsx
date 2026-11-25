import { ExternalLink } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { UnfitValueMark } from '@/components/properties/UnfitValueMark'
import { badgeVariants } from '@/components/ui/badge'
import { IconButton } from '@/components/ui/icon-button'
import { openUrl } from '@/lib/open-url'
import { BUILTIN_PROPERTY_ICONS, formatPropertyName } from '@/lib/property-utils'
import { isLinkablePropertyUrl } from '@/lib/url-validation'
import { cn } from '@/lib/utils'

interface PropertyChipProps {
  propKey: string
  value: string
  /** The value button's name when it does more than edit the value (a ref chip opens its target). */
  valueAriaLabel?: string | undefined
  className?: string
  onClick?: (() => void) | undefined
  onKeyClick?: (() => void) | undefined
  /** The value doesn't fit its key's definition (#6206): the chip carries a mark. */
  unfit?: boolean | undefined
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
 * A value that doesn't fit: the caller, which holds the space's definitions,
 * passes `unfit` (#6206). The chip then wears the warning tone, its group
 * name says the value doesn't fit, and an `UnfitValueMark` after the value
 * opens the key's values that don't fit in Settings.
 *
 * Chrome: Badge's `property` tone via `badgeVariants()` (#1678, #7040): an
 * outline around `key: value`, no fill, so a property never reads as a tag;
 * the tighter gap is the chip's own.
 */
export function PropertyChip({
  propKey,
  value,
  valueAriaLabel,
  className,
  onClick,
  onKeyClick,
  unfit = false,
}: PropertyChipProps): React.ReactElement {
  const { t } = useTranslation()
  const Icon = BUILTIN_PROPERTY_ICONS[propKey]
  const displayName = formatPropertyName(propKey)
  const chipLabel = t('property.selectValue', { key: displayName, value })
  const groupLabel = unfit ? t('property.unfitChipLabel', { key: displayName, value }) : chipLabel

  // The key is set apart from the value by weight: a fade (`opacity-60`) fails AA contrast (#5743).
  const keyLabel = onKeyClick ? (
    <button
      type="button"
      className={cn(
        'property-key-label font-normal hover:underline cursor-pointer rounded-sm',
        'focus-ring-visible',
        Icon && 'inline-flex items-center gap-0.5',
      )}
      // #1498: the chip lives outside the contenteditable, so a plain press
      // would blur the block's editor and end the edit. preventDefault on
      // mousedown keeps the editor focused, so the edit-key flow opens with the
      // caret where it was.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onKeyClick}
      aria-label={t('property.editKeyLabel', { key: displayName })}
    >
      {Icon && <Icon className="h-2.5 w-2.5 shrink-0 [@media(pointer:coarse)]:size-3" />}
      {displayName}:
    </button>
  ) : (
    <span
      className={cn('property-key-label font-normal', Icon && 'inline-flex items-center gap-0.5')}
    >
      {Icon && <Icon className="h-2.5 w-2.5 shrink-0 [@media(pointer:coarse)]:size-3" />}
      {displayName}:
    </span>
  )

  const valueNode = onClick ? (
    <button
      type="button"
      className={cn(
        'property-chip-value cursor-pointer hover:underline rounded-sm touch-hit-area',
        'focus-ring-visible',
      )}
      // #1498: keep the editor focused through the click, so the value-edit
      // flow opens with the caret where it was (see the key-label note above).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={valueAriaLabel ?? chipLabel}
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
        // The predicate tolerates surrounding whitespace (the URL parser strips
        // it); the opener plugin's URL scope does not.
        void openUrl(value.trim())
      }}
    >
      <ExternalLink aria-hidden="true" />
    </IconButton>
  ) : null

  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- generic labelled grouping; the suggested tags (fieldset/details/hgroup/optgroup) carry unwanted semantics and would break the inline-flex chip layout
      role="group"
      aria-label={groupLabel}
      className={cn(
        badgeVariants({ tone: 'property' }),
        'property-chip gap-0.5 leading-none select-none',
        unfit && 'border-alert-warning-border bg-alert-warning text-alert-warning-foreground',
        'focus-within:ring-[3px] focus-within:ring-ring',
        onClick &&
          (unfit
            ? 'hover:bg-alert-warning/80 transition-colors'
            : 'hover:bg-accent/50 active:bg-accent/70 transition-colors'),
        className,
      )}
      data-testid="property-chip"
    >
      {keyLabel}
      {valueNode}
      {unfit && <UnfitValueMark propKey={propKey} value={value} />}
      {openLink}
    </div>
  )
}
