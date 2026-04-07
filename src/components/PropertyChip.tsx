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

  const keyLabel = onKeyClick ? (
    <button
      type="button"
      className={cn(
        'property-key-label opacity-60 hover:underline cursor-pointer',
        Icon && 'inline-flex items-center gap-0.5',
      )}
      onClick={(e) => {
        e.stopPropagation()
        onKeyClick()
      }}
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

  return (
    <button
      type="button"
      className={cn(
        'property-chip inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium leading-none select-none [@media(pointer:coarse)]:px-2.5 [@media(pointer:coarse)]:py-1',
        'bg-muted text-muted-foreground',
        onClick && 'cursor-pointer hover:bg-accent/50 active:bg-accent/70 transition-colors',
        className,
      )}
      data-testid="property-chip"
      onClick={onClick}
    >
      {keyLabel}
      <span>{value}</span>
    </button>
  )
}
