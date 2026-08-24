/**
 * attachment-invalidation — module-level counter for attachment-row
 * mutations that happen OUTSIDE the attachment drawer's own handlers.
 *
 * #4335 review — `AttachmentList` (`useBlockAttachments` /
 * `BatchAttachmentsProvider`) has no TanStack Query cache to invalidate; it
 * is plain local state, refreshed only on `blockId` change or an explicit
 * `batchProvider.invalidate(blockId)` call, which `useBlockAttachments`
 * makes itself, from ITS OWN `handleDeleteAttachment` /
 * `handleRenameAttachment`, after their IPC resolves.
 *
 * A revert issued from the global History view (`commands.revertOps`,
 * `HistoryView.tsx`) or a point-in-time restore
 * (`commands.restorePageToOp`, `HistoryRestoreDialog.tsx`) mutates the
 * `attachments` table directly and bypasses those handlers entirely, so a
 * concurrently-mounted `AttachmentList` for the touched block would keep
 * showing pre-mutation data (e.g. the pre-revert filename of a reverted
 * `rename_attachment`) until something else happened to remount it.
 *
 * This is the smallest fix that closes that gap: a bumped counter any
 * mounted attachment-list consumer subscribes to and treats as "refetch
 * everything I'm currently showing". Mirrors the module-level
 * counter + subscriber-set shape of `graph-structure-events.ts` /
 * `block-property-events.ts`, minus the debounce — a revert/restore is a
 * single discrete user action, not keystroke-paced, so there is nothing to
 * coalesce.
 */

const subscribers = new Set<() => void>()
let generation = 0

/**
 * Synchronous snapshot of the current invalidation counter. This is the
 * snapshot fn used by `useSyncExternalStore`.
 */
export function getAttachmentInvalidationKey(): number {
  return generation
}

/**
 * Subscribe to invalidation bumps. Returns an unsubscribe fn.
 */
export function subscribeToAttachmentInvalidation(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * Record that attachment rows may have changed outside the normal
 * delete/rename handlers. Call AFTER the backend mutation commits.
 */
export function recordAttachmentInvalidation(): void {
  generation += 1
  for (const cb of subscribers) cb()
}

/**
 * Test-only reset. Imported directly by tests; not part of the public
 * surface.
 */
export function _resetAttachmentInvalidationForTest(): void {
  generation = 0
  subscribers.clear()
}
