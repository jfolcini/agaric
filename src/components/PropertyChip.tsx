import type React from 'react'
import { useTranslation } from 'react-i18next'
import { BUILTIN_PROPERTY_ICONS, formatPropertyName } from '@/lib/property-utils'
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
 * without producing a `<button>` nested inside a `<button>` (TEST-4b).
 *
 * Event isolation: the wrapper has no click handler. Clicking the key
 * button fires `onKeyClick` only; clicking the value button fires
 * `onClick` only. Nothing bubbles between the two.
 *
 * Focus ring: the wrapper carries a `focus-within` ring so tabbing into
 * either inner button lights up the whole pill instead of two overlapping
 * rings.
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
        'property-key-label opacity-60 hover:underline cursor-pointer',
        'focus-visible:outline-hidden',
        Icon && 'inline-flex items-center gap-0.5',
      )}
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
        'property-chip-value cursor-pointer hover:underline',
        'focus-visible:outline-hidden',
      )}
      onClick={onClick}
      aria-label={chipLabel}
    >
      {value}
    </button>
  ) : (
    <span className="property-chip-value">{value}</span>
  )

  return (
    // biome-ignore lint/a11y/useSemanticElements: role="group" is the aria-label carrier for a two-button pill — <fieldset> is form-grouping semantics. See TEST-4b.
    <div
      role="group"
      aria-label={chipLabel}
      className={cn(
        'property-chip inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium leading-none select-none touch-target [@media(pointer:coarse)]:px-2 [@media(pointer:coarse)]:py-0.5',
        'bg-muted text-muted-foreground',
        'focus-within:ring-[3px] focus-within:ring-ring/50',
        onClick && 'hover:bg-accent/50 active:bg-accent/70 transition-colors',
        className,
      )}
      data-testid="property-chip"
    >
      {keyLabel}
      {valueNode}
    </div>
  )
}
