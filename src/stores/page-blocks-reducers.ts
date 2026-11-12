/**
 * Mutation reducers for the per-page block store. They close over the store's
 * `set`/`get` and the per-store helpers in `ReducerDeps`; `load` and the
 * initial state stay in `page-blocks.ts`, which owns the load generation.
 */

import type { StoreApi } from 'zustand'

import { retryOnPoolBusy, unwrap } from '@/lib/app-error'
import type { BlockRow, OpRef, PageSourceReport, PasteInput, PasteSplice } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { newBlockId } from '@/lib/block-id'
import {
  computeDedentedBlocks,
  computeIndentedBlocks,
  findPrevSiblingAt,
  indentTooDeep,
  planSplit,
} from '@/lib/block-tree-ops'
import { recordGraphStructureChange } from '@/lib/graph-structure-events'
import { i18n } from '@/lib/i18n'
import { clearListStyle, contentShowsListMarker } from '@/lib/list-style'
import { logger } from '@/lib/logger'
import { notifyPageAdded, notifyTagAdded } from '@/lib/name-change-bus'
import { notify } from '@/lib/notify'
import { invalidatePropertyCaches } from '@/lib/property-caches'
import { requireActiveScope } from '@/lib/space-scope'
import { buildIndexById, type FlatBlock, getDragDescendants } from '@/lib/tree-utils'
import {
  buildBlocksById,
  cloneBlocksByIdWith,
  cloneBlocksByIdWithout,
} from '@/stores/page-blocks-map'
import {
  applyProvisionalMove,
  reconcileBatchMove,
  reconcileProvisionalMoveSuccess,
  rollbackProvisionalMove,
} from '@/stores/page-blocks-move'
import type { DeleteBlockOptions, PageBlockState } from '@/stores/page-blocks-types'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

/**
 * Record a successful local write: push the undo entry (by the command's
 * `opRefs`) and bump the graph-structure signal, since any block write,
 * an edit included, can add or remove a `[[link]]` edge (#1530).
 *
 * `undoable: false` keeps the graph bump but skips undo entirely, entry and
 * redo invalidation both: housekeeping the user did not ask for (the
 * leaked-empty-block cleanup) must not take their next Ctrl+Z or Ctrl+Y
 * (#4729). `merge: false` starts an entry of its own (a paste; see
 * `onNewAction`).
 */
export function notifyUndoNewAction(
  rootParentId: string | null,
  opRefs: OpRef[],
  coalesceKey?: string,
  { undoable = true, merge = true }: { undoable?: boolean; merge?: boolean } = {},
): void {
  if (rootParentId && undoable) {
    const { onNewAction } = useUndoStore.getState()
    if (!merge) onNewAction(rootParentId, opRefs, coalesceKey, { merge })
    else if (coalesceKey !== undefined) onNewAction(rootParentId, opRefs, coalesceKey)
    else onNewAction(rootParentId, opRefs)
  }
  recordGraphStructureChange()
}

/**
 * A paste's `[[Title]]` or `#tag` naming nothing yet creates that page or tag,
 * listed ahead of the pasted content (#1484, #4338). Seed the resolve cache so
 * its chip shows the name at once, and tell the pickers in `spaceId`, so the
 * next `[[` offers the page instead of "Create new page".
 */
function announceCreatedNames(rows: readonly BlockRow[], spaceId: string | null): void {
  for (const row of rows) {
    if (row.block_type !== 'page' && row.block_type !== 'tag') continue
    const name = row.content ?? ''
    useResolveStore.getState().set(row.id, name, false)
    if (spaceId == null) continue
    if (row.block_type === 'page') notifyPageAdded(row.id, name, spaceId)
    else notifyTagAdded(row.id, name, spaceId)
  }
}

/**
 * `state` with one block's content replaced, copying that slot and key only,
 * so every other row keeps its object and skips its memoized render (#2200).
 */
function withContent(
  state: PageBlockState,
  blockId: string,
  content: string,
): Partial<PageBlockState> {
  const idx = state.blocks.findIndex((b) => b.id === blockId)
  if (idx < 0) return {}
  const edited = { ...(state.blocks[idx] as FlatBlock), content }
  const blocks = state.blocks.slice()
  blocks[idx] = edited
  return { blocks, blocksById: cloneBlocksByIdWith(state.blocksById, [edited]) }
}

/**
 * The block's 0-based slot among its same-parent siblings, in flat-tree order
 * (#400). Movers send slots and the backend assigns the dense rank, so the
 * frontend does no `position` arithmetic.
 */
function siblingSlot(blocks: FlatBlock[], block: FlatBlock): number {
  const parentId = block.parent_id ?? null
  const siblings = blocks.filter(
    (b) => (b.parent_id ?? null) === parentId && b.depth === block.depth,
  )
  return siblings.findIndex((b) => b.id === block.id)
}

