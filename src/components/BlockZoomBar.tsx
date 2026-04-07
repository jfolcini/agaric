/**
 * BlockZoomBar — breadcrumb navigation bar for zoomed block view.
 *
 * Renders a clickable breadcrumb trail: Home > Ancestor > ... > Current.
 * Extracted from BlockTree's inline breadcrumb JSX.
 */

import { ChevronRight, Home } from 'lucide-react'
import type React from 'react'
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { BreadcrumbItem } from '../hooks/useBlockZoom'
import { cn } from '../lib/utils'

export interface BlockZoomBarProps {
  breadcrumbs: BreadcrumbItem[]
  /** Called when the user clicks a breadcrumb item to navigate to it. */
  onNavigate: (blockId: string) => void
  /** Called when the user clicks the Home button to zoom out to root. */
  onZoomToRoot: () => void
}

export function BlockZoomBar({
  breadcrumbs,
  onNavigate,
  onZoomToRoot,
}: BlockZoomBarProps): React.ReactElement | null {
  const { t } = useTranslation()

  if (breadcrumbs.length === 0) return null

  return (
    <ScrollArea className="border-b border-border/40">
      <nav
        aria-label={t('block.breadcrumb')}
        className="flex items-center gap-1 px-2 py-1.5 text-sm text-muted-foreground"
      >
        <button
          type="button"
          className="flex-shrink-0 hover:text-foreground transition-colors"
          onClick={onZoomToRoot}
          aria-label={t('block.zoomToRoot')}
        >
          <Home className="h-3.5 w-3.5" />
        </button>
        {breadcrumbs.map((item, i) => (
          <Fragment key={item.id}>
            <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground/50" />
            <button
              type="button"
              className={cn(
                'truncate max-w-[200px] hover:text-foreground transition-colors',
                i === breadcrumbs.length - 1 && 'text-foreground font-medium',
              )}
              onClick={() => (i === breadcrumbs.length - 1 ? undefined : onNavigate(item.id))}
            >
              {item.content || t('block.untitled')}
            </button>
          </Fragment>
        ))}
      </nav>
    </ScrollArea>
  )
}
