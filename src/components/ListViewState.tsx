/**
 * ListViewState — shared component encapsulating the
 * loading→skeleton / empty→EmptyState / loaded branching pattern.
 *
 * Eliminates the repetitive three-way conditional found across 19+ list views.
 *
 * Usage:
 * ```tsx
 * <ListViewState loading={loading} items={items} empty={<EmptyState ... />}>
 *   {(items) => <ul>{items.map(i => <li key={i.id}>{i.name}</li>)}</ul>}
 * </ListViewState>
 * ```
 */

import type React from 'react'
import { LoadingSkeleton } from './LoadingSkeleton'

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
  /** Render function called with the items array when there are items to display. */
  children: (items: T[]) => React.ReactNode
}

export function ListViewState<T>({
  loading,
  items,
  skeleton,
  empty,
  children,
}: ListViewStateProps<T>): React.ReactElement | null {
  // 1. Loading with no items yet → show skeleton
  if (loading && items.length === 0) {
    if (skeleton === undefined) return <LoadingSkeleton count={3} />
    if (skeleton == null) return null
    return <>{skeleton}</>
  }

  // 2. Done loading, no items → show empty state
  if (!loading && items.length === 0) {
    return <>{empty}</>
  }

  // 3. Items available (possibly still loading more) → render children
  if (items.length > 0) {
    return <>{children(items)}</>
  }

  return null
}
