import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

interface CollapsiblePanelHeaderProps {
  isCollapsed: boolean
  onToggle: () => void
  className?: string
  children: React.ReactNode
}

export function CollapsiblePanelHeader({
  isCollapsed,
  onToggle,
  className,
  children,
}: CollapsiblePanelHeaderProps) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        className,
        'flex w-full items-center gap-2 rounded-md px-3 py-2',
        'text-sm font-semibold text-muted-foreground',
        'hover:bg-accent/50 active:bg-accent/70 transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
      )}
      aria-expanded={!isCollapsed}
      aria-label={
        typeof children === 'string'
          ? t(isCollapsed ? 'common.expand' : 'common.collapse', { section: children })
          : undefined
      }
    >
      {!isCollapsed ? (
        <ChevronDown className="h-4 w-4 shrink-0" />
      ) : (
        <ChevronRight className="h-4 w-4 shrink-0" />
      )}
      {children}
    </button>
  )
}
