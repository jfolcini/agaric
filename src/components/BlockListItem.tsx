/**
 * BlockListItem — shared presentational component for rendering a block
 * in list views (DuePanel, DonePanel, AgendaResults).
 *
 * Renders a clickable `<li>` with a consistent layout:
 *   [metadata slot] → [truncated content] → [page breadcrumb]
 *
 * The `metadata` slot accepts arbitrary React nodes (icons, priority
 * badges, date chips) so each consumer can inject context-specific
 * elements without duplicating the surrounding structure.
 */

import type React from 'react'
import { cn } from '@/lib/utils'
import { truncateContent } from '../lib/text-utils'
import { PageLink } from './PageLink'

export interface BlockListItemProps {
  /** Block content text — truncated via truncateContent. */
  content: string | null
  /** Max characters before truncation. Default 120. */
  contentMaxLength?: number
  /** Fallback text when content is null/empty. Default "(empty)". */
  emptyContentFallback?: string
  /** Nodes rendered before the content text (icons, badges, chips). */
  metadata?: React.ReactNode
  /** Page ID for the breadcrumb. Hidden when nullish. */
  pageId?: string | null
  /** Page title shown in breadcrumb. */
  pageTitle?: string
  /** Arrow text before page title (e.g. "→"). Default "→". */
  breadcrumbArrow?: string
  /** Render breadcrumb title as a PageLink (true) or plain text (false). Default true. */
  breadcrumbAsLink?: boolean
  /** Click handler for the list item. */
  onClick?: () => void
  /** Keyboard handler for the list item. */
  onKeyDown?: (e: React.KeyboardEvent) => void
  /** Additional CSS classes appended to the `<li>`. */
  className?: string
  /** Additional CSS classes for the content `<span>`. */
  contentClassName?: string
  /** Additional CSS classes for the breadcrumb `<span>`. */
  breadcrumbClassName?: string
  /** data-testid for the `<li>`. */
  testId?: string
}

export function BlockListItem({
  content,
  contentMaxLength = 120,
  emptyContentFallback = '(empty)',
  metadata,
  pageId,
  pageTitle = '',
  breadcrumbArrow = '\u2192',
  breadcrumbAsLink = true,
  onClick,
  onKeyDown,
  className,
  contentClassName,
  breadcrumbClassName,
  testId,
}: BlockListItemProps): React.ReactElement {
  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors',
        className,
      )}
      data-testid={testId}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: li needs tabIndex for keyboard navigation
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {/* Metadata slot: icons, badges, chips */}
      {metadata}

      {/* Truncated block content */}
      <span className={cn('text-sm min-w-0 flex-1 truncate', contentClassName)}>
        {truncateContent(content, contentMaxLength, emptyContentFallback)}
      </span>

      {/* Source page breadcrumb */}
      {pageId && (
        <span
          className={cn('text-xs text-muted-foreground truncate max-w-[40%]', breadcrumbClassName)}
        >
          {breadcrumbArrow}{' '}
          {breadcrumbAsLink ? <PageLink pageId={pageId} title={pageTitle} /> : pageTitle}
        </span>
      )}
    </li>
  )
}
