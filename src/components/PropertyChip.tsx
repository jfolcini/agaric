import type React from 'react'
import { cn } from '@/lib/utils'

interface PropertyChipProps {
  propKey: string
  value: string
  className?: string
  onClick?: () => void
}

export function PropertyChip({ propKey, value, className, onClick }: PropertyChipProps): React.ReactElement {
  return (
    <button
      type="button"
      className={cn(
        'property-chip inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 mt-1 text-[10px] font-medium leading-none select-none',
        'bg-muted text-muted-foreground',
        onClick && 'cursor-pointer hover:bg-accent/50 transition-colors',
        className,
      )}
      onClick={onClick}
    >
      <span className="opacity-60">{propKey}:</span>
      <span>{value}</span>
    </button>
  )
}
