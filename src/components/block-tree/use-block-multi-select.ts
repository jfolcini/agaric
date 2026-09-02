import type { TFunction } from 'i18next'
import { useCallback, useRef, useState } from 'react'
import type { StoreApi } from 'zustand'

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { notifyPagesRemoved } from '@/lib/name-change-bus'
import { notify } from '@/lib/notify'
import { buildIndexById, getDragDescendants } from '@/lib/tree-utils'
import type { PageBlockState } from '@/stores/page-blocks'
import { useUndoStore } from '@/stores/undo'

export interface UseBlockMultiSelectParams {
  selectedBlockIds: string[]
  clearSelected: () => void
  rootParentId: string | null
  pageStore: StoreApi<PageBlockState>
  /**
   * #4524 — the ORIGIN space of everything this hook removes, for the `[[`
   * picker's name-cache eviction in `handleBatchDelete`. A PROP, mirroring
   * `PageBrowserBatchToolbar`'s `currentSpaceId`, rather than a
   * `useSpaceStore.getState()` read taken at emit time: the space an event is
   * labelled with must be the one that was live when the user acted, and a
   * fresh read after the await would label the batch with whatever space the
   * user switched to while the IPC was in flight — the "worse than no
   * scoping" mislabelling `src/lib/name-change-bus.ts` warns about. Closing
   * over the prop and listing it in the delete callback's dep array is what
   * pins it (see the long note in `handleTrash`). `null` (space unhydrated)
   * falls back to a full invalidation inside `notifyPagesRemoved`.
   */
  currentSpaceId: string | null
  t: TFunction
  /**
   * #1734 — single-block priority cycle, fanned out across the selection by
   * `handleBatchSetPriority`. Mirrors the bulk priority path the context menu
   * already exposes; passed in so the hook reuses the canonical cycle logic
   * (configurable level set, optimistic update, undo bookkeeping).
   */
  handleTogglePriority: (blockId: string) => void | Promise<void>
}

export interface UseBlockMultiSelectReturn {
  batchDeleteConfirm: boolean
  batchInProgress: boolean
  setBatchDeleteConfirm: (v: boolean) => void
  handleBatchSetTodo: (state: string | null) => Promise<void>
  handleBatchSetPriority: () => Promise<void>
  handleBatchDelete: () => Promise<void>
}

