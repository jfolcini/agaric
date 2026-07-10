/**
 * Mutation reducers for the per-page block store (#2254).
 *
 * Extracted verbatim from `page-blocks.ts` — behavior-preserving move. Every
 * reducer keeps its exact logic and closes over the store's `set`/`get` plus
 * two per-store helpers created by the factory (`splitInProgress`,
 * `enqueueMove`), passed in via `ReducerDeps`. The store core spreads
 * `createReducers({ set, get, splitInProgress, enqueueMove })` into its
 * `createStore` initializer, so the reducers wire in with an unchanged public
 * API. The `load` reducer and initial state stay in the core (they close over
 * the private `loadGeneration` counter).
 */

import type { StoreApi } from 'zustand'

import { notify } from '@/lib/notify'

import { retryOnPoolBusy } from '../lib/app-error'
import { internalizeRefTokens, parseIndentedMarkdown } from '../lib/block-clipboard'
import { computeIndentedBlocks, findPrevSiblingAt, planSplit } from '../lib/block-tree-ops'
import { recordGraphStructureChange } from '../lib/graph-structure-events'
import { i18n } from '../lib/i18n'
import { logger } from '../lib/logger'
import { buildImportRefInternalizers } from '../lib/paste-internalize'
import type { BlockRow, CreateBlockSpec } from '../lib/tauri'
import {
  createBlock,
  createBlocksBatch,
  deleteBlock,
  editBlock,
  moveBlock,
  moveBlocksBatch,
} from '../lib/tauri'
import {
  buildIndexById,
  getDragDescendants,
  MAX_BLOCK_DEPTH,
  type FlatBlock,
} from '../lib/tree-utils'
import { buildBlocksById, cloneBlocksByIdWith, cloneBlocksByIdWithout } from './page-blocks-map'
import { applyStructuralMove, reconcileBatchMove } from './page-blocks-move'
import type { PageBlockState } from './page-blocks-types'
import { useUndoStore } from './undo'

/**
 * Notify the undo store that a new action occurred on the given page, and bump
 * the graph-structure mutation signal.
 *
 * #1530: every local block/link/page CRUD op (`createBelow`, `edit`, `remove`,
 * `reorder`, `moveToParent`, `moveBlocks`, `indent`, `dedent`, `moveUp`,
 * `moveDown`, `splitBlock`, `pasteBlocks`) funnels through here after a
 * successful write, so it is the single funnel for "this page's block/link
 * structure just changed locally." `edit` is included deliberately — editing a
 * block's text can add or remove a `[[link]]`, which is a graph EDGE. Bumping
 * the structure counter here invalidates `GraphView`'s cache so the next graph
 * read reflects the new nodes/edges instead of stale data until the TTL. The
 * `appendBlock` path bumps it separately because that path does not call this
 * helper (its caller owns the undo notification).
 */
function notifyUndoNewAction(rootParentId: string | null): void {
  if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
  recordGraphStructureChange()
}

/**
 * #400 — compute the 0-based sibling slot of a block among its same-parent
 * siblings (excluding the block itself), reading the current flat-tree order.
 *
 * The slot is the index the block currently occupies in the ordered list of
 * its siblings. Callers use it to derive the target slot for a sibling-swap
 * (moveUp = slot - 1; moveDown = slot + 1 once the block has vacated its own
 * slot) without any `position`-integer arithmetic — the backend assigns the
 * dense rank from the slot.
 */
function siblingSlot(blocks: FlatBlock[], block: FlatBlock): number {
  const parentId = block.parent_id ?? null
  const siblings = blocks.filter(
    (b) => (b.parent_id ?? null) === parentId && b.depth === block.depth,
  )
  return siblings.findIndex((b) => b.id === block.id)
}

/** Zustand `set` for the page-block store (functional + object partial forms). */
type PageBlockSet = StoreApi<PageBlockState>['setState']

/**
 * Per-store dependencies the reducers close over. `set`/`get` are the raw
 * `createStore` initializer args (the un-wrapped `set`, so internal writes keep
 * bypassing the `augmentBlocksUpdate` wrap on `store.setState`, as before).
 * `splitInProgress` and `enqueueMove` are created once per store by the factory.
 */
interface ReducerDeps {
  set: PageBlockSet
  get: () => PageBlockState
  splitInProgress: Set<string>
  enqueueMove: <T>(blockId: string, run: () => Promise<T>) => Promise<T>
}