type PageBlockSet = StoreApi<PageBlockState>['setState']

/**
 * Per-store dependencies. `set` is the raw initializer `set`, which keeps
 * `blocksById` itself and bypasses the `augmentBlocksUpdate` wrap on
 * `store.setState`.
 */
interface ReducerDeps {
  set: PageBlockSet
  get: () => PageBlockState
  splitInProgress: Set<string>
  createsInFlight: Map<string, Promise<void>>
  enqueueMove: <T>(blockId: string, run: () => Promise<T>) => Promise<T>
}

export function createReducers({
  set,
  get,
  splitInProgress,
  createsInFlight,
  enqueueMove,
}: ReducerDeps): Pick<
  PageBlockState,
  | 'createBelow'
  | 'edit'
  | 'remove'
  | 'splitBlock'
  | 'reorder'
  | 'moveToParent'
  | 'moveBlocks'
  | 'indent'
  | 'dedent'
  | 'moveUp'
  | 'moveDown'
  | 'pasteBlocks'
  | 'duplicateBlock'
  | 'applyPageSource'
  | 'appendBlock'
> {
  return {
    createBelow: async (afterBlockId: string, content = '', newId = newBlockId()) => {
      const { blocks, rootParentId } = get()
      const idx = blocks.findIndex((b) => b.id === afterBlockId)
      const afterBlock = blocks[idx]
      if (!afterBlock) return null

      const afterSlot = siblingSlot(blocks, afterBlock)

      // The id is minted client-side and the backend uses it verbatim, so the
      // row is spliced in before the IPC and focus never moves to a server id.
      // `position: null` heals to the backend's dense rank on success.
      const parentId = afterBlock.parent_id

      const handle = applyProvisionalMove(set, newId, (state) => {
        const cur = state.blocks
        const curIdx = cur.findIndex((b) => b.id === afterBlockId)
        const curAfter = cur[curIdx] as FlatBlock
        // After the anchor and all its descendants.
        const descendants = getDragDescendants(cur, afterBlockId)
        let insertIdx = curIdx + 1
        while (insertIdx < cur.length && descendants.has((cur[insertIdx] as FlatBlock).id)) {
          insertIdx++
        }
        const newBlock: FlatBlock = {
          id: newId,
          block_type: 'content',
          content,
          parent_id: curAfter.parent_id,
          position: null,
          deleted_at: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: curAfter.page_id,
          depth: curAfter.depth,
        }
        const newBlocks = [...cur]
        newBlocks.splice(insertIdx, 0, newBlock)
        return { blocks: newBlocks, touchedIds: [newBlock.id] }
      })

      const anchorCreate = createsInFlight.get(afterBlockId)
      let answered: () => void = () => undefined
      createsInFlight.set(
        newId,
        new Promise<void>((resolve) => {
          answered = resolve
        }),
      )
      // Settled once the create answers, before the reconcile or rollback
      // below: either may load(), which waits for the creates in flight.
      const settle = () => {
        createsInFlight.delete(newId)
        answered()
      }
      try {
        // The slot is the anchor's + 1, so the anchor's own create must land first.
        if (anchorCreate) await anchorCreate
        // No active space: refuse through the rollback below (#5415).
        const spaceId = useSpaceStore.getState().currentSpaceId
        if (spaceId == null) throw new Error('No active space; cannot create block')
        // A transient pool_busy blip must not lose the block (#730).
        const result = await retryOnPoolBusy(() =>
          commands
            .createBlock(
              'content',
              content,
              parentId ?? null,
              afterSlot + 1,
              requireActiveScope(spaceId),
              newId,
            )
            .then(unwrap),
        )
        settle()

        // Heal `position` to the backend's rank; a concurrent load() that
        // dropped or moved the provisional row reconciles by reloading.
        await reconcileProvisionalMoveSuccess(set, get, handle, result.position)
        notifyUndoNewAction(rootParentId, result.op_refs)
        return newId
      } catch (err) {
        settle()
        // Exact restore when nothing landed since; otherwise reload, so a write
        // built on the provisional block (an immediate indent) is not clobbered.
        await rollbackProvisionalMove(set, get, handle)
        logger.error('page-blocks', 'Failed to create block', { afterBlockId }, err)
        notify.error(i18n.t('error.createBlockFailed'))
        return null
      }
    },

    edit: async (blockId: string, content: string, { merge = true, undoGroup } = {}) => {
      const { rootParentId, blocksById } = get()
      const previousContent = blocksById.get(blockId)?.content
      // Copy only the edited slot and key: rows memo on block object identity,
      // and a whole-array walk or Map rebuild per keystroke fans out to every
      // mounted row (#2200).
      set((state) => withContent(state, blockId, content))
      try {
        const pendingCreate = createsInFlight.get(blockId)
        if (pendingCreate) await pendingCreate
        // Retry pool_busy before rolling back text the user can see (#730).
        const resp = await retryOnPoolBusy(() => commands.editBlock(blockId, content).then(unwrap))
        // Adopt the backend's normalized echo, unless a newer edit already
        // replaced the text this call wrote (#753).
        if (typeof resp?.content === 'string' && resp.content !== content) {
          set((state) => {
            const cur = state.blocksById.get(blockId)
            if (!cur || cur.content !== content) return {}
            const normalized = { ...cur, content: resp.content }
            const idx = state.blocks.findIndex((b) => b.id === blockId)
            if (idx < 0) return {}
            const blocks = state.blocks.slice()
            blocks[idx] = normalized
            return { blocks, blocksById: cloneBlocksByIdWith(state.blocksById, [normalized]) }
          })
        }
        // A list block whose text no longer opens with a paragraph leaves the
        // list (`showsListMarker`), once the text is saved; sync, undo and
        // restore go through `load()` and clear nothing. A failure here must not
        // roll back saved text. The clear joins the edit's undo entry (#6156).
        let opRefs = resp.op_refs
        try {
          if (
            previousContent !== undefined &&
            contentShowsListMarker(previousContent ?? '') &&
            !contentShowsListMarker(content)
          ) {
            opRefs = [...opRefs, ...(await clearListStyle(blockId))]
          }
        } catch (err) {
          logger.warn('page-blocks', 'clearing the list style failed', { blockId }, err)
        }
        // One undo entry per block's typing session (#2600). A `merge: false`
        // edit gets no key, so the typing after it does not join it either;
        // an `undoGroup` key joins edits of several blocks.
        const coalesceKey = undoGroup ?? (merge ? `edit:${blockId}` : undefined)
        notifyUndoNewAction(rootParentId, opRefs, coalesceKey, { merge })
        return true
      } catch (err) {
        // Roll back only if the live text is still what this edit wrote; a
        // newer edit must not be clobbered (#824).
        if (previousContent !== undefined) {
          set((state) => {
            const cur = state.blocksById.get(blockId)
            if (!cur || cur.content !== content) return {}
            const restored = { ...cur, content: previousContent }
            const idx = state.blocks.findIndex((b) => b.id === blockId)
            if (idx < 0) return {}
            const blocks = state.blocks.slice()
            blocks[idx] = restored
            return { blocks, blocksById: cloneBlocksByIdWith(state.blocksById, [restored]) }
          })
        }
        logger.error('page-blocks', 'Failed to edit block', { blockId }, err)
        notify.error(i18n.t('error.saveFailed'))
        return false
      }
    },

    remove: async (blockId: string, options?: DeleteBlockOptions) => {
      // Before the splice too: the create's reconcile would find the row gone
      // and reload the page.
      const pendingCreate = createsInFlight.get(blockId)
      if (pendingCreate) await pendingCreate
      const { rootParentId } = get()
      // Default: a user-initiated delete (#4729).
      const undoable = options?.undoable ?? true

      // Remove the block and its descendants before the IPC, snapshotting for
      // an exact rollback.
      let prevBlocks: FlatBlock[] | null = null
      let prevById: Map<string, FlatBlock> | null = null
      let provBlocks: FlatBlock[] | null = null
      let removedIds: string[] = [blockId]
      const spaceId = useSpaceStore.getState().currentSpaceId
      set((state) => {
        prevBlocks = state.blocks
        prevById = state.blocksById
        const descendants = getDragDescendants(state.blocks, blockId)
        removedIds = [blockId, ...descendants]
        const newBlocks = state.blocks.filter((b) => b.id !== blockId && !descendants.has(b.id))
        provBlocks = newBlocks
        return {
          blocks: newBlocks,
          blocksById: cloneBlocksByIdWithout(state.blocksById, [blockId, ...descendants]),
        }
      })

      try {
        const resp = await retryOnPoolBusy(() => commands.deleteBlock(blockId).then(unwrap))
        // A racing load() whose snapshot predated the delete may have restored
        // the block: remove it again, recomputing descendants from current
        // state (#2543).
        set((state) => {
          if (!state.blocksById.has(blockId)) return {}
          const descendants = getDragDescendants(state.blocks, blockId)
          const newBlocks = state.blocks.filter((b) => b.id !== blockId && !descendants.has(b.id))
          return {
            blocks: newBlocks,
            blocksById: cloneBlocksByIdWithout(state.blocksById, [blockId, ...descendants]),
          }
        })
        // Chips pointing into the removed subtree render deleted (#5246).
        useResolveStore.getState().markDeleted(spaceId, [...removedIds, ...resp.affected_page_ids])
        // Callers manage focus after remove() resolves.
        notifyUndoNewAction(rootParentId, resp.op_refs, undefined, { undoable })
      } catch (err) {
        // Exact restore when nothing landed since; otherwise reload, so a
        // concurrent write to the removed subtree is not clobbered.
        let needsReload = false
        set((state) => {
          if (state.blocks === provBlocks && prevBlocks != null && prevById != null) {
            return { blocks: prevBlocks, blocksById: prevById }
          }
          needsReload = true
          return {}
        })
        if (needsReload) await get().load()
        logger.error('page-blocks', 'Failed to delete block', { blockId }, err)
        notify.error(i18n.t('error.deleteBlockFailed'))
      }
    },

    // Resolves `true` only when the plan fully committed (a noop included).
    // The blur path's draft discard keeps the crash-recovery draft on `false`,
    // so a failed write must never resolve `true` (#2451).
    splitBlock: async (blockId: string, markdown: string): Promise<boolean> => {
      // A re-entrant duplicate persisted nothing; `false` is the safe answer.
      if (splitInProgress.has(blockId)) return false
      splitInProgress.add(blockId)
      try {
        const plan = planSplit(markdown)
        if (plan.kind === 'noop') return true
        if (plan.kind === 'edit-only') {
          return await get().edit(blockId, plan.content)
        }
        // Create the after-parts before shortening the original: a `[[link]]`
        // to another space is accepted only while a live block of this page
        // holds it (#5272). Any failure deletes what was created and leaves the
        // original whole, reporting `false` so the draft survives (#2913).
        const createdIds: string[] = []
        let lastId = blockId
        for (const content of plan.rest) {
          const newId = await get().createBelow(lastId, content)
          if (newId === null) {
            // createBelow logged + toasted.
            for (const id of createdIds) await get().remove(id)
            return false
          }
          createdIds.push(newId)
          lastId = newId
        }
        // A failed `edit()` restores the original, which the after-parts would
        // then duplicate.
        if (!(await get().edit(blockId, plan.first))) {
          for (const id of createdIds) await get().remove(id)
          return false
        }
        return true
      } finally {
        splitInProgress.delete(blockId)
      }
    },

    reorder: (blockId: string, newIndex: number) =>
      enqueueMove(blockId, async (): Promise<void> => {
        const { blocks, rootParentId } = get()
        const block = blocks.find((b) => b.id === blockId)
        if (!block) return
        const parentId = block.parent_id

        // `newIndex` is a slot among the block's other siblings, `siblingSlot`
        // counts self; at the block's own slot the two agree, so equality means
        // a no-op (#928).
        const currentSlot = siblingSlot(blocks, block)
        if (newIndex === currentSlot) return

        // A same-parent reorder splices locally before the IPC, without a
        // load() (#404); the rank heals on resolve.
        const handle = applyProvisionalMove(set, blockId, (state) => {
          const cur = state.blocks
          const curBlock = cur.find((b) => b.id === blockId) as FlatBlock
          const descendants = getDragDescendants(cur, blockId)
          const movedSet = new Set([blockId, ...descendants])
          const movedItems = cur.filter((b) => movedSet.has(b.id))
          const remaining = cur.filter((b) => !movedSet.has(b.id))
          // One id-to-index map for the repeated anchor lookups (#2041).
          const remainingIndex = buildIndexById(remaining)

          // The flat index of the `newIndex`-th sibling, or past the last
          // sibling's subtree.
          const siblingsRemaining = remaining.filter(
            (b) => (b.parent_id ?? null) === (parentId ?? null) && b.depth === curBlock.depth,
          )
          let insertAt: number
          if (newIndex >= siblingsRemaining.length) {
            const lastSib = siblingsRemaining.at(-1)
            if (lastSib) {
              const lastSibDesc = getDragDescendants(remaining, lastSib.id, remainingIndex)
              insertAt = (remainingIndex.get(lastSib.id) ?? -1) + 1
              while (
                insertAt < remaining.length &&
                lastSibDesc.has((remaining[insertAt] as FlatBlock).id)
              ) {
                insertAt++
              }
            } else {
              // No siblings left: right after the parent, or first at root.
              insertAt = parentId == null ? 0 : (remainingIndex.get(parentId) ?? -1) + 1
            }
          } else {
            const anchor = siblingsRemaining[newIndex] as FlatBlock
            insertAt = remainingIndex.get(anchor.id) ?? -1
          }

          const newBlocks = [...remaining]
          newBlocks.splice(insertAt, 0, ...movedItems)
          // Only order changed: nothing to touch in the Map.
          return { blocks: newBlocks, touchedIds: [] }
        })

        try {
          const resp = await retryOnPoolBusy(() =>
            commands.moveBlock(blockId, parentId, newIndex).then(unwrap),
          )

          // A different parent echoed means the guess was wrong: reload.
          if ((resp.new_parent_id ?? null) !== (parentId ?? null)) {
            await get().load()
            notifyUndoNewAction(rootParentId, resp.op_refs)
            return
          }

          await reconcileProvisionalMoveSuccess(set, get, handle, resp.new_position)
          notifyUndoNewAction(rootParentId, resp.op_refs)
        } catch (err) {
          await rollbackProvisionalMove(set, get, handle)
          logger.error('page-blocks', 'Failed to reorder block', { blockId }, err)
          notify.error(i18n.t('error.reorderBlockFailed'))
        }
      }),

    moveToParent: async (blockId: string, newParentId: string | null, newIndex: number) => {
      const { rootParentId, blocks } = get()

      // Splice optimistically only when the block is loaded and the target is
      // root or a loaded block outside the moved subtree (#2900); a caller can
      // still ask for its own subtree. Otherwise move, then reload.
      const block = blocks.find((b) => b.id === blockId)
      const descendants = block ? getDragDescendants(blocks, blockId) : null
      const newParentBlock = newParentId == null ? null : blocks.find((b) => b.id === newParentId)
      const canSplice =
        block != null &&
        descendants != null &&
        (newParentId == null ||
          (newParentBlock != null &&
            newParentBlock.id !== blockId &&
            !descendants.has(newParentBlock.id)))

      const handle = canSplice
        ? applyProvisionalMove(set, blockId, (state) => {
            const cur = state.blocks
            const curBlock = cur.find((b) => b.id === blockId) as FlatBlock
            const curDescendants = getDragDescendants(cur, blockId)
            const movedSet = new Set([blockId, ...curDescendants])

            const targetParent =
              newParentId == null
                ? null
                : (cur.find((p) => p.id === newParentId) as FlatBlock | undefined)
            const newDepth = newParentId == null ? 0 : (targetParent?.depth ?? curBlock.depth) + 1
            const delta = newDepth - curBlock.depth

            // The subtree shifts by `delta`; descendants keep their objects
            // when the depth does not change.
            const movedItems: FlatBlock[] = cur
              .filter((b) => movedSet.has(b.id))
              .map((b) => {
                if (b.id === blockId) {
                  return Object.assign({}, b, { depth: newDepth, parent_id: newParentId })
                }
                return delta === 0 ? b : Object.assign({}, b, { depth: b.depth + delta })
              })

            const remaining = cur.filter((b) => !movedSet.has(b.id))
            const remainingIndex = buildIndexById(remaining)

            // Sibling-slot insertion as in `reorder`, among the target's children.
            const siblingsRemaining = remaining.filter(
              (b) => (b.parent_id ?? null) === (newParentId ?? null) && b.depth === newDepth,
            )
            let insertAt: number
            if (newIndex >= siblingsRemaining.length) {
              const lastSib = siblingsRemaining.at(-1)
              if (lastSib) {
                const lastSibDesc = getDragDescendants(remaining, lastSib.id, remainingIndex)
                insertAt = (remainingIndex.get(lastSib.id) ?? -1) + 1
                while (
                  insertAt < remaining.length &&
                  lastSibDesc.has((remaining[insertAt] as FlatBlock).id)
                ) {
                  insertAt++
                }
              } else {
                // No siblings left: right after the parent, or first at root.
                insertAt = newParentId == null ? 0 : (remainingIndex.get(newParentId) ?? -1) + 1
              }
            } else {
              const anchor = siblingsRemaining[newIndex] as FlatBlock
              insertAt = remainingIndex.get(anchor.id) ?? -1
            }

            const newBlocks = [...remaining]
            newBlocks.splice(insertAt, 0, ...movedItems)
            return {
              blocks: newBlocks,
              touchedIds: delta === 0 ? [blockId] : [blockId, ...curDescendants],
            }
          })
        : null

      try {
        const resp = await retryOnPoolBusy(() =>
          commands.moveBlock(blockId, newParentId, newIndex).then(unwrap),
        )

        if (!handle) {
          await get().load()
          notifyUndoNewAction(rootParentId, resp.op_refs)
          return
        }

        // A different parent echoed means the guess was wrong: reload.
        if ((resp.new_parent_id ?? null) !== (newParentId ?? null)) {
          await get().load()
          notifyUndoNewAction(rootParentId, resp.op_refs)
          return
        }

        await reconcileProvisionalMoveSuccess(set, get, handle, resp.new_position)
        notifyUndoNewAction(rootParentId, resp.op_refs)
      } catch (err) {
        if (handle) await rollbackProvisionalMove(set, get, handle)
        logger.error(
          'page-blocks',
          'Failed to move block to new parent',
          {
            blockId,
          },
          err,
        )
        notify.error(i18n.t('error.moveBlockFailed'))
      }
    },

    moveBlocks: async (ids: string[], newParentId: string | null, newIndex: number) => {
      const { rootParentId } = get()
      if (ids.length === 0) return

      // Move in document order, so the run keeps its order; drop ids that
      // vanished mid-gesture.
      const order = new Map(get().blocks.map((b, i) => [b.id, i] as const))
      const ordered = ids
        .filter((id) => order.has(id))
        .toSorted((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      if (ordered.length === 0) return

      try {
        // One IPC lands the run at consecutive slots in one transaction (#2274).
        const resp = await retryOnPoolBusy(() =>
          commands.moveBlocksBatch(ordered, newParentId, newIndex).then(unwrap),
        )

        // Reconcile against commit-time state; null asks for a reload.
        let needsReload = false
        set((state) => {
          const next = reconcileBatchMove(state, resp.moves, ordered, newParentId, newIndex)
          if (!next) {
            needsReload = true
            return {}
          }
          return { blocks: next, blocksById: buildBlocksById(next) }
        })
        if (needsReload) await get().load()
        notifyUndoNewAction(rootParentId, resp.op_refs)
      } catch (err) {
        logger.error('page-blocks', 'Failed to move blocks', { ids, newParentId, newIndex }, err)
        notify.error(i18n.t('error.moveBlockFailed'))
        // No optimistic update and an all-or-nothing batch: nothing to roll
        // back, and restoring a snapshot would clobber concurrent writes.
      }
    },

    // Movers queue per block (`enqueueMove`, #774).
    indent: (blockId: string) =>
      enqueueMove(blockId, async (): Promise<boolean> => {
        const { blocks, rootParentId } = get()
        // One id-to-index map for both lookups (#2041).
        const blocksIndex = buildIndexById(blocks)
        const idx = blocksIndex.get(blockId) ?? -1
        if (idx <= 0) return false
        const block = blocks[idx]
        const prevSibling = findPrevSiblingAt(blocks, idx)
        if (!block || !prevSibling) return false

        // Refuse, not just IPC-reject, an indent past `MAX_BLOCK_DEPTH` (#928).
        if (indentTooDeep(blocks, blockId, prevSibling, blocksIndex)) {
          // A toast, so sighted users see why Tab did nothing; deduped across
          // key repeat (#976).
          notify.error(i18n.t('error.maxNestingReached'), { id: 'max-nesting-reached' })
          return false
        }

        // Indent appends: the slot is the previous sibling's child count.
        const prevChildCount = blocks.filter((b) => (b.parent_id ?? null) === prevSibling.id).length

        // `computeIndentedBlocks` gives the block `position: 1`, so indent
        // heals no position on resolve.
        const handle = applyProvisionalMove(set, blockId, (state) => {
          const cur = state.blocks
          const curPrev = cur.find((b) => b.id === prevSibling.id) as FlatBlock
          const newBlocks = computeIndentedBlocks(cur, blockId, curPrev)
          const descendantIds = getDragDescendants(cur, blockId)
          return { blocks: newBlocks, touchedIds: [blockId, ...descendantIds] }
        })

        try {
          const resp = await retryOnPoolBusy(() =>
            commands.moveBlock(blockId, prevSibling.id, prevChildCount).then(unwrap),
          )

          // A different parent echoed means the splice diverged: reload.
          if (resp.new_parent_id !== prevSibling.id) {
            await get().load()
            notifyUndoNewAction(rootParentId, resp.op_refs)
            return true
          }
          await reconcileProvisionalMoveSuccess(set, get, handle, null)
          notifyUndoNewAction(rootParentId, resp.op_refs)
          return true
        } catch (err) {
          await rollbackProvisionalMove(set, get, handle)
          logger.error('page-blocks', 'Failed to indent block', { blockId }, err)
          notify.error(i18n.t('error.indentBlockFailed'))
          return false
        }
      }),

    dedent: (blockId: string) =>
      enqueueMove(blockId, async (): Promise<boolean> => {
        const { blocks, blocksById, rootParentId } = get()
        const block = blocksById.get(blockId)
        if (!block?.parent_id) return false

        const parent = blocksById.get(block.parent_id)
        if (!parent) return false

        const newParentId = parent.parent_id
        // Dedent lands right after the parent among the grandparent's children.
        const newIndex = siblingSlot(blocks, parent) + 1

        const handle = applyProvisionalMove(set, blockId, (state) => {
          const next = computeDedentedBlocks(state.blocks, blockId, parent.id, newParentId)
          return { blocks: next, touchedIds: [blockId, ...getDragDescendants(next, blockId)] }
        })

        try {
          const resp = await retryOnPoolBusy(() =>
            commands.moveBlock(blockId, newParentId, newIndex).then(unwrap),
          )

          // A different parent echoed means the splice diverged: reload.
          if ((resp.new_parent_id ?? null) !== (newParentId ?? null)) {
            await get().load()
            notifyUndoNewAction(rootParentId, resp.op_refs)
            return true
          }

          await reconcileProvisionalMoveSuccess(set, get, handle, resp.new_position)
          notifyUndoNewAction(rootParentId, resp.op_refs)
          return true
        } catch (err) {
          await rollbackProvisionalMove(set, get, handle)
          logger.error('page-blocks', 'Failed to dedent block', { blockId }, err)
          notify.error(i18n.t('error.dedentBlockFailed'))
          return false
        }
      }),

    moveUp: (blockId: string) =>
      enqueueMove(blockId, async (): Promise<boolean> => {
        const { blocks, blocksById, rootParentId } = get()
        const block = blocksById.get(blockId)
        if (!block) return false

        const parentId = block.parent_id

        const siblings = blocks.filter(
          (b) => (b.parent_id ?? null) === (parentId ?? null) && b.depth === block.depth,
        )
        const sibIndex = siblings.findIndex((b) => b.id === blockId)
        if (sibIndex < 0) return false

        // A first child pops out to just before its parent (#922); a first
        // child at root has nowhere to go.
        if (sibIndex === 0) {
          if (parentId == null) return false
          const parent = blocksById.get(parentId)
          if (!parent) return false
          // Cross-parent: move, then reload.
          const newParentId = parent.parent_id ?? null
          const newIndex = siblingSlot(blocks, parent)
          try {
            const resp = await retryOnPoolBusy(() =>
              commands.moveBlock(blockId, newParentId, newIndex).then(unwrap),
            )
            await get().load()
            notifyUndoNewAction(rootParentId, resp.op_refs)
            return true
          } catch (err) {
            logger.error('page-blocks', 'Failed to move block up', { blockId }, err)
            notify.error(i18n.t('error.moveBlockUpFailed'))
            return false
          }
        }

        const prevSibling = siblings[sibIndex - 1] as FlatBlock
        // Swap with the previous sibling.
        const newIndex = sibIndex - 1

        const handle = applyProvisionalMove(set, blockId, (state) => {
          const cur = state.blocks
          const movedDescendants = getDragDescendants(cur, blockId)
          const movedSet = new Set([blockId, ...movedDescendants])
          const movedItems = cur.filter((b) => movedSet.has(b.id))
          const remaining = cur.filter((b) => !movedSet.has(b.id))
          // A block's descendants follow it in the flat array, so its index is
          // already before the whole subtree.
          const insertAt = remaining.findIndex((b) => b.id === prevSibling.id)
          const newBlocks = [...remaining]
          newBlocks.splice(insertAt, 0, ...movedItems)
          // Only order changed: nothing to touch in the Map.
          return { blocks: newBlocks, touchedIds: [] }
        })

        try {
          const resp = await retryOnPoolBusy(() =>
            commands.moveBlock(blockId, parentId, newIndex).then(unwrap),
          )

          if ((resp.new_parent_id ?? null) !== (parentId ?? null)) {
            await get().load()
          } else {
            await reconcileProvisionalMoveSuccess(set, get, handle, resp.new_position)
          }
          notifyUndoNewAction(rootParentId, resp.op_refs)
          return true
        } catch (err) {
          await rollbackProvisionalMove(set, get, handle)
          logger.error('page-blocks', 'Failed to move block up', { blockId }, err)
          notify.error(i18n.t('error.moveBlockUpFailed'))
          return false
        }
      }),

    moveDown: (blockId: string) =>
      enqueueMove(blockId, async (): Promise<boolean> => {
        const { blocks, blocksById, rootParentId } = get()
        const block = blocksById.get(blockId)
        if (!block) return false

        const parentId = block.parent_id

        const siblings = blocks.filter(
          (b) => (b.parent_id ?? null) === (parentId ?? null) && b.depth === block.depth,
        )
        const sibIndex = siblings.findIndex((b) => b.id === blockId)
        if (sibIndex < 0) return false

        // A last child pops out to just after its parent (#922); a last child
        // at root has nowhere to go.
        if (sibIndex >= siblings.length - 1) {
          if (parentId == null) return false
          const parent = blocksById.get(parentId)
          if (!parent) return false
          // Cross-parent: move, then reload.
          const newParentId = parent.parent_id ?? null
          const newIndex = siblingSlot(blocks, parent) + 1
          try {
            const resp = await retryOnPoolBusy(() =>
              commands.moveBlock(blockId, newParentId, newIndex).then(unwrap),
            )
            await get().load()
            notifyUndoNewAction(rootParentId, resp.op_refs)
            return true
          } catch (err) {
            logger.error('page-blocks', 'Failed to move block down', { blockId }, err)
            notify.error(i18n.t('error.moveBlockDownFailed'))
            return false
          }
        }

        const nextSibling = siblings[sibIndex + 1] as FlatBlock
        // Slots exclude the block: once it vacates `sibIndex` the next sibling
        // slides there, so landing after it is `sibIndex + 1`.
        const newIndex = sibIndex + 1

        const handle = applyProvisionalMove(set, blockId, (state) => {
          const cur = state.blocks
          // Re-insert after the next sibling's subtree.
          const movedDescendants = getDragDescendants(cur, blockId)
          const movedSet = new Set([blockId, ...movedDescendants])
          const movedItems = cur.filter((b) => movedSet.has(b.id))
          const remaining = cur.filter((b) => !movedSet.has(b.id))
          const remainingIndex = buildIndexById(remaining)
          const nextDescendants = getDragDescendants(remaining, nextSibling.id, remainingIndex)
          let insertAt = (remainingIndex.get(nextSibling.id) ?? -1) + 1
          while (
            insertAt < remaining.length &&
            nextDescendants.has((remaining[insertAt] as FlatBlock).id)
          ) {
            insertAt++
          }
          const newBlocks = [...remaining]
          newBlocks.splice(insertAt, 0, ...movedItems)
          // Only order changed: nothing to touch in the Map.
          return { blocks: newBlocks, touchedIds: [] }
        })

        try {
          const resp = await retryOnPoolBusy(() =>
            commands.moveBlock(blockId, parentId, newIndex).then(unwrap),
          )

          if ((resp.new_parent_id ?? null) !== (parentId ?? null)) {
            await get().load()
          } else {
            await reconcileProvisionalMoveSuccess(set, get, handle, resp.new_position)
          }
          notifyUndoNewAction(rootParentId, resp.op_refs)
          return true
        } catch (err) {
          await rollbackProvisionalMove(set, get, handle)
          logger.error('page-blocks', 'Failed to move block down', { blockId }, err)
          notify.error(i18n.t('error.moveBlockDownFailed'))
          return false
        }
      }),

    pasteBlocks: async (
      anchorBlockId: string,
      input: PasteInput,
      splice?: PasteSplice,
      onSpliced?: (content: string) => void,
    ) => {
      const { blocksById, rootParentId } = get()
      if (!blocksById.has(anchorBlockId)) return []
      // The pickers hear of created names in the space the paste was made in (#4391).
      const spaceId = useSpaceStore.getState().currentSpaceId
      try {
        const resp = await retryOnPoolBusy(() =>
          commands.pasteBlocks(anchorBlockId, input, splice ?? null).then(unwrap),
        )
        notifyUndoNewAction(rootParentId, resp.op_refs, undefined, { merge: false })
        announceCreatedNames(resp.blocks, spaceId)
        // A property line the paste kept as text, named (#5160).
        if (resp.warnings.length > 0) {
          notify.warning(i18n.t('blockTree.pasteKeptAsText'), {
            description: resp.warnings.join('\n'),
          })
        }
        const anchor = splice ? resp.blocks.find((b) => b.id === anchorBlockId) : undefined
        if (anchor) {
          // Before the reload, which keeps a focused block's text as the store holds it.
          const content = anchor.content ?? ''
          set((state) => withContent(state, anchorBlockId, content))
          onSpliced?.(content)
        }
        await get().load()
        return resp.blocks.filter((b) => b.block_type === 'content').map((b) => b.id)
      } catch (err) {
        logger.error('page-blocks', 'Failed to paste blocks', { anchorBlockId }, err)
        notify.error(i18n.t('error.pasteBlocksFailed'))
        return []
      }
    },

    duplicateBlock: async (blockId: string) => {
      const { blocksById, rootParentId } = get()
      if (!blocksById.has(blockId)) return
      try {
        const resp = await retryOnPoolBusy(() => commands.duplicateBlock(blockId).then(unwrap))
        notifyUndoNewAction(rootParentId, resp.op_refs)
        await get().load()
      } catch (err) {
        logger.error('page-blocks', 'Failed to duplicate block', { blockId }, err)
        notify.error(i18n.t('blockTree.duplicateFailed'))
      }
    },

    applyPageSource: async (
      source: string,
      baseSource: string,
      merge: boolean,
      lineIds: Array<string | null>,
    ): Promise<PageSourceReport> => {
      const { rootParentId } = get()
      if (rootParentId == null) throw new Error('applyPageSource needs a page')
      // As in `pasteBlocks` (#4391).
      const spaceId = useSpaceStore.getState().currentSpaceId
      const resp = await retryOnPoolBusy(() =>
        commands.applyPageSource(rootParentId, source, baseSource, merge, lineIds).then(unwrap),
      )
      notifyUndoNewAction(rootParentId, resp.op_refs)
      announceCreatedNames(resp.names_created, spaceId)
      invalidatePropertyCaches()
      await get().load()
      return resp
    },

    appendBlock: (row: BlockRow) => {
      // The caller creates directly under the page, so depth 0.
      const newBlock: FlatBlock = { ...row, depth: 0 }
      // Derive the array and the Map from the same commit-time state.
      set((state) => ({
        blocks: [...state.blocks, newBlock],
        blocksById: cloneBlocksByIdWith(state.blocksById, [newBlock]),
      }))
      // The caller owns undo, so bump the graph signal here.
      recordGraphStructureChange()
    },
  }
}