export function useBlockMultiSelect({
  selectedBlockIds,
  clearSelected,
  rootParentId,
  pageStore,
  currentSpaceId,
  t,
  handleTogglePriority,
}: UseBlockMultiSelectParams): UseBlockMultiSelectReturn {
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false)
  // `batchInProgress` (state) is surfaced to the UI (disables buttons in
  // BlockContextMenu). `batchInProgressRef` is the reentrancy guard — using a
  // ref here prevents cascade re-renders caused by rebuilding the useCallback
  // Identity on every flag flip (#).
  const [batchInProgress, setBatchInProgress] = useState(false)
  const batchInProgressRef = useRef(false)

  const handleBatchSetTodo = useCallback(
    async (state: string | null) => {
      if (batchInProgressRef.current) return
      batchInProgressRef.current = true
      setBatchInProgress(true)
      try {
        const ids = [...selectedBlockIds]
        const idSet = new Set(ids)
        // Optimistic FE update — flip the badge instantly while the
        // single-IPC batch round-trips. On failure the catch below
        // surfaces an error toast; the next page load will re-read
        // the truthful state from the backend.
        pageStore.setState((s) => ({
          blocks: s.blocks.map((b) => (idSet.has(b.id) ? { ...b, todo_state: state } : b)),
        }))
        // One IPC for the whole batch (was N).
        // Backend wraps the per-block op_log appends + materialised
        // `blocks.todo_state` writes in a single IMMEDIATE tx.
        let successCount = 0
        let failCount = 0
        try {
          successCount = unwrap(await commands.setTodoStateBatch(ids, state))
          // Treat any id we asked for that the backend silently
          // skipped (missing / already-deleted) as a "fail" for the
          // toast counter so the user sees an honest summary.
          failCount = Math.max(0, ids.length - successCount)
        } catch {
          failCount = ids.length
        }
        if (successCount > 0 && rootParentId) {
          useUndoStore.getState().onNewAction(rootParentId)
        }
        clearSelected()
        if (failCount > 0) {
          notify.error(
            t('blockTree.updateFailedMessage', {
              failCount,
              totalCount: ids.length,
            }),
          )
        } else {
          notify.success(
            t('blockTree.setStateMessage', {
              successCount,
              state: state ?? 'none',
            }),
          )
        }
      } finally {
        batchInProgressRef.current = false
        setBatchInProgress(false)
      }
    },
    [selectedBlockIds, clearSelected, rootParentId, t, pageStore],
  )

  // #1734 — cycle priority across the whole selection. Unlike TODO/delete there
  // is no dedicated single-IPC batch priority endpoint, so this fans out the
  // canonical per-block cycle (the exact path the bulk context menu uses),
  // awaiting each in turn so one failure surfaces a toast (raised inside
  // `handleTogglePriority`) without aborting the rest. Selection is cleared
  // afterwards, matching the toolbar's other batch actions.
  const handleBatchSetPriority = useCallback(async () => {
    if (batchInProgressRef.current) return
    batchInProgressRef.current = true
    setBatchInProgress(true)
    try {
      const ids = [...selectedBlockIds]
      for (const id of ids) {
        await Promise.resolve(handleTogglePriority(id))
      }
      clearSelected()
    } finally {
      batchInProgressRef.current = false
      setBatchInProgress(false)
    }
  }, [selectedBlockIds, handleTogglePriority, clearSelected])

  const handleBatchDelete = useCallback(async () => {
    if (batchInProgressRef.current) return
    batchInProgressRef.current = true
    setBatchInProgress(true)
    try {
      const ids = [...selectedBlockIds]
      // #4524 review note 2 — captured HERE, alongside `ids` and before the
      // `deleteBlocksByIds` await below, not read fresh off the store after
      // it. Same value-at-the-moment-the-user-acted discipline the
      // `currentSpaceId` prop above is for: a read taken after the await
      // would reflect whatever the store holds once the IPC settles, and a
      // reload or navigation mid-flight can replace it before then. The
      // page-subset fan-out (below) filters `ids` through this snapshot, so
      // a stale reference after such a swap would silently drop ids from
      // that subset — never add a wrong one, because a swapped-in store
      // holds a different id space entirely and a lookup for an old id
      // simply misses. Low stakes either way: `affected_page_ids` (also
      // below) already reports every page this call actually deleted, in
      // full, straight from the backend; this snapshot only ever adds ids
      // the backend SKIPPED (missing, or soft-deleted by a concurrent
      // write) to that set, so the asymmetry this closes could only have
      // under-evicted a page that was not live anyway.
      const blocksById = pageStore.getState().blocksById
      // The ancestor pre-walk is no
      // longer needed. The single-row `deleteBlock` IPC required the
      // FE to filter selected descendants client-side because each
      // root ran in its own IMMEDIATE tx and the cascade-races would
      // surface as spurious "delete failed" toast counts. The batch
      // endpoint `delete_blocks_by_ids` walks descendants in one
      // recursive CTE seeded from every root simultaneously, so
      // duplicate descendant ids in the input set are coalesced
      // server-side. Send the raw selection unchanged.
      let successCount = 0
      let failCount = 0
      try {
        // Backend returns `deleted_count`, the number of blocks soft-deleted
        // (roots + descendants combined). For UX we report against the
        // selection size: a 1:1 mapping is the common case for a
        // flat selection; ancestor-coalescing makes the returned
        // count >= selectedRoots, which still represents "every
        // requested row is gone".
        //
        // #4480 added a sibling `affected_page_ids` field for callers that
        // maintain the `[[` picker's per-space page cache. This surface is
        // one of them (#4524) — see the fan-out below.
        const { deleted_count: affected, affected_page_ids: cascadedPageIds } = unwrap(
          await commands.deleteBlocksByIds(ids),
        )
        // The selection itself was processed atomically. Count
        // successful "selected rows that are now deleted" by
        // re-reading the in-memory state shape: since the call
        // succeeded, every selected id is either a deleted root or
        // a descendant of a selected ancestor — both gone. Use the
        // selection size for the toast counter.
        successCount = ids.length
        // `affected` is unused in the toast (it would surface
        // descendants we did not explicitly select), but keeping
        // the local makes the intent explicit.
        void affected
        // #4524 — evict every PAGE this delete removed from the `[[` picker's
        // per-space name cache, which is filled once per space from
        // `list_all_pages_in_space` and has no other delete signal. Until now
        // this surface published NOTHING — not the selected roots, not the
        // cascaded descendants — so a page trashed from the block tree went on
        // being offered under `[[` for the rest of the session. That is #4450's
        // plain symptom on a surface #4450 never covered; the sibling
        // `PageBrowserBatchToolbar.handleTrash` has published for the identical
        // cache consequence since #4007, over the identical command. The policy
        // (de-duplicate, budget the fan-out against what is actually emitted,
        // fall back to a full invalidation with no active space) is
        // `notifyPagesRemoved`, shared with that toolbar rather than copied.
        //
        // The cohort is the UNION of two halves, and BOTH are needed — but
        // they are published under DIFFERENT scopes (#4558, see below):
        //
        //  - `cascadedPageIds` — the backend's page membership of the cascade.
        //    The recursive CTE walks `parent_id` with no page-boundary stop, so
        //    deleting a block tombstones nested PAGES the user never selected.
        //    Only the backend can see that set; re-deriving it here from
        //    `getDragDescendants` is exactly how two arms drift apart, and it
        //    would be wrong besides — the store holds only the loaded page's
        //    rows, not the subtree of a nested page.
        //  - the PAGE subset of `ids` — a selected id the backend SKIPPED
        //    (missing, or soft-deleted by a concurrent write) is absent from
        //    the reported cohort but was in the user's selection and is not a
        //    live page either way.
        //
        // #4558 — cascade is space-less, see notifyPageRemoved.
        //
        // The PAGE SUBSET, not `ids` wholesale — and this is where the hook
        // must NOT copy `handleTrash`. The toolbar's selection is pages by
        // construction (it is the Pages view); a block-tree selection is
        // mostly CONTENT rows, which the picker never offers. Publishing them
        // would fire O(listeners x pages) of synchronous work per id that
        // cannot match anything, and — worse — a routine 30-block content
        // delete would exceed `NAME_CACHE_FANOUT_MAX_IDS` and wipe a warm
        // cache to describe the removal of nothing. `block_type` is on the
        // rows already in the store, so the filter costs one map lookup per
        // selected id. `blocksById` is the snapshot captured above, BEFORE
        // both the await and the splice below drop those rows — see the
        // review-note-2 comment at its capture site.
        //
        // What "wipe a warm cache" costs, spelled out because it is NEW on
        // this surface (#4534 review note 3): past `NAME_CACHE_FANOUT_MAX_IDS`
        // — and on the `spaceId == null` branch — `notifyPagesRemoved` falls
        // back to `invalidateNameCaches()`, and that event is not page-scoped.
        // `useBlockResolve` subscribes BOTH caches to it, so `applyTagNameChange`
        // returns `[]` as well and the `#` picker's `tagsListRef` is dropped
        // alongside `pagesListRef` — for a delete that removed no tag at all.
        // The consequence is a re-fetch on the next `#` read, never a wrong
        // suggestion, and it is the policy `PageBrowserBatchToolbar` has
        // carried since #4007 (a big trash drops both caches too), so the
        // block tree matching it is deliberate. It is written down here
        // because this hook is the surface where the fallback is EASIEST to
        // reach by accident: a block-tree selection is mostly content rows, so
        // it is the page-subset filter above — not the cap — that keeps an
        // everyday 30-block content delete from clearing the tag cache.
        const selectedPageIds = new Set<string>()
        for (const id of ids) {
          if (blocksById.get(id)?.block_type === 'page') selectedPageIds.add(id)
        }
        notifyPagesRemoved(selectedPageIds, currentSpaceId, cascadedPageIds)
        // #2653 — the backend soft-deletes every selected root AND its whole
        // subtree (recursive CTE), but the selection only ever holds the
        // explicitly-clicked ids (never their hidden/collapsed descendants).
        // Mirror the single-block remove() reducer: splice out the UNION of the
        // selected ids plus each root's `getDragDescendants`, so a deleted
        // parent's non-selected children don't linger as ghost rows backed by
        // tombstoned blocks. The set is recomputed from `state.blocks` CURRENT
        // AT COMMIT TIME (#714 discipline), and `pageStore.setState` is
        // augmented to rebuild `blocksById` from the filtered array, so the
        // id→block map is reconciled in the same write.
        pageStore.setState((s) => {
          const removed = new Set(ids)
          // #2041 — one shared `id → index` map for the whole selection, so
          // each root's descendant walk is an O(1) lookup instead of its own
          // `findIndex` scan over `s.blocks` (matches `serializeBlockSubtree`
          // in `src/lib/block-clipboard.ts`).
          const indexById = buildIndexById(s.blocks)
          for (const id of ids) {
            for (const descendantId of getDragDescendants(s.blocks, id, indexById)) {
              removed.add(descendantId)
            }
          }
          return { blocks: s.blocks.filter((b) => !removed.has(b.id)) }
        })
        // C4 (#217) — the batch delete appended DeleteBlock ops to the
        // page op-log (one per root), so Ctrl+Z genuinely reverses it
        // via undo_page_op. Mark a new action so the redo stack/depth
        // reset to a clean slate (mirrors handleBatchSetTodo) and the
        // toast below can honestly advertise the undo path.
        if (rootParentId) {
          useUndoStore.getState().onNewAction(rootParentId)
        }
      } catch {
        failCount = ids.length
      }
      clearSelected()
      setBatchDeleteConfirm(false)
      if (failCount > 0) {
        notify.error(
          t('blockTree.deleteFailedMessage', {
            failCount,
            totalCount: ids.length,
          }),
        )
      } else {
        // Reassure the user the destructive batch is recoverable.
        notify.success(t('blockTree.deletedMessageUndo', { count: successCount }))
      }
    } finally {
      batchInProgressRef.current = false
      setBatchInProgress(false)
    }
  }, [selectedBlockIds, clearSelected, rootParentId, t, pageStore, currentSpaceId])

  return {
    batchDeleteConfirm,
    batchInProgress,
    setBatchDeleteConfirm,
    handleBatchSetTodo,
    handleBatchSetPriority,
    handleBatchDelete,
  }
}
