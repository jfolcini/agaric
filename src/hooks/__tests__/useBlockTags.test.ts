/**
 * Tests for useBlockTags hook — tag loading, adding, removing, and creating.
 *
 * Validates:
 * - allTags loads tag blocks on mount via listBlocks({ blockType: 'tag' })
 * - appliedTagIds loads tags for given blockId via listTagsForBlock
 * - handleAddTag calls addTag IPC and updates appliedTagIds
 * - handleRemoveTag calls removeTag IPC and updates appliedTagIds
 * - handleCreateTag creates a tag block and adds it to the block
 * - Error paths show toast.error messages
 * - loading state transitions correctly
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlockStore } from '../../stores/blocks'
import { useResolveStore } from '../../stores/resolve'
import { useUndoStore } from '../../stores/undo'
import { useBlockTags } from '../useBlockTags'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const mockedInvoke = vi.mocked(invoke)
const mockedToastError = vi.mocked(toast.error)

function makeTagBlock(id: string, content: string) {
  return {
    id,
    block_type: 'tag' as const,
    content,
    parent_id: null,
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    depth: 0,
  }
}

const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue(emptyPage)
  useBlockStore.setState({
    blocks: [],
    rootParentId: null,
    focusedBlockId: null,
    loading: false,
  })
})

// ---------------------------------------------------------------------------
// allTags — loads tag blocks on mount
// ---------------------------------------------------------------------------

describe('useBlockTags allTags', () => {
  it('loads tag blocks on mount', async () => {
    const tagBlocks = {
      items: [makeTagBlock('TAG_1', 'Work'), makeTagBlock('TAG_2', 'Personal')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return tagBlocks
      if (cmd === 'list_tags_for_block') return []
      return emptyPage
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(result.current.allTags).toHaveLength(2)
    })

    expect(result.current.allTags).toEqual([
      { id: 'TAG_1', name: 'Work' },
      { id: 'TAG_2', name: 'Personal' },
    ])

    expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
      parentId: null,
      blockType: 'tag',
      tagId: null,
      showDeleted: null,
      agendaDate: null,
      agendaDateRange: null,
      agendaSource: null,
      cursor: null,
      limit: null,
    })
  })

  it('shows toast error when loading tags fails', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') throw new Error('Network error')
      if (cmd === 'list_tags_for_block') return []
      return emptyPage
    })

    renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to load tags')
    })
  })
})

// ---------------------------------------------------------------------------
// appliedTagIds — loads tags for given blockId
// ---------------------------------------------------------------------------

describe('useBlockTags appliedTagIds', () => {
  it('loads tags for given blockId', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return ['TAG_1', 'TAG_3']
      return emptyPage
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(result.current.appliedTagIds.size).toBe(2)
    })

    expect(result.current.appliedTagIds.has('TAG_1')).toBe(true)
    expect(result.current.appliedTagIds.has('TAG_3')).toBe(true)

    expect(mockedInvoke).toHaveBeenCalledWith('list_tags_for_block', {
      blockId: 'BLOCK_1',
    })
  })

  it('resets appliedTagIds when blockId is null', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      return emptyPage
    })

    const { result } = renderHook(() => useBlockTags(null))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.appliedTagIds.size).toBe(0)
    // list_tags_for_block should NOT be called when blockId is null
    const tagCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_tags_for_block')
    expect(tagCalls).toHaveLength(0)
  })

  it('shows toast error when loading applied tags fails', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') throw new Error('DB error')
      return emptyPage
    })

    renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to load tags')
    })
  })
})

// ---------------------------------------------------------------------------
// handleAddTag
// ---------------------------------------------------------------------------

describe('useBlockTags handleAddTag', () => {
  it('calls addTag and updates appliedTagIds', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'add_tag') return { success: true }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleAddTag('TAG_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('add_tag', {
      blockId: 'BLOCK_1',
      tagId: 'TAG_1',
    })

    expect(result.current.appliedTagIds.has('TAG_1')).toBe(true)
  })

  it('does nothing when blockId is null', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      return undefined
    })

    const { result } = renderHook(() => useBlockTags(null))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleAddTag('TAG_1')
    })

    const addTagCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'add_tag')
    expect(addTagCalls).toHaveLength(0)
  })

  it('shows toast error on failure', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'add_tag') throw new Error('IPC failed')
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleAddTag('TAG_1')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to add tag')
    expect(result.current.appliedTagIds.has('TAG_1')).toBe(false)
  })

  it('calls onNewAction after successful add when rootParentId is set', async () => {
    const onNewActionSpy = vi.fn()
    useBlockStore.setState({
      blocks: [],
      rootParentId: 'PAGE_1',
      focusedBlockId: null,
      loading: false,
    })
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'add_tag') return { success: true }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleAddTag('TAG_1')
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })
})

// ---------------------------------------------------------------------------
// handleRemoveTag
// ---------------------------------------------------------------------------

describe('useBlockTags handleRemoveTag', () => {
  it('calls removeTag and updates appliedTagIds', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return ['TAG_1', 'TAG_2']
      if (cmd === 'remove_tag') return { success: true }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(result.current.appliedTagIds.size).toBe(2)
    })

    await act(async () => {
      await result.current.handleRemoveTag('TAG_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('remove_tag', {
      blockId: 'BLOCK_1',
      tagId: 'TAG_1',
    })

    expect(result.current.appliedTagIds.has('TAG_1')).toBe(false)
    expect(result.current.appliedTagIds.has('TAG_2')).toBe(true)
  })

  it('does nothing when blockId is null', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      return undefined
    })

    const { result } = renderHook(() => useBlockTags(null))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleRemoveTag('TAG_1')
    })

    const removeTagCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'remove_tag')
    expect(removeTagCalls).toHaveLength(0)
  })

  it('shows toast error on failure', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return ['TAG_1']
      if (cmd === 'remove_tag') throw new Error('IPC failed')
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(result.current.appliedTagIds.has('TAG_1')).toBe(true)
    })

    await act(async () => {
      await result.current.handleRemoveTag('TAG_1')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to delete tag')
    // Tag should still be in the set (no removal on failure)
    expect(result.current.appliedTagIds.has('TAG_1')).toBe(true)
  })

  it('calls onNewAction after successful remove when rootParentId is set', async () => {
    const onNewActionSpy = vi.fn()
    useBlockStore.setState({
      blocks: [],
      rootParentId: 'PAGE_1',
      focusedBlockId: null,
      loading: false,
    })
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return ['TAG_1']
      if (cmd === 'remove_tag') return { success: true }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(result.current.appliedTagIds.has('TAG_1')).toBe(true)
    })

    await act(async () => {
      await result.current.handleRemoveTag('TAG_1')
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })
})

// ---------------------------------------------------------------------------
// handleCreateTag
// ---------------------------------------------------------------------------

describe('useBlockTags handleCreateTag', () => {
  it('creates tag block and adds tag to the block', async () => {
    const createdBlock = makeTagBlock('NEW_TAG_1', 'NewTag')

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'create_block') return createdBlock
      if (cmd === 'add_tag') return { success: true }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleCreateTag('NewTag')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'tag',
      content: 'NewTag',
      parentId: null,
      position: null,
    })

    expect(mockedInvoke).toHaveBeenCalledWith('add_tag', {
      blockId: 'BLOCK_1',
      tagId: 'NEW_TAG_1',
    })

    // allTags should include the new tag
    expect(result.current.allTags).toEqual([{ id: 'NEW_TAG_1', name: 'NewTag' }])
    // appliedTagIds should include the new tag
    expect(result.current.appliedTagIds.has('NEW_TAG_1')).toBe(true)
  })

  it('trims whitespace from tag name', async () => {
    const createdBlock = makeTagBlock('NEW_TAG_1', 'Trimmed')

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'create_block') return createdBlock
      if (cmd === 'add_tag') return { success: true }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleCreateTag('  Trimmed  ')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'tag',
      content: 'Trimmed',
      parentId: null,
      position: null,
    })
  })

  it('does nothing for empty or whitespace-only name', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleCreateTag('   ')
    })

    const createCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(createCalls).toHaveLength(0)
  })

  it('creates tag but does not add to block when blockId is null', async () => {
    const createdBlock = makeTagBlock('NEW_TAG_1', 'Solo')

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'create_block') return createdBlock
      return undefined
    })

    const { result } = renderHook(() => useBlockTags(null))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleCreateTag('Solo')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'tag',
      content: 'Solo',
      parentId: null,
      position: null,
    })

    // addTag should NOT be called
    const addTagCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'add_tag')
    expect(addTagCalls).toHaveLength(0)

    // allTags should still include the new tag
    expect(result.current.allTags).toEqual([{ id: 'NEW_TAG_1', name: 'Solo' }])
    // But appliedTagIds should be empty
    expect(result.current.appliedTagIds.size).toBe(0)
  })

  it('updates resolve store with created tag', async () => {
    const createdBlock = makeTagBlock('NEW_TAG_1', 'Resolved')
    const resolveSetSpy = vi.fn()
    useResolveStore.setState({ ...useResolveStore.getState(), set: resolveSetSpy })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'create_block') return createdBlock
      if (cmd === 'add_tag') return { success: true }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleCreateTag('Resolved')
    })

    expect(resolveSetSpy).toHaveBeenCalledWith('NEW_TAG_1', 'Resolved', false)
  })

  it('shows toast error on failure', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'create_block') throw new Error('IPC failed')
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleCreateTag('FailTag')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to create tag')
  })
})

// ---------------------------------------------------------------------------
// loading state transitions
// ---------------------------------------------------------------------------

describe('useBlockTags loading state', () => {
  it('loading starts true and becomes false after tags load', async () => {
    let resolveTagsForBlock!: (value: string[]) => void
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') {
        return new Promise<string[]>((resolve) => {
          resolveTagsForBlock = resolve
        })
      }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    // loading should be true while waiting for listTagsForBlock
    expect(result.current.loading).toBe(true)

    await act(async () => {
      resolveTagsForBlock(['TAG_1'])
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.appliedTagIds.has('TAG_1')).toBe(true)
  })

  it('loading becomes false even when listTagsForBlock fails', async () => {
    let rejectTagsForBlock!: (reason: Error) => void
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') {
        return new Promise<string[]>((_resolve, reject) => {
          rejectTagsForBlock = reject
        })
      }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'))

    expect(result.current.loading).toBe(true)

    await act(async () => {
      rejectTagsForBlock(new Error('DB error'))
    })

    expect(result.current.loading).toBe(false)
  })

  it('loading becomes false immediately when blockId is null', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      return undefined
    })

    const { result } = renderHook(() => useBlockTags(null))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })
})
