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
import { createElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '../../__tests__/fixtures'
import {
  createPageBlockStore,
  PageBlockContext,
  type PageBlockState,
} from '../../stores/page-blocks'
import { useResolveStore } from '../../stores/resolve'
import { useSpaceStore } from '../../stores/space'
import { useUndoStore } from '../../stores/undo'
import { useBlockTags } from '../useBlockTags'

const mockedInvoke = vi.mocked(invoke)
const mockedToastError = vi.mocked(toast.error)

let pageStore: StoreApi<PageBlockState>
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(PageBlockContext.Provider, { value: pageStore }, children)

const originalOnNewAction = useUndoStore.getState().onNewAction
afterEach(() => {
  useUndoStore.setState({
    ...useUndoStore.getState(),
    onNewAction: originalOnNewAction,
    pages: new Map(),
  })
  // #1518 — reset the space store so a race test's `currentSpaceId` doesn't
  // leak into the next test.
  useSpaceStore.setState({ currentSpaceId: null })
})

const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue(emptyPage)
  pageStore = createPageBlockStore('PAGE_1')
})

// ---------------------------------------------------------------------------
// allTags — loads tag blocks on mount
// ---------------------------------------------------------------------------

describe('useBlockTags allTags', () => {
  it('loads tag blocks on mount', async () => {
    const tagBlocks = {
      items: [
        makeBlock({ id: 'TAG_1', block_type: 'tag' as const, content: 'Work', page_id: null }),
        makeBlock({
          id: 'TAG_2',
          block_type: 'tag' as const,
          content: 'Personal',
          page_id: null,
        }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return tagBlocks
      if (cmd === 'list_tags_for_block') return []
      return emptyPage
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

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
      agenda: null,
      cursor: null,
      limit: null,
      // FEAT-3 Phase 4 — `useBlockTags` threads `currentSpaceId` (null
      // in this test fixture, no space seeded) and the wrapper falls
      // back to `''` per the pre-bootstrap convention.
      spaceId: '',
    })
  })

  it('shows toast error when loading tags fails', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') throw new Error('Network error')
      if (cmd === 'list_tags_for_block') return []
      return emptyPage
    })

    renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(
        'Failed to load tags',
        expect.objectContaining({ id: 'tags-load-failed' }),
      )
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

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.appliedTagIds.size).toBe(2)
    })

    expect(result.current.appliedTagIds.has('TAG_1')).toBe(true)
    expect(result.current.appliedTagIds.has('TAG_3')).toBe(true)

    expect(mockedInvoke).toHaveBeenCalledWith('list_tags_for_block', {
      blockId: 'BLOCK_1',
    })
  })

  // #1423 — direct (`block_tags`) and inherited (`block_tag_inherited`)
  // tags are fetched in parallel; a tag present in BOTH must surface as
  // direct only (direct wins, since a direct tag is removable) and never
  // be duplicated into the inherited set.
  it('partitions inherited tags excluding direct ones (direct wins)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return ['TAG_DIR', 'TAG_BOTH']
      // TAG_BOTH is also inherited; it must be deduped out (direct wins).
      if (cmd === 'list_inherited_tags_for_block') return ['TAG_INH', 'TAG_BOTH']
      return emptyPage
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.appliedTagIds.size).toBe(2)
    })

    // Direct set keeps both directly-applied tags verbatim.
    expect(result.current.appliedTagIds.has('TAG_DIR')).toBe(true)
    expect(result.current.appliedTagIds.has('TAG_BOTH')).toBe(true)

    // Inherited set is ONLY the purely-inherited tag — TAG_BOTH is
    // excluded (renders once, as direct), TAG_INH is present.
    expect([...result.current.inheritedTagIds].sort()).toEqual(['TAG_INH'])
    expect(result.current.inheritedTagIds.has('TAG_BOTH')).toBe(false)

    expect(mockedInvoke).toHaveBeenCalledWith('list_inherited_tags_for_block', {
      blockId: 'BLOCK_1',
    })
  })

  it('resets appliedTagIds when blockId is null', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      return emptyPage
    })

    const { result } = renderHook(() => useBlockTags(null), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.appliedTagIds.size).toBe(0)
    // #1423 — inherited set resets too.
    expect(result.current.inheritedTagIds.size).toBe(0)
    // Neither tag-listing IPC should fire when blockId is null.
    const tagCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_tags_for_block')
    expect(tagCalls).toHaveLength(0)
    const inhCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'list_inherited_tags_for_block',
    )
    expect(inhCalls).toHaveLength(0)
  })

  it('shows toast error when loading applied tags fails', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') throw new Error('DB error')
      return emptyPage
    })

    renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(
        'Failed to load tags',
        expect.objectContaining({ id: 'tags-load-failed' }),
      )
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

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

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

  it('promotes an inherited-only tag to direct on add, removing it from inheritedTagIds (#1423)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'list_inherited_tags_for_block') return ['TAG_INH']
      if (cmd === 'add_tag') return { success: true }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    // Starts inherited-only.
    expect(result.current.inheritedTagIds.has('TAG_INH')).toBe(true)
    expect(result.current.appliedTagIds.has('TAG_INH')).toBe(false)

    await act(async () => {
      await result.current.handleAddTag('TAG_INH')
    })

    // Now direct, and no longer inherited — so it can't render as a duplicate chip.
    expect(result.current.appliedTagIds.has('TAG_INH')).toBe(true)
    expect(result.current.inheritedTagIds.has('TAG_INH')).toBe(false)
  })

  it('does nothing when blockId is null', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      return undefined
    })

    const { result } = renderHook(() => useBlockTags(null), { wrapper })

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

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

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
    // pageStore already has rootParentId: 'PAGE_1' from createPageBlockStore
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'add_tag') return { success: true }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleAddTag('TAG_1')
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })

  it('does not call onNewAction when addTag fails', async () => {
    const onNewActionSpy = vi.fn()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'add_tag') throw new Error('IPC failed')
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleAddTag('TAG_1')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to add tag')
    expect(onNewActionSpy).not.toHaveBeenCalled()
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

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

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

    const { result } = renderHook(() => useBlockTags(null), { wrapper })

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

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

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
    // pageStore already has rootParentId: 'PAGE_1' from createPageBlockStore
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return ['TAG_1']
      if (cmd === 'remove_tag') return { success: true }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.appliedTagIds.has('TAG_1')).toBe(true)
    })

    await act(async () => {
      await result.current.handleRemoveTag('TAG_1')
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })

  it('does not call onNewAction when removeTag fails', async () => {
    const onNewActionSpy = vi.fn()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return ['TAG_1']
      if (cmd === 'remove_tag') throw new Error('IPC failed')
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.appliedTagIds.has('TAG_1')).toBe(true)
    })

    await act(async () => {
      await result.current.handleRemoveTag('TAG_1')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to delete tag')
    expect(onNewActionSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// handleCreateTag
// ---------------------------------------------------------------------------

describe('useBlockTags handleCreateTag', () => {
  it('creates tag block and adds tag to the block', async () => {
    const createdBlock = makeBlock({
      id: 'NEW_TAG_1',
      block_type: 'tag' as const,
      content: 'NewTag',
      page_id: null,
    })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'create_block') return createdBlock
      if (cmd === 'add_tag') return { success: true }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

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
      index: null,
      scope: { kind: 'global' },
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
    const createdBlock = makeBlock({
      id: 'NEW_TAG_1',
      block_type: 'tag' as const,
      content: 'Trimmed',
      page_id: null,
    })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'create_block') return createdBlock
      if (cmd === 'add_tag') return { success: true }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

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
      index: null,
      scope: { kind: 'global' },
    })
  })

  it('does nothing for empty or whitespace-only name', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

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
    const createdBlock = makeBlock({
      id: 'NEW_TAG_1',
      block_type: 'tag' as const,
      content: 'Solo',
      page_id: null,
    })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'create_block') return createdBlock
      return undefined
    })

    const { result } = renderHook(() => useBlockTags(null), { wrapper })

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
      index: null,
      scope: { kind: 'global' },
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
    const createdBlock = makeBlock({
      id: 'NEW_TAG_1',
      block_type: 'tag' as const,
      content: 'Resolved',
      page_id: null,
    })
    const resolveSetSpy = vi.fn()
    useResolveStore.setState({ ...useResolveStore.getState(), set: resolveSetSpy })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'create_block') return createdBlock
      if (cmd === 'add_tag') return { success: true }
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

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

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleCreateTag('FailTag')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to create tag')
  })

  it('does not update allTags or resolveStore when createBlock fails', async () => {
    const resolveSetSpy = vi.fn()
    useResolveStore.setState({ ...useResolveStore.getState(), set: resolveSetSpy })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'create_block') throw new Error('IPC failed')
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleCreateTag('FailTag')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to create tag')
    expect(result.current.allTags).toEqual([])
    expect(resolveSetSpy).not.toHaveBeenCalled()
    expect(result.current.appliedTagIds.size).toBe(0)
  })

  it('shows toast error when addTag fails after successful createBlock', async () => {
    const createdBlock = makeBlock({
      id: 'NEW_TAG_1',
      block_type: 'tag' as const,
      content: 'PartialFail',
      page_id: null,
    })
    const onNewActionSpy = vi.fn()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'create_block') return createdBlock
      if (cmd === 'add_tag') throw new Error('IPC failed')
      return undefined
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleCreateTag('PartialFail')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to create tag')
    // allTags IS updated because setAllTags runs before addTag
    expect(result.current.allTags).toEqual([{ id: 'NEW_TAG_1', name: 'PartialFail' }])
    // appliedTagIds should NOT include the new tag
    expect(result.current.appliedTagIds.has('NEW_TAG_1')).toBe(false)
    // onNewAction should NOT be called
    expect(onNewActionSpy).not.toHaveBeenCalled()
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

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

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

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

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

    const { result } = renderHook(() => useBlockTags(null), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// #1518 — staleness guards: a slow, older IPC response must never clobber the
// state for the newer block / space once the id has switched.
// ---------------------------------------------------------------------------

describe('useBlockTags staleness guards (#1518)', () => {
  it('drops a stale block tag list that resolves after the newer block', async () => {
    // Both fetches are gated behind manual resolvers. We resolve BLOCK_NEW
    // first, then BLOCK_OLD LAST — without the cancelled guard the late
    // BLOCK_OLD write would overwrite BLOCK_NEW's tags (the #1518 leak).
    const resolvers = new Map<string, (value: string[]) => void>()
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_inherited_tags_for_block') return []
      if (cmd === 'list_tags_for_block') {
        const blockId = (args as { blockId: string }).blockId
        return new Promise<string[]>((resolve) => {
          resolvers.set(blockId, resolve)
        })
      }
      return emptyPage
    })

    const { result, rerender } = renderHook(({ id }) => useBlockTags(id), {
      wrapper,
      initialProps: { id: 'BLOCK_OLD' },
    })

    // Switch to the newer block before either fetch resolves.
    await waitFor(() => expect(resolvers.has('BLOCK_OLD')).toBe(true))
    rerender({ id: 'BLOCK_NEW' })
    await waitFor(() => expect(resolvers.has('BLOCK_NEW')).toBe(true))

    // Resolve the NEWER block first…
    await act(async () => {
      resolvers.get('BLOCK_NEW')?.(['TAG_NEW'])
    })
    await waitFor(() => {
      expect(result.current.appliedTagIds.has('TAG_NEW')).toBe(true)
    })

    // …then let the stale OLDER block resolve LAST. It must be dropped.
    await act(async () => {
      resolvers.get('BLOCK_OLD')?.(['TAG_OLD'])
    })

    expect(result.current.appliedTagIds.has('TAG_OLD')).toBe(false)
    expect(result.current.appliedTagIds.has('TAG_NEW')).toBe(true)
    expect(result.current.appliedTagIds.size).toBe(1)
  })

  it('drops a stale space tag list that resolves after the newer space', async () => {
    // SPACE_OLD's list_blocks is gated so it lands LAST; SPACE_NEW resolves
    // immediately. The `getState()` re-check + cancelled guard must keep
    // SPACE_NEW's tags and discard the late SPACE_OLD response.
    const newTags = {
      items: [
        makeBlock({ id: 'TAG_NEW', block_type: 'tag' as const, content: 'New', page_id: null }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
    const oldTags = {
      items: [
        makeBlock({ id: 'TAG_OLD', block_type: 'tag' as const, content: 'Old', page_id: null }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }

    let resolveOld!: (value: typeof oldTags) => void
    const oldPending = new Promise<typeof oldTags>((resolve) => {
      resolveOld = resolve
    })

    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'list_inherited_tags_for_block') return []
      if (cmd === 'list_blocks') {
        const spaceId = (args as { spaceId: string }).spaceId
        if (spaceId === 'SPACE_OLD') return oldPending
        return newTags
      }
      return emptyPage
    })

    useSpaceStore.setState({ currentSpaceId: 'SPACE_OLD' })
    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    // Switch to the newer space before the old fetch resolves. The hook
    // re-subscribes via its currentSpaceId selector, so the store update
    // drives a re-render + a fresh SPACE_NEW fetch.
    await act(async () => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_NEW' })
    })

    await waitFor(() => {
      expect(result.current.allTags).toEqual([{ id: 'TAG_NEW', name: 'New' }])
    })

    // Let the stale SPACE_OLD fetch resolve LAST — it must NOT clobber
    // SPACE_NEW (caught by either the cancelled flag or the getState check).
    await act(async () => {
      resolveOld(oldTags)
    })

    expect(result.current.allTags).toEqual([{ id: 'TAG_NEW', name: 'New' }])
  })

  it('drops the original space tag list on switch-back (A→B→A) — cancelled is the load-bearing guard', async () => {
    // Switch-back isolates the `cancelled` guard from the `getState()`
    // re-check: the original SPACE_A fetch is stale, yet by the time it
    // resolves the live store is back to SPACE_A — so the captured id
    // MATCHES the store and `getState()` would let it through. Only the
    // `cancelled` flag (tripped by the first SPACE_A effect's cleanup)
    // drops it. Removing `if (cancelled) return` from the space effect
    // makes this test fail; removing the `getState()` check does not.
    let resolveStaleA: ((value: typeof emptyPage) => void) | null = null
    const tagsFor = (id: string, name: string) => ({
      items: [makeBlock({ id, block_type: 'tag' as const, content: name, page_id: null })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'list_inherited_tags_for_block') return []
      if (cmd === 'list_blocks') {
        const spaceId = (args as { spaceId: string }).spaceId
        // The FIRST SPACE_A fetch is gated so it can resolve last (stale).
        if (spaceId === 'SPACE_A' && resolveStaleA === null) {
          return new Promise<typeof emptyPage>((resolve) => {
            resolveStaleA = resolve
          })
        }
        if (spaceId === 'SPACE_B') return tagsFor('TAG_B', 'B')
        // The SECOND SPACE_A fetch (after switch-back) resolves immediately.
        return tagsFor('TAG_A2', 'A2')
      }
      return emptyPage
    })

    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })
    await waitFor(() => expect(resolveStaleA).not.toBeNull())

    // A → B → A. Each switch trips the prior effect's cleanup (cancelled).
    await act(async () => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
    })
    await act(async () => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
    })
    await waitFor(() => {
      expect(result.current.allTags).toEqual([{ id: 'TAG_A2', name: 'A2' }])
    })

    // The original (stale) SPACE_A fetch resolves last. The live store is
    // SPACE_A again, so getState() matches the captured id — only the
    // cancelled flag prevents this stale write from clobbering TAG_A2.
    await act(async () => {
      resolveStaleA?.({ items: [], next_cursor: null, has_more: false, total_count: null })
    })

    expect(result.current.allTags).toEqual([{ id: 'TAG_A2', name: 'A2' }])
  })
})
