/**
 * `split_block` and `merge_blocks` (#6531): each runs the handlers of the ops
 * the backend appends in its one transaction, all or nothing.
 *
 * Twin of `src-tauri/src/commands/blocks/split_merge.rs`.
 */

import { blocksHandlers } from '@/lib/tauri-mock/handlers/blocks'
import {
  type Handler,
  type TypedHandlers,
  comparePositionThenId,
  invalidOperationRejection,
  notFoundRejection,
  ownerSpaceOf,
} from '@/lib/tauri-mock/handlers/shared'
import { allOrNothing, blocks } from '@/lib/tauri-mock/seed'

/** `ordered_live_children`. */
function liveChildIds(parentId: string | null): string[] {
  return [...blocks.values()]
    .filter((b) => ((b['parent_id'] as string | null) ?? null) === parentId && !b['deleted_at'])
    .toSorted(comparePositionThenId)
    .map((b) => b['id'] as string)
}

function requestOf(args: unknown): Record<string, unknown> {
  return (args as Record<string, unknown>)['request'] as Record<string, unknown>
}

export const splitMergeHandlers = {
  split_block: allOrNothing((args: unknown) => {
    const request = requestOf(args)
    const blockId = request['blockId'] as string
    const source = blocks.get(blockId)
    // `live_placement` reads the live row only.
    if (!source || source['deleted_at'] != null) {
      throw notFoundRejection(`block '${blockId}' (not found or deleted)`)
    }
    const parentId = (source['parent_id'] as string | null) ?? null
    const { op_refs: createRefs, ...created } = blocksHandlers.create_block({
      blockType: 'content',
      content: request['after'],
      parentId,
      index: liveChildIds(parentId).indexOf(blockId) + 1,
      blockId: request['newBlockId'],
      // A content block takes no space of its own; the mock's create reads one.
      scope: { kind: 'active', space_id: ownerSpaceOf(source) ?? 'unscoped' },
    })
    const { op_refs: editRefs, ...block } = blocksHandlers.edit_block({
      blockId,
      toText: request['before'],
      baseText: request['baseText'],
    })
    return { block, created, op_refs: [...createRefs, ...editRefs] }
  }),

  merge_blocks: allOrNothing((args: unknown) => {
    const request = requestOf(args)
    const blockId = request['blockId'] as string
    const intoId = request['intoId'] as string
    if (blockId === intoId) {
      throw invalidOperationRejection(`block '${blockId}' cannot be merged into itself`)
    }
    const { op_refs: editRefs, ...block } = blocksHandlers.edit_block({
      blockId: intoId,
      toText: request['mergedText'],
      baseText: request['baseText'],
    })
    const children = liveChildIds(blockId)
    // `validate_move_in_tx`, which the mock's batch move does not run.
    if (children.includes(intoId)) {
      throw invalidOperationRejection(`block '${intoId}' cannot be its own parent`)
    }
    const moved =
      children.length === 0
        ? { moves: [], op_refs: [] }
        : blocksHandlers.move_blocks_batch({
            blockIds: children,
            newParentId: intoId,
            newIndex: Number.MAX_SAFE_INTEGER,
          })
    const deleted = blocksHandlers.delete_block({ blockId })
    return {
      block,
      moves: moved.moves,
      op_refs: [...editRefs, ...moved.op_refs, ...deleted.op_refs],
    }
  }),
} satisfies Pick<TypedHandlers, 'split_block' | 'merge_blocks'> satisfies Record<string, Handler>
