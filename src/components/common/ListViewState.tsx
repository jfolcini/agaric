/**
 * ListViewState — shared component encapsulating the
 * loading→skeleton / error→retry / empty→EmptyState / loaded branching pattern.
 *
 * Eliminates the repetitive conditional found across 19+ list views.
 *
 * #3306 — the `error` branch is not optional decoration. Before it existed the
 * machine had no way to say "the load failed", so every consumer painted its
 * empty state over a failure: a settled error gave `loading === false` with
 * `items === []`, which is byte-identical to an empty list. The empty branch is
 * now reachable only on a settled SUCCESS.
 *
 * Usage:
 * ```tsx
 * <ListViewState
 *   loading={loading}
 *   items={items}
 *   error={isError && t('thing.loadFailed')}
 *   onRetry={refetch}
 *   empty={<EmptyState ... />}
 * >
 *   {(items) => <ul>{items.map(i => <li key={i.id}>{i.name}</li>)}</ul>}
 * </ListViewState>
 * ```
 */

import type React from 'react'

import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { t } from '@/lib/i18n'

/**
 * The error card `ListViewState` renders when a load has settled in failure.
 *
 * Modelled on the two sibling views that already got this right —
 * `HistoryView`'s `role="alert"` banner with a Retry button and
 * `SearchPanel`'s `search-error-state` / `search-error-retry` pair — so the
 * app has ONE presentation of "this list failed to load" instead of four.
 *
 * Exported because two list surfaces (`PageBrowser`) do their own
 * three-way branching inline rather than through `ListViewState`, and must
 * still render the identical card.
 */
export function ListErrorState({
  message,
  onRetry,
  testId = 'list-error-state',
}: {
  message?: string | undefined
  onRetry?: (() => void) | undefined
  testId?: string | undefined
}): React.ReactElement {
  return (
    <div
      className="flex items-start justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
      role="alert"
      data-testid={testId}
    >
      <p className="text-sm font-medium text-destructive">{message ?? t('error.loadFailed')}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} data-testid={`${testId}-retry`}>
          {t('action.retry')}
        </Button>
      )}
    </div>
  )
}

export interface ListViewStateProps<T> {
  /** Whether the data is currently being fetched. */
  loading: boolean
  /** The list of items to display. */
  items: T[]
  /**
   * Custom skeleton to show while loading and items are empty.
   * Pass `null` to skip the skeleton entirely (e.g. when it is handled elsewhere).
   * Defaults to `<LoadingSkeleton count={3} />`.
   */
  skeleton?: React.ReactNode
  /** Content shown when not loading and items are empty. */
  empty: React.ReactNode
  /**
   * Set when the last load SETTLED IN FAILURE (#3306).
   *
   * Without this the state machine had three states and no fourth for error,
   * so a failed load — `loading === false`, `items === []` — was
   * indistinguishable from an empty one and every consumer rendered its
   * "nothing here yet" copy with a "create your first…" CTA. A user with 5,000
   * pages was told their vault was empty and invited to start over; the same
   * failure on Trash read as "your trash is empty", which a user can
   * reasonably interpret as "my deleted items were purged". The only error
   * signal was a ~4s toast.
   *
   * Pass a translated message (each surface already owns a `*.loadFailed`
   * string) or `true` for the generic one. The empty branch is reachable only
   * on a settled SUCCESS once this is set.
   */
  error?: string | boolean | null | undefined
  /**
   * Re-run the failed load. Rendered as the Retry button on the error card —
   * `docs/UX.md` § UI primitives requires that error states include a way to
   * retry or recover. Omit only when the surface genuinely has no re-fetch.
   */
  onRetry?: (() => void) | undefined
  /** Render function called with the items array when there are items to display. */
  children: (items: T[]) => React.ReactNode
}

export function ListViewState<T>({
  loading,
  items,
  skeleton,
  empty,
  error,
  onRetry,
  children,
}: ListViewStateProps<T>): React.ReactElement | null {
  // 1. Loading with no items yet → show skeleton
  if (loading && items.length === 0) {
    if (skeleton === undefined) return <LoadingSkeleton count={3} />
    if (skeleton == null) return null
    return <>{skeleton}</>
  }

  // 2. Settled in failure with nothing to show → error card + retry.
  //    Checked BEFORE the empty branch: that ordering is the fix. Items
  //    already on screen are kept (a refresh that fails should not blank the
  //    list), so the branch is gated on there being nothing to fall back to.
  if (!loading && error && items.length === 0) {
    return (
      <ListErrorState message={typeof error === 'string' ? error : undefined} onRetry={onRetry} />
    )
  }

  // 3. Done loading, no error, no items → show empty state
  if (!loading && !error && items.length === 0) {
    return <>{empty}</>
  }

  // 4. Items available (possibly still loading more) → render children
  if (items.length > 0) {
    return <>{children(items)}</>
  }

  return null
}
