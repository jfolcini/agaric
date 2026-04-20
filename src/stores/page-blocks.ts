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
import { toast } from 'sonner'
import { createStore, type StoreApi, useStore } from 'zustand'
import { parse, serialize } from '../editor/markdown-serializer'
import type { BlockLevelNode } from '../editor/types'
import { i18n } from '../lib/i18n'
import { logger } from '../lib/logger'
import type { BlockRow, PageResponse } from '../lib/tauri'
import { createBlock, deleteBlock, editBlock, listBlocks, moveBlock } from '../lib/tauri'
import { buildFlatTree, type FlatBlock, getDragDescendants } from '../lib/tree-utils'
import { useBlockStore } from './blocks'
import { useUndoStore } from './undo'

export type { FlatBlock }

// ── Per-page state interface ─────────────────────────────────────────────

export interface PageBlockState {
  /** Ordered flat-tree of blocks for this page (depth-annotated). */
  blocks: FlatBlock[]
  /** The root parent ID for this page. */
  rootParentId: string | null
  /** Loading state. */
  loading: boolean

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
}

// ── Recursive subtree loader ─────────────────────────────────────────────

const MAX_SUBTREE_BLOCKS = 2000

async function loadSubtree(
  parentId: string | undefined,
  maxDepth = 10,
  currentDepth = 0,
  loaded: { count: number } = { count: 0 },
): Promise<BlockRow[]> {
  if (currentDepth >= maxDepth) return []
  if (loaded.count >= MAX_SUBTREE_BLOCKS) return []
  const resp: PageResponse<BlockRow> = await listBlocks({ parentId, limit: 500 })
  const blocks = resp.items
  if (blocks.length === 0) return blocks

  loaded.count += blocks.length
  if (loaded.count >= MAX_SUBTREE_BLOCKS) return blocks

  const childArrays = await Promise.all(
    blocks.map((b) => loadSubtree(b.id, maxDepth, currentDepth + 1, loaded)),
  )

  return [...blocks, ...childArrays.flat()]
}

/** Notify the undo store that a new action occurred on the given page. */
function notifyUndoNewAction(rootParentId: string | null): void {
  if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
}

/**
 * Compute a midpoint position between two sibling positions, nudging up by one
 * when the floored midpoint would collide with `beforePos`. Callers rely on
 * the returned value being strictly greater than `beforePos`.
 */
