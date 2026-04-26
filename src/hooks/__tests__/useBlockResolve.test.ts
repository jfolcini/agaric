/**
 * Tests for useBlockResolve hook — resolve callbacks, picker search, and page creation.
 *
 * Validates:
 * - resolveBlockTitle / resolveBlockStatus (cache hit & fallback)
 * - resolveTagName / resolveTagStatus (cache hit & fallback)
 * - All four resolve callbacks re-create when store version changes
 * - searchTags delegates to listTagsByPrefix and maps results
 * - searchPages short-query path (cache + fallback to listBlocks)
 * - searchPages long-query path (FTS + cache supplementation)
 * - searchPages "Create new" option logic
 * - onCreatePage creates block, updates store, and updates pagesListRef
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/tauri', () => ({
  createBlock: vi.fn(),
  createPageInSpace: vi.fn(),
  listBlocks: vi.fn(),
  listTagsByPrefix: vi.fn(),
  resolvePageByAlias: vi.fn(),
  searchBlocks: vi.fn(),
}))

import {
  createBlock,
  createPageInSpace,
  listBlocks,
  listTagsByPrefix,
  resolvePageByAlias,
  searchBlocks,
} from '../../lib/tauri'
import { keyFor, useResolveStore } from '../../stores/resolve'
import { useSpaceStore } from '../../stores/space'
import { useBlockResolve } from '../useBlockResolve'

const mockedCreateBlock = vi.mocked(createBlock)
const mockedCreatePageInSpace = vi.mocked(createPageInSpace)
const mockedListBlocks = vi.mocked(listBlocks)
const mockedListTagsByPrefix = vi.mocked(listTagsByPrefix)
const mockedResolvePageByAlias = vi.mocked(resolvePageByAlias)
const mockedSearchBlocks = vi.mocked(searchBlocks)

beforeEach(() => {
  vi.clearAllMocks()
  useResolveStore.setState({
    cache: new Map(),
    pagesList: [],
    version: 0,
    _preloaded: false,
  })
  // FEAT-3 Phase 2 — `onCreatePage` and the `searchPages` IPC paths now
  // consult `useSpaceStore`. Seed a deterministic space so both paths
  // exercise the real code instead of the defensive `!isReady` guard.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

// ── Resolve callbacks ──────────────────────────────────────────────────

describe('resolveBlockTitle', () => {
  it('returns cached title when the block is in the store', () => {
    useResolveStore.getState().set('BLOCK_A', 'My Page', false)

    const { result } = renderHook(() => useBlockResolve())
    expect(result.current.resolveBlockTitle('BLOCK_A')).toBe('My Page')
  })

  it('returns [[ABCD1234...]] fallback for uncached block', () => {
    const { result } = renderHook(() => useBlockResolve())
    // ID shorter than 8 chars still works (slice returns what it can)
    expect(result.current.resolveBlockTitle('01ABCDEF99999999')).toBe('[[01ABCDEF...]]')
  })

  it('returns fallback with first 8 chars of the ULID', () => {
    const { result } = renderHook(() => useBlockResolve())
    expect(result.current.resolveBlockTitle('XYZW1234REST')).toBe('[[XYZW1234...]]')
  })
})

describe('resolveBlockStatus', () => {
  it('returns "active" for a non-deleted cached block', () => {
    useResolveStore.getState().set('BLOCK_B', 'Active Page', false)

    const { result } = renderHook(() => useBlockResolve())
    expect(result.current.resolveBlockStatus('BLOCK_B')).toBe('active')
  })

  it('returns "deleted" for a deleted cached block', () => {
    useResolveStore.getState().set('BLOCK_C', 'Deleted Page', true)

    const { result } = renderHook(() => useBlockResolve())
    expect(result.current.resolveBlockStatus('BLOCK_C')).toBe('deleted')
  })

  it('defaults to "active" for uncached block', () => {
    const { result } = renderHook(() => useBlockResolve())
    expect(result.current.resolveBlockStatus('UNKNOWN_ID')).toBe('active')
  })
})

describe('resolveTagName', () => {
  it('returns cached title for a known tag', () => {
    useResolveStore.getState().set('TAG_1', 'important', false)

    const { result } = renderHook(() => useBlockResolve())
    expect(result.current.resolveTagName('TAG_1')).toBe('important')
  })

  it('returns #ABCD1234... fallback for uncached tag', () => {
    const { result } = renderHook(() => useBlockResolve())
    expect(result.current.resolveTagName('01ABCDEF99999999')).toBe('#01ABCDEF...')
  })
})

describe('resolveTagStatus', () => {
  it('returns "active" for a non-deleted cached tag', () => {
    useResolveStore.getState().set('TAG_2', 'urgent', false)

    const { result } = renderHook(() => useBlockResolve())
    expect(result.current.resolveTagStatus('TAG_2')).toBe('active')
  })

  it('returns "deleted" for a deleted cached tag', () => {
    useResolveStore.getState().set('TAG_3', 'obsolete', true)

    const { result } = renderHook(() => useBlockResolve())
    expect(result.current.resolveTagStatus('TAG_3')).toBe('deleted')
  })

  it('defaults to "active" for uncached tag', () => {
    const { result } = renderHook(() => useBlockResolve())
    expect(result.current.resolveTagStatus('UNKNOWN_TAG')).toBe('active')
  })
})

describe('resolve callbacks react to store version changes', () => {
  it('resolveBlockTitle picks up new cache entries after version bump', () => {
    const id = 'BLOCK_X_FULL_ID'

    const { result, rerender } = renderHook(() => useBlockResolve())

    // Initially uncached — shows fallback
    expect(result.current.resolveBlockTitle(id)).toBe('[[BLOCK_X_...]]')

    // Populate store (bumps version via .set())
    act(() => {
      useResolveStore.getState().set(id, 'Updated Title', false)
    })

    // Re-render picks up the new version and re-creates the callback
    rerender()
    expect(result.current.resolveBlockTitle(id)).toBe('Updated Title')
  })

  it('resolve callback references are stable across version bumps', () => {
    const { result, rerender } = renderHook(() => useBlockResolve())

    // Capture initial references
    const initialBlockTitle = result.current.resolveBlockTitle
    const initialBlockStatus = result.current.resolveBlockStatus
    const initialTagName = result.current.resolveTagName
    const initialTagStatus = result.current.resolveTagStatus

    // Bump the store version by adding a cache entry
    act(() => {
      useResolveStore.getState().set('BUMP_ID', 'Bump Title', false)
    })

    rerender()

    // All callback references should be the same (stable)
    expect(result.current.resolveBlockTitle).toBe(initialBlockTitle)
    expect(result.current.resolveBlockStatus).toBe(initialBlockStatus)
    expect(result.current.resolveTagName).toBe(initialTagName)
    expect(result.current.resolveTagStatus).toBe(initialTagStatus)
  })

  it('stable callbacks still read updated cache via ref', () => {
    const id = 'STABLE_REF_TEST'

    const { result, rerender } = renderHook(() => useBlockResolve())

    // Initially uncached
    expect(result.current.resolveBlockTitle(id)).toBe('[[STABLE_R...]]')

    // Update cache
    act(() => {
      useResolveStore.getState().set(id, 'Fresh Value', false)
    })

    rerender()

    // Same callback reference reads updated cache through ref
    expect(result.current.resolveBlockTitle(id)).toBe('Fresh Value')
    expect(result.current.resolveBlockStatus(id)).toBe('active')
    expect(result.current.resolveTagName(id)).toBe('Fresh Value')
    expect(result.current.resolveTagStatus(id)).toBe('active')
  })

  it('resolveBlockStatus picks up deleted status after version bump', () => {
    const { result } = renderHook(() => useBlockResolve())

    // Initially active (uncached)
    expect(result.current.resolveBlockStatus('BLOCK_Y')).toBe('active')

    // Mark as deleted in store
    act(() => {
      useResolveStore.getState().set('BLOCK_Y', 'Some Page', true)
    })

    // Re-render picks up new version
    const { result: result2 } = renderHook(() => useBlockResolve())
    expect(result2.current.resolveBlockStatus('BLOCK_Y')).toBe('deleted')
  })

  it('resolveTagName picks up new tag after version bump', () => {
    const { result } = renderHook(() => useBlockResolve())
    expect(result.current.resolveTagName('TAG_NEW')).toMatch(/^#TAG_NEW/)

    act(() => {
      useResolveStore.getState().set('TAG_NEW', 'fresh-tag', false)
    })

    const { result: result2 } = renderHook(() => useBlockResolve())
    expect(result2.current.resolveTagName('TAG_NEW')).toBe('fresh-tag')
  })

  it('resolveTagStatus picks up deleted status after version bump', () => {
    act(() => {
      useResolveStore.getState().set('TAG_Z', 'soon-deleted', false)
    })

    const { result } = renderHook(() => useBlockResolve())
    expect(result.current.resolveTagStatus('TAG_Z')).toBe('active')

    act(() => {
      useResolveStore.getState().set('TAG_Z', 'soon-deleted', true)
    })

    const { result: result2 } = renderHook(() => useBlockResolve())
    expect(result2.current.resolveTagStatus('TAG_Z')).toBe('deleted')
  })
})

// ── searchTags ──────────────────────────────────────────────────────────

describe('searchTags', () => {
  it('calls listTagsByPrefix and maps results to PickerItem[]', async () => {
    mockedListTagsByPrefix.mockResolvedValueOnce([
      { tag_id: 'T1', name: 'project', usage_count: 5, updated_at: '2024-01-01' },
      { tag_id: 'T2', name: 'priority', usage_count: 3, updated_at: '2024-01-02' },
    ])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('pr')
    })

    expect(mockedListTagsByPrefix).toHaveBeenCalledWith({ prefix: 'pr' })
    // Non-exact match, so a "Create new tag" option is prepended (F-26)
    expect(items[0]).toEqual({ id: '__create__', label: 'pr', isCreate: true })
    const tagItems = items.filter((i) => !i.isCreate)
    expect(tagItems).toHaveLength(2)
    expect(tagItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'T1', label: 'project' }),
        expect.objectContaining({ id: 'T2', label: 'priority' }),
      ]),
    )
  })

  it('returns only "Create new tag" option when no tags match', async () => {
    mockedListTagsByPrefix.mockResolvedValueOnce([])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('zzz')
    })

    expect(items).toEqual([{ id: '__create__', label: 'zzz', isCreate: true }])
  })

  it('populates the resolve cache with fetched tags', async () => {
    mockedListTagsByPrefix.mockResolvedValueOnce([
      { tag_id: 'T10', name: 'important', usage_count: 2, updated_at: '2024-01-01' },
      { tag_id: 'T11', name: 'urgent', usage_count: 1, updated_at: '2024-01-02' },
    ])

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchTags('imp')
    })

    // Verify the resolve store cache was populated.
    // FEAT-3p7 — cache is composite-keyed (`${spaceId}::${ulid}`).
    const cache = useResolveStore.getState().cache
    expect(cache.get(keyFor('SPACE_TEST', 'T10'))).toEqual({ title: 'important', deleted: false })
    expect(cache.get(keyFor('SPACE_TEST', 'T11'))).toEqual({ title: 'urgent', deleted: false })
  })

  it('does not call batchSet when no tags match', async () => {
    mockedListTagsByPrefix.mockResolvedValueOnce([])

    const initialVersion = useResolveStore.getState().version

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchTags('zzz')
    })

    // Version should not change — no batchSet call
    expect(useResolveStore.getState().version).toBe(initialVersion)
  })

  it('does NOT append "Create new tag" when exact match exists (case-insensitive)', async () => {
    mockedListTagsByPrefix.mockResolvedValueOnce([
      { tag_id: 'T20', name: 'project', usage_count: 5, updated_at: '2024-01-01' },
    ])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('project')
    })

    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toBeUndefined()
  })

  it('does NOT append "Create new tag" for empty query', async () => {
    mockedListTagsByPrefix.mockResolvedValueOnce([
      { tag_id: 'T30', name: 'any-tag', usage_count: 1, updated_at: '2024-01-01' },
    ])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('')
    })

    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toBeUndefined()
  })

  it('preserves original casing in "Create new tag" label', async () => {
    mockedListTagsByPrefix.mockResolvedValueOnce([])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('  MyTag  ')
    })

    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toEqual({ id: '__create__', label: 'MyTag', isCreate: true })
  })

  it('strips trailing ] from tag query', async () => {
    mockedListTagsByPrefix.mockResolvedValueOnce([
      { tag_id: 'T40', name: 'todo', usage_count: 2, updated_at: '2024-01-01' },
    ])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('todo]')
    })

    // Sends stripped prefix to listTagsByPrefix
    expect(mockedListTagsByPrefix).toHaveBeenCalledWith({ prefix: 'todo' })
    // Exact match after stripping — no create option
    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toBeUndefined()
  })
})

// ── onCreateTag ─────────────────────────────────────────────────────────

describe('onCreateTag', () => {
  it('calls createBlock with tag type and content', async () => {
    mockedCreateBlock.mockResolvedValueOnce({
      id: 'NEW_TAG_1',
      block_type: 'tag',
      content: 'urgent',
      parent_id: null,
      position: null,
      deleted_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
    })

    const { result } = renderHook(() => useBlockResolve())

    let newId = ''
    await act(async () => {
      newId = await result.current.onCreateTag('urgent')
    })

    expect(mockedCreateBlock).toHaveBeenCalledWith({
      blockType: 'tag',
      content: 'urgent',
    })
    expect(newId).toBe('NEW_TAG_1')
  })

  it('updates the resolve store with the new tag', async () => {
    mockedCreateBlock.mockResolvedValueOnce({
      id: 'NEW_TAG_2',
      block_type: 'tag',
      content: 'important',
      parent_id: null,
      position: null,
      deleted_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
    })

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.onCreateTag('important')
    })

    const cached = useResolveStore.getState().cache.get(keyFor('SPACE_TEST', 'NEW_TAG_2'))
    expect(cached).toEqual({ title: 'important', deleted: false })
  })

  it('returns the new block id', async () => {
    mockedCreateBlock.mockResolvedValueOnce({
      id: 'TAG_RETURNED_ID',
      block_type: 'tag',
      content: 'test',
      parent_id: null,
      position: null,
      deleted_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
    })

    const { result } = renderHook(() => useBlockResolve())

    let newId = ''
    await act(async () => {
      newId = await result.current.onCreateTag('test')
    })

    expect(newId).toBe('TAG_RETURNED_ID')
  })

  it('propagates createBlock rejection', async () => {
    mockedCreateBlock.mockRejectedValue(new Error('tag creation failed'))

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await expect(result.current.onCreateTag('bad')).rejects.toThrow('tag creation failed')
    })
  })
})

// ── searchPages ─────────────────────────────────────────────────────────

describe('searchPages — short query (<=2 chars)', () => {
  it('uses pagesListRef cache for substring match', async () => {
    const { result } = renderHook(() => useBlockResolve())

    // Populate the ref cache
    act(() => {
      result.current.pagesListRef.current = [
        { id: 'P1', title: 'My Page' },
        { id: 'P2', title: 'Another Page' },
        { id: 'P3', title: 'Meeting Notes' },
      ]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('my')
    })

    // Should NOT call listBlocks since cache is populated
    expect(mockedListBlocks).not.toHaveBeenCalled()
    expect(items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'P1', label: 'My Page' })]),
    )
    // "Another Page" and "Meeting Notes" don't contain "my"
    const ids = items.filter((i) => !i.isCreate).map((i) => i.id)
    expect(ids).toContain('P1')
    expect(ids).not.toContain('P2')
    expect(ids).not.toContain('P3')
  })

  it('falls back to listBlocks when pagesListRef is empty', async () => {
    mockedListBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'P10',
          block_type: 'page',
          content: 'Alpha',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
        {
          id: 'P11',
          block_type: 'page',
          content: 'Beta',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('al')
    })

    expect(mockedListBlocks).toHaveBeenCalledWith({
      blockType: 'page',
      limit: 500,
      spaceId: 'SPACE_TEST',
    })
    // Should match "Alpha" (contains "al")
    const matchIds = items.filter((i) => !i.isCreate).map((i) => i.id)
    expect(matchIds).toContain('P10')
    // "Beta" does not contain "al"
    expect(matchIds).not.toContain('P11')
  })

  it('populates pagesListRef cache after listBlocks fallback', async () => {
    mockedListBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'P20',
          block_type: 'page',
          content: 'Cached Page',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchPages('ca')
    })

    expect(result.current.pagesListRef.current).toEqual([{ id: 'P20', title: 'Cached Page' }])
  })

  it('handles null content as "Untitled"', async () => {
    mockedListBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'P30',
          block_type: 'page',
          content: null,
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('un')
    })

    // "Untitled" contains "un"
    expect(items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'P30', label: 'Untitled' })]),
    )
    expect(result.current.pagesListRef.current).toEqual([{ id: 'P30', title: 'Untitled' }])
  })

  it('returns all pages (up to 20) for empty query string', async () => {
    const { result } = renderHook(() => useBlockResolve())

    const manyPages = Array.from({ length: 25 }, (_, i) => ({
      id: `P${i}`,
      title: `Page ${i}`,
    }))
    act(() => {
      result.current.pagesListRef.current = manyPages
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('')
    })

    // All pages match empty query, but capped at 20
    expect(items).toHaveLength(20)
    // Empty query should NOT append "Create new"
    expect(items.find((i) => i.isCreate)).toBeUndefined()
  })

  it('caps results at 20 for short queries', async () => {
    const { result } = renderHook(() => useBlockResolve())

    const manyPages = Array.from({ length: 30 }, (_, i) => ({
      id: `PA${i}`,
      title: `A Page ${i}`,
    }))
    act(() => {
      result.current.pagesListRef.current = manyPages
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('a')
    })

    // All 30 match "a" but capped at 20, plus possible "Create new"
    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate).toHaveLength(20)
  })
})

describe('searchPages — long query (>2 chars)', () => {
  it('uses searchBlocks FTS and filters to pages', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'F1',
          block_type: 'page',
          content: 'Meeting Notes',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
        {
          id: 'F2',
          block_type: 'block',
          content: 'meeting agenda item',
          parent_id: 'F1',
          position: 0,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
        {
          id: 'F3',
          block_type: 'page',
          content: 'Team Meeting',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('meeting')
    })

    expect(mockedSearchBlocks).toHaveBeenCalledWith({
      query: 'meeting',
      limit: 20,
      spaceId: 'SPACE_TEST',
    })
    // Only page-type blocks should be returned
    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate).toEqual([
      expect.objectContaining({ id: 'F1', label: 'Meeting Notes' }),
      expect.objectContaining({ id: 'F3', label: 'Team Meeting' }),
    ])
  })

  it('supplements from pagesListRef when FTS returns few results', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'F10',
          block_type: 'page',
          content: 'Design Doc',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    // Populate pagesListRef cache with entries that contain "design"
    act(() => {
      result.current.pagesListRef.current = [
        { id: 'F10', title: 'Design Doc' }, // already in FTS results (should be deduped)
        { id: 'C1', title: 'Design Review' }, // should be added as supplement
        { id: 'C2', title: 'Design Sprint' }, // should be added as supplement
        { id: 'C3', title: 'Unrelated Page' }, // doesn't match "design"
      ]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('design')
    })

    const nonCreate = items.filter((i) => !i.isCreate)
    // FTS returned 1 result (< 5), so cache supplementation kicks in
    // F10 from FTS + C1 and C2 from cache (C3 doesn't match, F10 is deduped)
    expect(nonCreate).toEqual([
      expect.objectContaining({ id: 'F10', label: 'Design Doc' }),
      expect.objectContaining({ id: 'C1', label: 'Design Review' }),
      expect.objectContaining({ id: 'C2', label: 'Design Sprint' }),
    ])
  })

  it('does NOT supplement from cache when FTS returns >= 5 results', async () => {
    const ftsPages = Array.from({ length: 6 }, (_, i) => ({
      id: `FTS${i}`,
      block_type: 'page' as const,
      content: `Report ${i}`,
      parent_id: null,
      position: null,
      deleted_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
    }))

    mockedSearchBlocks.mockResolvedValueOnce({
      items: ftsPages,
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [
        { id: 'CACHE_EXTRA', title: 'Extra Report from Cache' },
      ]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('report')
    })

    const nonCreate = items.filter((i) => !i.isCreate)
    // 6 FTS results >= 5, no cache supplementation
    expect(nonCreate).toHaveLength(6)
    expect(nonCreate.find((i) => i.id === 'CACHE_EXTRA')).toBeUndefined()
  })

  it('does NOT supplement when pagesListRef is empty', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'F20',
          block_type: 'page',
          content: 'Lonely Result',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())
    // pagesListRef is empty by default

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('lonely')
    })

    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate).toHaveLength(1)
    expect(nonCreate[0]).toEqual(expect.objectContaining({ id: 'F20', label: 'Lonely Result' }))
  })

  it('handles null content as "Untitled" in FTS results', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'F30',
          block_type: 'page',
          content: null,
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('untitled')
    })

    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate).toEqual([expect.objectContaining({ id: 'F30', label: 'Untitled' })])
  })
})

describe('searchPages — "Create new" option', () => {
  it('appends "Create new" when query does not exactly match an existing page', async () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [
        { id: 'P1', title: 'My Page' },
        { id: 'P2', title: 'Another Page' },
      ]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('my')
    })

    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toEqual({ id: '__create__', label: 'my', isCreate: true })
  })

  it('does NOT append "Create new" when query exactly matches (case-insensitive)', async () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [{ id: 'P1', title: 'My Page' }]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('My Page')
    })

    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toBeUndefined()
  })

  it('does NOT append "Create new" when query exactly matches (different case)', async () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [{ id: 'P1', title: 'My Page' }]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('my page')
    })

    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toBeUndefined()
  })

  // UX-248 — Unicode-aware fold so the "exact match exists" check
  // folds Turkish / German / accented titles the same way the cache
  // filter does above.  Without this, a page titled `İstanbul` queried
  // as `istanbul` would (incorrectly) trigger "Create new".
  it('does NOT append "Create new" when query exactly matches a Turkish title via fold', async () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [{ id: 'P1', title: 'İstanbul' }]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('istanbul')
    })

    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toBeUndefined()
  })

  it('does NOT append "Create new" when query exactly matches a German title via fold', async () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [{ id: 'P1', title: 'Straße' }]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('strasse')
    })

    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toBeUndefined()
  })

  it('does NOT append "Create new" for empty query', async () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [{ id: 'P1', title: 'Some Page' }]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('')
    })

    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toBeUndefined()
  })

  it('preserves original query trim in "Create new" label (not lowercased)', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('  New Fancy Page  ')
    })

    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toEqual({
      id: '__create__',
      label: 'New Fancy Page',
      isCreate: true,
    })
  })

  it('appends "Create new" for long query when no exact match in FTS results', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'F40',
          block_type: 'page',
          content: 'Weekly Report',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('weekly')
    })

    // "weekly" !== "Weekly Report" so "Create new" should appear
    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toEqual({ id: '__create__', label: 'weekly', isCreate: true })
  })

  it('does NOT append "Create new" when FTS result exactly matches (uses matches as allSource when pagesListRef empty)', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'F50',
          block_type: 'page',
          content: 'Design',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())
    // pagesListRef is empty, so allSource = matches

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('design')
    })

    // "design" matches "Design" case-insensitively via the matches source (label field)
    // allSource = matches (PickerItem[]) → 'label' in p → p.label.toLowerCase() === q
    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toBeUndefined()
  })
})

describe('searchPages — trailing bracket stripping (#586)', () => {
  it('strips trailing ]] from query so [[text]] resolves to "text"', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'P2',
          block_type: 'page',
          content: 'Text Document',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('text]]')
    })

    // FTS receives "text" (stripped), not "text]]"
    expect(mockedSearchBlocks).toHaveBeenCalledWith({
      query: 'text',
      limit: 20,
      spaceId: 'SPACE_TEST',
    })
    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate).toEqual([expect.objectContaining({ id: 'P2', label: 'Text Document' })])
  })

  it('strips single trailing ] from query', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'P1',
          block_type: 'page',
          content: 'Test Page',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('test]')
    })

    expect(mockedSearchBlocks).toHaveBeenCalledWith({
      query: 'test',
      limit: 20,
      spaceId: 'SPACE_TEST',
    })
    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate).toEqual([expect.objectContaining({ id: 'P1', label: 'Test Page' })])
  })

  it('"Create new" label strips trailing ]] too', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('New Page]]')
    })

    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toEqual({
      id: '__create__',
      label: 'New Page',
      isCreate: true,
    })
  })

  it('exact match after stripping ]] suppresses "Create new" option', async () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [{ id: 'P1', title: 'My Page' }]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('My Page]]')
    })

    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toBeUndefined()
  })

  it('works correctly for long queries (>2 chars) with trailing ]]', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'F60',
          block_type: 'page',
          content: 'Meeting Notes',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('meeting]]')
    })

    // FTS receives "meeting" (stripped), returns Meeting Notes
    expect(mockedSearchBlocks).toHaveBeenCalledWith({
      query: 'meeting',
      limit: 20,
      spaceId: 'SPACE_TEST',
    })
    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate).toEqual([expect.objectContaining({ id: 'F60', label: 'Meeting Notes' })])
  })
})

// ── onCreatePage ────────────────────────────────────────────────────────

describe('onCreatePage', () => {
  it('calls createPageInSpace with content and current space id', async () => {
    mockedCreatePageInSpace.mockResolvedValueOnce('NEW_PAGE_1')

    const { result } = renderHook(() => useBlockResolve())

    let newId = ''
    await act(async () => {
      newId = await result.current.onCreatePage('Brand New Page')
    })

    expect(mockedCreatePageInSpace).toHaveBeenCalledWith({
      content: 'Brand New Page',
      spaceId: 'SPACE_TEST',
    })
    // FEAT-3 Phase 2 — the legacy `createBlock({ blockType: 'page' })`
    // path is no longer invoked; the space-aware wrapper replaces it.
    expect(mockedCreateBlock).not.toHaveBeenCalled()
    expect(newId).toBe('NEW_PAGE_1')
  })

  it('updates the resolve store with the new page', async () => {
    mockedCreatePageInSpace.mockResolvedValueOnce('NEW_PAGE_2')

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.onCreatePage('Store Updated Page')
    })

    const cached = useResolveStore.getState().cache.get(keyFor('SPACE_TEST', 'NEW_PAGE_2'))
    expect(cached).toEqual({ title: 'Store Updated Page', deleted: false })
  })

  it('appends the new page to pagesListRef', async () => {
    mockedCreatePageInSpace.mockResolvedValueOnce('NEW_PAGE_3')

    const { result } = renderHook(() => useBlockResolve())

    // Pre-populate pagesListRef
    act(() => {
      result.current.pagesListRef.current = [{ id: 'EXISTING', title: 'Existing Page' }]
    })

    await act(async () => {
      await result.current.onCreatePage('Appended Page')
    })

    expect(result.current.pagesListRef.current).toEqual([
      { id: 'EXISTING', title: 'Existing Page' },
      { id: 'NEW_PAGE_3', title: 'Appended Page' },
    ])
  })

  it('returns the new block id', async () => {
    mockedCreatePageInSpace.mockResolvedValueOnce('RETURNED_ID')

    const { result } = renderHook(() => useBlockResolve())

    let newId = ''
    await act(async () => {
      newId = await result.current.onCreatePage('Test')
    })

    expect(newId).toBe('RETURNED_ID')
  })

  // FEAT-3 Phase 2 — defensive guard for the `!isReady` branch.
  it('refuses to create when the space store has not hydrated', async () => {
    useSpaceStore.setState({ currentSpaceId: null, availableSpaces: [], isReady: false })

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await expect(result.current.onCreatePage('New Page')).rejects.toThrow()
    })
    expect(mockedCreatePageInSpace).not.toHaveBeenCalled()
  })
})

// ── Error handling (H-10 fix: catch in hook, return []) ─────────────────

describe('error handling', () => {
  it('searchTags returns [] when listTagsByPrefix rejects', async () => {
    mockedListTagsByPrefix.mockRejectedValue(new Error('IPC: tags unavailable'))

    const { result } = renderHook(() => useBlockResolve())

    let items: unknown
    await act(async () => {
      items = await result.current.searchTags('test')
    })
    expect(items).toEqual([])
  })

  it('searchPages returns [] when searchBlocks rejects (long query)', async () => {
    mockedSearchBlocks.mockRejectedValue(new Error('FTS index corrupt'))

    const { result } = renderHook(() => useBlockResolve())

    let items: unknown
    await act(async () => {
      items = await result.current.searchPages('long query')
    })
    expect(items).toEqual([])
  })

  it('searchPages returns [] when listBlocks rejects (short query, empty cache)', async () => {
    mockedListBlocks.mockRejectedValue(new Error('DB connection lost'))

    const { result } = renderHook(() => useBlockResolve())
    // pagesListRef is empty by default, so it will fall back to listBlocks

    let items: unknown
    await act(async () => {
      items = await result.current.searchPages('ab')
    })
    expect(items).toEqual([])
  })

  it('onCreatePage propagates createPageInSpace rejection', async () => {
    mockedCreatePageInSpace.mockRejectedValue(new Error('write permission denied'))

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await expect(result.current.onCreatePage('New Page')).rejects.toThrow(
        'write permission denied',
      )
    })
  })
})

// ── pagesListRef ────────────────────────────────────────────────────────

describe('pagesListRef', () => {
  it('is initially an empty array', () => {
    const { result } = renderHook(() => useBlockResolve())
    expect(result.current.pagesListRef.current).toEqual([])
  })

  it('is a mutable ref that can be set externally', () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [{ id: 'EXT1', title: 'External Page' }]
    })

    expect(result.current.pagesListRef.current).toEqual([{ id: 'EXT1', title: 'External Page' }])
  })
})

// ── searchPages alias matching ──────────────────────────────────────────

describe('searchPages — alias matching via resolvePageByAlias', () => {
  it('searchPages matches alias via resolvePageByAlias', async () => {
    // FTS returns no direct matches
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    // Alias lookup finds a page
    mockedResolvePageByAlias.mockResolvedValueOnce(['ALIAS_PAGE_1', 'Daily Notes'])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('daily-note')
    })

    expect(mockedResolvePageByAlias).toHaveBeenCalledWith('daily-note')

    // The alias match should be prepended to the results
    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate[0]).toEqual({
      id: 'ALIAS_PAGE_1',
      label: 'Daily Notes (alias: daily-note)',
      isAlias: true,
    })
  })

  it('searchPages skips alias when already in results', async () => {
    // FTS already has the page
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'ALIAS_PAGE_2',
          block_type: 'page',
          content: 'Weekly Review',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    // Alias also resolves to the same page
    mockedResolvePageByAlias.mockResolvedValueOnce(['ALIAS_PAGE_2', 'Weekly Review'])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('weekly')
    })

    // The alias match should NOT be duplicated
    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate).toHaveLength(1)
    expect(nonCreate[0]).toEqual(
      expect.objectContaining({ id: 'ALIAS_PAGE_2', label: 'Weekly Review' }),
    )
  })

  it('searchPages ignores alias lookup failure silently', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    // Alias lookup throws
    mockedResolvePageByAlias.mockRejectedValue(new Error('alias service down'))

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      // Should NOT throw
      items = await result.current.searchPages('broken-alias')
    })

    // Only the create option should be present
    expect(items).toEqual([{ id: '__create__', label: 'broken-alias', isCreate: true }])
  })

  it('searchPages handles null alias title as "Untitled"', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    mockedResolvePageByAlias.mockResolvedValueOnce(['ALIAS_PAGE_3', null])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('mystery')
    })

    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate[0]).toEqual({
      id: 'ALIAS_PAGE_3',
      label: 'Untitled (alias: mystery)',
      isAlias: true,
    })
  })

  it('searchPages does not call resolvePageByAlias for empty query', async () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [{ id: 'P1', title: 'Some Page' }]
    })

    await act(async () => {
      await result.current.searchPages('')
    })

    expect(mockedResolvePageByAlias).not.toHaveBeenCalled()
  })
})

// ── Priority ordering (MAINT-61) ────────────────────────────────────────
//
// After the strategy extraction, the dispatcher runs resolvers in a fixed
// priority order:
//   1. Short/long match strategy (cache vs FTS)
//   2. Resolve-cache population
//   3. Alias match prepended
//   4. "Create new page" appended
// These tests lock the observable order so future refactors can't silently
// reshuffle it.

describe('searchPages — strategy priority ordering (MAINT-61)', () => {
  it('orders results: alias first, then FTS matches, then create last', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'FTS_HIT_1',
          block_type: 'page',
          content: 'Meeting Notes',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
        {
          id: 'FTS_HIT_2',
          block_type: 'page',
          content: 'Team Meeting',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })
    mockedResolvePageByAlias.mockResolvedValueOnce(['ALIAS_ONLY', 'Aliased Page'])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('meeting')
    })

    // Exact order: alias → FTS matches → create
    expect(items).toHaveLength(4)
    expect(items[0]).toEqual({
      id: 'ALIAS_ONLY',
      label: 'Aliased Page (alias: meeting)',
      isAlias: true,
    })
    expect(items[1]?.id).toBe('FTS_HIT_1')
    expect(items[2]?.id).toBe('FTS_HIT_2')
    expect(items[3]).toEqual({ id: '__create__', label: 'meeting', isCreate: true })
  })

  it('orders results: alias first, then cache matches, then create last (short query)', async () => {
    mockedResolvePageByAlias.mockResolvedValueOnce(['ALIAS_SHORT', 'Alias Target'])

    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [
        { id: 'C1', title: 'abc page' },
        { id: 'C2', title: 'abc other' },
      ]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('ab')
    })

    // Alias prepended, cache matches in order, create appended
    expect(items).toHaveLength(4)
    expect(items[0]?.id).toBe('ALIAS_SHORT')
    expect(items[0]?.isAlias).toBe(true)
    const middleIds = [items[1]?.id, items[2]?.id]
    expect(middleIds).toContain('C1')
    expect(middleIds).toContain('C2')
    expect(items[3]?.id).toBe('__create__')
  })

  it('populates resolve cache for all non-create matches (excluding alias id when already present)', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'CACHE_POP_1',
          block_type: 'page',
          content: 'Sample Page',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })
    mockedResolvePageByAlias.mockResolvedValueOnce(null)

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchPages('sample')
    })

    // Cache population happens BEFORE alias lookup and BEFORE create option,
    // so only FTS/cache-strategy matches should be in the resolve store,
    // never the "__create__" synthetic id.
    // FEAT-3p7 — cache is composite-keyed (`${spaceId}::${ulid}`).
    const cache = useResolveStore.getState().cache
    expect(cache.get(keyFor('SPACE_TEST', 'CACHE_POP_1'))).toEqual({
      title: 'Sample Page',
      deleted: false,
    })
    expect(cache.get(keyFor('SPACE_TEST', '__create__'))).toBeUndefined()
  })

  it('short-query strategy handles namespaced titles via formatNamespacedLabel', async () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [
        { id: 'NS_A', title: 'work/projects/alpha' },
        { id: 'NS_B', title: 'beta' },
      ]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('')
    })

    const nsItem = items.find((i) => i.id === 'NS_A')
    expect(nsItem?.label).toBe('alpha')
    expect(nsItem?.breadcrumb).toBe('work / projects')

    const plainItem = items.find((i) => i.id === 'NS_B')
    expect(plainItem?.label).toBe('beta')
    expect(plainItem?.breadcrumb).toBeUndefined()
  })

  it('long-query strategy caps total (FTS + cache supplement) at 20', async () => {
    // FTS returns 2 pages (< 5 so supplementation kicks in)
    mockedSearchBlocks.mockResolvedValueOnce({
      items: Array.from({ length: 2 }, (_, i) => ({
        id: `FTS_CAP_${i}`,
        block_type: 'page' as const,
        content: `ReportHit ${i}`,
        parent_id: null,
        position: null,
        deleted_at: null,
        is_conflict: false,
        conflict_type: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
        page_id: null,
      })),
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    // Populate cache with 30 matches — supplementation should cap at 10,
    // and the combined result set should cap at 20.
    act(() => {
      result.current.pagesListRef.current = Array.from({ length: 30 }, (_, i) => ({
        id: `CACHE_CAP_${i}`,
        title: `reportcache ${i}`,
      }))
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('report')
    })

    const nonCreate = items.filter((i) => !i.isCreate && !i.isAlias)
    // 2 FTS + 10 cache (per the internal .slice(0, 10)) = 12 ≤ 20 cap
    expect(nonCreate).toHaveLength(12)
    expect(nonCreate[0]?.id).toBe('FTS_CAP_0')
    expect(nonCreate[1]?.id).toBe('FTS_CAP_1')
  })

  it('preserves alias priority even when FTS strategy runs', async () => {
    // FTS returns a result; alias must still be prepended first
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'FTS_BEHIND',
          block_type: 'page',
          content: 'Some Content',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })
    mockedResolvePageByAlias.mockResolvedValueOnce(['ALIAS_FIRST', 'Canonical Page'])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('content')
    })

    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate[0]?.id).toBe('ALIAS_FIRST')
    expect(nonCreate[0]?.isAlias).toBe(true)
    expect(nonCreate[1]?.id).toBe('FTS_BEHIND')
  })
})

// ── UX-65: Icons in picker items ────────────────────────────────────────

describe('searchTags — icons (UX-65)', () => {
  it('includes icon in tag picker items', async () => {
    mockedListTagsByPrefix.mockResolvedValueOnce([
      { tag_id: 'T100', name: 'work', usage_count: 1, updated_at: '2024-01-01' },
    ])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('work')
    })

    const tagItem = items.find((i) => i.id === 'T100')
    expect(tagItem).toBeDefined()
    expect(tagItem?.icon).toBeDefined()
  })
})

describe('searchPages — icons and breadcrumbs (UX-65)', () => {
  it('includes icon in page picker items', async () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [{ id: 'P100', title: 'My Page' }]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('my')
    })

    const pageItem = items.find((i) => i.id === 'P100')
    expect(pageItem).toBeDefined()
    expect(pageItem?.icon).toBeDefined()
  })

  it('adds breadcrumb for namespaced page titles', async () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [{ id: 'NS1', title: 'work/meetings/standup' }]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('')
    })

    const nsItem = items.find((i) => i.id === 'NS1')
    expect(nsItem).toBeDefined()
    expect(nsItem?.label).toBe('standup')
    expect(nsItem?.breadcrumb).toBe('work / meetings')
  })

  it('does not add breadcrumb for non-namespaced pages', async () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [{ id: 'P200', title: 'Simple Page' }]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('')
    })

    const simpleItem = items.find((i) => i.id === 'P200')
    expect(simpleItem).toBeDefined()
    expect(simpleItem?.label).toBe('Simple Page')
    expect(simpleItem?.breadcrumb).toBeUndefined()
  })

  it('adds breadcrumb for namespaced pages via FTS (long query)', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'FNS1',
          block_type: 'page',
          content: 'projects/frontend/react-app',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('react')
    })

    const nsItem = items.find((i) => i.id === 'FNS1')
    expect(nsItem).toBeDefined()
    expect(nsItem?.label).toBe('react-app')
    expect(nsItem?.breadcrumb).toBe('projects / frontend')
  })
})

describe('searchBlockRefs — icons (UX-65)', () => {
  it('includes icon in block ref picker items', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'BR1',
          block_type: 'block',
          content: 'Some block content',
          parent_id: null,
          position: 0,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchBlockRefs>> = []
    await act(async () => {
      items = await result.current.searchBlockRefs('some block')
    })

    expect(items).toHaveLength(1)
    expect(items[0]?.icon).toBeDefined()
  })

  it('shows parent page title as breadcrumb when available', async () => {
    // Pre-populate the resolve cache with a parent page
    useResolveStore.getState().set('PARENT_PAGE', 'My Page Title', false)

    mockedSearchBlocks.mockResolvedValueOnce({
      items: [
        {
          id: 'BR2',
          block_type: 'block',
          content: 'A child block',
          parent_id: 'PARENT_PAGE',
          position: 0,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchBlockRefs>> = []
    await act(async () => {
      items = await result.current.searchBlockRefs('child block')
    })

    expect(items).toHaveLength(1)
    expect(items[0]?.breadcrumb).toBe('My Page Title')
  })
})

// ── UX-68: Fuzzy matching ───────────────────────────────────────────────

describe('searchTags — fuzzy matching (UX-68)', () => {
  it('matches tags via fuzzy matching, not just substring', async () => {
    mockedListTagsByPrefix.mockResolvedValueOnce([
      { tag_id: 'TF1', name: 'quick-notes', usage_count: 1, updated_at: '2024-01-01' },
      { tag_id: 'TF2', name: 'quarterly', usage_count: 1, updated_at: '2024-01-01' },
      { tag_id: 'TF3', name: 'unrelated', usage_count: 1, updated_at: '2024-01-01' },
    ])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('qn')
    })

    // matchSorter with 'qn' should match 'quick-notes' (q + n)
    const tagIds = items.filter((i) => !i.isCreate).map((i) => i.id)
    expect(tagIds).toContain('TF1')
  })
})

describe('searchPages — fuzzy matching (UX-68)', () => {
  it('matches pages via fuzzy matching for short queries', async () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [
        { id: 'PF1', title: 'Quick Notes' },
        { id: 'PF2', title: 'Quarterly Report' },
        { id: 'PF3', title: 'Zzz Unrelated' },
      ]
    })

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('qn')
    })

    // matchSorter with 'qn' should match 'Quick Notes' (q + n)
    const pageIds = items.filter((i) => !i.isCreate).map((i) => i.id)
    expect(pageIds).toContain('PF1')
  })
})
