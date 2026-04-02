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
  listBlocks: vi.fn(),
  listTagsByPrefix: vi.fn(),
  searchBlocks: vi.fn(),
}))

import { createBlock, listBlocks, listTagsByPrefix, searchBlocks } from '../../lib/tauri'
import { useResolveStore } from '../../stores/resolve'
import { useBlockResolve } from '../useBlockResolve'

const mockedCreateBlock = vi.mocked(createBlock)
const mockedListBlocks = vi.mocked(listBlocks)
const mockedListTagsByPrefix = vi.mocked(listTagsByPrefix)
const mockedSearchBlocks = vi.mocked(searchBlocks)

beforeEach(() => {
  vi.clearAllMocks()
  useResolveStore.setState({
    cache: new Map(),
    pagesList: [],
    version: 0,
    _preloaded: false,
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
    mockedListTagsByPrefix.mockResolvedValue([
      { tag_id: 'T1', name: 'project', usage_count: 5, updated_at: '2024-01-01' },
      { tag_id: 'T2', name: 'priority', usage_count: 3, updated_at: '2024-01-02' },
    ])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('pr')
    })

    expect(mockedListTagsByPrefix).toHaveBeenCalledWith({ prefix: 'pr' })
    expect(items).toEqual([
      { id: 'T1', label: 'project' },
      { id: 'T2', label: 'priority' },
    ])
  })

  it('returns empty array when no tags match', async () => {
    mockedListTagsByPrefix.mockResolvedValue([])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('zzz')
    })

    expect(items).toEqual([])
  })

  it('populates the resolve cache with fetched tags', async () => {
    mockedListTagsByPrefix.mockResolvedValue([
      { tag_id: 'T10', name: 'important', usage_count: 2, updated_at: '2024-01-01' },
      { tag_id: 'T11', name: 'urgent', usage_count: 1, updated_at: '2024-01-02' },
    ])

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchTags('imp')
    })

    // Verify the resolve store cache was populated
    const cache = useResolveStore.getState().cache
    expect(cache.get('T10')).toEqual({ title: 'important', deleted: false })
    expect(cache.get('T11')).toEqual({ title: 'urgent', deleted: false })
  })

  it('does not call batchSet when no tags match', async () => {
    mockedListTagsByPrefix.mockResolvedValue([])

    const initialVersion = useResolveStore.getState().version

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchTags('zzz')
    })

    // Version should not change — no batchSet call
    expect(useResolveStore.getState().version).toBe(initialVersion)
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
    expect(items).toEqual(expect.arrayContaining([{ id: 'P1', label: 'My Page' }]))
    // "Another Page" and "Meeting Notes" don't contain "my"
    const ids = items.filter((i) => !i.isCreate).map((i) => i.id)
    expect(ids).toContain('P1')
    expect(ids).not.toContain('P2')
    expect(ids).not.toContain('P3')
  })

  it('falls back to listBlocks when pagesListRef is empty', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [
        {
          id: 'P10',
          block_type: 'page',
          content: 'Alpha',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
        },
        {
          id: 'P11',
          block_type: 'page',
          content: 'Beta',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
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

    expect(mockedListBlocks).toHaveBeenCalledWith({ blockType: 'page', limit: 500 })
    // Should match "Alpha" (contains "al")
    const matchIds = items.filter((i) => !i.isCreate).map((i) => i.id)
    expect(matchIds).toContain('P10')
    // "Beta" does not contain "al"
    expect(matchIds).not.toContain('P11')
  })

  it('populates pagesListRef cache after listBlocks fallback', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [
        {
          id: 'P20',
          block_type: 'page',
          content: 'Cached Page',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
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
    mockedListBlocks.mockResolvedValue({
      items: [
        {
          id: 'P30',
          block_type: 'page',
          content: null,
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
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
    expect(items).toEqual(expect.arrayContaining([{ id: 'P30', label: 'Untitled' }]))
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
    mockedSearchBlocks.mockResolvedValue({
      items: [
        {
          id: 'F1',
          block_type: 'page',
          content: 'Meeting Notes',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
        },
        {
          id: 'F2',
          block_type: 'block',
          content: 'meeting agenda item',
          parent_id: 'F1',
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
        },
        {
          id: 'F3',
          block_type: 'page',
          content: 'Team Meeting',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
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

    expect(mockedSearchBlocks).toHaveBeenCalledWith({ query: 'meeting', limit: 20 })
    // Only page-type blocks should be returned
    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate).toEqual([
      { id: 'F1', label: 'Meeting Notes' },
      { id: 'F3', label: 'Team Meeting' },
    ])
  })

  it('supplements from pagesListRef when FTS returns few results', async () => {
    mockedSearchBlocks.mockResolvedValue({
      items: [
        {
          id: 'F10',
          block_type: 'page',
          content: 'Design Doc',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
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
      { id: 'F10', label: 'Design Doc' },
      { id: 'C1', label: 'Design Review' },
      { id: 'C2', label: 'Design Sprint' },
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
      archived_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
    }))

    mockedSearchBlocks.mockResolvedValue({
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
    mockedSearchBlocks.mockResolvedValue({
      items: [
        {
          id: 'F20',
          block_type: 'page',
          content: 'Lonely Result',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
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
    expect(nonCreate[0]).toEqual({ id: 'F20', label: 'Lonely Result' })
  })

  it('handles null content as "Untitled" in FTS results', async () => {
    mockedSearchBlocks.mockResolvedValue({
      items: [
        {
          id: 'F30',
          block_type: 'page',
          content: null,
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
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
    expect(nonCreate).toEqual([{ id: 'F30', label: 'Untitled' }])
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
    mockedSearchBlocks.mockResolvedValue({
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
    mockedSearchBlocks.mockResolvedValue({
      items: [
        {
          id: 'F40',
          block_type: 'page',
          content: 'Weekly Report',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
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
    mockedSearchBlocks.mockResolvedValue({
      items: [
        {
          id: 'F50',
          block_type: 'page',
          content: 'Design',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
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

// ── onCreatePage ────────────────────────────────────────────────────────

describe('onCreatePage', () => {
  it('calls createBlock with page type and content', async () => {
    mockedCreateBlock.mockResolvedValue({
      id: 'NEW_PAGE_1',
      block_type: 'page',
      content: 'Brand New Page',
      parent_id: null,
      position: null,
      deleted_at: null,
      archived_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
    })

    const { result } = renderHook(() => useBlockResolve())

    let newId = ''
    await act(async () => {
      newId = await result.current.onCreatePage('Brand New Page')
    })

    expect(mockedCreateBlock).toHaveBeenCalledWith({
      blockType: 'page',
      content: 'Brand New Page',
    })
    expect(newId).toBe('NEW_PAGE_1')
  })

  it('updates the resolve store with the new page', async () => {
    mockedCreateBlock.mockResolvedValue({
      id: 'NEW_PAGE_2',
      block_type: 'page',
      content: 'Store Updated Page',
      parent_id: null,
      position: null,
      deleted_at: null,
      archived_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
    })

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.onCreatePage('Store Updated Page')
    })

    const cached = useResolveStore.getState().cache.get('NEW_PAGE_2')
    expect(cached).toEqual({ title: 'Store Updated Page', deleted: false })
  })

  it('appends the new page to pagesListRef', async () => {
    mockedCreateBlock.mockResolvedValue({
      id: 'NEW_PAGE_3',
      block_type: 'page',
      content: 'Appended Page',
      parent_id: null,
      position: null,
      deleted_at: null,
      archived_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
    })

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
    mockedCreateBlock.mockResolvedValue({
      id: 'RETURNED_ID',
      block_type: 'page',
      content: 'Test',
      parent_id: null,
      position: null,
      deleted_at: null,
      archived_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
    })

    const { result } = renderHook(() => useBlockResolve())

    let newId = ''
    await act(async () => {
      newId = await result.current.onCreatePage('Test')
    })

    expect(newId).toBe('RETURNED_ID')
  })
})

// ── Error propagation (no try/catch in hook) ────────────────────────────

describe('error propagation', () => {
  it('searchTags propagates listTagsByPrefix rejection', async () => {
    mockedListTagsByPrefix.mockRejectedValue(new Error('IPC: tags unavailable'))

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await expect(result.current.searchTags('test')).rejects.toThrow('IPC: tags unavailable')
    })
  })

  it('searchPages propagates searchBlocks rejection (long query)', async () => {
    mockedSearchBlocks.mockRejectedValue(new Error('FTS index corrupt'))

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await expect(result.current.searchPages('long query')).rejects.toThrow('FTS index corrupt')
    })
  })

  it('searchPages propagates listBlocks rejection (short query, empty cache)', async () => {
    mockedListBlocks.mockRejectedValue(new Error('DB connection lost'))

    const { result } = renderHook(() => useBlockResolve())
    // pagesListRef is empty by default, so it will fall back to listBlocks

    await act(async () => {
      await expect(result.current.searchPages('ab')).rejects.toThrow('DB connection lost')
    })
  })

  it('onCreatePage propagates createBlock rejection', async () => {
    mockedCreateBlock.mockRejectedValue(new Error('write permission denied'))

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
