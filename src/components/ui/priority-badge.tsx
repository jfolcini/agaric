import { priorityColor } from '@/lib/priority-color'
import { cn } from '@/lib/utils'

export function PriorityBadge({ priority, className }: { priority: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-xs font-bold leading-none',
        priorityColor(priority),
        className,
      )}
    >
      P{priority}
    </span>
  )
}
