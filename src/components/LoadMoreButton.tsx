/**
 * LoadMoreButton — shared "load more" pagination button.
 *
 * Renders a full-width outline button with optional loading spinner.
 * Hidden when `hasMore` is false. Used by LinkedReferences,
 * UnlinkedReferences, AgendaResults, PageBrowser, DonePanel, DuePanel.
 */

import { Loader2 } from 'lucide-react'
import type React from 'react'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'

export interface LoadMoreButtonProps {
  /** Whether there are more items to load. Button is hidden when false. */
  hasMore: boolean
  /** Whether a load is currently in progress. Disables button and shows spinner. */
  loading: boolean
  /** Callback to trigger loading the next page. */
  onLoadMore: () => void
  /** Optional additional CSS classes. */
  className?: string | undefined
  /** Text shown when not loading. Defaults to "Load more". */
  label?: string | undefined
  /** Text shown while loading. Defaults to "Loading…". */
  loadingLabel?: string | undefined
  /** Accessible label when idle. */
  ariaLabel?: string | undefined
  /** Accessible label while loading. */
  ariaLoadingLabel?: string | undefined
}

export function LoadMoreButton({
  hasMore,
  loading,
  onLoadMore,
  className,
  label = 'Load more',
  loadingLabel = 'Loading\u2026',
  ariaLabel,
  ariaLoadingLabel,
}: LoadMoreButtonProps): React.ReactElement | null {
  if (!hasMore) return null

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('w-full', className)}
      onClick={onLoadMore}
      disabled={loading}
      aria-busy={loading}
      aria-label={loading ? (ariaLoadingLabel ?? loadingLabel) : (ariaLabel ?? label)}
    >
      {loading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" data-testid="loader-spinner" /> {loadingLabel}
        </>
      ) : (
        label
      )}
    </Button>
  )
}
