/**
 * Page-move fan-out (#5248) — the one entry point for "these pages just left this space",
 * shared by `PageHeader`'s and `PageBrowserBatchToolbar`'s move to space.
 */

import { notifyPagesRemoved } from '@/lib/name-change-bus'
import { useResolveStore } from '@/stores/resolve'

/**
 * Stop `originSpaceId`'s `[[` picker offering the moved pages and render its chips to them
 * broken, as `@/stores/resolve` requires of any link between spaces. Call after the move
 * commits; `originSpaceId` is the space the pages LEFT, captured before the IPC.
 */
export function announcePagesMovedOut(
  pageIds: readonly string[],
  originSpaceId: string | null,
): void {
  notifyPagesRemoved(pageIds, originSpaceId)
  useResolveStore.getState().markMovedOut(originSpaceId, pageIds)
}
