/**
 * PageLink -- inline clickable page name that navigates to the page.
 *
 * Renders a `<span role="link">` that calls `navigateToPage` on click.
 * Uses `<span>` instead of `<button>` so it can be nested inside other
 * clickable containers (ResultCard buttons, list item buttons) without
 * violating HTML nesting rules. Calls `stopPropagation` so it works
 * inside parent click handlers.
 */

import type React from 'react'

import { usePagePrefetchIntent } from '@/hooks/usePagePrefetchIntent'
import { cn } from '@/lib/utils'
import { useTabsStore } from '@/stores/tabs'

export interface PageLinkProps {
  /** The page ID to navigate to. */
  pageId: string
  /** The page title (used for the navigation stack entry). */
  title: string
  /** Optional CSS class name. */
  className?: string
  /** Optional children — defaults to rendering the title text. */
  children?: React.ReactNode
}

export function PageLink({
  pageId,
  title,
  className,
  children,
}: PageLinkProps): React.ReactElement {
  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  // #2850 — hover/focus intent: warm this page's block subtree a beat
  // before the click actually lands. `schedule` debounces internally, and
  // `cancel` on leave/blur drops a hover that never dwelled long enough.
  const prefetchIntent = usePagePrefetchIntent()

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigateToPage(pageId, title)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      navigateToPage(pageId, title)
    }
  }

  return (
    <span
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- intentionally a <span> (see file header) so it can nest inside clickable button containers without invalid HTML; SPA nav has no href so <a> would gain nothing
      role="link"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => prefetchIntent.schedule(pageId)}
      onMouseLeave={prefetchIntent.cancel}
      onFocus={() => prefetchIntent.schedule(pageId)}
      onBlur={prefetchIntent.cancel}
      className={cn(
        'cursor-pointer hover:underline focus-ring-visible focus-visible:rounded-sm',
        className,
      )}
    >
      {children ?? title}
    </span>
  )
}
