/**
 * Leaked-empty-block cleanup — the drop-on-blur half of #4729 (Part 1).
 *
 * 47% of the live content blocks in a real vault are empty, and 203 of the 352
 * that sit under a page are INTERLEAVED rather than trailing (106 have real
 * content after them). Those are not cursor positions; nothing anywhere ever
 * deleted them. This module is the predicate + runner that BlockTree's
 * focus-change cleanup effect uses to drop such a block when the user leaves
 * it.
 *
 * ## "Empty" is not "blank content"
 *
 * A block with no text can still carry meaning, and deleting it would be data
 * loss. The predicate mirrors the backend boot sweep's (issue #4729, the
 * "Decision" comment) — a block is a candidate only if ALL of:
 *
 *   1. it is a live `content` block                       (local)
 *   2. `content.trim() === ''`                             (local)
 *   3. it has no descendants                               (local)
 *   4. no `todo_state` / `priority` / `due_date` /
 *      `scheduled_date`                                    (local)
 *   5. no block properties and no tags                     (IPC)
 *   6. it is not referenced by another live block —
 *      no `((id))` block-ref, no `[[id]]` link             (IPC)
 *   7. deleting it would not leave the surface the user is
 *      looking at with nothing to click into               (local)
 *
 * Guards 3-6 are NOT exercised by the reported vault (all 508 empties pass
 * them), which is exactly why each one has a test that constructs the case
 * explicitly — the data will never produce it.
 *
 * Guard 7 is the one that matters at scale: without it the sweep would leave
 * 216 pages with zero live children. It has two arms here, because the
 * frontend has a second surface the backend does not:
 *
 *   - the PAGE — a page with no block has nothing to click into;
 *   - the ZOOM ROOT — `useBlockZoomEmptySeed` seeds an empty child under a
 *     zoomed leaf so the pane is typable. Deleting that seed on blur would
 *     make the seed effect re-arm and mint a replacement, so every click-away
 *     would churn a delete op + a create op for no user-visible change.
 *
 * ## Ordering
 *
 * Local guards run first and reject the overwhelming majority for free; only a
 * genuinely blank, childless, metadata-free block pays the three IPCs. Every
 * IPC failure resolves to "keep the block" — the safe direction, since the
 * backend boot sweep is the backstop for anything blur misses.
 */

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { toSpaceScope } from '@/lib/space-scope'
import { type FlatBlock, getDragDescendants } from '@/lib/tree-utils'

export interface EmptyBlockGuardInput {
  /** The page store's full flat tree (NOT the zoom/collapse projection). */
  blocks: readonly FlatBlock[]
  /** The block the user just left. */
  blockId: string
  /** Active zoom root, or `null` at page level. Guard 7's second arm. */
  zoomedBlockId: string | null
}

/**
 * The guards decidable from the page store alone (1-4 and 7).
 *
 * Exported for the per-guard tests and reused as the post-IPC re-check in
 * {@link deleteBlockIfLeakedEmpty}: the three metadata queries are awaited, and
 * the tree can change under them (a sync load, an undo, the user coming back
 * and typing), so the decision is only acted on if it still holds afterwards.
 */
export function isLeakedEmptyCandidate({
  blocks,
  blockId,
  zoomedBlockId,
}: EmptyBlockGuardInput): boolean {
  const block = blocks.find((b) => b.id === blockId)
  if (!block) return false

  // Guard 1 — a live content block. Never a page/tag row, never one already
  // soft-deleted (deleting twice would append a second delete op).
  if (block.block_type !== 'content') return false
  if (block.deleted_at !== null) return false

  // Guard 2 — blank after trimming.
  if ((block.content ?? '').trim() !== '') return false

  // Guard 3 — no children. A blank parent is an outline node, not a leak, and
  // `delete_block` cascades onto the whole subtree.
  const descendants = getDragDescendants(blocks, blockId)
  if (descendants.size > 0) return false

  // Guard 4 — no task/date metadata. A block with a due date and no text is a
  // real (if badly named) task; the same goes for a bare TODO or a priority.
  if (
    block.todo_state !== null ||
    block.priority !== null ||
    block.due_date !== null ||
    block.scheduled_date !== null
  ) {
    return false
  }

  // Guard 7a — not the last remaining block of its page. A page with nothing
  // to click into is worse than a stray empty block.
  if (blocks.length <= 1) return false

  // Guard 7b — not the last remaining block of the zoomed pane (see the module
  // docstring: otherwise the #922 empty-zoom seed re-arms and churns ops).
  if (zoomedBlockId !== null && zoomedBlockId !== blockId) {
    const paneIds = getDragDescendants(blocks, zoomedBlockId)
    if (paneIds.has(blockId) && paneIds.size <= 1) return false
  }

  return true
}

