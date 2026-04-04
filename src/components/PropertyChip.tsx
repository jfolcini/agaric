import type React from 'react'
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
  const keyLabel = onKeyClick ? (
    <button
      type="button"
      className={cn('property-key-label opacity-60 hover:underline cursor-pointer')}
      onClick={(e) => {
        e.stopPropagation()
        onKeyClick()
      }}
    >
      {propKey}:
    </button>
  ) : (
    <span className="property-key-label opacity-60">{propKey}:</span>
  )

  return (
    <button
      type="button"
      className={cn(
        'property-chip inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none select-none [@media(pointer:coarse)]:px-2.5 [@media(pointer:coarse)]:py-1',
        'bg-muted text-muted-foreground',
        onClick && 'cursor-pointer hover:bg-accent/50 transition-colors',
        className,
      )}
      onClick={onClick}
    >
      {keyLabel}
      <span>{value}</span>
    </button>
  )
}
