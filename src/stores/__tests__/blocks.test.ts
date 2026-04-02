import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlockStore } from '../blocks'

vi.mock('sonner', () => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() })
  return { toast }
})

const mockedInvoke = vi.mocked(invoke)

// --- Mock for undo store (used by notifyUndoNewAction in blocks.ts) ---
const mockOnNewAction = vi.fn()
vi.mock('@/stores/undo', () => ({
  useUndoStore: {
    getState: () => ({
      onNewAction: mockOnNewAction,
    }),
  },
}))

/** Helper — build a FlatBlock with defaults. */
function makeBlock(
  overrides: Partial<{
    id: string
    block_type: string
    content: string | null
    parent_id: string | null
    position: number | null
    deleted_at: string | null
    archived_at: string | null
    is_conflict: boolean
    conflict_type: string | null
    depth: number
  }> = {},
) {
  return {
    id: overrides.id ?? 'BLOCK_001',
    block_type: overrides.block_type ?? 'text',
    content: overrides.content ?? 'hello',
    parent_id: overrides.parent_id ?? null,
    position: overrides.position ?? 0,
    deleted_at: overrides.deleted_at ?? null,
    archived_at: overrides.archived_at ?? null,
    is_conflict: overrides.is_conflict ?? false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    depth: overrides.depth ?? 0,
  }
}

