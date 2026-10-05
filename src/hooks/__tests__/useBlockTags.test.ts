/**
 * Tests for useBlockTags hook — tag loading, adding, removing, and creating.
 *
 * Validates:
 * - allTags loads every tag in the space via listAllTagsInSpace
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

import { makeBlock, withOps } from '@/__tests__/fixtures'
import {
  type CommandReturns,
  mockInvokeCommands,
  type TypedInvokeHandlers,
} from '@/__tests__/helpers/invoke'
import { useBlockTags } from '@/hooks/useBlockTags'
import { getGraphStructureKey } from '@/lib/graph-structure-events'
import type { NameChange } from '@/lib/name-change-bus'
import { invalidateNameCaches, subscribeToNameChanges } from '@/lib/name-change-bus'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)

function stubInvoke(handlers: Readonly<TypedInvokeHandlers>): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(handlers))
}

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

type TagRow = CommandReturns['list_all_tags_in_space'][number]

function tagRow(tagId: string, name: string): TagRow {
  return { tag_id: tagId, name, usage_count: 0, updated_at: '2025-01-15T00:00:00Z' }
}

beforeEach(() => {
  vi.clearAllMocks()
  stubInvoke({ list_all_tags_in_space: () => [] })
  pageStore = createPageBlockStore('PAGE_1')
})

// ---------------------------------------------------------------------------
// allTags — loads tag blocks on mount
// ---------------------------------------------------------------------------

describe('useBlockTags allTags', () => {
  it('loads every tag in the space on mount (#5244)', async () => {
    // #5244 — more than the 50 rows `listBlocks`' default page returned.
    const rows = Array.from({ length: 60 }, (_, i) => tagRow(`TAG_${i}`, `tag-${i}`))
    // #2248 — an active space is required; seed one so the mount fetch fires.
    useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => rows,
      list_tags_for_block: () => [],
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.allTags).toHaveLength(60)
    })
    expect(result.current.allTags.at(-1)).toEqual({ id: 'TAG_59', name: 'tag-59' })
    expect(mockedInvoke).toHaveBeenCalledWith('list_all_tags_in_space', {
      scope: { kind: 'active', space_id: 'SPACE_1' },
    })
  })

  it('short-circuits to an empty tag list without invoking when there is no active space (#2248)', async () => {
    // No space seeded (currentSpaceId is null). The tag listing has no
    // cross-space form, so the hook must NOT dispatch and must render empty.
    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_tags_for_block: () => [],
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.allTags).toEqual([])
    const listCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_all_tags_in_space')
    expect(listCalls).toHaveLength(0)
  })

  it('shows toast error when loading tags fails', async () => {
    // Without an active space the hook never lists the tags at all; the
    // toast this test names was previously raised by the *other* fetch, whose
    // untyped `list_inherited_tags_for_block` stub returned a page envelope
    // where the command returns `string[]`.
    useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => {
        throw new Error('Network error')
      },
      list_tags_for_block: () => [],
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
    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => ['TAG_1', 'TAG_3'],
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
    stubInvoke({
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => ['TAG_DIR', 'TAG_BOTH'],
      // TAG_BOTH is also inherited; it must be deduped out (direct wins).
      list_inherited_tags_for_block: () => ['TAG_INH', 'TAG_BOTH'],
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
    expect([...result.current.inheritedTagIds].toSorted()).toEqual(['TAG_INH'])
    expect(result.current.inheritedTagIds.has('TAG_BOTH')).toBe(false)

    expect(mockedInvoke).toHaveBeenCalledWith('list_inherited_tags_for_block', {
      blockId: 'BLOCK_1',
    })
  })

  it('resets appliedTagIds when blockId is null', async () => {
    stubInvoke({
      list_all_tags_in_space: () => [],
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
    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => {
        throw new Error('DB error')
      },
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
    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => [],
      add_tag: () => ({
        block_id: 'BLOCK_1',
        tag_id: 'TAG_1',
        op_refs: [{ device_id: 'dev1', seq: 7 }],
      }),
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
    stubInvoke({
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => [],
      list_inherited_tags_for_block: () => ['TAG_INH'],
      add_tag: () => ({
        block_id: 'BLOCK_1',
        tag_id: 'TAG_1',
        op_refs: [{ device_id: 'dev1', seq: 7 }],
      }),
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
    stubInvoke({
      list_all_tags_in_space: () => [],
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
    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => [],
      add_tag: () => {
        throw new Error('IPC failed')
      },
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

    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => [],
      add_tag: () => ({
        block_id: 'BLOCK_1',
        tag_id: 'TAG_1',
        op_refs: [{ device_id: 'dev1', seq: 7 }],
      }),
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleAddTag('TAG_1')
    })

    // #2468 — the captured op ref(s) are forwarded for ref-addressed undo.
    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1', [{ device_id: 'dev1', seq: 7 }])
  })

  it('does NOT call onNewAction on an idempotent no-op add (empty op_refs, #2468)', async () => {
    // Tag already attached backend-side: `add_tag` appends NO op and returns
    // `op_refs: []` — nothing to undo, so no undo entry may be pushed (and
    // the redo stack must not be invalidated for an action that changed
    // nothing).
    const onNewActionSpy = vi.fn()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => [],
      add_tag: () => ({ block_id: 'BLOCK_1', tag_id: 'TAG_1', op_refs: [] }),
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleAddTag('TAG_1')
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
    // The IPC still ran and the local UI state still reflects the tag.
    expect(result.current.appliedTagIds.has('TAG_1')).toBe(true)
  })

  it('does NOT call onNewAction on an idempotent no-op remove (empty op_refs, #2468)', async () => {
    const onNewActionSpy = vi.fn()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => ['TAG_1'],
      remove_tag: () => ({ block_id: 'BLOCK_1', tag_id: 'TAG_1', op_refs: [] }),
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.appliedTagIds.has('TAG_1')).toBe(true)
    })

    await act(async () => {
      await result.current.handleRemoveTag('TAG_1')
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })

  it('does not call onNewAction when addTag fails', async () => {
    const onNewActionSpy = vi.fn()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => [],
      add_tag: () => {
        throw new Error('IPC failed')
      },
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
    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => ['TAG_1', 'TAG_2'],
      remove_tag: () => ({
        block_id: 'BLOCK_1',
        tag_id: 'TAG_1',
        op_refs: [{ device_id: 'dev1', seq: 8 }],
      }),
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
    stubInvoke({
      list_all_tags_in_space: () => [],
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
    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => ['TAG_1'],
      remove_tag: () => {
        throw new Error('IPC failed')
      },
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

    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => ['TAG_1'],
      remove_tag: () => ({
        block_id: 'BLOCK_1',
        tag_id: 'TAG_1',
        op_refs: [{ device_id: 'dev1', seq: 8 }],
      }),
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.appliedTagIds.has('TAG_1')).toBe(true)
    })

    await act(async () => {
      await result.current.handleRemoveTag('TAG_1')
    })

    // #2468 — the captured op ref(s) are forwarded for ref-addressed undo.
    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1', [{ device_id: 'dev1', seq: 8 }])
  })

  it('does not call onNewAction when removeTag fails', async () => {
    const onNewActionSpy = vi.fn()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => ['TAG_1'],
      remove_tag: () => {
        throw new Error('IPC failed')
      },
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

    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => [],
      // `create_block` returns the row inside the `op_refs` envelope.
      create_block: () => withOps(createdBlock),
      add_tag: () => ({
        block_id: 'BLOCK_1',
        tag_id: 'TAG_1',
        op_refs: [{ device_id: 'dev1', seq: 7 }],
      }),
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
      // #2849 PR2 — tag creation supplies no client id; the binding sends null.
      blockId: null,
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

    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => [],
      create_block: () => withOps(createdBlock),
      add_tag: () => ({
        block_id: 'BLOCK_1',
        tag_id: 'TAG_1',
        op_refs: [{ device_id: 'dev1', seq: 7 }],
      }),
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
      // #2849 PR2 — tag creation supplies no client id; the binding sends null.
      blockId: null,
    })
  })

  it('does nothing for empty or whitespace-only name', async () => {
    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => [],
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

    stubInvoke({
      list_all_tags_in_space: () => [],
      create_block: () => withOps(createdBlock),
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
      // #2849 PR2 — tag creation supplies no client id; the binding sends null.
      blockId: null,
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

    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => [],
      create_block: () => withOps(createdBlock),
      add_tag: () => ({
        block_id: 'BLOCK_1',
        tag_id: 'TAG_1',
        op_refs: [{ device_id: 'dev1', seq: 7 }],
      }),
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
    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => [],
      create_block: () => {
        throw new Error('IPC failed')
      },
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

    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => [],
      create_block: () => {
        throw new Error('IPC failed')
      },
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

    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () => [],
      create_block: () => withOps(createdBlock),
      add_tag: () => {
        throw new Error('IPC failed')
      },
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleCreateTag('PartialFail')
    })

    // The tag exists, so the add's own failure is what the user is told.
    expect(mockedToastError).toHaveBeenCalledWith('Failed to add tag')
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
    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () =>
        new Promise<string[]>((resolve) => {
          resolveTagsForBlock = resolve
        }),
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
    stubInvoke({
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      list_tags_for_block: () =>
        new Promise<string[]>((_resolve, reject) => {
          rejectTagsForBlock = reject
        }),
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })

    expect(result.current.loading).toBe(true)

    await act(async () => {
      rejectTagsForBlock(new Error('DB error'))
    })

    expect(result.current.loading).toBe(false)
  })

  it('loading becomes false immediately when blockId is null', async () => {
    stubInvoke({
      list_all_tags_in_space: () => [],
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
    stubInvoke({
      list_all_tags_in_space: () => [],
      list_inherited_tags_for_block: () => [],
      list_tags_for_block: (args) => {
        const blockId = (args as { blockId: string }).blockId
        return new Promise<string[]>((resolve) => {
          resolvers.set(blockId, resolve)
        })
      },
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
    // SPACE_OLD's listing is gated so it lands LAST; SPACE_NEW resolves
    // immediately. The `getState()` re-check + cancelled guard must keep
    // SPACE_NEW's tags and discard the late SPACE_OLD response.
    let resolveOld!: (value: TagRow[]) => void
    const oldPending = new Promise<TagRow[]>((resolve) => {
      resolveOld = resolve
    })

    stubInvoke({
      list_tags_for_block: () => [],
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: (args) => {
        const spaceId = (args as { scope: { space_id: string } }).scope.space_id
        if (spaceId === 'SPACE_OLD') return oldPending
        return [tagRow('TAG_NEW', 'New')]
      },
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
      resolveOld([tagRow('TAG_OLD', 'Old')])
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
    let resolveStaleA: ((value: TagRow[]) => void) | null = null

    stubInvoke({
      list_tags_for_block: () => [],
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: (args) => {
        const spaceId = (args as { scope: { space_id: string } }).scope.space_id
        // The FIRST SPACE_A fetch is gated so it can resolve last (stale).
        if (spaceId === 'SPACE_A' && resolveStaleA === null) {
          return new Promise<TagRow[]>((resolve) => {
            resolveStaleA = resolve
          })
        }
        if (spaceId === 'SPACE_B') return [tagRow('TAG_B', 'B')]
        // The SECOND SPACE_A fetch (after switch-back) resolves immediately.
        return [tagRow('TAG_A2', 'A2')]
      },
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
      resolveStaleA?.([])
    })

    expect(result.current.allTags).toEqual([{ id: 'TAG_A2', name: 'A2' }])
  })
})

// ---------------------------------------------------------------------------
// #5244 — `useSyncEvents` announces a sync or MCP write as an `invalidated`
// name change. #5250 — a header add/remove bumps the graph-structure counter
// for the tag-filtered graph.
// ---------------------------------------------------------------------------

describe('useBlockTags out-of-band refresh', () => {
  it('refetches the catalogue and the applied tags, keeping the chips meanwhile (#5244)', async () => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
    let catalogue = [tagRow('TAG_1', 'one')]
    let pendingApplied: ((ids: string[]) => void) | null = null
    let appliedCalls = 0
    stubInvoke({
      list_all_tags_in_space: () => catalogue,
      list_inherited_tags_for_block: () => [],
      list_tags_for_block: () => {
        appliedCalls += 1
        if (appliedCalls === 1) return ['TAG_1']
        return new Promise<string[]>((resolve) => {
          pendingApplied = resolve
        })
      },
    })

    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })
    await waitFor(() => expect(result.current.appliedTagIds.has('TAG_1')).toBe(true))

    catalogue = [tagRow('TAG_1', 'one'), tagRow('TAG_2', 'synced')]
    act(() => invalidateNameCaches())

    await waitFor(() => expect(pendingApplied).not.toBeNull())
    expect(result.current.appliedTagIds.has('TAG_1')).toBe(true)
    await waitFor(() =>
      expect(result.current.allTags).toEqual([
        { id: 'TAG_1', name: 'one' },
        { id: 'TAG_2', name: 'synced' },
      ]),
    )

    await act(async () => pendingApplied?.(['TAG_1', 'TAG_2']))
    expect([...result.current.appliedTagIds]).toEqual(['TAG_1', 'TAG_2'])
  })

  it('bumps the counter after an add and after a remove (#5250)', async () => {
    stubInvoke({
      list_all_tags_in_space: () => [],
      list_inherited_tags_for_block: () => [],
      list_tags_for_block: () => [],
      add_tag: () => ({ block_id: 'BLOCK_1', tag_id: 'TAG_1', op_refs: [] }),
      remove_tag: () => ({ block_id: 'BLOCK_1', tag_id: 'TAG_1', op_refs: [] }),
    })
    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => result.current.handleAddTag('TAG_1'))
    await waitFor(() => expect(getGraphStructureKey()).toBe(1))

    await act(async () => result.current.handleRemoveTag('TAG_1'))
    await waitFor(() => expect(getGraphStructureKey()).toBe(2))
  })
})

// ---------------------------------------------------------------------------
// #5236 — a header-created tag reaches the `#` picker caches, and a create the
// backend answers with an EXISTING tag neither duplicates it nor re-adds it.
// ---------------------------------------------------------------------------

describe('useBlockTags handleCreateTag publishing and reuse (#5236)', () => {
  const existing = makeBlock({ id: 'TAG_1', block_type: 'tag' as const, content: 'work' })

  it('announces the created tag on the name-change bus', async () => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
    stubInvoke({
      list_all_tags_in_space: () => [],
      list_inherited_tags_for_block: () => [],
      list_tags_for_block: () => [],
      create_block: () => withOps(makeBlock({ id: 'NEW_TAG', block_type: 'tag' as const })),
      add_tag: () => ({ block_id: 'BLOCK_1', tag_id: 'NEW_TAG', op_refs: [] }),
    })
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((change) => changes.push(change))
    try {
      const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })
      await waitFor(() => expect(result.current.loading).toBe(false))

      await act(async () => result.current.handleCreateTag('launch'))

      expect(changes).toEqual([
        { kind: 'added', entity: 'tag', id: 'NEW_TAG', name: 'launch', spaceId: 'SPACE_1' },
      ])
    } finally {
      unsubscribe()
    }
  })

  it('does not re-add or re-list a tag that is already applied', async () => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
    stubInvoke({
      list_all_tags_in_space: () => [tagRow('TAG_1', 'work')],
      list_inherited_tags_for_block: () => [],
      list_tags_for_block: () => ['TAG_1'],
      create_block: () => withOps(existing),
      // The real `add_tag` rejects a tag that is already applied.
      add_tag: () => {
        throw new Error('tag already applied')
      },
    })
    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })
    await waitFor(() => expect(result.current.allTags).toHaveLength(1))
    await waitFor(() => expect(result.current.appliedTagIds.has('TAG_1')).toBe(true))

    await act(async () => result.current.handleCreateTag('work'))

    expect(result.current.allTags).toEqual([{ id: 'TAG_1', name: 'work' }])
    expect([...result.current.appliedTagIds]).toEqual(['TAG_1'])
    expect(mockedToastError).not.toHaveBeenCalled()
  })

  it('applies an existing tag that was only inherited, promoting it to direct', async () => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
    stubInvoke({
      list_all_tags_in_space: () => [tagRow('TAG_1', 'work')],
      list_inherited_tags_for_block: () => ['TAG_1'],
      list_tags_for_block: () => [],
      create_block: () => withOps(existing),
      add_tag: () => ({ block_id: 'BLOCK_1', tag_id: 'TAG_1', op_refs: [] }),
    })
    const { result } = renderHook(() => useBlockTags('BLOCK_1'), { wrapper })
    await waitFor(() => expect(result.current.inheritedTagIds.has('TAG_1')).toBe(true))

    await act(async () => result.current.handleCreateTag('work'))

    expect(result.current.appliedTagIds.has('TAG_1')).toBe(true)
    expect(result.current.inheritedTagIds.has('TAG_1')).toBe(false)
    expect(result.current.allTags).toEqual([{ id: 'TAG_1', name: 'work' }])
  })
})
