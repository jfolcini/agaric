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
import {
  computeIndentedBlocks,
  findPrevSiblingAt,
  midpointPosition,
  planSplit,
} from '../lib/block-tree-ops'
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
  /** Edit a block's content. */
  edit: (blockId: string, content: string) => Promise<void>
  /** Delete a block (and its descendants from the flat tree). */
  remove: (blockId: string) => Promise<void>

  /**
   * Auto-split: given a block ID and markdown with newlines, split into
   * multiple blocks. First line edits the original, subsequent lines
   * create new blocks below.
   */
  splitBlock: (blockId: string, markdown: string) => Promise<void>

  /** Reorder: move block to a new index within its sibling list. */
  reorder: (blockId: string, newIndex: number) => Promise<void>

  /** Move block to a new parent + position (used by tree DnD). */
  moveToParent: (blockId: string, newParentId: string | null, newPosition: number) => Promise<void>

  /** Indent: make block a child of its previous sibling (same depth). */
  indent: (blockId: string) => Promise<void>
  /** Dedent: move block up one level to grandparent. */
  dedent: (blockId: string) => Promise<void>

  /** Move block up among its siblings (swap with previous sibling). */
  moveUp: (blockId: string) => Promise<void>
  /** Move block down among its siblings (swap with next sibling). */
  moveDown: (blockId: string) => Promise<void>

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
 * Derive the target `position` value for a reorder operation in the flat tree.
 *
 * - Moving down (newIndex > oldIndex): position sits between `blocks[newIndex]`
 *   and `blocks[newIndex + 1]`; if the target is at the tail, extend past the
 *   last sibling.
 * - Moving up (newIndex <= oldIndex): position sits between
 *   `blocks[newIndex - 1]` and `blocks[newIndex]`; if the target is index 0,
 *   step before the first sibling.
 */
