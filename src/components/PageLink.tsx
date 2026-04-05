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
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation'

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
  const navigateToPage = useNavigationStore((s) => s.navigateToPage)

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
    // biome-ignore lint/a11y/useSemanticElements: <a> cannot nest inside <button> (ResultCard, QueryResult)
    <span
      role="link"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn('cursor-pointer hover:underline', className)}
    >
      {children ?? title}
    </span>
  )
}
