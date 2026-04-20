import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { makeBlock } from '../../__tests__/fixtures'
import { createPageBlockStore, type PageBlockState } from '../page-blocks'

const mockedInvoke = vi.mocked(invoke)

// --- Mock for undo store (used by notifyUndoNewAction in page-blocks.ts) ---
const mockOnNewAction = vi.fn()
const mockClearPage = vi.fn()
vi.mock('@/stores/undo', () => ({
  useUndoStore: {
    getState: () => ({
      onNewAction: mockOnNewAction,
      clearPage: mockClearPage,
    }),
  },
}))

// Mock the global block store (focus/selection) — page-blocks.ts imports it for cross-store updates
let mockGlobalBlockState = {
  focusedBlockId: null as string | null,
  selectedBlockIds: [] as string[],
}
const mockGlobalSetState = vi.fn()
vi.mock('@/stores/blocks', () => ({
  useBlockStore: {
    getState: () => mockGlobalBlockState,
    setState: (...args: unknown[]) => mockGlobalSetState(...args),
  },
}))

let store: StoreApi<PageBlockState>

describe('PageBlockStore', () => {
  beforeEach(() => {
    store = createPageBlockStore('PAGE_1')
    mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: [] }
    vi.clearAllMocks()
  })

  // ---------------------------------------------------------------------------
  // load
  // ---------------------------------------------------------------------------
  describe('load', () => {
    it('fetches blocks from the backend and stores them with depth', async () => {
      const blocks = [
        makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1' }),
      ]
      // Root level returns A and B
      mockedInvoke.mockResolvedValueOnce({
        items: blocks,
        next_cursor: null,
        has_more: false,
      })
      // Children of A — empty
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })
      // Children of B — empty
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

      await store.getState().load()

      const result = store.getState().blocks
      expect(result).toHaveLength(2)
      expect(result[0]?.id).toBe('A')
      expect(result[0]?.depth).toBe(0)
      expect(result[1]?.id).toBe('B')
      expect(store.getState().loading).toBe(false)
    })

    it('sets loading=true while the request is in flight', async () => {
      let resolvePromise!: (v: unknown) => void
      const pending = new Promise((resolve) => {
        resolvePromise = resolve
      })
      mockedInvoke.mockReturnValueOnce(pending)

      const loadPromise = store.getState().load()
      expect(store.getState().loading).toBe(true)

      resolvePromise({ items: [], next_cursor: null, has_more: false })
      await loadPromise

      expect(store.getState().loading).toBe(false)
    })

    it('resets loading on error without changing blocks', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('network'))

      await store.getState().load()

      expect(store.getState().loading).toBe(false)
      expect(store.getState().blocks).toEqual([])
    })

    it('passes parentId through to list_blocks', async () => {
      const s = createPageBlockStore('PARENT_42')
      mockedInvoke.mockResolvedValue({
        items: [],
        next_cursor: null,
        has_more: false,
      })

      await s.getState().load()

      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({ parentId: 'PARENT_42' }),
      )
    })

    it('preserves focused block content during sync reload', async () => {
      // Pre-populate store with blocks (simulating user editing block A)
      const blockA = makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'user is typing here' })
      const blockB = makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'original B' })
      store.setState({ blocks: [blockA, blockB] })

      // Simulate block A being focused (user is editing it)
      mockGlobalBlockState = { focusedBlockId: 'A', selectedBlockIds: [] }

      // Backend returns different (stale) content for block A
      const backendBlocks = [
        makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'old backend content' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'updated B from backend' }),
      ]
      mockedInvoke.mockResolvedValueOnce({
        items: backendBlocks,
        next_cursor: null,
        has_more: false,
      })
      // Children of A — empty
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })
      // Children of B — empty
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

      await store.getState().load()

      const result = store.getState().blocks
      // Focused block A should preserve its pre-load content
      expect(result.find((b) => b.id === 'A')?.content).toBe('user is typing here')
      // Non-focused block B should be updated from backend
      expect(result.find((b) => b.id === 'B')?.content).toBe('updated B from backend')
    })

    it('updates non-focused blocks from backend during sync reload', async () => {
      const blockA = makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'old A' })
      const blockB = makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'old B' })
      const blockC = makeBlock({ id: 'C', parent_id: 'PAGE_1', content: 'old C' })
      store.setState({ blocks: [blockA, blockB, blockC] })

      // Only block B is focused
      mockGlobalBlockState = { focusedBlockId: 'B', selectedBlockIds: [] }

      const backendBlocks = [
        makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'new A from backend' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'new B from backend' }),
        makeBlock({ id: 'C', parent_id: 'PAGE_1', content: 'new C from backend' }),
      ]
      mockedInvoke.mockResolvedValueOnce({
        items: backendBlocks,
        next_cursor: null,
        has_more: false,
      })
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

      await store.getState().load()

      const result = store.getState().blocks
      // Non-focused blocks A and C should be updated
      expect(result.find((b) => b.id === 'A')?.content).toBe('new A from backend')
      expect(result.find((b) => b.id === 'C')?.content).toBe('new C from backend')
      // Focused block B should preserve its pre-load content
      expect(result.find((b) => b.id === 'B')?.content).toBe('old B')
    })

    it('updates all blocks when no block is focused (normal reload)', async () => {
      const blockA = makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'old A' })
      const blockB = makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'old B' })
      store.setState({ blocks: [blockA, blockB] })

      // No block is focused
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: [] }

      const backendBlocks = [
        makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'new A from backend' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'new B from backend' }),
      ]
      mockedInvoke.mockResolvedValueOnce({
        items: backendBlocks,
        next_cursor: null,
        has_more: false,
      })
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

      await store.getState().load()

      const result = store.getState().blocks
      // All blocks should be updated from backend
      expect(result.find((b) => b.id === 'A')?.content).toBe('new A from backend')
      expect(result.find((b) => b.id === 'B')?.content).toBe('new B from backend')
    })
  })

  // ---------------------------------------------------------------------------
  // createBelow
  // ---------------------------------------------------------------------------
  describe('createBelow', () => {
    it('inserts a new block after the specified block', async () => {
      const blockA = makeBlock({ id: 'A', position: 0 })
      const blockB = makeBlock({ id: 'B', position: 1 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: 'new content',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      const newId = await store.getState().createBelow('A', 'new content')

      expect(newId).toBe('NEW')
      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(3)
      expect(blocks[0]?.id).toBe('A')
      expect(blocks[1]?.id).toBe('NEW')
      expect(blocks[1]?.content).toBe('new content')
      expect(blocks[2]?.id).toBe('B')
    })

    it('returns null when afterBlockId is not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      const result = await store.getState().createBelow('NONEXISTENT')

      expect(result).toBeNull()
      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('returns null on backend error (state unchanged)', async () => {
      const block = makeBlock({ id: 'A' })
      store.setState({ blocks: [block] })
      mockedInvoke.mockRejectedValueOnce(new Error('create failed'))

      const result = await store.getState().createBelow('A')

      expect(result).toBeNull()
      expect(store.getState().blocks).toHaveLength(1)
    })

    it('inherits parent_id from the afterBlock', async () => {
      const block = makeBlock({ id: 'A', parent_id: 'PARENT', position: 3 })
      store.setState({ blocks: [block] })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: '',
        parent_id: 'PARENT',
        position: 4,
        deleted_at: null,
      })

      await store.getState().createBelow('A')

      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_block',
        expect.objectContaining({
          parentId: 'PARENT',
          position: 4,
        }),
      )
    })

    it('defaults content to empty string', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', position: 0 })] })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: '',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      await store.getState().createBelow('A')

      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_block',
        expect.objectContaining({ content: '' }),
      )
    })
  })

  // ---------------------------------------------------------------------------
  // edit
  // ---------------------------------------------------------------------------
  describe('edit', () => {
    it('updates block content locally after successful backend call', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'new',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })

      await store.getState().edit('A', 'new')

      expect(store.getState().blocks[0]?.content).toBe('new')
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', { blockId: 'A', toText: 'new' })
    })

    it('rolls back optimistic content on backend error', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockRejectedValueOnce(new Error('edit failed'))

      await store.getState().edit('A', 'new')

      expect(store.getState().blocks[0]?.content).toBe('old')
    })

    it('shows toast.error on backend failure', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockRejectedValueOnce(new Error('edit failed'))

      await store.getState().edit('A', 'new')

      expect(toast.error).toHaveBeenCalledWith('Failed to save')
    })

    it('does not crash when editing a block that does not exist in the store', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'aaa' })] })
      mockedInvoke.mockRejectedValueOnce(new Error('not found'))

      await store.getState().edit('NONEXISTENT', 'whatever')

      // Store is unchanged — no crash
      expect(store.getState().blocks).toHaveLength(1)
      expect(store.getState().blocks[0]?.content).toBe('aaa')
    })

    it('only updates the target block, leaving others unchanged', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'aaa' }), makeBlock({ id: 'B', content: 'bbb' })],
      })
      mockedInvoke.mockResolvedValueOnce({})

      await store.getState().edit('A', 'aaa-updated')

      expect(store.getState().blocks[0]?.content).toBe('aaa-updated')
      expect(store.getState().blocks[1]?.content).toBe('bbb')
    })

    it('notifies undo with the original rootParentId even if it changes during await', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockImplementation(async () => {
        // Simulate rootParentId change during IPC
        store.setState({ rootParentId: 'PAGE_2' })
        return {}
      })

      await store.getState().edit('A', 'new')

      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })
  })

  // ---------------------------------------------------------------------------
  // remove
  // ---------------------------------------------------------------------------
  describe('remove', () => {
    it('removes the block from local state on success', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A' }), makeBlock({ id: 'B' })],
      })
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await store.getState().remove('A')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.id).toBe('B')
    })

    it('does not mutate global block store focus — callers manage focus', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A' })],
      })
      mockGlobalBlockState = { focusedBlockId: 'A', selectedBlockIds: [] }
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await store.getState().remove('A')

      expect(mockGlobalSetState).not.toHaveBeenCalled()
    })

    it('does not modify state on backend error', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A' })],
      })
      mockedInvoke.mockRejectedValueOnce(new Error('delete failed'))

      await store.getState().remove('A')

      expect(store.getState().blocks).toHaveLength(1)
    })

    it('does not mutate global block store selection — callers manage selection', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', content: 'alpha', position: 0 }),
          makeBlock({ id: 'B', content: 'beta', position: 1 }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: ['A', 'B'] }
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await store.getState().remove('A')

      expect(mockGlobalSetState).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // splitBlock
  // ---------------------------------------------------------------------------
  describe('splitBlock', () => {
    it('does nothing for single-line content', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().splitBlock('A', 'no newlines')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('edits first line and creates new blocks for remaining lines', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      // edit('A', 'line1') → invoke('edit_block', ...)
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'line1',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      // createBelow('A', 'line2') → invoke('create_block', ...)
      mockedInvoke.mockResolvedValueOnce({
        id: 'B',
        block_type: 'text',
        content: 'line2',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      // createBelow('B', 'line3') → invoke('create_block', ...)
      mockedInvoke.mockResolvedValueOnce({
        id: 'C',
        block_type: 'text',
        content: 'line3',
        parent_id: null,
        position: 2,
        deleted_at: null,
      })

      await store.getState().splitBlock('A', 'line1\nline2\nline3')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(3)
      expect(blocks[0]?.content).toBe('line1')
      expect(blocks[1]?.content).toBe('line2')
      expect(blocks[2]?.content).toBe('line3')
    })

    it('handles empty first line in split — filters empty paragraphs', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      // Empty paragraph filtered → only 'text' remains → single block, just edit
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'text',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })

      await store.getState().splitBlock('A', '\ntext')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.content).toBe('text')
    })

    it('chains createBelow sequentially using previous new id', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      store.setState({ blocks: [block] })

      // edit
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'a',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      // createBelow('A', 'b') → returns 'B'
      mockedInvoke.mockResolvedValueOnce({
        id: 'B',
        block_type: 'text',
        content: 'b',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      // createBelow('B', 'c') — note: must use B as the afterBlockId
      mockedInvoke.mockResolvedValueOnce({
        id: 'C',
        block_type: 'text',
        content: 'c',
        parent_id: null,
        position: 2,
        deleted_at: null,
      })

      await store.getState().splitBlock('A', 'a\nb\nc')

      // Verify the third invoke used position based on B's position
      expect(mockedInvoke).toHaveBeenCalledTimes(3)
      const blocks = store.getState().blocks
      expect(blocks.map((b) => b.id)).toEqual(['A', 'B', 'C'])
    })

    it('splits heading + paragraph into two blocks', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      store.setState({ blocks: [block] })

      // edit('A', '# Title') — first block is heading
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: '# Title',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      // createBelow('A', 'Paragraph') — second block is paragraph
      mockedInvoke.mockResolvedValueOnce({
        id: 'B',
        block_type: 'text',
        content: 'Paragraph',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      await store.getState().splitBlock('A', '# Title\nParagraph')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(2)
      expect(blocks[0]?.content).toBe('# Title')
      expect(blocks[1]?.content).toBe('Paragraph')
    })

    it('does NOT split single code block (multi-line content is one block)', async () => {
      const codeContent = '```\ncode line 1\ncode line 2\n```'
      const block = makeBlock({ id: 'A', position: 0, content: codeContent })
      store.setState({ blocks: [block] })

      // Single code block → blockCount = 1, serialized matches input → no edit, no split
      await store.getState().splitBlock('A', codeContent)

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.content).toBe(codeContent)
    })

    it('does NOT split single heading (single block)', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      await store.getState().splitBlock('A', '## Just a heading')

      // Single heading → blockCount = 1 → no split, no edit needed since content unchanged
      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(1)
    })

    it('filters empty paragraphs between content blocks', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      store.setState({ blocks: [block] })

      // 'hello\n\nworld' → 3 parsed blocks: paragraph("hello"), empty paragraph, paragraph("world")
      // After filtering empty: 2 blocks
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'hello',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      mockedInvoke.mockResolvedValueOnce({
        id: 'B',
        block_type: 'text',
        content: 'world',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      await store.getState().splitBlock('A', 'hello\n\nworld')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(2)
      expect(blocks[0]?.content).toBe('hello')
      expect(blocks[1]?.content).toBe('world')
    })

    it('rejects a second concurrent splitBlock on the same block (re-entrancy guard)', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      // Mocks for the first (and only) splitBlock that executes:
      // edit_block for 'line1'
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'line1',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      // create_block for 'line2'
      mockedInvoke.mockResolvedValueOnce({
        id: 'B',
        block_type: 'text',
        content: 'line2',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      // Fire two splitBlocks simultaneously on the same block
      await Promise.all([
        store.getState().splitBlock('A', 'line1\nline2'),
        store.getState().splitBlock('A', 'line1\nline2'),
      ])

      // Only the first splitBlock should have made backend calls (edit + create = 2)
      expect(mockedInvoke).toHaveBeenCalledTimes(2)

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(2)
      expect(blocks[0]?.content).toBe('line1')
      expect(blocks[1]?.content).toBe('line2')
    })

    it('clears re-entrancy guard after completion — next splitBlock works', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      // First splitBlock on block A
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'line1',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      mockedInvoke.mockResolvedValueOnce({
        id: 'B',
        block_type: 'text',
        content: 'line2',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      await store.getState().splitBlock('A', 'line1\nline2')
      expect(mockedInvoke).toHaveBeenCalledTimes(2)

      // Second splitBlock on same block A — should work (guard cleared)
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'x',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      mockedInvoke.mockResolvedValueOnce({
        id: 'C',
        block_type: 'text',
        content: 'y',
        parent_id: null,
        position: 2,
        deleted_at: null,
      })

      await store.getState().splitBlock('A', 'x\ny')
      expect(mockedInvoke).toHaveBeenCalledTimes(4)
    })
  })

  // ---------------------------------------------------------------------------
  // indent
  // ---------------------------------------------------------------------------
  describe('indent', () => {
    it('makes a block a child of its previous sibling', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'A',
        new_position: 0,
      })

      await store.getState().indent('B')

      const moved = store.getState().blocks.find((b) => b.id === 'B')
      expect(moved?.parent_id).toBe('A')
      expect(moved?.position).toBe(1)
      expect(moved?.depth).toBe(1)
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: 'A',
        newPosition: 1,
      })
    })

    it('does nothing for the first block (idx === 0)', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().indent('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does nothing when block not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().indent('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does nothing when previous block has a different parent', async () => {
      const blockA = makeBlock({ id: 'A', parent_id: 'P1', depth: 0 })
      const blockB = makeBlock({ id: 'B', parent_id: 'P2', depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      await store.getState().indent('B')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not update state on backend error', async () => {
      const blockA = makeBlock({ id: 'A', parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await store.getState().indent('B')

      expect(store.getState().blocks.find((b) => b.id === 'B')?.parent_id).toBeNull()
    })

    it('places indented block after prevSibling existing children (while-loop)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const childA1 = makeBlock({ id: 'A1', position: 0, parent_id: 'A', depth: 1 })
      const childA2 = makeBlock({ id: 'A2', position: 1, parent_id: 'A', depth: 1 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, childA1, childA2, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'A',
        new_position: 0,
      })

      await store.getState().indent('B')

      const blocks = store.getState().blocks
      const bIdx = blocks.findIndex((b) => b.id === 'B')
      expect(bIdx).toBeGreaterThan(blocks.findIndex((b) => b.id === 'A2'))
      expect(blocks[bIdx]?.parent_id).toBe('A')
      expect(blocks[bIdx]?.depth).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // moveToParent
  // ---------------------------------------------------------------------------
  describe('moveToParent', () => {
    it('calls moveBlock, reloads tree, and notifies undo', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // move_block
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'A',
        new_position: 0,
      })
      // list_blocks (reload from load())
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

      await store.getState().moveToParent('B', 'A', 0)

      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: 'A',
        newPosition: 0,
      })
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({ parentId: 'PAGE_1' }),
      )
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('does not update blocks or notify undo on backend error', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await store.getState().moveToParent('B', 'A', 0)

      expect(store.getState().blocks).toHaveLength(2)
      expect(store.getState().blocks[0]?.id).toBe('A')
      expect(store.getState().blocks[1]?.id).toBe('B')
      expect(mockOnNewAction).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // moveToParent race conditions
  // ---------------------------------------------------------------------------
  describe('moveToParent race conditions', () => {
    it('notifies undo with the original rootParentId even if it changes during await', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // Deferred promise for move_block so we can mutate state mid-flight.
      let resolveMove!: (v: unknown) => void
      const movePending = new Promise((resolve) => {
        resolveMove = resolve
      })
      mockedInvoke.mockReturnValueOnce(movePending)
      // list_blocks call(s) for the load() that follows moveBlock resolve. Cover root + any child fetches.
      mockedInvoke.mockResolvedValue({ items: [], next_cursor: null, has_more: false })

      const promise = store.getState().moveToParent('B', 'A', 0)

      // Simulate the user navigating to a different page while the IPC is in flight.
      store.setState({ rootParentId: 'DIFFERENT_PAGE' })

      // Resolve the move_block IPC; load() and notifyUndoNewAction run after.
      resolveMove({ block_id: 'B', new_parent_id: 'A', new_position: 0 })
      await promise

      // The undo notification must target the ORIGINAL page, not the one the user navigated to.
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
      expect(mockOnNewAction).not.toHaveBeenCalledWith('DIFFERENT_PAGE')
    })
  })

  // ---------------------------------------------------------------------------
  // dedent
  // ---------------------------------------------------------------------------
  describe('dedent', () => {
    it('moves a block up to its grandparent', async () => {
      const parent = makeBlock({ id: 'P', parent_id: null, position: 0, depth: 0 })
      const child = makeBlock({ id: 'C', parent_id: 'P', position: 0, depth: 1 })
      store.setState({ blocks: [parent, child] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 1,
      })

      await store.getState().dedent('C')

      const moved = store.getState().blocks.find((b) => b.id === 'C')
      expect(moved?.parent_id).toBeNull()
      expect(moved?.position).toBe(1)
      expect(moved?.depth).toBe(0)
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'C',
        newParentId: null,
        newPosition: 1,
      })
    })

    it('does nothing if block is at root level', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', parent_id: null })],
      })

      await store.getState().dedent('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does nothing when block not found', async () => {
      store.setState({ blocks: [] })

      await store.getState().dedent('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does nothing when parent is not in the blocks array', async () => {
      const orphan = makeBlock({ id: 'A', parent_id: 'MISSING_PARENT' })
      store.setState({ blocks: [orphan] })

      await store.getState().dedent('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not update state on backend error', async () => {
      const parent = makeBlock({ id: 'P', parent_id: null, depth: 0 })
      const child = makeBlock({ id: 'C', parent_id: 'P', depth: 1 })
      store.setState({ blocks: [parent, child] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await store.getState().dedent('C')

      expect(store.getState().blocks.find((b) => b.id === 'C')?.parent_id).toBe('P')
    })

    it('positions after parent when moving to grandparent', async () => {
      const parent = makeBlock({ id: 'P', parent_id: 'GP', position: 5, depth: 1 })
      const child = makeBlock({ id: 'C', parent_id: 'P', position: 0, depth: 2 })
      store.setState({ blocks: [parent, child] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: 'GP',
        new_position: 6,
      })

      await store.getState().dedent('C')

      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'C',
        newParentId: 'GP',
        newPosition: 6,
      })
    })

    it('places dedented block after parent subtree with other descendants (while-loop)', async () => {
      const grandparent = makeBlock({ id: 'GP', parent_id: null, position: 0, depth: 0 })
      const parent = makeBlock({ id: 'P', parent_id: 'GP', position: 0, depth: 1 })
      const sibling = makeBlock({ id: 'S', parent_id: 'P', position: 0, depth: 2 })
      const child = makeBlock({ id: 'C', parent_id: 'P', position: 1, depth: 2 })
      const otherRoot = makeBlock({ id: 'R', parent_id: null, position: 1, depth: 0 })
      store.setState({ blocks: [grandparent, parent, sibling, child, otherRoot] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: 'GP',
        new_position: 1,
      })

      await store.getState().dedent('C')

      const blocks = store.getState().blocks
      const cIdx = blocks.findIndex((b) => b.id === 'C')
      const sIdx = blocks.findIndex((b) => b.id === 'S')
      const pIdx = blocks.findIndex((b) => b.id === 'P')
      expect(cIdx).toBeGreaterThan(sIdx)
      expect(cIdx).toBeGreaterThan(pIdx)
      expect(blocks[cIdx]?.depth).toBe(1)
      expect(blocks[cIdx]?.parent_id).toBe('GP')
    })
  })

  // ---------------------------------------------------------------------------
  // reorder
  // ---------------------------------------------------------------------------
  describe('reorder', () => {
    it('calls moveBlock and reorders the local array', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 2, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 0,
      })

      await store.getState().reorder('C', 0)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'move_block',
        expect.objectContaining({ blockId: 'C', newParentId: null }),
      )
      const blocks = store.getState().blocks
      expect(blocks[0]?.id).toBe('C')
      expect(blocks[1]?.id).toBe('A')
      expect(blocks[2]?.id).toBe('B')
    })

    it('is no-op when same index', async () => {
      const blockA = makeBlock({ id: 'A', position: 0 })
      const blockB = makeBlock({ id: 'B', position: 1 })
      store.setState({ blocks: [blockA, blockB] })

      await store.getState().reorder('A', 0)

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('is no-op when blockId not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().reorder('NONEXISTENT', 0)

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not update state on backend error', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await store.getState().reorder('B', 0)

      const blocks = store.getState().blocks
      expect(blocks[0]?.id).toBe('A')
      expect(blocks[1]?.id).toBe('B')
    })

    it('moves block down in the list (arrayMove semantics)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 2, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: null,
        new_position: 3,
      })

      // Move A to index 2 (where C is) → [B, C, A] via arrayMove
      await store.getState().reorder('A', 2)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'move_block',
        expect.objectContaining({ blockId: 'A', newParentId: null }),
      )
      const blocks = store.getState().blocks
      // arrayMove([A,B,C], 0, 2) → [B, C, A]
      expect(blocks[0]?.id).toBe('B')
      expect(blocks[1]?.id).toBe('C')
      expect(blocks[2]?.id).toBe('A')
    })

    it('preserves parent_id when reordering', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: 'PARENT' })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: 'PARENT' })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'PARENT',
        new_position: -1,
      })

      await store.getState().reorder('B', 0)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'move_block',
        expect.objectContaining({ blockId: 'B', newParentId: 'PARENT' }),
      )
    })

    it('handles consecutive positions (collision avoidance) for backward move', async () => {
      // Positions 10, 11, 12 — consecutive, no room for Math.floor average
      const blockA = makeBlock({ id: 'A', position: 10, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 11, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 12, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 11,
      })

      // Move C (idx 2) to idx 1 → between A(10) and B(11)
      // floor((10+11)/2) = 10, which <= 10, so nudge up → 11
      // Position 11 collides with B but local array order is correct
      await store.getState().reorder('C', 1)

      const blocks = store.getState().blocks
      expect(blocks.map((b) => b.id)).toEqual(['A', 'C', 'B'])
      // Position is nudged to beforePos + 1
      expect(blocks[1]?.position).toBe(11)
    })

    it('handles consecutive positions for forward move', async () => {
      const blockA = makeBlock({ id: 'A', position: 10, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 11, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 12, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: null,
        new_position: 12,
      })

      // Move A (idx 0) to idx 1 → between B(11) and C(12)
      // floor((11+12)/2) = 11, which <= 11, so nudge up → 12
      await store.getState().reorder('A', 1)

      const blocks = store.getState().blocks
      // arrayMove([A,B,C], 0, 1) → [B, A, C]
      expect(blocks.map((b) => b.id)).toEqual(['B', 'A', 'C'])
      expect(blocks[1]?.position).toBe(12)
    })

    it('assigns position after last block when moving forward to last index', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 10, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: null,
        new_position: 11,
      })

      // Move A to last index (2) — hits newIndex >= blocks.length - 1 branch
      await store.getState().reorder('A', 2)

      const blocks = store.getState().blocks
      // arrayMove([A,B,C], 0, 2) → [B, C, A]
      expect(blocks.map((b) => b.id)).toEqual(['B', 'C', 'A'])
      // Position = last block's position + 1
      expect(blocks[2]?.position).toBe(11)
    })

    it('uses average position when there is room between positions', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 10, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 20, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 5,
      })

      // Move C (idx 2) to idx 1 → between A(0) and B(10)
      // floor((0+10)/2) = 5, which > 0, so no nudge needed
      await store.getState().reorder('C', 1)

      const blocks = store.getState().blocks
      expect(blocks.map((b) => b.id)).toEqual(['A', 'C', 'B'])
      expect(blocks[1]?.position).toBe(5)
    })
  })

  // ---------------------------------------------------------------------------
  // moveUp
  // ---------------------------------------------------------------------------
  describe('moveUp', () => {
    it('calls move_block with prevSibling.position - 1, then reloads', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // move_block
      mockedInvoke.mockResolvedValueOnce({})
      // list_blocks (reload)
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

      await store.getState().moveUp('B')

      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: null,
        newPosition: -1, // prevSibling(A).position(0) - 1
      })
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({ parentId: 'PAGE_1' }),
      )
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('is no-op when block is the first sibling', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      await store.getState().moveUp('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('is no-op when block is not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().moveUp('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not crash on backend error (silently fails)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await expect(store.getState().moveUp('B')).resolves.toBeUndefined()
      expect(store.getState().blocks).toHaveLength(2)
    })

    it('uses correct parentId in move_block call', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: 'PARENT', depth: 1 })
      const blockB = makeBlock({ id: 'B', position: 3, parent_id: 'PARENT', depth: 1 })
      store.setState({ blocks: [blockA, blockB] })

      // move_block
      mockedInvoke.mockResolvedValueOnce({})
      // list_blocks (reload)
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

      await store.getState().moveUp('B')

      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: 'PARENT',
        newPosition: -1, // prevSibling(A).position(0) - 1
      })
    })
  })

  // ---------------------------------------------------------------------------
  // moveDown
  // ---------------------------------------------------------------------------
  describe('moveDown', () => {
    it('calls move_block with nextSibling.position + 1, then reloads', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // move_block
      mockedInvoke.mockResolvedValueOnce({})
      // list_blocks (reload)
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

      await store.getState().moveDown('A')

      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'A',
        newParentId: null,
        newPosition: 6, // nextSibling(B).position(5) + 1
      })
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({ parentId: 'PAGE_1' }),
      )
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('is no-op when block is the last sibling', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      await store.getState().moveDown('B')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('is no-op when block is not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().moveDown('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not crash on backend error (silently fails)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await expect(store.getState().moveDown('A')).resolves.toBeUndefined()
      expect(store.getState().blocks).toHaveLength(2)
    })
  })

  // ---------------------------------------------------------------------------
  // undo store integration — notifyUndoNewAction
  // ---------------------------------------------------------------------------
  describe('undo store integration', () => {
    it('createBelow calls onNewAction after successful create', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      store.setState({ blocks: [block] })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: '',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      await store.getState().createBelow('A')

      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('edit calls onNewAction after successful edit', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'new',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })

      await store.getState().edit('A', 'new')

      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('remove calls onNewAction after successful delete', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A' })],
      })
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await store.getState().remove('A')

      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('does NOT call onNewAction when createBelow fails', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      store.setState({ blocks: [block] })

      mockedInvoke.mockRejectedValueOnce(new Error('create failed'))

      await store.getState().createBelow('A')

      expect(mockOnNewAction).not.toHaveBeenCalled()
    })

    it('does NOT call onNewAction when edit fails', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockRejectedValueOnce(new Error('edit failed'))

      await store.getState().edit('A', 'new')

      expect(mockOnNewAction).not.toHaveBeenCalled()
    })

    it('does NOT call onNewAction when remove fails', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A' })],
      })
      mockedInvoke.mockRejectedValueOnce(new Error('delete failed'))

      await store.getState().remove('A')

      expect(mockOnNewAction).not.toHaveBeenCalled()
    })
  })
})
