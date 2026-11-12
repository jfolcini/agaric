/**
 * Leaked-empty-block cleanup: BlockTree's focus-change effect drops an empty
 * block when the user leaves it (#4729). Nothing else ever deletes these, and
 * many sit between blocks with content.
 *
 * A block with no text can still carry meaning, so a block is a candidate only
 * if all hold, mirroring the backend boot sweep:
 *
 *   1. it is a live `content` block                       (local)
 *   2. `content.trim() === ''`                             (local)
 *   3. it has no descendants                               (local)
 *   4. no `todo_state` / `priority` / `due_date` /
 *      `scheduled_date`                                    (local)
 *   5. no block properties, no tags and no attachments     (IPC)
 *   6. it is not referenced by another live block —
 *      no `((id))` block-ref, no `[[id]]` link             (IPC)
 *   7. deleting it would not leave the surface the user is
 *      looking at with nothing to click into               (local)
 *
 * Guard 7 has two arms: the page, and the zoom root, whose seeded empty child
 * (`useBlockZoomEmptySeed`) would be re-minted after every delete, churning ops.
 *
 * Local guards run first; only a blank, childless, metadata-free block pays
 * the IPCs, and only once a save of it that defers its text past an IPC has
 * landed (#5448). Every IPC failure keeps the block: the boot sweep is the
 * backstop.
 */

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { paginationLimit } from '@/lib/safe-limit'
import { requireActiveScope } from '@/lib/space-scope'
import { type FlatBlock, getDragDescendants } from '@/lib/tree-utils'
import { useBlockStore } from '@/stores/blocks'
import { settlePendingSaves } from '@/stores/unmount-flush'

/**
 * The page's last block when it is blank, childless and unfocused: "Add block"
 * puts the caret there, because a second blank block would strand it. The
 * blur cleanup only looks at the block focus leaves, so it never revisits this
 * one; a focused blank tail it drops when the new block takes focus. The flat
 * tree's tail is a direct child of the page only when it is childless.
 */
export function unfocusedBlankTail(blocks: readonly FlatBlock[], pageId: string): string | null {
  const last = blocks.at(-1)
  if (
    last?.parent_id === pageId &&
    last.id !== useBlockStore.getState().focusedBlockId &&
    last.block_type === 'content' &&
    (last.content ?? '').trim() === '' &&
    last.todo_state === null &&
    last.priority === null &&
    last.due_date === null &&
    last.scheduled_date === null
  ) {
    return last.id
  }
  return null
}

export interface EmptyBlockGuardInput {
  /** The page store's full flat tree (NOT the zoom/collapse projection). */
  blocks: readonly FlatBlock[]
  /** The block the user just left. */
  blockId: string
  /** Active zoom root, or `null` at page level. Guard 7's second arm. */
  zoomedBlockId: string | null
}

/**
 * The guards decidable from the page store alone (1-4 and 7). Also the
 * re-check after the IPCs in {@link deleteBlockIfLeakedEmpty}, since the tree
 * can change while they are awaited.
 */
export function isLeakedEmptyCandidate({
  blocks,
  blockId,
  zoomedBlockId,
}: EmptyBlockGuardInput): boolean {
  const block = blocks.find((b) => b.id === blockId)
  if (!block) return false

  // Guard 1 — a live content block; deleting a soft-deleted one twice would
  // append a second delete op.
  if (block.block_type !== 'content') return false
  if (block.deleted_at !== null) return false

  // Guard 2 — blank after trimming.
  if ((block.content ?? '').trim() !== '') return false

  // Guard 3 — no children: a blank parent is an outline node, and
  // `delete_block` cascades onto the subtree.
  const descendants = getDragDescendants(blocks, blockId)
  if (descendants.size > 0) return false

  // Guard 4 — a blank block with a date, a TODO or a priority is a real task.
  if (
    block.todo_state !== null ||
    block.priority !== null ||
    block.due_date !== null ||
    block.scheduled_date !== null
  ) {
    return false
  }

  // Guard 7a — not the page's last block.
  if (blocks.length <= 1) return false

  // Guard 7b — not the zoomed pane's last block.
  if (zoomedBlockId !== null && zoomedBlockId !== blockId) {
    const paneIds = getDragDescendants(blocks, zoomedBlockId)
    if (paneIds.has(blockId) && paneIds.size <= 1) return false
  }

  return true
}

