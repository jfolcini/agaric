/**
 * LoadMoreButton — shared "load more" pagination button.
 *
 * Renders a full-width outline button with optional loading spinner.
 * Hidden when `hasMore` is false. Used by LinkedReferences,
 * UnlinkedReferences, AgendaResults, PageBrowser, DonePanel, DuePanel.
 *
 * When both `loadedCount` and `totalCount` are provided, renders a
 * secondary progress line below the button ("Loaded X of Y") so users
 * can gauge the remaining result set (UX-218).
 */

import type React from 'react'
import { Spinner } from '@/components/ui/spinner'
import { t } from '@/lib/i18n'
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
  /** Number of items already loaded. Renders "Loaded X of Y" when paired with `totalCount`. */
  loadedCount?: number | undefined
  /** Total number of items available. Renders "Loaded X of Y" when paired with `loadedCount`. */
  totalCount?: number | undefined
}

export function LoadMoreButton({
  hasMore,
  loading,
  onLoadMore,
  className,
  label = t('action.loadMore'),
  loadingLabel = t('action.loading'),
  ariaLabel,
  ariaLoadingLabel,
  loadedCount,
  totalCount,
}: LoadMoreButtonProps): React.ReactElement | null {
  if (!hasMore) return null

  const showProgress =
    typeof loadedCount === 'number' &&
    typeof totalCount === 'number' &&
    totalCount > 0 &&
    loadedCount >= 0

  return (
    <div className={cn('flex flex-col items-stretch gap-1', className)}>
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={onLoadMore}
        disabled={loading}
        aria-busy={loading}
        aria-label={loading ? (ariaLoadingLabel ?? loadingLabel) : (ariaLabel ?? label)}
      >
        {loading ? (
          <>
            <Spinner data-testid="loader-spinner" /> {loadingLabel}
          </>
        ) : (
          label
        )}
      </Button>
      {showProgress && (
        <span
          className="text-xs text-muted-foreground text-center"
          data-testid="load-more-progress"
        >
          {t('loadMore.progress', { loaded: loadedCount, total: totalCount })}
        </span>
      )}
    </div>
  )
}