function midpointPosition(beforePos: number, afterPos: number): number {
  const mid = Math.floor((beforePos + afterPos) / 2)
  return mid <= beforePos ? beforePos + 1 : mid
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

// ── splitBlock helpers ───────────────────────────────────────────────────

/**
 * Plan produced by {@link planSplit}, describing what `splitBlock` should do:
 *
 * - `noop` — parsing produced no work (empty markdown, or a single block that
 *   round-trips to the same markdown, or a set of blocks that are all empty
 *   paragraphs).
 * - `edit-only` — the parsed content is a single block whose serialized form
 *   differs from the input markdown; edit the existing block in place.
 * - `split` — multiple non-empty blocks; edit the existing block with `first`
 *   and create new blocks below for each entry in `rest`.
 */
export type SplitPlan =
  | { kind: 'noop' }
  | { kind: 'edit-only'; content: string }
  | { kind: 'split'; first: string; rest: readonly string[] }

/** True when a block carries content — non-paragraph blocks, or paragraphs with inline nodes. */
export function isNonEmptyBlock(b: BlockLevelNode): boolean {
  return b.type !== 'paragraph' || (b.content != null && b.content.length > 0)
}

/** Serialize a single block-level node by wrapping it in a one-element doc. */
function serializeSingleBlock(b: BlockLevelNode): string {
  return serialize({ type: 'doc', content: [b] })
}

/**
 * Pure classifier for `splitBlock`: parse the markdown and decide whether to
 * do nothing, edit the target block in place, or split into multiple blocks.
 *
 * Keeping this pure (no store access, no IO) lets the store action stay a
 * thin orchestrator and makes the branching logic unit-testable in isolation.
 */
export function planSplit(markdown: string): SplitPlan {
  const doc = parse(markdown)
  const blocks = doc.content ?? []
  if (blocks.length <= 1) {
    const content = blocks.length === 1 ? serializeSingleBlock(blocks[0] as BlockLevelNode) : ''
    return content === markdown ? { kind: 'noop' } : { kind: 'edit-only', content }
  }
  const nonEmpty = blocks.filter(isNonEmptyBlock)
  if (nonEmpty.length === 0) return { kind: 'noop' }
  const serialized = nonEmpty.map((b) => serializeSingleBlock(b as BlockLevelNode))
  const [first, ...rest] = serialized
  return { kind: 'split', first: first as string, rest }
}

// ── indent helpers ───────────────────────────────────────────────────────

/**
 * Walk backwards from `idx` in a flat-tree slice and return the previous
 * sibling of `blocks[idx]` — the nearest earlier block at the same depth and
 * with the same `parent_id`. Returns `null` when there is no such sibling
 * (the block is the first child of its parent, or `idx` is out of range).
 *
 * Mirrors the inline loop from the `indent` action but is pure and easily
 * testable. The walk short-circuits if a block at a *shallower* depth is
 * encountered first, matching the original semantics.
 */
export function findPrevSiblingAt(blocks: readonly FlatBlock[], idx: number): FlatBlock | null {
  const block = blocks[idx]
  if (!block) return null
  for (let i = idx - 1; i >= 0; i--) {
    const candidate = blocks[i]
    if (!candidate) continue
    if (candidate.depth < block.depth) return null
    if (
      candidate.depth === block.depth &&
      (candidate.parent_id ?? null) === (block.parent_id ?? null)
    ) {
      return candidate
    }
  }
  return null
}

/**
 * Pure computation of the flat-tree state that results from indenting
 * `blockId` under `prevSibling`:
 *
 * - `blockId` and all of its descendants have their `depth` incremented by 1.
 * - `blockId` itself is re-parented to `prevSibling.id` with `position: 1`.
 * - The moved subtree is spliced back after `prevSibling` and any existing
 *   descendants of `prevSibling` (so it lands at the tail of the new parent).
 *
 * Callers are responsible for validating that `prevSibling` is a legal
 * indent target (same depth + parent as `blockId` before the move).
 */
export function computeIndentedBlocks(
  blocks: readonly FlatBlock[],
  blockId: string,
  prevSibling: FlatBlock,
): FlatBlock[] {
  const arr = [...blocks]
  const descendantIds = getDragDescendants(arr, blockId)
  const movedSet = new Set<string>([blockId, ...descendantIds])

  const movedItems: FlatBlock[] = arr
    .filter((b) => movedSet.has(b.id))
    .map((b) => ({
      ...b,
      depth: b.depth + 1,
      ...(b.id === blockId ? { parent_id: prevSibling.id, position: 1 } : {}),
    }))

  const remaining = arr.filter((b) => !movedSet.has(b.id))
  const prevSibDescendants = getDragDescendants(remaining, prevSibling.id)
  let insertAt = remaining.findIndex((b) => b.id === prevSibling.id) + 1
  while (
    insertAt < remaining.length &&
    prevSibDescendants.has((remaining[insertAt] as FlatBlock).id)
  ) {
    insertAt++
  }

  remaining.splice(insertAt, 0, ...movedItems)
  return remaining
}

// ── Store factory ────────────────────────────────────────────────────────

export function createPageBlockStore(pageId: string): StoreApi<PageBlockState> {
  /** Guard: block IDs currently being split. Prevents re-entrant splitBlock calls. */
  const splitInProgress = new Set<string>()

  return createStore<PageBlockState>((set, get) => ({
    blocks: [],
    rootParentId: pageId,
    loading: true,

    load: async () => {
      const rootParentId = get().rootParentId
      set({ loading: true })
      try {
        const start = performance.now()
        const allBlocks = await loadSubtree(rootParentId ?? undefined)
        // Defensive: discard if rootParentId changed (shouldn't happen with per-page stores)
        if (get().rootParentId !== rootParentId) return
        let newBlocks = buildFlatTree(allBlocks, rootParentId)

        // Preserve focused block's content during sync reload to prevent
        // visual flash and store/editor divergence
        const focusedBlockId = useBlockStore.getState().focusedBlockId
        if (focusedBlockId) {
          const currentBlock = get().blocks.find((b) => b.id === focusedBlockId)
          if (currentBlock) {
            newBlocks = newBlocks.map((b) =>
              b.id === focusedBlockId ? { ...b, content: currentBlock.content } : b,
            )
          }
        }

        set({ blocks: newBlocks, loading: false })
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
        toast.error(i18n.t('error.loadBlocksFailed'))
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
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: afterBlock.page_id,
          depth: afterBlock.depth,
        }
        const newBlocks = [...blocks]
        newBlocks.splice(insertIdx, 0, newBlock)
        set({ blocks: newBlocks })
        notifyUndoNewAction(rootParentId)
        return result.id
      } catch (err) {
        logger.error('page-blocks', 'Failed to create block', { afterBlockId }, err)
        toast.error(i18n.t('error.createBlockFailed'))
        return null
      }
    },

    edit: async (blockId: string, content: string) => {
      const { rootParentId, blocks } = get()
      const previousContent = blocks.find((b) => b.id === blockId)?.content
      set((state) => ({
        blocks: state.blocks.map((b) => (b.id === blockId ? { ...b, content } : b)),
      }))
      try {
        await editBlock(blockId, content)
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        // Rollback optimistic update
        if (previousContent !== undefined) {
          set((state) => ({
            blocks: state.blocks.map((b) =>
              b.id === blockId ? { ...b, content: previousContent } : b,
            ),
          }))
        }
        logger.error('page-blocks', 'Failed to edit block', { blockId }, err)
        toast.error(i18n.t('error.saveFailed'))
      }
    },

    remove: async (blockId: string) => {
      const { blocks, rootParentId } = get()
      try {
        await deleteBlock(blockId)
        // Remove block AND its descendants from the flat tree
        const descendants = getDragDescendants(blocks, blockId)
        set((state) => ({
          blocks: state.blocks.filter((b) => b.id !== blockId && !descendants.has(b.id)),
        }))
        // Focus/selection cleanup is the caller's responsibility — all current
        // callers (handleDeleteBlock, handleMerge*, handleEscapeCancel, BlockTree
        // empty-block cleanup) explicitly manage focus after remove() resolves.
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        logger.error('page-blocks', 'Failed to delete block', { blockId }, err)
        toast.error(i18n.t('error.deleteBlockFailed'))
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
        await get().edit(blockId, plan.first)
        let lastId = blockId
        for (const content of plan.rest) {
          const newId = await get().createBelow(lastId, content)
          if (newId) lastId = newId
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
        newBlocks.splice(newIndex, 0, {
          ...(moved as FlatBlock),
          position: newPosition,
        })
        set({ blocks: newBlocks })
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        logger.error('page-blocks', 'Failed to reorder block', { blockId }, err)
        toast.error(i18n.t('error.reorderBlockFailed'))
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
        toast.error(i18n.t('error.moveBlockFailed'))
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
        set({ blocks: computeIndentedBlocks(blocks, blockId, prevSibling) })
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        logger.error('page-blocks', 'Failed to indent block', { blockId }, err)
        toast.error(i18n.t('error.indentBlockFailed'))
      }
    },

    dedent: async (blockId: string) => {
      const { blocks, rootParentId } = get()
      const block = blocks.find((b) => b.id === blockId)
      if (!block?.parent_id) return

      const parent = blocks.find((b) => b.id === block.parent_id)
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
        set({ blocks: remaining })
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        logger.error('page-blocks', 'Failed to dedent block', { blockId }, err)
        toast.error(i18n.t('error.dedentBlockFailed'))
      }
    },

    moveUp: async (blockId: string) => {
      const { blocks, rootParentId } = get()
      const block = blocks.find((b) => b.id === blockId)
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
        await moveBlock(blockId, parentId, newPosition)
        await get().load()
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        logger.error('page-blocks', 'Failed to move block up', { blockId }, err)
        toast.error(i18n.t('error.moveBlockUpFailed'))
      }
    },

    moveDown: async (blockId: string) => {
      const { blocks, rootParentId } = get()
      const block = blocks.find((b) => b.id === blockId)
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
        await moveBlock(blockId, parentId, newPosition)
        await get().load()
        notifyUndoNewAction(rootParentId)
      } catch (err) {
        logger.error('page-blocks', 'Failed to move block down', { blockId }, err)
        toast.error(i18n.t('error.moveBlockDownFailed'))
      }
    },
  }))
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
 * PageBlockStoreProviders (one per DaySection) without issues.
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
      pageBlockRegistry.delete(pageId)
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