/**
 * Guards 5 and 6 — the three metadata queries, run in parallel.
 *
 * Resolves `true` only when the block provably carries nothing: no
 * `block_properties` row, no tag, and no live block linking to it (the
 * `block_links` table backing `get_backlinks` holds both `((id))` block-refs
 * and `[[id]]` links). A rejected query resolves `false` — an unknown answer
 * must never authorise a delete.
 *
 * The backlink query uses the GLOBAL scope on purpose: a reference from
 * another space still means somebody is pointing at this block.
 */
async function carriesNothing(blockId: string): Promise<boolean> {
  try {
    const [properties, tags, backlinks] = await Promise.all([
      commands.getProperties(blockId).then(unwrap),
      commands.listTagsForBlock(blockId).then(unwrap),
      // limit 1 — presence is the whole question.
      commands.getBacklinks(blockId, null, 1, toSpaceScope(null)).then(unwrap),
    ])
    return properties.length === 0 && tags.length === 0 && backlinks.items.length === 0
  } catch (err: unknown) {
    logger.warn('emptyBlockCleanup', 'metadata probe failed — keeping the block', { blockId }, err)
    return false
  }
}

export interface DeleteIfLeakedEmptyParams {
  /** The block the user just left. */
  blockId: string
  /** Active zoom root, or `null` at page level. Guard 7's second arm. */
  zoomedBlockId: string | null
  /**
   * The page store's `remove` action (or BlockTree's verifying wrapper around
   * it). Deleting MUST go through it: it appends the `delete_block` op that
   * the Loro doc and the op log are projections of. A direct store mutation
   * would diverge and be reverted on the next sync.
   *
   * Called with `{ undoable: false }` — see the call in
   * {@link deleteBlockIfLeakedEmpty}.
   */
  remove: (blockId: string, options?: { undoable?: boolean }) => Promise<void>
  /**
   * Read the live flat tree. Called once up front and again after the metadata
   * probe resolves, so the decision is made on the tree as it is at each point
   * rather than on a snapshot captured before the round trip.
   */
  readBlocks: () => readonly FlatBlock[]
  /**
   * Whether the page loader hit its `PAGE_SUBTREE_MAX_BLOCKS` cap (the store's
   * `truncatedTotal !== null`). Guard 3 asks "does this block have children?"
   * of the LOADED tree; on a truncated page a nested child whose parent row was
   * cut is dropped by `buildFlatTree`, so a blank block could read as childless
   * and `delete_block` would cascade onto a subtree nobody could see. The whole
   * cleanup stands down on such a page — the backend sweep, which queries the
   * real table, is the backstop.
   */
  isPageTruncated: () => boolean
  /**
   * Re-checked after the probe: `false` aborts the delete. BlockTree passes
   * "the user has not focused this block again", so a quick click-away-and-back
   * during the IPC round trip cannot delete the block out from under a caret
   * that is already back inside it.
   */
  isStillBlurred: () => boolean
}

/**
 * Delete `blockId` if — and only if — it is a leaked empty block.
 *
 * Resolves `true` when the delete was dispatched, `false` when any guard held.
 * Never throws: the caller is a `useEffect`, and a rejected cleanup would be an
 * unhandled rejection.
 */
export async function deleteBlockIfLeakedEmpty({
  blockId,
  zoomedBlockId,
  remove,
  readBlocks,
  isPageTruncated,
  isStillBlurred,
}: DeleteIfLeakedEmptyParams): Promise<boolean> {
  // Window blur / tab switch / app background is NOT the user leaving a block.
  // The contenteditable's `blur` fires all the same, and deleting then is
  // user-hostile: they alt-tab away and come back to a vanished block with no
  // gesture of their own to blame. `document.hasFocus()` is false throughout
  // the blur that a window/tab/app switch causes and true for every in-app
  // focus move (block→block, block→whitespace, block→toolbar), which is
  // exactly the distinction. The block is left for the backend boot sweep.
  if (document.hasFocus() === false) return false

  // A capped page's flat tree is not a faithful answer to "has children".
  if (isPageTruncated()) return false

  if (!isLeakedEmptyCandidate({ blocks: readBlocks(), blockId, zoomedBlockId })) return false
  if (!(await carriesNothing(blockId))) return false

  // Re-decide on the post-await world (see `isLeakedEmptyCandidate`).
  if (!isStillBlurred()) return false
  if (!isLeakedEmptyCandidate({ blocks: readBlocks(), blockId, zoomedBlockId })) return false

  try {
    // `undoable: false` — this delete is HOUSEKEEPING. The user clicked away
    // from a blank block; they did not ask for a delete, and they must not
    // have to spend their next Ctrl+Z on undoing one they never saw (nor lose
    // a pending Ctrl+Y to it — `onNewAction` also clears the redo stack).
    // Everything else about the delete is unchanged: the `DeleteBlock` op is
    // appended, the row is soft-deleted, it syncs, and it is recoverable from
    // Trash — which is the right affordance for a cleanup.
    await remove(blockId, { undoable: false })
  } catch (err: unknown) {
    logger.warn('emptyBlockCleanup', 'failed to delete leaked empty block', { blockId }, err)
    return false
  }
  return true
}
