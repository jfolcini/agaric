/**
 * Block store — Zustand state for the block tree (ADR-01).
 *
 * Manages the in-memory block list, focused block, and CRUD operations.
 * All mutations go through Tauri commands and update local state on success.
 *
 * The store maintains a flattened tree: blocks are ordered depth-first with
 * a `depth` field for visual indentation. This enables tree-aware DnD,
 * keyboard indent/dedent, and proper hierarchy rendering.
 */

import { toast } from 'sonner'
import { create } from 'zustand'
import { parse, serialize } from '../editor/markdown-serializer'
import type { BlockRow, PageResponse } from '../lib/tauri'
import { createBlock, deleteBlock, editBlock, listBlocks, moveBlock } from '../lib/tauri'
import { buildFlatTree, type FlatBlock, getDragDescendants } from '../lib/tree-utils'
import { useUndoStore } from './undo'

export type { FlatBlock }

interface BlockStore {
  /** Ordered flat-tree of blocks for the current view (depth-annotated). */
  blocks: FlatBlock[]
  /** The root parent ID for the current tree view. */
  rootParentId: string | null
  /** ID of the currently focused/editing block, or null. */
  focusedBlockId: string | null
  /** Loading state. */
  loading: boolean

  /** Load the full block subtree from the backend. */
  load: (parentId?: string) => Promise<void>
  /** Set which block is focused. */
  setFocused: (blockId: string | null) => void

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

/** Notify the undo store that a new action occurred on the current page. */
function notifyUndoNewAction(rootParentId: string | null): void {
  if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
}

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

// ── Store ────────────────────────────────────────────────────────────────

export const useBlockStore = create<BlockStore>((set, get) => ({
  blocks: [],
  rootParentId: null,
  focusedBlockId: null,
  loading: false,

  load: async (parentId?: string) => {
    const newRoot = parentId ?? null
    const prevRoot = get().rootParentId
    // When switching to a different parent, clear stale blocks immediately
    // so components never see data from a previous view.
    // When reloading the same parent, keep blocks to avoid a flash of empty content.
    set({
      loading: true,
      rootParentId: newRoot,
      ...(newRoot !== prevRoot ? { blocks: [], focusedBlockId: null } : {}),
    })
    try {
      const allBlocks = await loadSubtree(parentId)
      const flatTree = buildFlatTree(allBlocks, newRoot)
      // Discard results if rootParentId changed while we were loading
      // (e.g. a newer load() was called for a different parent).
      if (get().rootParentId !== newRoot) return
      set({ blocks: flatTree, loading: false })
    } catch {
      if (get().rootParentId !== newRoot) return
      set({ loading: false })
      toast.error('Failed to load blocks')
    }
  },

  setFocused: (blockId: string | null) => {
    set({ focusedBlockId: blockId })
  },

  createBelow: async (afterBlockId: string, content = '') => {
    const { blocks } = get()
    const idx = blocks.findIndex((b) => b.id === afterBlockId)
    const afterBlock = blocks[idx]
    if (!afterBlock) return null

    try {
      const result = await createBlock({
        blockType: 'content',
        content,
        parentId: afterBlock.parent_id ?? undefined,
        position: (afterBlock.position ?? 0) + 1,
      })

      // Insert the new block into the local array at the right position.
      // In a flat tree, the new sibling goes right after the afterBlock
      // and all its descendants.
      const descendants = getDragDescendants(blocks, afterBlockId)
      let insertIdx = idx + 1
      while (insertIdx < blocks.length && descendants.has(blocks[insertIdx].id)) {
        insertIdx++
      }

      const newBlock: FlatBlock = {
        id: result.id,
        block_type: result.block_type,
        content: result.content,
        parent_id: result.parent_id,
        position: result.position,
        deleted_at: null,
        archived_at: null,
        is_conflict: false,
        conflict_type: null,
        depth: afterBlock.depth,
      }
      const newBlocks = [...blocks]
      newBlocks.splice(insertIdx, 0, newBlock)
      set({ blocks: newBlocks })
      notifyUndoNewAction(get().rootParentId)
      return result.id
    } catch {
      toast.error('Failed to create block')
      return null
    }
  },

  edit: async (blockId: string, content: string) => {
    try {
      await editBlock(blockId, content)
      set((state) => ({
        blocks: state.blocks.map((b) => (b.id === blockId ? { ...b, content } : b)),
      }))
      notifyUndoNewAction(get().rootParentId)
    } catch {
      toast.error('Failed to save changes')
    }
  },

  remove: async (blockId: string) => {
    const { blocks } = get()
    try {
      await deleteBlock(blockId)
      // Remove block AND its descendants from the flat tree
      const descendants = getDragDescendants(blocks, blockId)
      set((state) => ({
        blocks: state.blocks.filter((b) => b.id !== blockId && !descendants.has(b.id)),
        focusedBlockId: state.focusedBlockId === blockId ? null : state.focusedBlockId,
      }))
      notifyUndoNewAction(get().rootParentId)
    } catch {
      toast.error('Failed to delete block')
    }
  },

  splitBlock: async (blockId: string, markdown: string) => {
    // Parse markdown into block-level nodes (paragraphs, headings, code blocks)
    // and split each into a separate block. Empty paragraphs are skipped.
    const doc = parse(markdown)
    const blocks = doc.content ?? []
    if (blocks.length <= 1) {
      // Single block or empty — just edit, no split needed
      const content = blocks.length === 1 ? serialize({ type: 'doc', content: [blocks[0]] }) : ''
      if (content !== markdown) await get().edit(blockId, content)
      return
    }

    // Filter out empty paragraphs
    const nonEmpty = blocks.filter(
      (b) => b.type !== 'paragraph' || (b.content && b.content.length > 0),
    )
    if (nonEmpty.length === 0) return

    // First block: edit the original
    const first = serialize({ type: 'doc', content: [nonEmpty[0]] })
    await get().edit(blockId, first)

    // Remaining blocks: create new blocks below, in order
    let lastId = blockId
    for (let i = 1; i < nonEmpty.length; i++) {
      const content = serialize({ type: 'doc', content: [nonEmpty[i]] })
      const newId = await get().createBelow(lastId, content)
      if (newId) lastId = newId
    }
  },

  reorder: async (blockId: string, newIndex: number) => {
    const { blocks } = get()
    const oldIndex = blocks.findIndex((b) => b.id === blockId)
    if (oldIndex < 0 || oldIndex === newIndex) return

    const block = blocks[oldIndex]
    const parentId = block.parent_id

    // Calculate new position based on where the block will end up after
    // arrayMove semantics (splice-remove at oldIndex, splice-insert at newIndex).
    // Use sibling-aware bounds to avoid basing position on non-sibling blocks.
    const siblings = blocks.filter(
      (b) => b.id !== blockId && (b.parent_id ?? null) === (parentId ?? null),
    )
    const lastSiblingPos = siblings.length > 0
      ? (siblings[siblings.length - 1].position ?? 0)
      : 0
    const firstSiblingPos = siblings.length > 0
      ? (siblings[0].position ?? 0)
      : 0

    let newPosition: number
    if (newIndex > oldIndex) {
      if (newIndex >= blocks.length - 1) {
        newPosition = lastSiblingPos + 1
      } else {
        const beforePos = blocks[newIndex].position ?? 0
        const afterPos = blocks[newIndex + 1].position ?? 0
        newPosition = Math.floor((beforePos + afterPos) / 2)
        if (newPosition <= beforePos) {
          newPosition = beforePos + 1
        }
      }
    } else {
      if (newIndex === 0) {
        newPosition = firstSiblingPos - 1
      } else {
        const beforePos = blocks[newIndex - 1].position ?? 0
        const afterPos = blocks[newIndex].position ?? 0
        newPosition = Math.floor((beforePos + afterPos) / 2)
        if (newPosition <= beforePos) {
          newPosition = beforePos + 1
        }
      }
    }

    try {
      await moveBlock(blockId, parentId, newPosition)
      const newBlocks = [...blocks]
      const [moved] = newBlocks.splice(oldIndex, 1)
      newBlocks.splice(newIndex, 0, {
        ...moved,
        position: newPosition,
      })
      set({ blocks: newBlocks })
      notifyUndoNewAction(get().rootParentId)
    } catch {
      toast.error('Failed to reorder block')
    }
  },

  moveToParent: async (blockId: string, newParentId: string | null, newPosition: number) => {
    try {
      await moveBlock(blockId, newParentId, newPosition)
      // Reload the full tree to get the correct flattened order.
      // This is simpler and more reliable than trying to locally reorder
      // a flattened tree with depth changes.
      const { rootParentId } = get()
      await get().load(rootParentId ?? undefined)
      notifyUndoNewAction(rootParentId)
    } catch {
      toast.error('Failed to move block')
    }
  },

  indent: async (blockId: string) => {
    const { blocks } = get()
    const idx = blocks.findIndex((b) => b.id === blockId)
    if (idx <= 0) return // First block or not found — can't indent

    const block = blocks[idx]

    // Find the previous sibling (same parent AND same depth)
    let prevSibling: FlatBlock | undefined
    for (let i = idx - 1; i >= 0; i--) {
      if (
        blocks[i].depth === block.depth &&
        (blocks[i].parent_id ?? null) === (block.parent_id ?? null)
      ) {
        prevSibling = blocks[i]
        break
      }
      // If we hit a shallower block, there's no previous sibling
      if (blocks[i].depth < block.depth) break
    }

    if (!prevSibling) return

    // Move block to be a child of previous sibling, position 0
    try {
      await moveBlock(blockId, prevSibling.id, 0)

      // Local state update: reparent block + descendants under prevSibling
      const descendantIds = getDragDescendants(blocks, blockId)
      const movedSet = new Set([blockId, ...descendantIds])

      // Extract moved items with updated depth/parent
      const movedItems: FlatBlock[] = blocks
        .filter((b) => movedSet.has(b.id))
        .map((b) => ({
          ...b,
          depth: b.depth + 1,
          ...(b.id === blockId ? { parent_id: prevSibling?.id, position: 0 } : {}),
        }))

      // Remove moved items and find insertion point after prevSibling's subtree
      const remaining = blocks.filter((b) => !movedSet.has(b.id))
      const prevSibDescendants = getDragDescendants(remaining, prevSibling.id)
      let insertAt = remaining.findIndex((b) => b.id === prevSibling?.id) + 1
      while (insertAt < remaining.length && prevSibDescendants.has(remaining[insertAt].id)) {
        insertAt++
      }

      remaining.splice(insertAt, 0, ...movedItems)
      set({ blocks: remaining })
      notifyUndoNewAction(get().rootParentId)
    } catch {
      toast.error('Failed to indent block')
    }
  },

  dedent: async (blockId: string) => {
    const { blocks } = get()
    const block = blocks.find((b) => b.id === blockId)
    if (!block?.parent_id) return // Already at root — can't dedent

    // Find the parent block in the flat tree
    const parent = blocks.find((b) => b.id === block.parent_id)
    if (!parent) return

    // Move to grandparent, position after the parent
    const newParentId = parent.parent_id
    const newPosition = (parent.position ?? 0) + 1
    try {
      await moveBlock(blockId, newParentId, newPosition)

      // Local state update: move block + descendants after parent's subtree, depth -1
      const descendantIds = getDragDescendants(blocks, blockId)
      const movedSet = new Set([blockId, ...descendantIds])

      const movedItems: FlatBlock[] = blocks
        .filter((b) => movedSet.has(b.id))
        .map((b) => ({
          ...b,
          depth: b.depth - 1,
          ...(b.id === blockId ? { parent_id: newParentId, position: newPosition } : {}),
        }))

      // Remove moved items and find insertion point after parent's subtree
      const remaining = blocks.filter((b) => !movedSet.has(b.id))
      const parentDescendants = getDragDescendants(remaining, parent.id)
      let insertAt = remaining.findIndex((b) => b.id === parent.id) + 1
      while (insertAt < remaining.length && parentDescendants.has(remaining[insertAt].id)) {
        insertAt++
      }

      remaining.splice(insertAt, 0, ...movedItems)
      set({ blocks: remaining })
      notifyUndoNewAction(get().rootParentId)
    } catch {
      toast.error('Failed to dedent block')
    }
  },

  moveUp: async (blockId: string) => {
    const { blocks, rootParentId } = get()
    const block = blocks.find((b) => b.id === blockId)
    if (!block) return

    const parentId = block.parent_id

    // Collect siblings (same parent_id and depth) in flat-tree order
    const siblings = blocks.filter(
      (b) => (b.parent_id ?? null) === (parentId ?? null) && b.depth === block.depth,
    )
    const sibIndex = siblings.findIndex((b) => b.id === blockId)
    if (sibIndex <= 0) return // Already first sibling or not found

    const prevSibling = siblings[sibIndex - 1]
    const newPosition = (prevSibling.position ?? 0) - 1

    try {
      await moveBlock(blockId, parentId, newPosition)
      await get().load(rootParentId ?? undefined)
      notifyUndoNewAction(rootParentId)
    } catch {
      toast.error('Failed to move block up')
    }
  },

  moveDown: async (blockId: string) => {
    const { blocks, rootParentId } = get()
    const block = blocks.find((b) => b.id === blockId)
    if (!block) return

    const parentId = block.parent_id

    // Collect siblings (same parent_id and depth) in flat-tree order
    const siblings = blocks.filter(
      (b) => (b.parent_id ?? null) === (parentId ?? null) && b.depth === block.depth,
    )
    const sibIndex = siblings.findIndex((b) => b.id === blockId)
    if (sibIndex < 0 || sibIndex >= siblings.length - 1) return // Already last sibling

    const nextSibling = siblings[sibIndex + 1]
    const newPosition = (nextSibling.position ?? 0) + 1

    try {
      await moveBlock(blockId, parentId, newPosition)
      await get().load(rootParentId ?? undefined)
      notifyUndoNewAction(rootParentId)
    } catch {
      toast.error('Failed to move block down')
    }
  },
}))