/**
 * Guards 5 and 6, in parallel: `true` only when the block provably carries
 * nothing (`block_links` behind `get_backlinks` holds both `((id))` and
 * `[[id]]`). A failed query, or no active space, keeps the block. The backlink
 * probe is space-scoped (#5415): cross-space links are refused at write time,
 * and one a "Move to space" left behind already renders broken.
 */
async function carriesNothing(blockId: string, spaceId: string | null): Promise<boolean> {
  if (spaceId == null) return false
  try {
    const [properties, tags, attachments, backlinks] = await Promise.all([
      commands.getProperties(blockId).then(unwrap),
      commands.listTagsForBlock(blockId).then(unwrap),
      commands.listAttachments(blockId).then(unwrap),
      commands
        .getBacklinks(blockId, null, paginationLimit(1), requireActiveScope(spaceId))
        .then(unwrap),
    ])
    return (
      properties.length === 0 &&
      tags.length === 0 &&
      attachments.length === 0 &&
      backlinks.items.length === 0
    )
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
  /** The active space the backlink probe is scoped to; `null` keeps the block. */
  spaceId: string | null
  /**
   * The page store's `remove` (or BlockTree's verifying wrapper), so the
   * delete appends its `delete_block` op; a direct store write would be
   * reverted on the next sync.
   */
  remove: (blockId: string, options?: { undoable?: boolean }) => Promise<void>
  /** The live flat tree, read before the probe and again after it. */
  readBlocks: () => readonly FlatBlock[]
  /**
   * Whether the load hit `PAGE_SUBTREE_MAX_BLOCKS`. A truncated tree can show
   * a parent as childless, and `delete_block` would cascade onto a subtree
   * nobody could see, so the cleanup stands down.
   */
  isPageTruncated: () => boolean
  /**
   * Re-checked after the probe; `false` aborts. BlockTree passes "not focused
   * again", so a quick click away and back cannot delete under the caret.
   */
  isStillBlurred: () => boolean
}

/**
 * Delete `blockId` only if it is a leaked empty block; whether the delete was
 * dispatched. Never throws: the caller is a `useEffect`.
 */
export async function deleteBlockIfLeakedEmpty({
  blockId,
  zoomedBlockId,
  spaceId,
  remove,
  readBlocks,
  isPageTruncated,
  isStillBlurred,
}: DeleteIfLeakedEmptyParams): Promise<boolean> {
  // A window, tab or app switch blurs the editor too, but is not the user
  // leaving the block; `document.hasFocus()` is false only then.
  if (document.hasFocus() === false) return false

  // A truncated tree cannot answer "has children".
  if (isPageTruncated()) return false

  if (!isLeakedEmptyCandidate({ blocks: readBlocks(), blockId, zoomedBlockId })) return false

  // A typed `key:: value` or task marker is saved only after its IPC answers,
  // until when the block looks blank (#5448). Decide on the settled block.
  try {
    await settlePendingSaves(blockId)
  } catch (err: unknown) {
    logger.warn('emptyBlockCleanup', 'pending save rejected — keeping the block', { blockId }, err)
    return false
  }

  if (!(await carriesNothing(blockId, spaceId))) return false

  // Re-decide on the tree after the awaits.
  if (!isStillBlurred()) return false
  if (!isLeakedEmptyCandidate({ blocks: readBlocks(), blockId, zoomedBlockId })) return false

  try {
    // Housekeeping the user did not ask for: no undo entry, no lost redo
    // (#4729). The delete still syncs and lands in Trash.
    await remove(blockId, { undoable: false })
  } catch (err: unknown) {
    logger.warn('emptyBlockCleanup', 'failed to delete leaked empty block', { blockId }, err)
    return false
  }
  return true
}