/** Build the store's mutation reducers. See module doc + `ReducerDeps`. */
export function createReducers({
  set,
  get,
  splitInProgress,
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
  | 'appendBlock'
> {
  return {
    createBelow: async (afterBlockId: string, content = '') => {
      const { blocks, rootParentId } = get()
      const idx = blocks.findIndex((b) => b.id === afterBlockId)
      const afterBlock = blocks[idx]
      if (!afterBlock) return null

      // #400: insert at the slot right after `afterBlock` among its siblings.
      const afterSlot = siblingSlot(blocks, afterBlock)

      try {
        // #730 — route through the shared pool_busy retry so a transient
        // connection-pool blip doesn't surface as a create failure / lost
        // block. retryOnPoolBusy re-throws every non-pool_busy error
        // unchanged, so the catch below behaves identically for real errors.
        const result = await retryOnPoolBusy(() =>
          createBlock({
            blockType: 'content',
            content,
            ...(afterBlock.parent_id != null && { parentId: afterBlock.parent_id }),
            index: afterSlot + 1,
          }),
        )

        // #714 — recompute the insertion splice INSIDE the functional updater
        // from `state.blocks` (current at commit time), never from the
        // pre-await capture: a concurrent write (edit flush, sync load,
        // queued move) that landed while the IPC was in flight must survive.
        // The anchor (`afterBlockId`) is re-located in current state; if it
        // vanished or moved mid-flight the splice context is invalid, so we
        // fall back to a full load() to reconcile with the backend.
        // #1077 — shared recompute-at-commit + reconcile-or-reload core.
        await applyStructuralMove(set, get, {
          validateAtCommit: (state) => {
            const curIdx = state.blocks.findIndex((b) => b.id === afterBlockId)
            const curAfter = state.blocks[curIdx]
            if (!curAfter) return { kind: 'reload' }
            // If an interleaved sync load() already delivered the freshly
            // created block (the backend committed it before the snapshot
            // query ran), splicing it again would duplicate the array entry
            // and break the blocks/blocksById size invariant. State is
            // already reconciled — commit nothing (no reload).
            if (state.blocksById.has(result.id)) return { kind: 'skip' }
            // The anchor was re-parented mid-flight (or the backend echoed an
            // unexpected parent): the new block belongs under the anchor's
            // ORIGINAL parent, so splicing it after the anchor's new location
            // would break array-order/parent_id consistency. Reload instead.
            if ((result.parent_id ?? null) !== (curAfter.parent_id ?? null)) {
              return { kind: 'reload' }
            }
            return { kind: 'commit' }
          },
          computeSpliced: (state) => {
            const cur = state.blocks
            const curIdx = cur.findIndex((b) => b.id === afterBlockId)
            const curAfter = cur[curIdx] as FlatBlock
            // Insert the new block into the local array at the right position.
            // In a flat tree, the new sibling goes right after the afterBlock
            // and all its descendants.
            const descendants = getDragDescendants(cur, afterBlockId)
            let insertIdx = curIdx + 1
            while (insertIdx < cur.length && descendants.has((cur[insertIdx] as FlatBlock).id)) {
              insertIdx++
            }

            const newBlock: FlatBlock = {
              id: result.id,
              block_type: result.block_type,
              content: result.content,
              parent_id: result.parent_id,
              position: result.position,
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
            // Single-block insert (perf invariant): only the new block's key.
            return { blocks: newBlocks, touchedIds: [newBlock.id] }
          },
        })
        notifyUndoNewAction(rootParentId)
        return result.id
      } catch (err) {
        logger.error('page-blocks', 'Failed to create block', { afterBlockId }, err)
        notify.error(i18n.t('error.createBlockFailed'))
        return null
      }
    },

    edit: async (blockId: string, content: string) => {
      const { rootParentId, blocksById } = get()
      const previousContent = blocksById.get(blockId)?.content
      // Single-block-edit hot path (perf-review Tier 1 #2, #2200): re-allocating
      // the entire Map per keystroke fans out to every mounted EditableBlock on a
      // 2000-block page. Derive `blocksById` from the previous Map and touch
      // only the edited key — full-scan `buildBlocksById` is reserved for
      // bulk paths (see invariant comment on `buildBlocksById`). Likewise for
      // `blocks`: locate the edited slot once (`findIndex`, short-circuits at
      // the match) and copy-on-write only that index (`slice()` + a single
      // assignment) instead of walking the WHOLE array through a per-element
      // `.map()` callback on every keystroke. Unchanged entries keep their
      // exact prior object reference either way (`.map()`'s `return b` already
      // did that) — the win is dropping the N-callback-invocation walk, not
      // the top-level array copy: the array reference still MUST change so
      // Zustand/React see the update, and downstream per-row `React.memo`
      // (SortableBlock/EditableBlock) keys off each BLOCK OBJECT's identity,
      // which this preserves for every entry but the edited one.
      set((state) => {
        const idx = state.blocks.findIndex((b) => b.id === blockId)
        if (idx < 0) return {}
        const edited = { ...(state.blocks[idx] as FlatBlock), content }
        const blocks = state.blocks.slice()
        blocks[idx] = edited
        return { blocks, blocksById: cloneBlocksByIdWith(state.blocksById, [edited]) }
      })
      try {
        // #730 — retry a transient pool_busy blip before reverting visible
        // user text. Without this a 50ms back-pressure spike rolled the
        // optimistic edit back and toasted "save failed" for text the user
        // can still see on screen.
        const resp = await retryOnPoolBusy(() => editBlock(blockId, content))
        // #753 — adopt the backend echo instead of discarding it. The
        // optimistic update above wrote the raw text we SENT; the backend
        // may normalize it (`edit_block` echoes the canonical BlockRow),
        // and dropping the echo left store and backend diverged until the
        // next full load(). Mirrors reorder's resp handling: recompute
        // inside the functional updater at commit time, and only adopt
        // when the block still holds the content this call wrote — a
        // newer in-flight edit must win over this echo.
        if (typeof resp?.content === 'string' && resp.content !== content) {
          set((state) => {
            const cur = state.blocksById.get(blockId)
            if (!cur || cur.content !== content) return {}
            const normalized = { ...cur, content: resp.content }
            // Same single-slot copy-on-write as the optimistic update above —
            // avoid the full `.map()` walk for a one-block touch.
            const idx = state.blocks.findIndex((b) => b.id === blockId)
            if (idx < 0) return {}
            const blocks = state.blocks.slice()
            blocks[idx] = normalized
            return { blocks, blocksById: cloneBlocksByIdWith(state.blocksById, [normalized]) }
          })
        }
        notifyUndoNewAction(rootParentId)
        return true
      } catch (err) {
        // Rollback optimistic update — also a single-block touch.
        // #824 — mirror the #753 success-path guard (`cur.content !== content`):
        // only roll back to `previousContent` if the live content is still the
        // text THIS edit optimistically wrote. If the user has typed past it
        // (a newer in-flight edit), restoring `previousContent` would clobber
        // that newer text — so leave it and just surface the failure toast.
        if (previousContent !== undefined) {
          set((state) => {
            const cur = state.blocksById.get(blockId)
            if (!cur || cur.content !== content) return {}
            const restored = { ...cur, content: previousContent }
            // Same single-slot copy-on-write as the optimistic update above —
            // avoid the full `.map()` walk for a one-block touch.
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

    remove: async (blockId: string) => {
      const { rootParentId } = get()
      try {
        // #730 — pool_busy retry (see edit/createBelow).
        await retryOnPoolBusy(() => deleteBlock(blockId))
        // #714 — recompute the descendant set INSIDE the functional updater
        // from `state.blocks` (current at commit time), never from the
        // pre-await capture: a concurrent structural change (reparent,
        // move) that lands while delete_block is in flight must be
        // reflected in which blocks actually get removed locally. A
        // pre-await snapshot would either strand a since-reparented block
        // with a dangling parent (backend cascade-deleted it, FE kept it)
        // or delete a block that was dedented OUT of this subtree mid-
        // flight (backend kept it alive, FE would drop a live block).
        // Few-block delete (perf invariant): touch only the removed keys
        // on the prior Map; the remaining `n - k` entries are reused as-is.
        set((state) => {
          const descendants = getDragDescendants(state.blocks, blockId)
          const newBlocks = state.blocks.filter((b) => b.id !== blockId && !descendants.has(b.id))
          return {
            blocks: newBlocks,
            blocksById: cloneBlocksByIdWithout(state.blocksById, [blockId, ...descendants]),
          }
        })
        // Focus/selection cleanup is the caller's responsibility — all current
        // callers (handleDeleteBlock, handleMerge*, handleEscapeCancel, BlockTree
        // empty-block cleanup) explicitly manage focus after remove() resolves.
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        logger.error('page-blocks', 'Failed to delete block', { blockId }, err)
        notify.error(i18n.t('error.deleteBlockFailed'))
      }
    },

    // Resolves `true` only when the plan FULLY committed (noop counts — there
    // was nothing to persist). `false` on any failed write, mirroring edit()'s
    // resolve-false contract: the blur path forwards this outcome to
    // `discardDraft`, whose `ok === false` gate keeps the crash-recovery
    // draft row alive when the typed text did not reach the DB (#2451 review
    // — a void resolution slipped past that gate and deleted the draft even
    // when the first-line write failed, the #2407 content-loss class on the
    // split path).
    splitBlock: async (blockId: string, markdown: string): Promise<boolean> => {
      // Re-entrant duplicate: the first in-flight split owns the writes and
      // its own outcome; this call persisted nothing, so report false (the
      // safe direction for a draft-discard gate).
      if (splitInProgress.has(blockId)) return false
      splitInProgress.add(blockId)
      try {
        const plan = planSplit(markdown)
        if (plan.kind === 'noop') return true
        if (plan.kind === 'edit-only') {
          return await get().edit(blockId, plan.content)
        }
        // Capture the pre-edit content so we can roll back the optimistic
        // local update if the FIRST `createBelow` fails after `edit` already
        // committed `plan.first` to local state. Without this, a partial-
        // failure split silently truncates the original block to `plan.first`
        // and the user's later content (`plan.rest`) is lost. If a later
        // `createBelow` fails (e.g. block-3 creation in a 4-line split after
        // blocks 1+2 succeeded), we leave the partial valid state alone —
        // rolling back at that point would orphan the already-created blocks.
        const previousContent = get().blocksById.get(blockId)?.content
        // #730 — `edit()` resolves `false` (and rolls its optimistic update
        // back internally) when the first-line write fails. The old code
        // ignored that boolean and proceeded to create every `plan.rest`
        // line below the reverted original — duplicating the user's pasted
        // content. Abort the split before creating anything if the first
        // edit didn't commit; the original block keeps its pre-paste content
        // (edit() already restored it) and nothing downstream is created.
        if (!(await get().edit(blockId, plan.first))) return false
        let lastId = blockId
        for (const content of plan.rest) {
          const newId = await get().createBelow(lastId, content)
          if (newId === null) {
            // createBelow failed (it logged + toasted internally). Only roll
            // back when no new blocks were created yet — the `lastId === blockId`
            // check is the durable signal for "first iteration failed."
            if (lastId === blockId && previousContent !== undefined) {
              // Single-block rollback (perf invariant): touch only the
              // restored key on the prior Map.
              set((state) => {
                let restored: FlatBlock | null = null
                const blocks = state.blocks.map((b) => {
                  if (b.id !== blockId) return b
                  const next = { ...b, content: previousContent }
                  restored = next
                  return next
                })
                if (restored == null) return { blocks }
                return {
                  blocks,
                  blocksById: cloneBlocksByIdWith(state.blocksById, [restored]),
                }
              })
            }
            // Some of the typed lines never reached the DB — report failure
            // so the blur path keeps the draft (which holds the FULL
            // unsplit markdown) for recovery.
            return false
          }
          lastId = newId
        }
        return true
      } finally {
        splitInProgress.delete(blockId)
      }
    },

    reorder: async (blockId: string, newIndex: number) => {
      const { blocks, rootParentId } = get()
      const block = blocks.find((b) => b.id === blockId)
      if (!block) return
      const parentId = block.parent_id

      // #400: `newIndex` is a 0-based sibling slot among the block's OTHER
      // same-parent children. A reorder to the block's current slot is a no-op.
      //
      // #928 (f6): the two bases coincide at the block's own slot even though
      // they count differently — `siblingSlot` returns the index INCLUDING the
      // block itself, while `newIndex` is the backend slot-basis EXCLUDING self.
      // Dropping a block onto its own position yields the same count whether
      // self is counted before it or excluded, so equality here is exact.
      const currentSlot = siblingSlot(blocks, block)
      if (newIndex === currentSlot) return

      try {
        // R5 (#404): same-parent reorder applies an OPTIMISTIC local splice and
        // does NOT call load(). The backend assigns the dense rank from the
        // slot; we mirror the resulting sibling order locally.
        // #730 — pool_busy retry (see edit/createBelow).
        const resp = await retryOnPoolBusy(() => moveBlock(blockId, parentId, newIndex))

        // Defensive: a reorder never crosses parents. If the backend echoes a
        // different parent, fall back to a structural reload.
        if ((resp.new_parent_id ?? null) !== (parentId ?? null)) {
          await get().load()
          notifyUndoNewAction(rootParentId)
          return
        }

        // #714 — recompute the splice INSIDE the functional updater from
        // `state.blocks` (current at commit time), never from the pre-await
        // capture: a concurrent write that landed while the IPC was in
        // flight must survive. If the block vanished or was re-parented
        // mid-flight, the splice context is invalid → fall back to load().
        // #1077 — shared recompute-at-commit + reconcile-or-reload core.
        await applyStructuralMove(set, get, {
          validateAtCommit: (state) => {
            const curBlock = state.blocks.find((b) => b.id === blockId)
            return !!curBlock && (curBlock.parent_id ?? null) === (parentId ?? null)
          },
          computeSpliced: (state) => {
            const cur = state.blocks
            const curBlock = cur.find((b) => b.id === blockId) as FlatBlock
            // Splice the moved subtree to its new slot among the siblings in the
            // flat tree. Build moved + remaining, then locate the insertion anchor
            // from the target sibling slot.
            const descendants = getDragDescendants(cur, blockId)
            const movedSet = new Set([blockId, ...descendants])
            const movedItems = cur
              .filter((b) => movedSet.has(b.id))
              .map((b) =>
                b.id === blockId ? Object.assign({}, b, { position: resp.new_position }) : b,
              )
            const remaining = cur.filter((b) => !movedSet.has(b.id))
            // `remaining` can be scanned twice below for the same anchor id
            // (getDragDescendants + the insertion anchor lookup) across the
            // branches. Build the id→index map once so every anchor lookup
            // here becomes an O(1) `.get()` instead of a `.findIndex()` scan
            // (#2041/#2200 — mirrors the dedent/moveDown conversion).
            const remainingIndex = buildIndexById(remaining)

            // The flat index in `remaining` of the (newIndex)-th same-parent
            // sibling; if newIndex is past the last sibling, insert after the last
            // sibling's subtree. parentDepth+1 is the sibling depth.
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
                // No remaining siblings — insert right after the parent, or at the
                // start of the list when at root level.
                insertAt = parentId == null ? 0 : (remainingIndex.get(parentId) ?? -1) + 1
              }
            } else {
              const anchor = siblingsRemaining[newIndex] as FlatBlock
              insertAt = remainingIndex.get(anchor.id) ?? -1
            }

            const newBlocks = [...remaining]
            newBlocks.splice(insertAt, 0, ...movedItems)
            // Subtree-touch (perf invariant): only the moved block's `position`
            // field changed; descendants are reused as-is.
            return { blocks: newBlocks, touchedIds: [blockId] }
          },
        })
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        logger.error('page-blocks', 'Failed to reorder block', { blockId }, err)
        notify.error(i18n.t('error.reorderBlockFailed'))
      }
    },

    moveToParent: async (blockId: string, newParentId: string | null, newIndex: number) => {
      const { rootParentId } = get()
      try {
        // #730 — pool_busy retry (see edit/createBelow).
        await retryOnPoolBusy(() => moveBlock(blockId, newParentId, newIndex))
        // Reload the full tree to get the correct flattened order.
        await get().load()
        notifyUndoNewAction(rootParentId)
      } catch (err) {
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

      // #914 — order the requested ids by their current document position so the
      // moved run preserves relative order at the destination. Ids absent from
      // the current tree (vanished mid-gesture) are dropped — there is nothing
      // to move and the backend would reject them.
      const order = new Map(get().blocks.map((b, i) => [b.id, i] as const))
      const ordered = ids
        .filter((id) => order.has(id))
        .toSorted((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      if (ordered.length === 0) return

      try {
        // #2274 — ONE IPC. `move_blocks_batch` lands the ordered run at
        // consecutive slots `newIndex, newIndex + 1, …` under `newParentId`
        // inside a single backend IMMEDIATE transaction (N `MoveBlock` ops),
        // preserving the #774 slot semantics WITHIN the tx. Replaces the old
        // per-root `moveBlock` IPC loop + full page reload. #730 — the single
        // call still goes through the shared pool_busy retry.
        const resp = await retryOnPoolBusy(() => moveBlocksBatch(ordered, newParentId, newIndex))

        // Surgical reconcile from the authoritative response — no blind load().
        // Computed inside the functional updater so it runs against the state
        // CURRENT AT COMMIT TIME (a concurrent write mid-flight must survive);
        // `reconcileBatchMove` returns null to request a reconciling reload.
        let needsReload = false
        set((state) => {
          const next = reconcileBatchMove(state, resp, ordered, newParentId, newIndex)
          if (!next) {
            needsReload = true
            return {}
          }
          return { blocks: next, blocksById: buildBlocksById(next) }
        })
        if (needsReload) await get().load()
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        logger.error('page-blocks', 'Failed to move blocks', { ids, newParentId, newIndex }, err)
        notify.error(i18n.t('error.moveBlockFailed'))
        // #2274 — the batch is transactional (all-or-nothing) backend-side and
        // this reducer applies NO optimistic update before the IPC resolves,
        // so on error there is nothing to roll back: the moved blocks' tree
        // shape is exactly what the (rolled-back) backend still holds. R26 —
        // the old wholesale pre-move snapshot restore here violated the
        // #714/#1077 commit-time discipline: it clobbered concurrent writes
        // (an edit echo adoption, a sync-triggered load()) that landed while
        // the IPC was in flight, diverging the store from the DB until the
        // next load(). Surface the failure and leave commit-time state alone.
      }
    },

    // #774 — serialize movers per block so a queued second press reads the
    // post-first-move state (see `enqueueMove` doc).
    indent: (blockId: string) =>
      enqueueMove(blockId, async (): Promise<boolean> => {
        const { blocks, rootParentId } = get()
        // `blocks` is scanned twice below for `blockId`'s slot (this findIndex
        // + getDragDescendants' internal lookup). Build the id→index map once
        // so both become O(1) lookups (#2041/#2200 — mirrors the
        // dedent/moveDown/reorder conversion).
        const blocksIndex = buildIndexById(blocks)
        const idx = blocksIndex.get(blockId) ?? -1
        if (idx <= 0) return false
        const block = blocks[idx]
        const prevSibling = findPrevSiblingAt(blocks, idx)
        if (!block || !prevSibling) return false

        // #928 — prevent (don't just IPC-reject) an indent that would push the
        // block's deepest descendant past MAX_BLOCK_DEPTH. After indent the
        // block sits at `prevSibling.depth + 1`; its subtree height carries the
        // rest. Short-circuit before the backend depth-limit rejection.
        const descendants = getDragDescendants(blocks, blockId, blocksIndex)
        let subtreeHeight = 0
        for (const b of blocks) {
          if (descendants.has(b.id)) subtreeHeight = Math.max(subtreeHeight, b.depth - block.depth)
        }
        if (prevSibling.depth + 1 + subtreeHeight > MAX_BLOCK_DEPTH - 1) {
          // #976 f21 — give sighted users feedback that Tab was rejected. The
          // keyboard handler's aria-live `announceMoveResult('moveFailed')`
          // covers AT, but a visual no-op left no explanation; a toast brings
          // visual + AT feedback to parity (mirrors the delete-boundary toast).
          // De-duped by `id` so a key-repeat at the depth ceiling shows once.
          notify.error(i18n.t('error.maxNestingReached'), { id: 'max-nesting-reached' })
          return false
        }

        // #400: indent makes the block the LAST child of the previous sibling —
        // its slot is the prev sibling's current child count (append).
        const prevChildCount = blocks.filter((b) => (b.parent_id ?? null) === prevSibling.id).length

        try {
          // #730 — pool_busy retry (see edit/createBelow).
          const resp = await retryOnPoolBusy(() =>
            moveBlock(blockId, prevSibling.id, prevChildCount),
          )

          // #774 — mirror reorder/moveUp/moveDown: if the backend echoes a
          // parent other than the one we requested (prevSibling), our local
          // "indent under prevSibling" splice would diverge from the backend
          // tree. Fall back to a structural reload so FE and BE stay in sync
          // instead of silently trusting the requested parent.
          if ((resp?.new_parent_id ?? null) !== prevSibling.id) {
            await get().load()
            notifyUndoNewAction(rootParentId)
            return true
          }
          // #714 — recompute the indent splice INSIDE the functional updater
          // from `state.blocks` (current at commit time), never from the
          // pre-await capture: a concurrent write that landed while the IPC
          // was in flight must survive. If either block vanished or the pair
          // is no longer a valid indent target (same parent + depth — e.g. an
          // interleaved structural move), fall back to a full load().
          // #1077 — shared recompute-at-commit + reconcile-or-reload core.
          await applyStructuralMove(set, get, {
            validateAtCommit: (state) => {
              const cur = state.blocks
              const curBlock = cur.find((b) => b.id === blockId)
              const curPrev = cur.find((b) => b.id === prevSibling.id)
              if (
                !curBlock ||
                !curPrev ||
                (curBlock.parent_id ?? null) !== (curPrev.parent_id ?? null) ||
                curBlock.depth !== curPrev.depth
              ) {
                return false
              }
              // The backend appended at slot `prevChildCount` (captured
              // pre-await). If the new parent's child set changed mid-flight,
              // the local "append as last child" no longer matches that slot —
              // reload instead of diverging silently from the backend order.
              const curChildCount = cur.filter((b) => (b.parent_id ?? null) === curPrev.id).length
              return curChildCount === prevChildCount
            },
            computeSpliced: (state) => {
              const cur = state.blocks
              const curPrev = cur.find((b) => b.id === prevSibling.id) as FlatBlock
              const newBlocks = computeIndentedBlocks(cur, blockId, curPrev)
              // Subtree-touch (perf invariant): only the indented block and its
              // descendants got new references; reuse the rest of the prior Map.
              const descendantIds = getDragDescendants(cur, blockId)
              return { blocks: newBlocks, touchedIds: [blockId, ...descendantIds] }
            },
          })
          notifyUndoNewAction(rootParentId)
          return true
        } catch (err) {
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
        // #400: dedent places the block right AFTER its parent among the
        // grandparent's children → slot = parent's sibling slot + 1.
        const newIndex = siblingSlot(blocks, parent) + 1
        try {
          // #730 — pool_busy retry (see edit/createBelow).
          const resp = await retryOnPoolBusy(() => moveBlock(blockId, newParentId, newIndex))

          // #774 — mirror reorder/moveUp/moveDown: dedent requests a specific
          // grandparent (`newParentId`). If the backend echoes a different
          // parent, the local "place after parent's subtree" splice would
          // diverge from the backend tree — reload instead of trusting the
          // requested parent.
          if ((resp.new_parent_id ?? null) !== (newParentId ?? null)) {
            await get().load()
            notifyUndoNewAction(rootParentId)
            return true
          }

          // #714 — recompute the dedent splice INSIDE the functional updater
          // from `state.blocks` (current at commit time), never from the
          // pre-await capture: a concurrent write that landed while the IPC
          // was in flight must survive. If the block or its parent vanished,
          // or the block was re-parented mid-flight, fall back to load().
          // #1077 — shared recompute-at-commit + reconcile-or-reload core.
          await applyStructuralMove(set, get, {
            validateAtCommit: (state) => {
              const cur = state.blocks
              const curBlock = cur.find((b) => b.id === blockId)
              const curParent = cur.find((b) => b.id === parent.id)
              if (!curBlock || !curParent || (curBlock.parent_id ?? null) !== parent.id) {
                return false
              }
              // The backend placed the block under `newParentId` at slot
              // `newIndex` (the parent's sibling slot + 1, captured pre-await).
              // If the parent was itself re-parented mid-flight, or its sibling
              // slot changed (a sibling inserted/removed above it), "insert
              // right after the parent's subtree" no longer matches the
              // backend's slot — reload instead of diverging silently.
              return (
                (curParent.parent_id ?? null) === (newParentId ?? null) &&
                siblingSlot(cur, curParent) + 1 === newIndex
              )
            },
            computeSpliced: (state) => {
              const cur = state.blocks
              const descendantIds = getDragDescendants(cur, blockId)
              const movedSet = new Set([blockId, ...descendantIds])

              const movedItems: FlatBlock[] = cur
                .filter((b) => movedSet.has(b.id))
                .map((b) => {
                  const moved = Object.assign({}, b, { depth: b.depth - 1 })
                  if (b.id === blockId) {
                    moved.parent_id = newParentId
                    moved.position = resp.new_position
                  }
                  return moved
                })

              const remaining = cur.filter((b) => !movedSet.has(b.id))
              // `remaining` is scanned twice for the parent's slot below
              // (getDragDescendants + the insertion anchor). Build the id→index
              // map once so both become O(1) lookups (#2041/#2200).
              const remainingIndex = buildIndexById(remaining)
              const parentDescendants = getDragDescendants(remaining, parent.id, remainingIndex)
              let insertAt = (remainingIndex.get(parent.id) ?? -1) + 1
              while (
                insertAt < remaining.length &&
                parentDescendants.has((remaining[insertAt] as FlatBlock).id)
              ) {
                insertAt++
              }

              remaining.splice(insertAt, 0, ...movedItems)
              // Subtree-touch (perf invariant): only `movedItems` got new references.
              return { blocks: remaining, touchedIds: movedItems.map((b) => b.id) }
            },
          })
          notifyUndoNewAction(rootParentId)
          return true
        } catch (err) {
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

        // #922 — outline-edge pop-out (Logseq/Workflowy): moveUp on a FIRST
        // child escapes the sibling group to become its parent's PREVIOUS
        // sibling (same depth as the parent, positioned just before it). A
        // first child at the ROOT (no parent) keeps the legacy no-op — there
        // is nowhere to pop out to.
        if (sibIndex === 0) {
          if (parentId == null) return false
          const parent = blocksById.get(parentId)
          if (!parent) return false
          // The pop-out parent is the grandparent; the target slot is the
          // parent's own sibling slot, dropping the block right BEFORE the
          // parent among the grandparent's children. Structural (cross-parent)
          // → `move_block` IPC + full `load()`, mirroring `moveToParent`.
          const newParentId = parent.parent_id ?? null
          const newIndex = siblingSlot(blocks, parent)
          try {
            await retryOnPoolBusy(() => moveBlock(blockId, newParentId, newIndex))
            await get().load()
            notifyUndoNewAction(rootParentId)
            return true
          } catch (err) {
            logger.error('page-blocks', 'Failed to move block up', { blockId }, err)
            notify.error(i18n.t('error.moveBlockUpFailed'))
            return false
          }
        }

        const prevSibling = siblings[sibIndex - 1] as FlatBlock
        // #400: target slot is the previous sibling's slot (sibIndex - 1) among
        // the OTHER children — moving up swaps with the previous sibling.
        const newIndex = sibIndex - 1

        try {
          // Splice locally instead of full re-list.
          // The MoveResponse echoes the canonical (parent_id, position) the
          // backend committed, so we can mirror the `reorder` path
          // without a follow-up `list_blocks` IPC. Same-parent only — moveUp
          // never crosses parents (it walks the sibling list at fixed depth).
          // #730 — pool_busy retry (see edit/createBelow).
          const resp = await retryOnPoolBusy(() => moveBlock(blockId, parentId, newIndex))

          // Defensive: if the backend echoes a different parent (shouldn't
          // happen for moveUp, but the response shape allows it), fall back
          // to the full reload path so descendant chains stay consistent.
          if ((resp.new_parent_id ?? null) !== (parentId ?? null)) {
            await get().load()
          } else {
            // #714 — recompute the swap splice INSIDE the functional updater
            // from `state.blocks` (current at commit time), never from the
            // pre-await capture: a concurrent write that landed while the IPC
            // was in flight must survive. If the block or its predecessor
            // vanished or the block was re-parented mid-flight, fall back to
            // a full load().
            // #1077 — shared recompute-at-commit + reconcile-or-reload core.
            await applyStructuralMove(set, get, {
              validateAtCommit: (state) => {
                const cur = state.blocks
                // Locate the moved block and its predecessor in the flat tree
                // (which may include descendants between them). Swap the two
                // sibling subtrees so visual order matches the new positions.
                const curBlock = cur.find((b) => b.id === blockId)
                if (!curBlock || (curBlock.parent_id ?? null) !== (parentId ?? null)) {
                  return false
                }
                // Backend semantics: the block lands at slot `newIndex` among its
                // OTHER same-parent siblings (captured pre-await). If the sibling
                // set changed mid-flight (insert/remove/re-parent above the
                // block), "insert before the captured prevSibling" no longer
                // equals that slot — reload instead of diverging silently. This
                // also covers prevSibling vanishing or being re-parented.
                const siblingsRemaining = cur.filter(
                  (b) =>
                    b.id !== blockId &&
                    (b.parent_id ?? null) === (parentId ?? null) &&
                    b.depth === curBlock.depth,
                )
                return siblingsRemaining[newIndex]?.id === prevSibling.id
              },
              computeSpliced: (state) => {
                const cur = state.blocks
                const movedDescendants = getDragDescendants(cur, blockId)
                const movedSet = new Set([blockId, ...movedDescendants])
                const movedItems = cur
                  .filter((b) => movedSet.has(b.id))
                  .map((b) =>
                    b.id === blockId ? Object.assign({}, b, { position: resp.new_position }) : b,
                  )
                const remaining = cur.filter((b) => !movedSet.has(b.id))
                // #2041/#2200 — unlike dedent/moveDown/reorder, this inserts
                // BEFORE `prevSibling`'s own slot: in a DFS-flattened array a
                // block's descendants always sit AFTER it, so landing at
                // `prevSibling`'s index already lands before its whole subtree
                // — no `getDragDescendants` skip-loop, hence no second scan of
                // `remaining` to fold into a shared `buildIndexById` map here.
                // A single `.findIndex` is the cheapest correct lookup; building
                // an id→index Map to serve exactly one lookup would cost O(n)
                // to save nothing (verified — left as-is intentionally).
                const insertAt = remaining.findIndex((b) => b.id === prevSibling.id)
                const newBlocks = [...remaining]
                newBlocks.splice(insertAt, 0, ...movedItems)
                // Subtree-touch (perf invariant): only the moved block (whose
                // `position` was rewritten) actually got a new reference; the
                // descendants are reused as-is. Update only that key.
                return { blocks: newBlocks, touchedIds: [blockId] }
              },
            })
          }
          notifyUndoNewAction(rootParentId)
          return true
        } catch (err) {
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

        // #922 — outline-edge pop-out (Logseq/Workflowy): moveDown on a LAST
        // child escapes the sibling group to become its parent's NEXT sibling
        // (same depth as the parent, positioned just after it). A last child at
        // the ROOT (no parent) keeps the legacy no-op.
        if (sibIndex >= siblings.length - 1) {
          if (parentId == null) return false
          const parent = blocksById.get(parentId)
          if (!parent) return false
          // Pop out under the grandparent, landing right AFTER the parent among
          // the grandparent's children → slot = parent's sibling slot + 1.
          // Structural (cross-parent) → `move_block` IPC + full `load()`.
          const newParentId = parent.parent_id ?? null
          const newIndex = siblingSlot(blocks, parent) + 1
          try {
            await retryOnPoolBusy(() => moveBlock(blockId, newParentId, newIndex))
            await get().load()
            notifyUndoNewAction(rootParentId)
            return true
          } catch (err) {
            logger.error('page-blocks', 'Failed to move block down', { blockId }, err)
            notify.error(i18n.t('error.moveBlockDownFailed'))
            return false
          }
        }

        const nextSibling = siblings[sibIndex + 1] as FlatBlock
        // #400: moving down swaps with the next sibling. `newIndex` is a slot
        // among the OTHER children (block excluded): once the block vacates slot
        // `sibIndex`, the next sibling slides to `sibIndex`, so landing AFTER it
        // is slot `sibIndex + 1`.
        const newIndex = sibIndex + 1

        try {
          // Splice locally instead of full re-list.
          // See moveUp comment for rationale; same-parent reorder only.
          // #730 — pool_busy retry (see edit/createBelow).
          const resp = await retryOnPoolBusy(() => moveBlock(blockId, parentId, newIndex))

          if ((resp.new_parent_id ?? null) !== (parentId ?? null)) {
            await get().load()
          } else {
            // #714 — recompute the swap splice INSIDE the functional updater
            // from `state.blocks` (current at commit time), never from the
            // pre-await capture: a concurrent write that landed while the IPC
            // was in flight must survive. If the block or its successor
            // vanished or the block was re-parented mid-flight, fall back to
            // a full load().
            // #1077 — shared recompute-at-commit + reconcile-or-reload core.
            await applyStructuralMove(set, get, {
              validateAtCommit: (state) => {
                const cur = state.blocks
                const curBlock = cur.find((b) => b.id === blockId)
                if (!curBlock || (curBlock.parent_id ?? null) !== (parentId ?? null)) {
                  return false
                }
                // Backend semantics: the block lands at slot `newIndex` among its
                // OTHER same-parent siblings (captured pre-await), i.e. right
                // after the captured nextSibling only while that sibling still
                // sits at slot `newIndex - 1`. If the sibling set changed
                // mid-flight, reload instead of diverging silently. This also
                // covers nextSibling vanishing or being re-parented.
                const siblingsRemaining = cur.filter(
                  (b) =>
                    b.id !== blockId &&
                    (b.parent_id ?? null) === (parentId ?? null) &&
                    b.depth === curBlock.depth,
                )
                return siblingsRemaining[newIndex - 1]?.id === nextSibling.id
              },
              computeSpliced: (state) => {
                const cur = state.blocks
                // Move the block AND its descendants past nextSibling AND its
                // descendants. Build moved + remaining, then re-insert moved
                // right after nextSibling's last descendant in `remaining`.
                const movedDescendants = getDragDescendants(cur, blockId)
                const movedSet = new Set([blockId, ...movedDescendants])
                const movedItems = cur
                  .filter((b) => movedSet.has(b.id))
                  .map((b) =>
                    b.id === blockId ? Object.assign({}, b, { position: resp.new_position }) : b,
                  )
                const remaining = cur.filter((b) => !movedSet.has(b.id))
                // `remaining` is scanned twice for nextSibling's slot below
                // (getDragDescendants + the insertion anchor). Build the id→index
                // map once so both become O(1) lookups (#2041/#2200).
                const remainingIndex = buildIndexById(remaining)
                const nextDescendants = getDragDescendants(
                  remaining,
                  nextSibling.id,
                  remainingIndex,
                )
                let insertAt = (remainingIndex.get(nextSibling.id) ?? -1) + 1
                while (
                  insertAt < remaining.length &&
                  nextDescendants.has((remaining[insertAt] as FlatBlock).id)
                ) {
                  insertAt++
                }
                const newBlocks = [...remaining]
                newBlocks.splice(insertAt, 0, ...movedItems)
                // Subtree-touch (perf invariant): only the moved block's
                // `position` field changed; the descendants are reused as-is.
                return { blocks: newBlocks, touchedIds: [blockId] }
              },
            })
          }
          notifyUndoNewAction(rootParentId)
          return true
        } catch (err) {
          logger.error('page-blocks', 'Failed to move block down', { blockId }, err)
          notify.error(i18n.t('error.moveBlockDownFailed'))
          return false
        }
      }),

    pasteBlocks: async (anchorBlockId: string, markdown: string) => {
      const { blocks, rootParentId } = get()
      const anchor = blocks.find((b) => b.id === anchorBlockId)
      // The anchor (last-selected / focused block) may have vanished between
      // the keypress and here (a racing sync delete). Reconcile and bail —
      // there is no valid sibling slot to paste into.
      if (!anchor) {
        await get().load()
        return []
      }

      // Top-level pasted blocks become SIBLINGS of the anchor (same parent),
      // landing right after the anchor among its siblings. `position` is 1-based
      // on the wire (#400: position 1 → engine index 0), so the 0-based slot
      // right after the anchor (`anchorSlot + 1`) maps to wire position
      // `anchorSlot + 2`; subsequent top-level blocks step up from there.
      const parentId = anchor.parent_id ?? null
      const firstSiblingPosition = siblingSlot(blocks, anchor) + 2

      // Parse the outline. Empty / unrecognizable text → a single content block
      // from the raw markdown (paste must not be a silent no-op).
      const parsed = parseIndentedMarkdown(markdown)
      const effective =
        parsed.length > 0 ? parsed : [{ content: markdown, parentIndex: null as number | null }]

      // #1484 — rewrite human-readable wiki-links (`[[Page Name]]`, `#tag`) in
      // the pasted content back to internal refs (`[[ULID]]`, `#[ULID]`),
      // creating missing pages/tags. Canonical `[[ULID]]`/`#[ULID]` tokens (an
      // internal duplicate→paste round-trip) and unresolvable/ambiguous names
      // are left untouched. The resolvers share one page/tag list fetch across
      // the whole paste; sequential per-block so same-name creation can't race.
      // `null` (no active space) → skip resolution, content stays verbatim.
      const internalizers = buildImportRefInternalizers()
      if (internalizers) {
        for (const entry of effective) {
          entry.content = await internalizeRefTokens(entry.content, internalizers)
        }
      }

      // Compute each parsed block's depth so we can batch level-by-level
      // (children reference parents created in an earlier batch — the
      // `insertTemplateBlocks` pattern). Depth 0 = top-level paste blocks.
      const depthByIndex: number[] = effective.map(() => 0)
      for (let i = 0; i < effective.length; i += 1) {
        const pIdx = effective[i]?.parentIndex
        if (pIdx != null) depthByIndex[i] = (depthByIndex[pIdx] ?? 0) + 1
      }
      let maxDepth = 0
      for (const d of depthByIndex) if (d > maxDepth) maxDepth = d

      // parsed-index → created block id (filled as each depth level lands).
      const createdIds: string[] = Array.from<string>({ length: effective.length })
      try {
        for (let level = 0; level <= maxDepth; level += 1) {
          const indicesAtLevel: number[] = []
          const specs: CreateBlockSpec[] = []
          // Count of top-level blocks placed so far, to step their sibling
          // positions contiguously after the anchor.
          let topLevelEmitted = 0
          for (let i = 0; i < effective.length; i += 1) {
            if ((depthByIndex[i] ?? 0) !== level) continue
            const entry = effective[i]
            if (entry == null) continue
            // Top-level paste blocks go under the anchor's parent; nested
            // blocks resolve to their just-created parent's id.
            const resolvedParentId =
              entry.parentIndex == null ? parentId : (createdIds[entry.parentIndex] ?? parentId)
            indicesAtLevel.push(i)
            specs.push({
              blockType: 'content',
              content: entry.content,
              parentId: resolvedParentId,
              // Top-level blocks land contiguously after the anchor; nested
              // blocks append under their just-created parent (`null` = append,
              // order preserved by their order in this batch).
              position: entry.parentIndex == null ? firstSiblingPosition + topLevelEmitted++ : null,
              properties: {},
            })
          }
          if (specs.length === 0) continue
          // #730 — route through the shared pool_busy retry like the other
          // structural actions.
          const created = await retryOnPoolBusy(() => createBlocksBatch(specs))
          for (let k = 0; k < indicesAtLevel.length; k += 1) {
            const idx = indicesAtLevel[k]
            const row = created[k]
            if (idx != null && row != null) createdIds[idx] = row.id
          }
        }
        // Structural insert across N blocks — reload for the authoritative
        // flattened order (mirrors `moveBlocks` / `moveToParent`).
        await get().load()
        notifyUndoNewAction(rootParentId)
        return createdIds.filter((id): id is string => typeof id === 'string')
      } catch (err) {
        logger.error('page-blocks', 'Failed to paste blocks', { anchorBlockId }, err)
        notify.error(i18n.t('error.pasteBlocksFailed'))
        // Reconcile FE with whatever the backend committed before the failure.
        await get().load()
        return createdIds.filter((id): id is string => typeof id === 'string')
      }
    },

    appendBlock: (row: BlockRow) => {
      // Depth 0 — the caller (PageEditor empty-page first-block-create)
      // creates directly under this page's `rootParentId`, which is the
      // top-level depth in the flat tree.
      const newBlock: FlatBlock = { ...row, depth: 0 }
      // Recompute the next blocks array INSIDE the updater (#714 discipline) so
      // the array and the `blocksById` Map are both derived from the same
      // commit-time state, never mixing a pre-set snapshot array with a
      // commit-time Map.
      // Single-block append (perf invariant): touch only the new key.
      set((state) => ({
        blocks: [...state.blocks, newBlock],
        blocksById: cloneBlocksByIdWith(state.blocksById, [newBlock]),
      }))
      // #1530 — this path does NOT route through `notifyUndoNewAction` (the
      // calling create path owns undo), so bump the graph-structure signal
      // directly: appending a block can change the page-link graph topology.
      recordGraphStructureChange()
    },
  }
}
