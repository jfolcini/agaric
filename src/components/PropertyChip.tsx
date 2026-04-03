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
  return (
    <button
      type="button"
      className={cn(
        'property-chip inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none select-none',
        'bg-muted text-muted-foreground',
        onClick && 'cursor-pointer hover:bg-accent/50 transition-colors',
        className,
      )}
      onClick={onClick}
    >
      <span
        className={cn(
          'property-key-label opacity-60',
          onKeyClick && 'hover:underline cursor-pointer',
        )}
        onClick={
          onKeyClick
            ? (e) => {
                e.stopPropagation()
                onKeyClick()
              }
            : undefined
        }
      >
        {propKey}:
      </span>
      <span>{value}</span>
    </button>
  )
}