function computeReorderPosition(
  blocks: FlatBlock[],
  oldIndex: number,
  newIndex: number,
  firstSiblingPos: number,
  lastSiblingPos: number,
): number {
  if (newIndex > oldIndex) {
    if (newIndex >= blocks.length - 1) {
      return lastSiblingPos + 1
    }
    const beforePos = blocks[newIndex]?.position ?? 0
    const afterPos = blocks[newIndex + 1]?.position ?? 0
    return midpointPosition(beforePos, afterPos)
  }
  if (newIndex === 0) {
    return firstSiblingPos - 1
  }
  const beforePos = blocks[newIndex - 1]?.position ?? 0
  const afterPos = blocks[newIndex]?.position ?? 0
  return midpointPosition(beforePos, afterPos)
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

// ── Store factory ────────────────────────────────────────────────────────

export function createPageBlockStore(pageId: string): StoreApi<PageBlockState> {
  /** Guard: block IDs currently being split. Prevents re-entrant splitBlock calls. */
  const splitInProgress = new Set<string>()

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
      set({ loading: true })
      try {
        const start = performance.now()
        // Single-SELECT descendant load via the materializer-maintained
        // `page_id` index — replaces the recursive per-parent
        // `listBlocks` walk that silently clamped each level to 100.
        const allBlocks = await loadPageSubtree(rootParentId, spaceId)
        // Defensive: discard if rootParentId changed (shouldn't happen with per-page stores)
        if (get().rootParentId !== rootParentId) return
        let newBlocks = buildFlatTree(allBlocks, rootParentId)

        // Preserve focused block's content during sync reload to prevent
        // visual flash and store/editor divergence
        const focusedBlockId = useBlockStore.getState().focusedBlockId
        if (focusedBlockId) {
          const currentBlock = get().blocksById.get(focusedBlockId)
          if (currentBlock) {
            newBlocks = newBlocks.map((b) =>
              b.id === focusedBlockId ? { ...b, content: currentBlock.content } : b,
            )
          }
        }

        set({ blocks: newBlocks, blocksById: buildBlocksById(newBlocks), loading: false })
        logger.debug('page-blocks', 'page loaded', {
          pageId: rootParentId ?? '',
          blockCount: newBlocks.length,
          durationMs: Math.round(performance.now() - start),
        })
      } catch (err) {
        if (get().rootParentId !== rootParentId) return
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

      try {
        const result = await createBlock({
          blockType: 'content',
          content,
          ...(afterBlock.parent_id != null && { parentId: afterBlock.parent_id }),
          position: (afterBlock.position ?? 0) + 1,
        })

        // Insert the new block into the local array at the right position.
        // In a flat tree, the new sibling goes right after the afterBlock
        // and all its descendants.
        const descendants = getDragDescendants(blocks, afterBlockId)
        let insertIdx = idx + 1
        while (insertIdx < blocks.length && descendants.has((blocks[insertIdx] as FlatBlock).id)) {
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
          page_id: afterBlock.page_id,
          depth: afterBlock.depth,
        }
        const newBlocks = [...blocks]
        newBlocks.splice(insertIdx, 0, newBlock)
        // Single-block insert (perf invariant): derive the new Map from the
        // current one with one `.set()` instead of an O(n) rebuild.
        set((state) => ({
          blocks: newBlocks,
          blocksById: cloneBlocksByIdWith(state.blocksById, [newBlock]),
        }))
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
        await editBlock(blockId, content)
        notifyUndoNewAction(rootParentId)
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
      }
    },

    remove: async (blockId: string) => {
      const { blocks, rootParentId } = get()
      try {
        await deleteBlock(blockId)
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
        await get().edit(blockId, plan.first)
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
      const oldIndex = blocks.findIndex((b) => b.id === blockId)
      if (oldIndex < 0 || oldIndex === newIndex) return

      const block = blocks[oldIndex]
      if (!block) return
      const parentId = block.parent_id

      const siblings = blocks.filter(
        (b) => b.id !== blockId && (b.parent_id ?? null) === (parentId ?? null),
      )
      const lastSiblingPos =
        siblings.length > 0 ? (siblings[siblings.length - 1]?.position ?? 0) : 0
      const firstSiblingPos = siblings.length > 0 ? (siblings[0]?.position ?? 0) : 0

      const newPosition = computeReorderPosition(
        blocks,
        oldIndex,
        newIndex,
        firstSiblingPos,
        lastSiblingPos,
      )

      try {
        await moveBlock(blockId, parentId, newPosition)
        const newBlocks = [...blocks]
        const [moved] = newBlocks.splice(oldIndex, 1)
        const movedNext: FlatBlock = {
          ...(moved as FlatBlock),
          position: newPosition,
        }
        newBlocks.splice(newIndex, 0, movedNext)
        // Single-block reorder (perf invariant): only the moved block's
        // reference changed; the remaining `n - 1` entries are identical and
        // can be reused from the previous Map.
        set((state) => ({
          blocks: newBlocks,
          blocksById: cloneBlocksByIdWith(state.blocksById, [movedNext]),
        }))
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        logger.error('page-blocks', 'Failed to reorder block', { blockId }, err)
        notify.error(i18n.t('error.reorderBlockFailed'))
      }
    },

    moveToParent: async (blockId: string, newParentId: string | null, newPosition: number) => {
      const { rootParentId } = get()
      try {
        await moveBlock(blockId, newParentId, newPosition)
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

    indent: async (blockId: string) => {
      const { blocks, rootParentId } = get()
      const idx = blocks.findIndex((b) => b.id === blockId)
      if (idx <= 0) return
      const prevSibling = findPrevSiblingAt(blocks, idx)
      if (!prevSibling) return

      try {
        await moveBlock(blockId, prevSibling.id, 1)
        const newBlocks = computeIndentedBlocks(blocks, blockId, prevSibling)
        // Subtree-touch (perf invariant): only the indented block and its
        // descendants got new references; reuse the rest of the prior Map.
        const descendantIds = getDragDescendants(blocks, blockId)
        const touchedIds = new Set<string>([blockId, ...descendantIds])
        const touched = newBlocks.filter((b) => touchedIds.has(b.id))
        set((state) => ({
          blocks: newBlocks,
          blocksById: cloneBlocksByIdWith(state.blocksById, touched),
        }))
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        logger.error('page-blocks', 'Failed to indent block', { blockId }, err)
        notify.error(i18n.t('error.indentBlockFailed'))
      }
    },

    dedent: async (blockId: string) => {
      const { blocks, blocksById, rootParentId } = get()
      const block = blocksById.get(blockId)
      if (!block?.parent_id) return

      const parent = blocksById.get(block.parent_id)
      if (!parent) return

      const newParentId = parent.parent_id
      const newPosition = (parent.position ?? 0) + 1
      try {
        await moveBlock(blockId, newParentId, newPosition)

        const descendantIds = getDragDescendants(blocks, blockId)
        const movedSet = new Set([blockId, ...descendantIds])

        const movedItems: FlatBlock[] = blocks
          .filter((b) => movedSet.has(b.id))
          .map((b) => ({
            ...b,
            depth: b.depth - 1,
            ...(b.id === blockId ? { parent_id: newParentId, position: newPosition } : {}),
          }))

        const remaining = blocks.filter((b) => !movedSet.has(b.id))
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
        set((state) => ({
          blocks: remaining,
          blocksById: cloneBlocksByIdWith(state.blocksById, movedItems),
        }))
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        logger.error('page-blocks', 'Failed to dedent block', { blockId }, err)
        notify.error(i18n.t('error.dedentBlockFailed'))
      }
    },

    moveUp: async (blockId: string) => {
      const { blocks, blocksById, rootParentId } = get()
      const block = blocksById.get(blockId)
      if (!block) return

      const parentId = block.parent_id

      const siblings = blocks.filter(
        (b) => (b.parent_id ?? null) === (parentId ?? null) && b.depth === block.depth,
      )
      const sibIndex = siblings.findIndex((b) => b.id === blockId)
      if (sibIndex <= 0) return

      const prevSibling = siblings[sibIndex - 1] as FlatBlock
      const newPosition = (prevSibling.position ?? 0) - 1

      try {
        // PEND-35 Tier 4.1 — splice locally instead of full re-list.
        // The MoveResponse echoes the canonical (parent_id, position) the
        // backend committed, so we can mirror the `reorder` path at :432-441
        // without a follow-up `list_blocks` IPC. Same-parent only — moveUp
        // never crosses parents (it walks the sibling list at fixed depth).
        const resp = await moveBlock(blockId, parentId, newPosition)

        // Defensive: if the backend echoes a different parent (shouldn't
        // happen for moveUp, but the response shape allows it), fall back
        // to the full reload path so descendant chains stay consistent.
        if ((resp.new_parent_id ?? null) !== (parentId ?? null)) {
          await get().load()
        } else {
          // Locate the moved block and its predecessor in the flat tree
          // (which may include descendants between them). Swap the two
          // sibling subtrees so visual order matches the new positions.
          const oldIndex = blocks.findIndex((b) => b.id === blockId)
          const prevIndex = blocks.findIndex((b) => b.id === prevSibling.id)
          if (oldIndex < 0 || prevIndex < 0) {
            // Shouldn't happen — fall back to full reload.
            await get().load()
          } else {
            const movedDescendants = getDragDescendants(blocks, blockId)
            const movedSet = new Set([blockId, ...movedDescendants])
            const movedItems = blocks
              .filter((b) => movedSet.has(b.id))
              .map((b) => (b.id === blockId ? { ...b, position: resp.new_position } : b))
            const remaining = blocks.filter((b) => !movedSet.has(b.id))
            const insertAt = remaining.findIndex((b) => b.id === prevSibling.id)
            const newBlocks = [...remaining]
            newBlocks.splice(insertAt, 0, ...movedItems)
            // Subtree-touch (perf invariant): only the moved block (whose
            // `position` was rewritten) actually got a new reference; the
            // descendants are reused as-is. Update only that key on the
            // prior Map.
            set((state) => ({
              blocks: newBlocks,
              blocksById: cloneBlocksByIdWith(
                state.blocksById,
                movedItems.filter((b) => b.id === blockId),
              ),
            }))
          }
        }
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        logger.error('page-blocks', 'Failed to move block up', { blockId }, err)
        notify.error(i18n.t('error.moveBlockUpFailed'))
      }
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing
    moveDown: async (blockId: string) => {
      const { blocks, blocksById, rootParentId } = get()
      const block = blocksById.get(blockId)
      if (!block) return

      const parentId = block.parent_id

      const siblings = blocks.filter(
        (b) => (b.parent_id ?? null) === (parentId ?? null) && b.depth === block.depth,
      )
      const sibIndex = siblings.findIndex((b) => b.id === blockId)
      if (sibIndex < 0 || sibIndex >= siblings.length - 1) return

      const nextSibling = siblings[sibIndex + 1] as FlatBlock
      const newPosition = (nextSibling.position ?? 0) + 1

      try {
        // PEND-35 Tier 4.1 — splice locally instead of full re-list.
        // See moveUp comment for rationale; same-parent reorder only.
        const resp = await moveBlock(blockId, parentId, newPosition)

        if ((resp.new_parent_id ?? null) !== (parentId ?? null)) {
          await get().load()
        } else {
          const oldIndex = blocks.findIndex((b) => b.id === blockId)
          const nextIndex = blocks.findIndex((b) => b.id === nextSibling.id)
          if (oldIndex < 0 || nextIndex < 0) {
            await get().load()
          } else {
            // Move the block AND its descendants past nextSibling AND its
            // descendants. Build moved + remaining, then re-insert moved
            // right after nextSibling's last descendant in `remaining`.
            const movedDescendants = getDragDescendants(blocks, blockId)
            const movedSet = new Set([blockId, ...movedDescendants])
            const movedItems = blocks
              .filter((b) => movedSet.has(b.id))
              .map((b) => (b.id === blockId ? { ...b, position: resp.new_position } : b))
            const remaining = blocks.filter((b) => !movedSet.has(b.id))
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
            set((state) => ({
              blocks: newBlocks,
              blocksById: cloneBlocksByIdWith(
                state.blocksById,
                movedItems.filter((b) => b.id === blockId),
              ),
            }))
          }
        }
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        logger.error('page-blocks', 'Failed to move block down', { blockId }, err)
        notify.error(i18n.t('error.moveBlockDownFailed'))
      }
    },

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

  // Register in the global registry for cross-context access
  // biome-ignore lint/correctness/useExhaustiveDependencies: store is stable for a given pageId via storeRef
  useEffect(() => {
    pageBlockRegistry.set(pageId, store)
    return () => {
      // Guard (FE-L-3): only delete if the slot still points to OUR store, so a
      // stale unmount cannot clobber a newer registration for the same pageId.
      if (pageBlockRegistry.get(pageId) === store) pageBlockRegistry.delete(pageId)
    }
  }, [pageId])

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
