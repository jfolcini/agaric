import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CollapsiblePanelHeaderProps {
  collapsed: boolean
  onToggle: () => void
  className?: string
  children: React.ReactNode
}

export function CollapsiblePanelHeader({
  collapsed,
  onToggle,
  className,
  children,
}: CollapsiblePanelHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        className,
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5',
        'text-sm font-medium text-muted-foreground',
        'hover:bg-accent/50 transition-colors',
      )}
      aria-expanded={!collapsed}
    >
      {!collapsed ? (
        <ChevronDown className="h-4 w-4 shrink-0" />
      ) : (
        <ChevronRight className="h-4 w-4 shrink-0" />
      )}
      {children}
    </button>
  )
}
