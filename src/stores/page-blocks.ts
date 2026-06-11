/**
 * Per-page block store — Zustand store instances scoped to individual pages.
 *
 * Each mounted BlockTree gets its own store via React context. This fixes
 * the multi-BlockTree conflict in weekly/monthly journal views where a
 * single global store caused the last load() to win for all instances.
 *
 * Pattern: createStore() factory + React context + module-level registry.
 *
 * ## Usage
 *
 * ```tsx
 * // Provider at BlockTree call site (PageEditor, DaySection)
 * <PageBlockStoreProvider pageId={pageId}>
 *   <BlockTree ... />
 * </PageBlockStoreProvider>
 *
 * // Consumer inside the provider tree
 * const blocks = usePageBlockStore((s) => s.blocks)
 * const store = usePageBlockStoreApi()
 * store.getState().load()
 * ```
 */

import { createContext, createElement, useContext, useEffect, useRef } from 'react'
import { createStore, type StoreApi, useStore } from 'zustand'

import { notify } from '@/lib/notify'

import { retryOnPoolBusy } from '../lib/app-error'
import { computeIndentedBlocks, findPrevSiblingAt, planSplit } from '../lib/block-tree-ops'
import { i18n } from '../lib/i18n'
import { logger } from '../lib/logger'
import type { BlockRow } from '../lib/tauri'
import { createBlock, deleteBlock, editBlock, loadPageSubtree, moveBlock } from '../lib/tauri'
import { buildFlatTree, type FlatBlock, getDragDescendants } from '../lib/tree-utils'
import { useBlockStore } from './blocks'
import { useSpaceStore } from './space'
import { useUndoStore } from './undo'

export type { FlatBlock }

// ── Per-page state interface ─────────────────────────────────────────────

export interface PageBlockState {
  /** Ordered flat-tree of blocks for this page (depth-annotated). */
  blocks: FlatBlock[]
  /**
   * O(1) lookup index over `blocks`, keyed by block id (PEND-20 G).
   * Always rebuilt from `blocks` on every mutation that touches the array;
   * the array is the source of truth for ordering, the Map is a derived cache.
   * Mutations produce a new Map reference so Zustand selector subscribers fire.
   */
  blocksById: Map<string, FlatBlock>
  /** The root parent ID for this page. */
  rootParentId: string | null
  /** Loading state. */
  loading: boolean

  /** O(1) helper — `state.blocksById.get(id)`. */
  getBlockById: (id: string) => FlatBlock | undefined

  /** Load the full block subtree from the backend. */
  load: () => Promise<void>

  /** Create a new block below the given block. Returns the new block ID. */
  createBelow: (afterBlockId: string, content?: string) => Promise<string | null>
  /** Edit a block's content. Resolves `true` on success, `false` if the
   * write failed (the optimistic update is rolled back and a generic
   * save-failed toast is shown). Callers that need a context-specific error
   * (e.g. the query builder) can branch on the returned boolean. */
  edit: (blockId: string, content: string) => Promise<boolean>
  /** Delete a block (and its descendants from the flat tree). */
  remove: (blockId: string) => Promise<void>

  /**
   * Auto-split: given a block ID and markdown with newlines, split into
   * multiple blocks. First line edits the original, subsequent lines
   * create new blocks below.
   */
  splitBlock: (blockId: string, markdown: string) => Promise<void>

  /**
   * Reorder: move block to a 0-based sibling slot (#400). `newIndex` is an
   * insertion slot among the block's same-parent siblings (0 = first / top).
   * Applies an optimistic local splice — no `load()` (R5 / #404).
   */
  reorder: (blockId: string, newIndex: number) => Promise<void>

  /**
   * Move block under a new parent at a 0-based sibling slot (#400). Structural,
   * so it reloads the tree (`load()`).
   */
  moveToParent: (blockId: string, newParentId: string | null, newIndex: number) => Promise<void>

  /**
   * Indent: make block a child of its previous sibling (same depth).
   * Resolves `true` when the move committed, `false` on a no-op or a caught
   * backend error (which also toasts) — so callers can announce accurately.
   */
  indent: (blockId: string) => Promise<boolean>
  /** Dedent: move block up one level to grandparent. Returns success (see `indent`). */
  dedent: (blockId: string) => Promise<boolean>

  /** Move block up among its siblings. Returns success (see `indent`). */
  moveUp: (blockId: string) => Promise<boolean>
  /** Move block down among its siblings. Returns success (see `indent`). */
  moveDown: (blockId: string) => Promise<boolean>