describe('useBlockStore', () => {
  beforeEach(() => {
    useBlockStore.setState({
      blocks: [],
      rootParentId: null,
      focusedBlockId: null,
      loading: false,
    })
    vi.clearAllMocks()
  })

  // ---------------------------------------------------------------------------
  // load
  // ---------------------------------------------------------------------------
  describe('load', () => {
    it('fetches blocks from the backend and stores them with depth', async () => {
      const blocks = [makeBlock({ id: 'A' }), makeBlock({ id: 'B' })]
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

      await useBlockStore.getState().load()

      const result = useBlockStore.getState().blocks
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('A')
      expect(result[0].depth).toBe(0)
      expect(result[1].id).toBe('B')
      expect(useBlockStore.getState().loading).toBe(false)
    })

    it('sets loading=true while the request is in flight', async () => {
      let resolvePromise!: (v: unknown) => void
      const pending = new Promise((resolve) => {
        resolvePromise = resolve
      })
      mockedInvoke.mockReturnValueOnce(pending)

      const loadPromise = useBlockStore.getState().load()
      expect(useBlockStore.getState().loading).toBe(true)

      resolvePromise({ items: [], next_cursor: null, has_more: false })
      await loadPromise

      expect(useBlockStore.getState().loading).toBe(false)
    })

    it('resets loading on error without changing blocks', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('network'))

      await useBlockStore.getState().load()

      expect(useBlockStore.getState().loading).toBe(false)
      expect(useBlockStore.getState().blocks).toEqual([])
    })

    it('passes parentId through to list_blocks', async () => {
      mockedInvoke.mockResolvedValue({
        items: [],
        next_cursor: null,
        has_more: false,
      })

      await useBlockStore.getState().load('PARENT_42')

      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({ parentId: 'PARENT_42' }),
      )
    })

    it('clears blocks immediately when switching to a different parent', async () => {
      // Pre-populate store with blocks from a previous parent
      useBlockStore.setState({
        blocks: [makeBlock({ id: 'OLD', parent_id: 'PAGE_A' })],
        rootParentId: 'PAGE_A',
        focusedBlockId: 'OLD',
      })

      // Start loading a different parent (never resolves)
      mockedInvoke.mockReturnValueOnce(new Promise(() => {}))
      const loadPromise = useBlockStore.getState().load('PAGE_B')

      // Blocks and focusedBlockId are cleared synchronously
      expect(useBlockStore.getState().blocks).toEqual([])
      expect(useBlockStore.getState().focusedBlockId).toBeNull()
      expect(useBlockStore.getState().rootParentId).toBe('PAGE_B')
      expect(useBlockStore.getState().loading).toBe(true)

      // Cleanup — avoid unhandled rejection
      void loadPromise
    })

    it('preserves blocks when reloading the same parent', async () => {
      const existing = [makeBlock({ id: 'KEEP', parent_id: 'PAGE_A' })]
      useBlockStore.setState({
        blocks: existing,
        rootParentId: 'PAGE_A',
        focusedBlockId: 'KEEP',
      })

      // Start reloading the same parent (never resolves)
      mockedInvoke.mockReturnValueOnce(new Promise(() => {}))
      const loadPromise = useBlockStore.getState().load('PAGE_A')

      // Blocks are NOT cleared — avoids flash of empty content
      expect(useBlockStore.getState().blocks).toEqual(existing)
      expect(useBlockStore.getState().focusedBlockId).toBe('KEEP')
      expect(useBlockStore.getState().loading).toBe(true)

      void loadPromise
    })

    it('discards results from a stale fetch when a newer load() wins', async () => {
      let resolveFirst!: (v: unknown) => void
      const firstFetch = new Promise((resolve) => {
        resolveFirst = resolve
      })
      const emptyPage = { items: [], next_cursor: null, has_more: false }

      // 1) Start loading PAGE_A (slow fetch)
      mockedInvoke.mockReturnValueOnce(firstFetch)
      const firstLoad = useBlockStore.getState().load('PAGE_A')

      // 2) Before PAGE_A completes, switch to PAGE_B (fast fetch)
      mockedInvoke.mockResolvedValue(emptyPage)
      const secondLoad = useBlockStore.getState().load('PAGE_B')
      await secondLoad

      expect(useBlockStore.getState().rootParentId).toBe('PAGE_B')
      expect(useBlockStore.getState().loading).toBe(false)

      // 3) PAGE_A's fetch finally completes — results must be discarded
      resolveFirst(emptyPage)
      await firstLoad

      // Store should still reflect PAGE_B, not revert to PAGE_A
      expect(useBlockStore.getState().rootParentId).toBe('PAGE_B')
      expect(useBlockStore.getState().loading).toBe(false)
    })

    it('discards error from a stale fetch without showing toast', async () => {
      const { toast } = await import('sonner')
      const mockedToastError = vi.mocked(toast.error)

      let rejectFirst!: (e: Error) => void
      const firstFetch = new Promise((_resolve, reject) => {
        rejectFirst = reject
      })
      const emptyPage = { items: [], next_cursor: null, has_more: false }

      // 1) Start loading PAGE_A (will fail)
      mockedInvoke.mockReturnValueOnce(firstFetch)
      const firstLoad = useBlockStore.getState().load('PAGE_A')

      // 2) Switch to PAGE_B before PAGE_A fails
      mockedInvoke.mockResolvedValue(emptyPage)
      await useBlockStore.getState().load('PAGE_B')

      // 3) PAGE_A fails — should NOT show error toast or change loading state
      rejectFirst(new Error('network'))
      await firstLoad

      expect(useBlockStore.getState().rootParentId).toBe('PAGE_B')
      expect(useBlockStore.getState().loading).toBe(false)
      expect(mockedToastError).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // setFocused
  // ---------------------------------------------------------------------------
  describe('setFocused', () => {
    it('sets the focused block id', () => {
      useBlockStore.getState().setFocused('BLOCK_A')
      expect(useBlockStore.getState().focusedBlockId).toBe('BLOCK_A')
    })

    it('clears the focused block id', () => {
      useBlockStore.setState({ focusedBlockId: 'BLOCK_A' })
      useBlockStore.getState().setFocused(null)
      expect(useBlockStore.getState().focusedBlockId).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // createBelow
  // ---------------------------------------------------------------------------
  describe('createBelow', () => {
    it('inserts a new block after the specified block', async () => {
      const blockA = makeBlock({ id: 'A', position: 0 })
      const blockB = makeBlock({ id: 'B', position: 1 })
      useBlockStore.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: 'new content',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      const newId = await useBlockStore.getState().createBelow('A', 'new content')

      expect(newId).toBe('NEW')
      const blocks = useBlockStore.getState().blocks
      expect(blocks).toHaveLength(3)
      expect(blocks[0].id).toBe('A')
      expect(blocks[1].id).toBe('NEW')
      expect(blocks[1].content).toBe('new content')
      expect(blocks[2].id).toBe('B')
    })

    it('returns null when afterBlockId is not found', async () => {
      useBlockStore.setState({ blocks: [makeBlock({ id: 'A' })] })

      const result = await useBlockStore.getState().createBelow('NONEXISTENT')

      expect(result).toBeNull()
      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('returns null on backend error (state unchanged)', async () => {
      const block = makeBlock({ id: 'A' })
      useBlockStore.setState({ blocks: [block] })
      mockedInvoke.mockRejectedValueOnce(new Error('create failed'))

      const result = await useBlockStore.getState().createBelow('A')

      expect(result).toBeNull()
      expect(useBlockStore.getState().blocks).toHaveLength(1)
    })

    it('inherits parent_id from the afterBlock', async () => {
      const block = makeBlock({ id: 'A', parent_id: 'PARENT', position: 3 })
      useBlockStore.setState({ blocks: [block] })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: '',
        parent_id: 'PARENT',
        position: 4,
        deleted_at: null,
      })

      await useBlockStore.getState().createBelow('A')

      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_block',
        expect.objectContaining({
          parentId: 'PARENT',
          position: 4,
        }),
      )
    })

    it('defaults content to empty string', async () => {
      useBlockStore.setState({ blocks: [makeBlock({ id: 'A', position: 0 })] })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: '',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      await useBlockStore.getState().createBelow('A')

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
      useBlockStore.setState({
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

      await useBlockStore.getState().edit('A', 'new')

      expect(useBlockStore.getState().blocks[0].content).toBe('new')
    })

    it('preserves optimistic content on backend error', async () => {
      useBlockStore.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockRejectedValueOnce(new Error('edit failed'))

      await useBlockStore.getState().edit('A', 'new')

      expect(useBlockStore.getState().blocks[0].content).toBe('new')
    })

    it('only updates the target block, leaving others unchanged', async () => {
      useBlockStore.setState({
        blocks: [makeBlock({ id: 'A', content: 'aaa' }), makeBlock({ id: 'B', content: 'bbb' })],
      })
      mockedInvoke.mockResolvedValueOnce({})

      await useBlockStore.getState().edit('A', 'aaa-updated')

      expect(useBlockStore.getState().blocks[0].content).toBe('aaa-updated')
      expect(useBlockStore.getState().blocks[1].content).toBe('bbb')
    })

    it('notifies undo with the original rootParentId even if it changes during await', async () => {
      useBlockStore.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
        rootParentId: 'PAGE_1',
      })
      mockedInvoke.mockImplementation(async () => {
        // Simulate navigation during IPC — rootParentId changes
        useBlockStore.setState({ rootParentId: 'PAGE_2' })
        return {}
      })

      await useBlockStore.getState().edit('A', 'new')

      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })
  })

  // ---------------------------------------------------------------------------
  // remove
  // ---------------------------------------------------------------------------
  describe('remove', () => {
    it('removes the block from local state on success', async () => {
      useBlockStore.setState({
        blocks: [makeBlock({ id: 'A' }), makeBlock({ id: 'B' })],
        focusedBlockId: null,
      })
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await useBlockStore.getState().remove('A')

      const blocks = useBlockStore.getState().blocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0].id).toBe('B')
    })

    it('clears focusedBlockId when the focused block is deleted', async () => {
      useBlockStore.setState({
        blocks: [makeBlock({ id: 'A' })],
        focusedBlockId: 'A',
      })
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await useBlockStore.getState().remove('A')

      expect(useBlockStore.getState().focusedBlockId).toBeNull()
    })

    it('preserves focusedBlockId when a different block is deleted', async () => {
      useBlockStore.setState({
        blocks: [makeBlock({ id: 'A' }), makeBlock({ id: 'B' })],
        focusedBlockId: 'A',
      })
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await useBlockStore.getState().remove('B')

      expect(useBlockStore.getState().focusedBlockId).toBe('A')
    })

    it('does not modify state on backend error', async () => {
      useBlockStore.setState({
        blocks: [makeBlock({ id: 'A' })],
        focusedBlockId: 'A',
      })
      mockedInvoke.mockRejectedValueOnce(new Error('delete failed'))

      await useBlockStore.getState().remove('A')

      expect(useBlockStore.getState().blocks).toHaveLength(1)
      expect(useBlockStore.getState().focusedBlockId).toBe('A')
    })
  })

  // ---------------------------------------------------------------------------
  // splitBlock
  // ---------------------------------------------------------------------------
  describe('splitBlock', () => {
    it('does nothing for single-line content', async () => {
      useBlockStore.setState({ blocks: [makeBlock({ id: 'A' })] })

      await useBlockStore.getState().splitBlock('A', 'no newlines')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('edits first line and creates new blocks for remaining lines', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      useBlockStore.setState({ blocks: [block] })

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

      await useBlockStore.getState().splitBlock('A', 'line1\nline2\nline3')

      const blocks = useBlockStore.getState().blocks
      expect(blocks).toHaveLength(3)
      expect(blocks[0].content).toBe('line1')
      expect(blocks[1].content).toBe('line2')
      expect(blocks[2].content).toBe('line3')
    })

    it('handles empty first line in split — filters empty paragraphs', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      useBlockStore.setState({ blocks: [block] })

      // Empty paragraph filtered → only 'text' remains → single block, just edit
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'text',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })

      await useBlockStore.getState().splitBlock('A', '\ntext')

      const blocks = useBlockStore.getState().blocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0].content).toBe('text')
    })

    it('chains createBelow sequentially using previous new id', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      useBlockStore.setState({ blocks: [block] })

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

      await useBlockStore.getState().splitBlock('A', 'a\nb\nc')

      // Verify the third invoke used position based on B's position
      expect(mockedInvoke).toHaveBeenCalledTimes(3)
      const blocks = useBlockStore.getState().blocks
      expect(blocks.map((b) => b.id)).toEqual(['A', 'B', 'C'])
    })

    it('splits heading + paragraph into two blocks', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      useBlockStore.setState({ blocks: [block] })

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

      await useBlockStore.getState().splitBlock('A', '# Title\nParagraph')

      const blocks = useBlockStore.getState().blocks
      expect(blocks).toHaveLength(2)
      expect(blocks[0].content).toBe('# Title')
      expect(blocks[1].content).toBe('Paragraph')
    })

    it('does NOT split single code block (multi-line content is one block)', async () => {
      const codeContent = '```\ncode line 1\ncode line 2\n```'
      const block = makeBlock({ id: 'A', position: 0, content: codeContent })
      useBlockStore.setState({ blocks: [block] })

      // Single code block → blockCount = 1, serialized matches input → no edit, no split
      await useBlockStore.getState().splitBlock('A', codeContent)

      const blocks = useBlockStore.getState().blocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0].content).toBe(codeContent)
    })

    it('does NOT split single heading (single block)', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      useBlockStore.setState({ blocks: [block] })

      await useBlockStore.getState().splitBlock('A', '## Just a heading')

      // Single heading → blockCount = 1 → no split, no edit needed since content unchanged
      const blocks = useBlockStore.getState().blocks
      expect(blocks).toHaveLength(1)
    })

    it('filters empty paragraphs between content blocks', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      useBlockStore.setState({ blocks: [block] })

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

      await useBlockStore.getState().splitBlock('A', 'hello\n\nworld')

      const blocks = useBlockStore.getState().blocks
      expect(blocks).toHaveLength(2)
      expect(blocks[0].content).toBe('hello')
      expect(blocks[1].content).toBe('world')
    })
  })

  // ---------------------------------------------------------------------------
  // indent
  // ---------------------------------------------------------------------------
  describe('indent', () => {
    it('makes a block a child of its previous sibling', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      useBlockStore.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'A',
        new_position: 0,
      })

      await useBlockStore.getState().indent('B')

      const moved = useBlockStore.getState().blocks.find((b) => b.id === 'B')
      expect(moved?.parent_id).toBe('A')
      expect(moved?.position).toBe(0)
      expect(moved?.depth).toBe(1)
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: 'A',
        newPosition: 0,
      })
    })

    it('does nothing for the first block (idx === 0)', async () => {
      useBlockStore.setState({ blocks: [makeBlock({ id: 'A' })] })

      await useBlockStore.getState().indent('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does nothing when block not found', async () => {
      useBlockStore.setState({ blocks: [makeBlock({ id: 'A' })] })

      await useBlockStore.getState().indent('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does nothing when previous block has a different parent', async () => {
      const blockA = makeBlock({ id: 'A', parent_id: 'P1', depth: 0 })
      const blockB = makeBlock({ id: 'B', parent_id: 'P2', depth: 0 })
      useBlockStore.setState({ blocks: [blockA, blockB] })

      await useBlockStore.getState().indent('B')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not update state on backend error', async () => {
      const blockA = makeBlock({ id: 'A', parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', parent_id: null, depth: 0 })
      useBlockStore.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await useBlockStore.getState().indent('B')

      expect(useBlockStore.getState().blocks.find((b) => b.id === 'B')?.parent_id).toBeNull()
    })

    it('places indented block after prevSibling existing children (while-loop)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const childA1 = makeBlock({ id: 'A1', position: 0, parent_id: 'A', depth: 1 })
      const childA2 = makeBlock({ id: 'A2', position: 1, parent_id: 'A', depth: 1 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      useBlockStore.setState({ blocks: [blockA, childA1, childA2, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'A',
        new_position: 0,
      })

      await useBlockStore.getState().indent('B')

      const blocks = useBlockStore.getState().blocks
      const bIdx = blocks.findIndex((b) => b.id === 'B')
      expect(bIdx).toBeGreaterThan(blocks.findIndex((b) => b.id === 'A2'))
      expect(blocks[bIdx].parent_id).toBe('A')
      expect(blocks[bIdx].depth).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // moveToParent
  // ---------------------------------------------------------------------------
  describe('moveToParent', () => {
    it('calls moveBlock, reloads tree, and notifies undo', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      useBlockStore.setState({ blocks: [blockA, blockB], rootParentId: 'PAGE1' })

      // move_block
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'A',
        new_position: 0,
      })
      // list_blocks (reload from load())
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

      await useBlockStore.getState().moveToParent('B', 'A', 0)

      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: 'A',
        newPosition: 0,
      })
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({ parentId: 'PAGE1' }),
      )
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE1')
    })

    it('does not update blocks or notify undo on backend error', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      useBlockStore.setState({ blocks: [blockA, blockB], rootParentId: 'PAGE1' })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await useBlockStore.getState().moveToParent('B', 'A', 0)

      expect(useBlockStore.getState().blocks).toHaveLength(2)
      expect(useBlockStore.getState().blocks[0].id).toBe('A')
      expect(useBlockStore.getState().blocks[1].id).toBe('B')
      expect(mockOnNewAction).not.toHaveBeenCalled()
    })

    it('handles null rootParentId (passes undefined to load)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      useBlockStore.setState({ blocks: [blockA], rootParentId: null })

      // move_block
      mockedInvoke.mockResolvedValueOnce({})
      // list_blocks (reload) — called with parentId: null (top-level)
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

      await useBlockStore.getState().moveToParent('A', null, 0)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({ parentId: null }),
      )
      expect(mockOnNewAction).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // dedent
  // ---------------------------------------------------------------------------
  describe('dedent', () => {
    it('moves a block up to its grandparent', async () => {
      const parent = makeBlock({ id: 'P', parent_id: null, position: 0, depth: 0 })
      const child = makeBlock({ id: 'C', parent_id: 'P', position: 0, depth: 1 })
      useBlockStore.setState({ blocks: [parent, child] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 1,
      })

      await useBlockStore.getState().dedent('C')

      const moved = useBlockStore.getState().blocks.find((b) => b.id === 'C')
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
      useBlockStore.setState({
        blocks: [makeBlock({ id: 'A', parent_id: null })],
      })

      await useBlockStore.getState().dedent('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does nothing when block not found', async () => {
      useBlockStore.setState({ blocks: [] })

      await useBlockStore.getState().dedent('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does nothing when parent is not in the blocks array', async () => {
      const orphan = makeBlock({ id: 'A', parent_id: 'MISSING_PARENT' })
      useBlockStore.setState({ blocks: [orphan] })

      await useBlockStore.getState().dedent('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not update state on backend error', async () => {
      const parent = makeBlock({ id: 'P', parent_id: null, depth: 0 })
      const child = makeBlock({ id: 'C', parent_id: 'P', depth: 1 })
      useBlockStore.setState({ blocks: [parent, child] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await useBlockStore.getState().dedent('C')

      expect(useBlockStore.getState().blocks.find((b) => b.id === 'C')?.parent_id).toBe('P')
    })

    it('positions after parent when moving to grandparent', async () => {
      const parent = makeBlock({ id: 'P', parent_id: 'GP', position: 5, depth: 1 })
      const child = makeBlock({ id: 'C', parent_id: 'P', position: 0, depth: 2 })
      useBlockStore.setState({ blocks: [parent, child] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: 'GP',
        new_position: 6,
      })

      await useBlockStore.getState().dedent('C')

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
      useBlockStore.setState({ blocks: [grandparent, parent, sibling, child, otherRoot] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: 'GP',
        new_position: 1,
      })

      await useBlockStore.getState().dedent('C')

      const blocks = useBlockStore.getState().blocks
      const cIdx = blocks.findIndex((b) => b.id === 'C')
      const sIdx = blocks.findIndex((b) => b.id === 'S')
      const pIdx = blocks.findIndex((b) => b.id === 'P')
      expect(cIdx).toBeGreaterThan(sIdx)
      expect(cIdx).toBeGreaterThan(pIdx)
      expect(blocks[cIdx].depth).toBe(1)
      expect(blocks[cIdx].parent_id).toBe('GP')
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
      useBlockStore.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 0,
      })

      await useBlockStore.getState().reorder('C', 0)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'move_block',
        expect.objectContaining({ blockId: 'C', newParentId: null }),
      )
      const blocks = useBlockStore.getState().blocks
      expect(blocks[0].id).toBe('C')
      expect(blocks[1].id).toBe('A')
      expect(blocks[2].id).toBe('B')
    })

    it('is no-op when same index', async () => {
      const blockA = makeBlock({ id: 'A', position: 0 })
      const blockB = makeBlock({ id: 'B', position: 1 })
      useBlockStore.setState({ blocks: [blockA, blockB] })

      await useBlockStore.getState().reorder('A', 0)

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('is no-op when blockId not found', async () => {
      useBlockStore.setState({ blocks: [makeBlock({ id: 'A' })] })

      await useBlockStore.getState().reorder('NONEXISTENT', 0)

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not update state on backend error', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      useBlockStore.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await useBlockStore.getState().reorder('B', 0)

      const blocks = useBlockStore.getState().blocks
      expect(blocks[0].id).toBe('A')
      expect(blocks[1].id).toBe('B')
    })

    it('moves block down in the list (arrayMove semantics)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 2, parent_id: null })
      useBlockStore.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: null,
        new_position: 3,
      })

      // Move A to index 2 (where C is) → [B, C, A] via arrayMove
      await useBlockStore.getState().reorder('A', 2)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'move_block',
        expect.objectContaining({ blockId: 'A', newParentId: null }),
      )
      const blocks = useBlockStore.getState().blocks
      // arrayMove([A,B,C], 0, 2) → [B, C, A]
      expect(blocks[0].id).toBe('B')
      expect(blocks[1].id).toBe('C')
      expect(blocks[2].id).toBe('A')
    })

    it('preserves parent_id when reordering', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: 'PARENT' })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: 'PARENT' })
      useBlockStore.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'PARENT',
        new_position: -1,
      })

      await useBlockStore.getState().reorder('B', 0)

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
      useBlockStore.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 11,
      })

      // Move C (idx 2) to idx 1 → between A(10) and B(11)
      // floor((10+11)/2) = 10, which <= 10, so nudge up → 11
      // Position 11 collides with B but local array order is correct
      await useBlockStore.getState().reorder('C', 1)

      const blocks = useBlockStore.getState().blocks
      expect(blocks.map((b) => b.id)).toEqual(['A', 'C', 'B'])
      // Position is nudged to beforePos + 1
      expect(blocks[1].position).toBe(11)
    })

    it('handles consecutive positions for forward move', async () => {
      const blockA = makeBlock({ id: 'A', position: 10, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 11, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 12, parent_id: null })
      useBlockStore.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: null,
        new_position: 12,
      })

      // Move A (idx 0) to idx 1 → between B(11) and C(12)
      // floor((11+12)/2) = 11, which <= 11, so nudge up → 12
      await useBlockStore.getState().reorder('A', 1)

      const blocks = useBlockStore.getState().blocks
      // arrayMove([A,B,C], 0, 1) → [B, A, C]
      expect(blocks.map((b) => b.id)).toEqual(['B', 'A', 'C'])
      expect(blocks[1].position).toBe(12)
    })

    it('assigns position after last block when moving forward to last index', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 10, parent_id: null })
      useBlockStore.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: null,
        new_position: 11,
      })

      // Move A to last index (2) — hits newIndex >= blocks.length - 1 branch
      await useBlockStore.getState().reorder('A', 2)

      const blocks = useBlockStore.getState().blocks
      // arrayMove([A,B,C], 0, 2) → [B, C, A]
      expect(blocks.map((b) => b.id)).toEqual(['B', 'C', 'A'])
      // Position = last block's position + 1
      expect(blocks[2].position).toBe(11)
    })

    it('uses average position when there is room between positions', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 10, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 20, parent_id: null })
      useBlockStore.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 5,
      })

      // Move C (idx 2) to idx 1 → between A(0) and B(10)
      // floor((0+10)/2) = 5, which > 0, so no nudge needed
      await useBlockStore.getState().reorder('C', 1)

      const blocks = useBlockStore.getState().blocks
      expect(blocks.map((b) => b.id)).toEqual(['A', 'C', 'B'])
      expect(blocks[1].position).toBe(5)
    })
  })

  // ---------------------------------------------------------------------------
  // moveUp
  // ---------------------------------------------------------------------------
  describe('moveUp', () => {
    it('calls move_block with prevSibling.position - 1, then reloads', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      useBlockStore.setState({ blocks: [blockA, blockB], rootParentId: 'PAGE1' })

      // move_block
      mockedInvoke.mockResolvedValueOnce({})
      // list_blocks (reload)
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

      await useBlockStore.getState().moveUp('B')

      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: null,
        newPosition: -1, // prevSibling(A).position(0) - 1
      })
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({ parentId: 'PAGE1' }),
      )
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE1')
    })

    it('is no-op when block is the first sibling', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      useBlockStore.setState({ blocks: [blockA, blockB] })

      await useBlockStore.getState().moveUp('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('is no-op when block is not found', async () => {
      useBlockStore.setState({ blocks: [makeBlock({ id: 'A' })] })

      await useBlockStore.getState().moveUp('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not crash on backend error (silently fails)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      useBlockStore.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await expect(useBlockStore.getState().moveUp('B')).resolves.toBeUndefined()
      expect(useBlockStore.getState().blocks).toHaveLength(2)
    })

    it('uses correct parentId in move_block call', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: 'PARENT', depth: 1 })
      const blockB = makeBlock({ id: 'B', position: 3, parent_id: 'PARENT', depth: 1 })
      useBlockStore.setState({ blocks: [blockA, blockB], rootParentId: 'PAGE1' })

      // move_block
      mockedInvoke.mockResolvedValueOnce({})
      // list_blocks (reload)
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

      await useBlockStore.getState().moveUp('B')

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
      useBlockStore.setState({ blocks: [blockA, blockB], rootParentId: 'PAGE1' })

      // move_block
      mockedInvoke.mockResolvedValueOnce({})
      // list_blocks (reload)
      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

      await useBlockStore.getState().moveDown('A')

      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'A',
        newParentId: null,
        newPosition: 6, // nextSibling(B).position(5) + 1
      })
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({ parentId: 'PAGE1' }),
      )
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE1')
    })

    it('is no-op when block is the last sibling', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      useBlockStore.setState({ blocks: [blockA, blockB] })

      await useBlockStore.getState().moveDown('B')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('is no-op when block is not found', async () => {
      useBlockStore.setState({ blocks: [makeBlock({ id: 'A' })] })

      await useBlockStore.getState().moveDown('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not crash on backend error (silently fails)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      useBlockStore.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await expect(useBlockStore.getState().moveDown('A')).resolves.toBeUndefined()
      expect(useBlockStore.getState().blocks).toHaveLength(2)
    })
  })

  // ---------------------------------------------------------------------------
  // undo store integration — notifyUndoNewAction
  // ---------------------------------------------------------------------------
  describe('undo store integration', () => {
    it('createBelow calls onNewAction after successful create', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      useBlockStore.setState({ blocks: [block], rootParentId: 'PAGE1' })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: '',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      await useBlockStore.getState().createBelow('A')

      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE1')
    })

    it('edit calls onNewAction after successful edit', async () => {
      useBlockStore.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
        rootParentId: 'PAGE1',
      })
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'new',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })

      await useBlockStore.getState().edit('A', 'new')

      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE1')
    })

    it('remove calls onNewAction after successful delete', async () => {
      useBlockStore.setState({
        blocks: [makeBlock({ id: 'A' })],
        focusedBlockId: null,
        rootParentId: 'PAGE1',
      })
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await useBlockStore.getState().remove('A')

      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE1')
    })

    it('does NOT call onNewAction when createBelow fails', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      useBlockStore.setState({ blocks: [block], rootParentId: 'PAGE1' })

      mockedInvoke.mockRejectedValueOnce(new Error('create failed'))

      await useBlockStore.getState().createBelow('A')

      expect(mockOnNewAction).not.toHaveBeenCalled()
    })

    it('does NOT call onNewAction when edit fails', async () => {
      useBlockStore.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
        rootParentId: 'PAGE1',
      })
      mockedInvoke.mockRejectedValueOnce(new Error('edit failed'))

      await useBlockStore.getState().edit('A', 'new')

      expect(mockOnNewAction).not.toHaveBeenCalled()
    })

    it('does NOT call onNewAction when remove fails', async () => {
      useBlockStore.setState({
        blocks: [makeBlock({ id: 'A' })],
        focusedBlockId: 'A',
        rootParentId: 'PAGE1',
      })
      mockedInvoke.mockRejectedValueOnce(new Error('delete failed'))

      await useBlockStore.getState().remove('A')

      expect(mockOnNewAction).not.toHaveBeenCalled()
    })

    it('does NOT call onNewAction when rootParentId is null', async () => {
      useBlockStore.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
        rootParentId: null,
      })
      mockedInvoke.mockResolvedValueOnce({})

      await useBlockStore.getState().edit('A', 'new')

      expect(mockOnNewAction).not.toHaveBeenCalled()
    })
  })
})
