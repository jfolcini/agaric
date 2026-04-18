/**
 * BlockZoomBar — breadcrumb navigation bar for zoomed block view.
 *
 * Renders a clickable breadcrumb trail: Home > Ancestor > ... > Current.
 * Extracted from BlockTree's inline breadcrumb JSX.
 *
 * Keyboard navigation (UX-215):
 * - ArrowLeft / ArrowRight move focus across breadcrumb buttons.
 * - Home / End jump to the first / last breadcrumb (including the Home button).
 * - The container is `role="toolbar"` so AT announces the grouping.
 * - The last breadcrumb carries `aria-current="location"` to indicate the
 *   current zoom level.
 */

import { ChevronRight, Home } from 'lucide-react'
import type React from 'react'
import { Fragment, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { BreadcrumbItem } from '../hooks/useBlockZoom'
import { useRichContentCallbacks } from '../hooks/useRichContentCallbacks'
import { cn } from '../lib/utils'
import { renderRichContent } from './StaticBlock'

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
  const richCallbacks = useRichContentCallbacks()
  const toolbarRef = useRef<HTMLDivElement | null>(null)

  const focusIndex = useCallback((index: number) => {
    const root = toolbarRef.current
    if (!root) return
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-zoom-crumb]'))
    if (buttons.length === 0) return
    const clamped = Math.max(0, Math.min(buttons.length - 1, index))
    buttons[clamped]?.focus()
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const root = toolbarRef.current
      if (!root) return
      const buttons = Array.from(
        root.querySelectorAll<HTMLButtonElement>('button[data-zoom-crumb]'),
      )
      if (buttons.length === 0) return
      const active = document.activeElement as HTMLElement | null
      const currentIndex = active ? buttons.indexOf(active as HTMLButtonElement) : -1
      switch (e.key) {
        case 'ArrowRight': {
          e.preventDefault()
          const next = currentIndex < 0 ? 0 : Math.min(buttons.length - 1, currentIndex + 1)
          focusIndex(next)
          break
        }
        case 'ArrowLeft': {
          e.preventDefault()
          const prev = currentIndex < 0 ? 0 : Math.max(0, currentIndex - 1)
          focusIndex(prev)
          break
        }
        case 'Home': {
          e.preventDefault()
          focusIndex(0)
          break
        }
        case 'End': {
          e.preventDefault()
          focusIndex(buttons.length - 1)
          break
        }
        default:
          break
      }
    },
    [focusIndex],
  )

  if (breadcrumbs.length === 0) return null

  return (
    <ScrollArea className="border-b border-border/40">
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label={t('blockZoom.breadcrumbs')}
        aria-orientation="horizontal"
        onKeyDown={handleKeyDown}
        className="flex items-center gap-1 px-2 py-1.5 text-sm text-muted-foreground"
      >
        <button
          type="button"
          data-zoom-crumb="home"
          className="flex-shrink-0 hover:text-foreground transition-colors"
          onClick={onZoomToRoot}
          aria-label={t('block.zoomToRoot')}
        >
          <Home className="h-3.5 w-3.5" />
        </button>
        {breadcrumbs.map((item, i) => {
          const isLast = i === breadcrumbs.length - 1
          return (
            <Fragment key={item.id}>
              <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground/50" />
              <button
                type="button"
                data-zoom-crumb={item.id}
                aria-current={isLast ? 'location' : undefined}
                className={cn(
                  'truncate max-w-[200px] hover:text-foreground transition-colors',
                  isLast && 'text-foreground font-medium',
                )}
                onClick={() => (isLast ? undefined : onNavigate(item.id))}
              >
                {item.content
                  ? renderRichContent(item.content, { interactive: false, ...richCallbacks })
                  : t('block.untitled')}
              </button>
            </Fragment>
          )
        })}
      </div>
    </ScrollArea>
  )
}