  /**
   * PEND-35 Tier 4.2 — append a single backend-returned `BlockRow` to the
   * in-memory flat tree at depth 0 (top-level child of this page).
   *
   * Used by callers that already have the freshly-created row in hand and
   * would otherwise re-fetch the entire page just to surface it. Pure FE
   * splice — no IPC, no undo notification (the calling create path owns
   * both side effects).
   */
  appendBlock: (row: BlockRow) => void
}

/** Notify the undo store that a new action occurred on the given page. */
function notifyUndoNewAction(rootParentId: string | null): void {
  if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
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

// ── blocksById helpers (PEND-20 G) ───────────────────────────────────────

/**
 * Build a fresh `blocksById` Map from a `blocks` array.
 *
 * Always returns a NEW Map instance — Zustand requires a new reference for
 * selector subscribers (e.g. `usePageBlockStore((s) => s.blocksById)`) to fire.
 * Last-write-wins on duplicate ids; in practice the loader and reducers never
 * produce duplicates, but a defensive `set()` keeps the contract explicit.
 *
 * **Perf invariant (Tier 1 #2, perf-review 2026-05-09).** This is a full O(n)
 * scan of `blocks`. Hot single-block-edit paths (`edit()` and other reducers
 * that touch one or a handful of entries) MUST NOT call this helper — instead,
 * derive the next Map from the previous one via `cloneBlocksByIdWith()` or
 * `cloneBlocksByIdWithout()` so only the touched keys allocate. Reserve
 * `buildBlocksById` for true bulk paths (`load`, external `setState`).
 */
function buildBlocksById(blocks: FlatBlock[]): Map<string, FlatBlock> {
  const map = new Map<string, FlatBlock>()
  for (const b of blocks) map.set(b.id, b)
  return map
}

/**
 * Clone `prev` and `.set()` one or more touched entries — returns a new Map
 * reference (so Zustand selector subscribers still fire) but only allocates
 * O(k) work for the touched keys plus O(n) for the structural clone of the
 * underlying Map (which is much cheaper than the per-entry object-property
 * access of a fresh `blocks.map()` walk in `buildBlocksById`).
 *
 * Used by single/few-block-edit reducers (`edit`, `createBelow`, `appendBlock`,
 * `reorder`, etc.) — see the perf invariant comment on `buildBlocksById`.
 */
function cloneBlocksByIdWith(
  prev: Map<string, FlatBlock>,
  touched: readonly FlatBlock[],
): Map<string, FlatBlock> {
  const next = new Map(prev)
  for (const b of touched) next.set(b.id, b)
  return next
}

/**
 * Clone `prev` and `.delete()` the given ids — counterpart to
 * `cloneBlocksByIdWith` for the `remove` reducer path.
 */
function cloneBlocksByIdWithout(
  prev: Map<string, FlatBlock>,
  removedIds: Iterable<string>,
): Map<string, FlatBlock> {
  const next = new Map(prev)
  for (const id of removedIds) next.delete(id)
  return next
}

/**
 * Augment an external `setState` partial so that callers passing only
 * `{ blocks: [...] }` get `blocksById` derived automatically. If the caller
 * supplies an explicit `blocksById` (e.g. fine-grained tests of the invariant),
 * it is honoured as-is.
 */
function augmentBlocksUpdate<T extends Partial<PageBlockState> | PageBlockState | null | undefined>(
  update: T,
): T {
  if (update == null) return update
  const obj = update as Partial<PageBlockState>
  const touchesBlocks = Object.hasOwn(obj, 'blocks')
  const hasMap = Object.hasOwn(obj, 'blocksById')
  if (!touchesBlocks || hasMap) return update
  const blocks = obj.blocks ?? []
  return { ...update, blocksById: buildBlocksById(blocks) } as T
}

/**
 * #713 — ownership gate for document-level BlockTree listeners.
 *
 * Journal week/month views mount one BlockTree (and one copy of every
 * document-level listener) per day, all sharing the GLOBAL `focusedBlockId`
 * from `useBlockStore`. A tree's listener may only act when its OWN page
 * store actually contains the focused block; otherwise N trees race
 * conflicting IPCs (e.g. todo cycling computed from a store where the block
 * doesn't exist → `current = null` → wrong next state). Non-owning trees
 * must return WITHOUT side effects and WITHOUT `preventDefault()`.
 */
export function storeOwnsBlock(
  store: StoreApi<PageBlockState>,
  blockId: string | null,
): blockId is string {
  return blockId != null && store.getState().blocksById.has(blockId)
}

// ── Store factory ────────────────────────────────────────────────────────

export function createPageBlockStore(pageId: string): StoreApi<PageBlockState> {
  /** Guard: block IDs currently being split. Prevents re-entrant splitBlock calls. */
  const splitInProgress = new Set<string>()

  /**
   * #774 — per-block mover serialization queue. The sibling-slot movers
   * (`moveUp`/`moveDown`/`indent`/`dedent`/`reorder`) capture their target
   * indices from `get()` state at the START of the action body, BEFORE the
   * `move_block` IPC awaits. A rapid double moveUp/moveDown fired before the
   * first resolved therefore computed BOTH requests from the same pre-move
   * snapshot: the second re-stated the first move's slot, so the two presses
   * collapsed into one backend move (lost intent — FE/BE stayed consistent,
   * but the block only moved one slot). Chaining each block's movers so the
   * next one runs only after the previous settles makes the second request
   * read the post-first-move state and target the correct next slot.
   *
   * Keyed by block id — moves of DIFFERENT blocks stay concurrent. The chain
   * swallows the predecessor's rejection (each mover owns its own try/catch
   * and never throws) before running the next link, so one failed move does
   * not strand the queue.
   */
  const moverQueue = new Map<string, Promise<unknown>>()
  function enqueueMove<T>(blockId: string, run: () => Promise<T>): Promise<T> {
    const prev = moverQueue.get(blockId)
    // When NO move for this block is in flight, run SYNCHRONOUSLY (up to the
    // first await inside `run`). This preserves the existing contract that a
    // mover captures its pre-await `get()` snapshot and dispatches its
    // `move_block` IPC synchronously with the call — the #714 stale-capture
    // races depend on it, and a lone move must not eat an extra microtask.
    // Only when a predecessor is still settling do we chain, so the queued
    // second press reads the post-first-move state (the #774 fix).
    const next: Promise<T> = prev ? prev.then(run, run) : run()
    // Keep the queue map from growing unbounded: once THIS link is the tail,
    // drop it so an idle block leaves no retained promise.
    moverQueue.set(blockId, next)
    void next.finally(() => {
      if (moverQueue.get(blockId) === next) moverQueue.delete(blockId)
    })
    return next
  }

  /**
   * #753 — load generation counter. `rootParentId` is immutable for the
   * lifetime of a per-page store, so the old "discard if rootParentId
   * changed" guard never fired for the real race: two overlapping
   * `load()` calls for the SAME page (sync:complete reload racing a
   * mount load) resolved last-write-wins, letting the staler snapshot
   * clobber the fresher one. Each `load()` claims a generation at start;
   * after every await it checks it is still the newest claimant and
   * discards its result otherwise (latest-started load wins).
   */
  let loadGeneration = 0

  const store = createStore<PageBlockState>((set, get) => ({
    blocks: [],
    blocksById: new Map(),
    rootParentId: pageId,
    loading: true,

    getBlockById: (id: string) => get().blocksById.get(id),

    load: async () => {
      // FE-H-22 — fail closed during pre-bootstrap. Earlier we forwarded
      // `useSpaceStore.getState().currentSpaceId ?? ''` to `listBlocks`
      // and relied on the backend treating `''` as a no-match SQL
      // filter. That contract is unwritten; a backend change to
      // interpret `''` as wildcard would silently leak cross-space
      // blocks into the page tree. Skip the fetch and leave state
      // (including the initial `loading: true`) untouched — the boot
      // sequence hydrates the space store before any BlockTree mounts,
      // so this branch is a defensive no-op rather than a hot path.
      const spaceId = useSpaceStore.getState().currentSpaceId
      if (spaceId == null) return
      const rootParentId = get().rootParentId
      if (rootParentId == null) return
      // #753 — claim a generation (see `loadGeneration` doc above).
      const generation = ++loadGeneration
      set({ loading: true })
      try {
        const start = performance.now()
        // #773 — capture the index as of load START. The backend snapshot
        // below can only know about blocks that existed when its query ran,
        // so "absent from the snapshot" is evidence of remote deletion ONLY
        // for blocks that were already here before the await. A block
        // optimistically spliced in mid-flight (createBelow committing while
        // this SELECT is in flight, then focused via Enter) lands in the
        // commit-time map but never in the snapshot — it must NOT trip the
        // focus-clear branch.
        const preLoadBlocksById = get().blocksById
        // Single-SELECT descendant load via the materializer-maintained
        // `page_id` index — replaces the recursive per-parent
        // `listBlocks` walk that silently clamped each level to 100.
        const allBlocks = await loadPageSubtree(rootParentId, spaceId)
        // Defensive: discard if rootParentId changed (shouldn't happen with per-page stores)
        if (get().rootParentId !== rootParentId) return
        // #753 — a newer load() started while this snapshot was in
        // flight; discard the stale result and let the newer load own
        // the store (including its `loading` flag).
        if (generation !== loadGeneration) return
        let newBlocks = buildFlatTree(allBlocks, rootParentId)

        // Preserve focused block's content during sync reload to prevent
        // visual flash and store/editor divergence
        const focusedBlockId = useBlockStore.getState().focusedBlockId
        if (focusedBlockId) {
          const currentBlock = get().blocksById.get(focusedBlockId)
          if (currentBlock) {
            if (newBlocks.some((b) => b.id === focusedBlockId)) {
              newBlocks = newBlocks.map((b) =>
                b.id === focusedBlockId ? { ...b, content: currentBlock.content } : b,
              )
            } else if (preLoadBlocksById.has(focusedBlockId)) {
              // #773 — sync-delete focus reconciliation. The focused block
              // lived in THIS store both when the load STARTED and now (so
              // this store owns the focus, mirroring the storeOwnsBlock gate
              // from #713) but is gone from the fresh backend snapshot — a
              // remote sync deleted it. Clear the global focus, otherwise
              // every tree fail-closes on the phantom id and block chords go
              // dead until the user clicks. Stores that never held the block
              // (other pages, fresh mounts where blocksById is still empty)
              // skip this branch, so ordinary navigation loads cannot
              // spuriously clear focus that is managed elsewhere. The
              // load-START check (`preLoadBlocksById`) keeps blocks created
              // and focused while this load was in flight — invisible to the
              // backend snapshot, so their absence proves nothing — from
              // being mistaken for remote deletions. `setFocused(null)` also
              // clears the coupled selection state, matching every other
              // focus-clear path in the app.
              useBlockStore.getState().setFocused(null)
            }
          }
        }

        // #798 — prune remotely-deleted ids from the global multi-selection.
        // Mirrors the #773 focus reconciliation above but for the coupled
        // selection set: a NON-focused block that lived in THIS store when
        // the load STARTED (`preLoadBlocksById`) but is gone from the fresh
        // backend snapshot was remotely deleted. Left in `selectedBlockIds`,
        // batch ops would target a dead block (a silent backend no-op via
        // idempotency, but selection-count badges would lie). Surviving ids
        // and ids this store never owned (managed by another tree, or
        // optimistically created mid-load and absent from the snapshot — same
        // load-START guard as #773) are preserved untouched, and the update
        // only fires when something actually changed.
        const survivingIds = new Set(newBlocks.map((b) => b.id))
        const { selectedBlockIds, setSelected } = useBlockStore.getState()
        if (selectedBlockIds.length > 0) {
          const pruned = selectedBlockIds.filter(
            (id) => survivingIds.has(id) || !preLoadBlocksById.has(id),
          )
          if (pruned.length !== selectedBlockIds.length) setSelected(pruned)
        }

        set({ blocks: newBlocks, blocksById: buildBlocksById(newBlocks), loading: false })
        logger.debug('page-blocks', 'page loaded', {
          pageId: rootParentId ?? '',
          blockCount: newBlocks.length,
          durationMs: Math.round(performance.now() - start),
        })
      } catch (err) {
        if (get().rootParentId !== rootParentId) return
        // #753 — a stale failed load must not stomp the newer load's
        // `loading: true` (or double-toast for a snapshot nobody wants).
        if (generation !== loadGeneration) return
        set({ loading: false })
        logger.error(
          'page-blocks',
          'Failed to load blocks',
          {
            rootParentId: rootParentId ?? '',
          },
          err,
        )
        notify.error(i18n.t('error.loadBlocksFailed'), { id: 'load-blocks-failed' })
      }
    },

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
        let needsReload = false
        set((state) => {
          const cur = state.blocks
          const curIdx = cur.findIndex((b) => b.id === afterBlockId)
          const curAfter = cur[curIdx]
          if (!curAfter) {
            needsReload = true
            return {}
          }
          // If an interleaved sync load() already delivered the freshly
          // created block (the backend committed it before the snapshot
          // query ran), splicing it again would duplicate the array entry
          // and break the blocks/blocksById size invariant. State is
          // already reconciled — commit nothing.
          if (state.blocksById.has(result.id)) return {}
          // The anchor was re-parented mid-flight (or the backend echoed an
          // unexpected parent): the new block belongs under the anchor's
          // ORIGINAL parent, so splicing it after the anchor's new location
          // would break array-order/parent_id consistency. Reload instead.
          if ((result.parent_id ?? null) !== (curAfter.parent_id ?? null)) {
            needsReload = true
            return {}
          }
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
          // Single-block insert (perf invariant): derive the new Map from the
          // current one with one `.set()` instead of an O(n) rebuild.
          return {
            blocks: newBlocks,
            blocksById: cloneBlocksByIdWith(state.blocksById, [newBlock]),
          }
        })
        if (needsReload) await get().load()
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
      // Single-block-edit hot path (perf-review Tier 1 #2): re-allocating the
      // entire Map per keystroke fans out to every mounted EditableBlock on a
      // 2000-block page. Derive `blocksById` from the previous Map and touch
      // only the edited key — full-scan `buildBlocksById` is reserved for
      // bulk paths (see invariant comment on `buildBlocksById`).
      set((state) => {
        let edited: FlatBlock | null = null
        const blocks = state.blocks.map((b) => {
          if (b.id !== blockId) return b
          const next = { ...b, content }
          edited = next
          return next
        })
        if (edited == null) return { blocks }
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
            const blocks = state.blocks.map((b) => (b.id === blockId ? normalized : b))
            return { blocks, blocksById: cloneBlocksByIdWith(state.blocksById, [normalized]) }
          })
        }
        notifyUndoNewAction(rootParentId)
        return true
      } catch (err) {
        // Rollback optimistic update — also a single-block touch.
        if (previousContent !== undefined) {
          set((state) => {
            let restored: FlatBlock | null = null
            const blocks = state.blocks.map((b) => {
              if (b.id !== blockId) return b
              const next = { ...b, content: previousContent }
              restored = next
              return next
            })
            if (restored == null) return { blocks }
            return { blocks, blocksById: cloneBlocksByIdWith(state.blocksById, [restored]) }
          })
        }
        logger.error('page-blocks', 'Failed to edit block', { blockId }, err)
        notify.error(i18n.t('error.saveFailed'))
        return false
      }
    },

    remove: async (blockId: string) => {
      const { blocks, rootParentId } = get()
      try {
        // #730 — pool_busy retry (see edit/createBelow).
        await retryOnPoolBusy(() => deleteBlock(blockId))
        // Remove block AND its descendants from the flat tree.
        // Few-block delete (perf invariant): touch only the removed keys on
        // the prior Map; the remaining `n - k` entries are reused as-is.
        const descendants = getDragDescendants(blocks, blockId)
        set((state) => {
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

    splitBlock: async (blockId: string, markdown: string) => {
      if (splitInProgress.has(blockId)) return
      splitInProgress.add(blockId)
      try {
        const plan = planSplit(markdown)
        if (plan.kind === 'noop') return
        if (plan.kind === 'edit-only') {
          await get().edit(blockId, plan.content)
          return
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
        if (!(await get().edit(blockId, plan.first))) return
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
            return
          }
          lastId = newId
        }
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
        let needsReload = false
        set((state) => {
          const cur = state.blocks
          const curBlock = cur.find((b) => b.id === blockId)
          if (!curBlock || (curBlock.parent_id ?? null) !== (parentId ?? null)) {
            needsReload = true
            return {}
          }
          // Splice the moved subtree to its new slot among the siblings in the
          // flat tree. Build moved + remaining, then locate the insertion anchor
          // from the target sibling slot.
          const descendants = getDragDescendants(cur, blockId)
          const movedSet = new Set([blockId, ...descendants])
          const movedItems = cur
            .filter((b) => movedSet.has(b.id))
            .map((b) => (b.id === blockId ? { ...b, position: resp.new_position } : b))
          const remaining = cur.filter((b) => !movedSet.has(b.id))

          // The flat index in `remaining` of the (newIndex)-th same-parent
          // sibling; if newIndex is past the last sibling, insert after the last
          // sibling's subtree. parentDepth+1 is the sibling depth.
          const siblingsRemaining = remaining.filter(
            (b) => (b.parent_id ?? null) === (parentId ?? null) && b.depth === curBlock.depth,
          )
          let insertAt: number
          if (newIndex >= siblingsRemaining.length) {
            const lastSib = siblingsRemaining[siblingsRemaining.length - 1]
            if (lastSib) {
              const lastSibDesc = getDragDescendants(remaining, lastSib.id)
              insertAt = remaining.findIndex((b) => b.id === lastSib.id) + 1
              while (
                insertAt < remaining.length &&
                lastSibDesc.has((remaining[insertAt] as FlatBlock).id)
              ) {
                insertAt++
              }
            } else {
              // No remaining siblings — insert right after the parent, or at the
              // start of the list when at root level.
              insertAt = parentId == null ? 0 : remaining.findIndex((b) => b.id === parentId) + 1
            }
          } else {
            const anchor = siblingsRemaining[newIndex] as FlatBlock
            insertAt = remaining.findIndex((b) => b.id === anchor.id)
          }

          const newBlocks = [...remaining]
          newBlocks.splice(insertAt, 0, ...movedItems)
          // Subtree-touch (perf invariant): only the moved block's `position`
          // field changed; descendants are reused as-is.
          return {
            blocks: newBlocks,
            blocksById: cloneBlocksByIdWith(
              state.blocksById,
              movedItems.filter((b) => b.id === blockId),
            ),
          }
        })
        if (needsReload) await get().load()
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

    // #774 — serialize movers per block so a queued second press reads the
    // post-first-move state (see `enqueueMove` doc).
    indent: (blockId: string) =>
      enqueueMove(blockId, async (): Promise<boolean> => {
        const { blocks, rootParentId } = get()
        const idx = blocks.findIndex((b) => b.id === blockId)
        if (idx <= 0) return false
        const prevSibling = findPrevSiblingAt(blocks, idx)
        if (!prevSibling) return false

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
          let needsReload = false
          set((state) => {
            const cur = state.blocks
            const curBlock = cur.find((b) => b.id === blockId)
            const curPrev = cur.find((b) => b.id === prevSibling.id)
            if (
              !curBlock ||
              !curPrev ||
              (curBlock.parent_id ?? null) !== (curPrev.parent_id ?? null) ||
              curBlock.depth !== curPrev.depth
            ) {
              needsReload = true
              return {}
            }
            // The backend appended at slot `prevChildCount` (captured
            // pre-await). If the new parent's child set changed mid-flight,
            // the local "append as last child" no longer matches that slot —
            // reload instead of diverging silently from the backend order.
            const curChildCount = cur.filter((b) => (b.parent_id ?? null) === curPrev.id).length
            if (curChildCount !== prevChildCount) {
              needsReload = true
              return {}
            }
            const newBlocks = computeIndentedBlocks(cur, blockId, curPrev)
            // Subtree-touch (perf invariant): only the indented block and its
            // descendants got new references; reuse the rest of the prior Map.
            const descendantIds = getDragDescendants(cur, blockId)
            const touchedIds = new Set<string>([blockId, ...descendantIds])
            const touched = newBlocks.filter((b) => touchedIds.has(b.id))
            return {
              blocks: newBlocks,
              blocksById: cloneBlocksByIdWith(state.blocksById, touched),
            }
          })
          if (needsReload) await get().load()
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
          let needsReload = false
          set((state) => {
            const cur = state.blocks
            const curBlock = cur.find((b) => b.id === blockId)
            const curParent = cur.find((b) => b.id === parent.id)
            if (!curBlock || !curParent || (curBlock.parent_id ?? null) !== parent.id) {
              needsReload = true
              return {}
            }
            // The backend placed the block under `newParentId` at slot
            // `newIndex` (the parent's sibling slot + 1, captured pre-await).
            // If the parent was itself re-parented mid-flight, or its sibling
            // slot changed (a sibling inserted/removed above it), "insert
            // right after the parent's subtree" no longer matches the
            // backend's slot — reload instead of diverging silently.
            if (
              (curParent.parent_id ?? null) !== (newParentId ?? null) ||
              siblingSlot(cur, curParent) + 1 !== newIndex
            ) {
              needsReload = true
              return {}
            }
            const descendantIds = getDragDescendants(cur, blockId)
            const movedSet = new Set([blockId, ...descendantIds])

            const movedItems: FlatBlock[] = cur
              .filter((b) => movedSet.has(b.id))
              .map((b) => ({
                ...b,
                depth: b.depth - 1,
                ...(b.id === blockId
                  ? { parent_id: newParentId, position: resp.new_position }
                  : {}),
              }))

            const remaining = cur.filter((b) => !movedSet.has(b.id))
            const parentDescendants = getDragDescendants(remaining, parent.id)
            let insertAt = remaining.findIndex((b) => b.id === parent.id) + 1
            while (
              insertAt < remaining.length &&
              parentDescendants.has((remaining[insertAt] as FlatBlock).id)
            ) {
              insertAt++
            }

            remaining.splice(insertAt, 0, ...movedItems)
            // Subtree-touch (perf invariant): only `movedItems` got new references.
            return {
              blocks: remaining,
              blocksById: cloneBlocksByIdWith(state.blocksById, movedItems),
            }
          })
          if (needsReload) await get().load()
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
        if (sibIndex <= 0) return false

        const prevSibling = siblings[sibIndex - 1] as FlatBlock
        // #400: target slot is the previous sibling's slot (sibIndex - 1) among
        // the OTHER children — moving up swaps with the previous sibling.
        const newIndex = sibIndex - 1

        try {
          // PEND-35 Tier 4.1 — splice locally instead of full re-list.
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
            let needsReload = false
            set((state) => {
              const cur = state.blocks
              // Locate the moved block and its predecessor in the flat tree
              // (which may include descendants between them). Swap the two
              // sibling subtrees so visual order matches the new positions.
              const curBlock = cur.find((b) => b.id === blockId)
              if (!curBlock || (curBlock.parent_id ?? null) !== (parentId ?? null)) {
                needsReload = true
                return {}
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
              if (siblingsRemaining[newIndex]?.id !== prevSibling.id) {
                needsReload = true
                return {}
              }
              const movedDescendants = getDragDescendants(cur, blockId)
              const movedSet = new Set([blockId, ...movedDescendants])
              const movedItems = cur
                .filter((b) => movedSet.has(b.id))
                .map((b) => (b.id === blockId ? { ...b, position: resp.new_position } : b))
              const remaining = cur.filter((b) => !movedSet.has(b.id))
              const insertAt = remaining.findIndex((b) => b.id === prevSibling.id)
              const newBlocks = [...remaining]
              newBlocks.splice(insertAt, 0, ...movedItems)
              // Subtree-touch (perf invariant): only the moved block (whose
              // `position` was rewritten) actually got a new reference; the
              // descendants are reused as-is. Update only that key on the
              // prior Map.
              return {
                blocks: newBlocks,
                blocksById: cloneBlocksByIdWith(
                  state.blocksById,
                  movedItems.filter((b) => b.id === blockId),
                ),
              }
            })
            if (needsReload) await get().load()
          }
          notifyUndoNewAction(rootParentId)
          return true
        } catch (err) {
          logger.error('page-blocks', 'Failed to move block up', { blockId }, err)
          notify.error(i18n.t('error.moveBlockUpFailed'))
          return false
        }
      }),

    // oxlint-disable-next-line eslint/complexity -- pre-existing
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
        if (sibIndex < 0 || sibIndex >= siblings.length - 1) return false

        const nextSibling = siblings[sibIndex + 1] as FlatBlock
        // #400: moving down swaps with the next sibling. `newIndex` is a slot
        // among the OTHER children (block excluded): once the block vacates slot
        // `sibIndex`, the next sibling slides to `sibIndex`, so landing AFTER it
        // is slot `sibIndex + 1`.
        const newIndex = sibIndex + 1

        try {
          // PEND-35 Tier 4.1 — splice locally instead of full re-list.
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
            let needsReload = false
            set((state) => {
              const cur = state.blocks
              const curBlock = cur.find((b) => b.id === blockId)
              if (!curBlock || (curBlock.parent_id ?? null) !== (parentId ?? null)) {
                needsReload = true
                return {}
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
              if (siblingsRemaining[newIndex - 1]?.id !== nextSibling.id) {
                needsReload = true
                return {}
              }
              // Move the block AND its descendants past nextSibling AND its
              // descendants. Build moved + remaining, then re-insert moved
              // right after nextSibling's last descendant in `remaining`.
              const movedDescendants = getDragDescendants(cur, blockId)
              const movedSet = new Set([blockId, ...movedDescendants])
              const movedItems = cur
                .filter((b) => movedSet.has(b.id))
                .map((b) => (b.id === blockId ? { ...b, position: resp.new_position } : b))
              const remaining = cur.filter((b) => !movedSet.has(b.id))
              const nextDescendants = getDragDescendants(remaining, nextSibling.id)
              let insertAt = remaining.findIndex((b) => b.id === nextSibling.id) + 1
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
              return {
                blocks: newBlocks,
                blocksById: cloneBlocksByIdWith(
                  state.blocksById,
                  movedItems.filter((b) => b.id === blockId),
                ),
              }
            })
            if (needsReload) await get().load()
          }
          notifyUndoNewAction(rootParentId)
          return true
        } catch (err) {
          logger.error('page-blocks', 'Failed to move block down', { blockId }, err)
          notify.error(i18n.t('error.moveBlockDownFailed'))
          return false
        }
      }),

    appendBlock: (row: BlockRow) => {
      const { blocks } = get()
      // Depth 0 — the caller (PageEditor empty-page first-block-create)
      // creates directly under this page's `rootParentId`, which is the
      // top-level depth in the flat tree.
      const newBlock: FlatBlock = { ...row, depth: 0 }
      const newBlocks = [...blocks, newBlock]
      // Single-block append (perf invariant): touch only the new key.
      set((state) => ({
        blocks: newBlocks,
        blocksById: cloneBlocksByIdWith(state.blocksById, [newBlock]),
      }))
    },
  }))

  // PEND-20 G — escape hatch for external callers (tests, ad-hoc setState).
  // Wrap `store.setState` so callers passing only `{ blocks: [...] }` get
  // `blocksById` derived automatically. Internal `set(...)` calls inside the
  // factory already maintain the Map atomically and bypass this wrap.
  const origSetState = store.setState
  store.setState = ((partial: unknown, replace?: unknown) => {
    if (typeof partial === 'function') {
      const updater = partial as (state: PageBlockState) => Partial<PageBlockState> | PageBlockState
      return (origSetState as (p: unknown, r?: unknown) => void)(
        (state: PageBlockState) => augmentBlocksUpdate(updater(state)),
        replace,
      )
    }
    return (origSetState as (p: unknown, r?: unknown) => void)(
      augmentBlocksUpdate(partial as Partial<PageBlockState>),
      replace,
    )
  }) as typeof store.setState

  return store
}

// ── Store registry ───────────────────────────────────────────────────────

/**
 * Module-level registry of mounted per-page stores.
 *
 * Used by global hooks (useSyncEvents, useUndoShortcuts) that need to
 * reload specific pages without being inside a provider context.
 * Providers register on mount, unregister on unmount.
 *
 * **Race condition note:** A theoretical race exists if Provider A unmounts
 * while Provider B mounts for the same `pageId` — A's cleanup could delete
 * B's entry. In practice this is prevented by React's batched state updates:
 * unmount effects for the old tree run before mount effects for the new tree
 * within the same commit phase. The monthly view mounts up to 30 concurrent
 * PageBlockStoreProviders (one per DaySection) without issues. As cheap
 * insurance (FE-L-3), the cleanup below only deletes when the registry slot
 * still points to *this* store, so a stale unmount cannot clobber a newer
 * registration.
 */
export const pageBlockRegistry = new Map<string, StoreApi<PageBlockState>>()

// ── React context ────────────────────────────────────────────────────────

export const PageBlockContext = createContext<StoreApi<PageBlockState> | null>(null)

/**
 * Provider that creates a per-page store instance and registers it.
 *
 * Wrap each BlockTree call site in this provider:
 * - PageEditor: `<PageBlockStoreProvider pageId={pageId}>`
 * - DaySection: `<PageBlockStoreProvider pageId={entry.pageId}>`
 */
export function PageBlockStoreProvider({
  pageId,
  children,
}: {
  pageId: string
  children: React.ReactNode
}): React.ReactElement {
  const storeRef = useRef<{ store: StoreApi<PageBlockState>; pageId: string } | null>(null)
  if (!storeRef.current || storeRef.current.pageId !== pageId) {
    storeRef.current = { store: createPageBlockStore(pageId), pageId }
  }

  const store = storeRef.current.store

  // Register in the global registry for cross-context access. `store` is
  // stable for a given pageId (storeRef only swaps it when pageId changes),
  // so including it adds no extra runs and fixes the stale-closure the linter
  // flags in the cleanup's `pageBlockRegistry.get(pageId) === store` guard.
  useEffect(() => {
    pageBlockRegistry.set(pageId, store)
    return () => {
      // Guard (FE-L-3): only delete if the slot still points to OUR store, so a
      // stale unmount cannot clobber a newer registration for the same pageId.
      if (pageBlockRegistry.get(pageId) === store) {
        pageBlockRegistry.delete(pageId)
        // #753 — drop the page's session undo state alongside the
        // registry slot. PageEditor already clears on navigation away,
        // but journal day pages (DaySection mounts one provider per
        // day) had NO clear path — every visited day accumulated up to
        // MAX_REDO_STACK OpRefs in the undo store for the whole
        // session. Same guard as the registry delete: a stale unmount
        // must not wipe a newer mount's live undo state.
        useUndoStore.getState().clearPage(pageId)
      }
    }
  }, [pageId, store])

  return createElement(PageBlockContext.Provider, { value: store }, children)
}

/**
 * Hook to subscribe to per-page block state with a selector.
 *
 * Must be called inside a PageBlockStoreProvider.
 */
export function usePageBlockStore<T>(selector: (state: PageBlockState) => T): T {
  const store = useContext(PageBlockContext)
  if (!store) throw new Error('usePageBlockStore must be used within a PageBlockStoreProvider')
  return useStore(store, selector)
}

/**
 * Hook to get the raw StoreApi for imperative access (getState/setState).
 *
 * Must be called inside a PageBlockStoreProvider.
 */
export function usePageBlockStoreApi(): StoreApi<PageBlockState> {
  const store = useContext(PageBlockContext)
  if (!store) throw new Error('usePageBlockStoreApi must be used within a PageBlockStoreProvider')
  return store
}
