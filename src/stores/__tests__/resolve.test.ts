/**
 * Tests for the resolve store — preload, set, batchSet, resolveTitle, resolveStatus.
 *
 * Covers the global resolve cache that maps block/tag ULIDs to display titles.
 * The preload function calls listBlocks and listTagsByPrefix (which wrap invoke).
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useResolveStore } from '../resolve'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  useResolveStore.setState({
    cache: new Map(),
    pagesList: [],
    version: 0,
    _preloaded: false,
  })
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// preload
// ---------------------------------------------------------------------------
describe('preload', () => {
  it('populates cache from pages and tags', async () => {
    const mockPages = [
      { id: 'PAGE_1', content: 'Page One', deleted_at: null },
      { id: 'PAGE_2', content: 'Page Two', deleted_at: null },
    ]
    const mockTags = [
      { tag_id: 'TAG_1', name: 'tag-one', usage_count: 5, updated_at: '2025-01-01' },
      { tag_id: 'TAG_2', name: 'tag-two', usage_count: 3, updated_at: '2025-01-01' },
    ]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_tags_by_prefix') return mockTags
      return null
    })

    await useResolveStore.getState().preload()

    const state = useResolveStore.getState()
    expect(state.cache.size).toBe(4)
    expect(state.cache.get('PAGE_1')).toEqual({ title: 'Page One', deleted: false })
    expect(state.cache.get('TAG_1')).toEqual({ title: 'tag-one', deleted: false })
    expect(state.pagesList).toHaveLength(2)
    expect(state.pagesList).toEqual([
      { id: 'PAGE_1', title: 'Page One' },
      { id: 'PAGE_2', title: 'Page Two' },
    ])
    expect(state._preloaded).toBe(true)
  })

  it('uses "Untitled" for pages with null content', async () => {
    const mockPages = [{ id: 'PAGE_NULL', content: null, deleted_at: null }]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_tags_by_prefix') return []
      return null
    })

    await useResolveStore.getState().preload()

    const entry = useResolveStore.getState().cache.get('PAGE_NULL')
    expect(entry).toEqual({ title: 'Untitled', deleted: false })
  })

  it('marks deleted pages', async () => {
    const mockPages = [
      { id: 'PAGE_DEL', content: 'Deleted Page', deleted_at: '2025-06-01T00:00:00Z' },
    ]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_tags_by_prefix') return []
      return null
    })

    await useResolveStore.getState().preload()

    const entry = useResolveStore.getState().cache.get('PAGE_DEL')
    expect(entry).toEqual({ title: 'Deleted Page', deleted: true })
  })

  it('sets _preloaded on error', async () => {
    mockedInvoke.mockRejectedValue(new Error('network failure'))

    await useResolveStore.getState().preload()

    const state = useResolveStore.getState()
    expect(state._preloaded).toBe(true)
    expect(state.cache.size).toBe(0)
  })

  it('bumps version', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: [], next_cursor: null, has_more: false }
      if (cmd === 'list_tags_by_prefix') return []
      return null
    })

    const versionBefore = useResolveStore.getState().version
    await useResolveStore.getState().preload()
    const versionAfter = useResolveStore.getState().version

    expect(versionAfter).toBe(versionBefore + 1)
  })

  it('preserves concurrent set() calls (merge, not replace)', async () => {
    // Simulate a set() call that lands before preload finishes
    useResolveStore.getState().set('NEW_PAGE', 'Created During Preload', false)

    const mockPages = [
      { id: 'PAGE_1', content: 'Page One', deleted_at: null },
      // DB also has an older version of NEW_PAGE
      { id: 'NEW_PAGE', content: 'Old DB Title', deleted_at: null },
    ]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_tags_by_prefix') return []
      return null
    })

    await useResolveStore.getState().preload()

    const state = useResolveStore.getState()
    // The concurrent set() entry must win over fetched data
    expect(state.cache.get('NEW_PAGE')).toEqual({ title: 'Created During Preload', deleted: false })
    // Other fetched entries should still be present
    expect(state.cache.get('PAGE_1')).toEqual({ title: 'Page One', deleted: false })
  })

  it('preserves pages created via set() during preload in pagesList (#534)', async () => {
    // Simulate a page created via set() before preload completes
    useResolveStore.getState().set('CREATED_DURING', 'New Page', false)

    const mockPages = [{ id: 'PAGE_1', content: 'Page One', deleted_at: null }]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_tags_by_prefix') return []
      return null
    })

    await useResolveStore.getState().preload()

    const state = useResolveStore.getState()
    // pagesList should contain both fetched pages AND the page created during preload
    expect(state.pagesList).toHaveLength(2)
    expect(state.pagesList.find((p) => p.id === 'PAGE_1')).toBeTruthy()
    expect(state.pagesList.find((p) => p.id === 'CREATED_DURING')).toBeTruthy()
  })

  it('preload with forceRefresh=true overwrites stale cache entries (B-7)', async () => {
    // Pre-populate cache with an old/stale title (simulates data from a previous preload)
    useResolveStore.getState().set('PAGE_RENAMED', 'Old Title', false)

    // Backend now returns the renamed page
    const mockPages = [{ id: 'PAGE_RENAMED', content: 'New Title After Rename', deleted_at: null }]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_tags_by_prefix') return []
      return null
    })

    await useResolveStore.getState().preload(true)

    const state = useResolveStore.getState()
    // Freshly fetched data must overwrite the stale cache entry
    expect(state.cache.get('PAGE_RENAMED')).toEqual({
      title: 'New Title After Rename',
      deleted: false,
    })
  })

  it('preload without forceRefresh preserves concurrent set() calls (B-7)', async () => {
    // Simulate a set() call that represents a local edit happening concurrently
    useResolveStore.getState().set('PAGE_EDITED', 'Local Edit Title', false)

    // Backend returns an older version of the same page
    const mockPages = [{ id: 'PAGE_EDITED', content: 'Stale Backend Title', deleted_at: null }]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_tags_by_prefix') return []
      return null
    })

    // Default preload (forceRefresh=false) — cache wins
    await useResolveStore.getState().preload()

    const state = useResolveStore.getState()
    // The concurrent set() entry must win over fetched data
    expect(state.cache.get('PAGE_EDITED')).toEqual({
      title: 'Local Edit Title',
      deleted: false,
    })
  })
})

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------
describe('set', () => {
  it('adds entry to cache and bumps version', () => {
    const versionBefore = useResolveStore.getState().version

    useResolveStore.getState().set('ID_1', 'My Page', false)

    const state = useResolveStore.getState()
    expect(state.cache.get('ID_1')).toEqual({ title: 'My Page', deleted: false })
    expect(state.version).toBe(versionBefore + 1)
  })

  it('updates existing entry', () => {
    useResolveStore.getState().set('ID_1', 'First Title', false)
    useResolveStore.getState().set('ID_1', 'Updated Title', true)

    const entry = useResolveStore.getState().cache.get('ID_1')
    expect(entry).toEqual({ title: 'Updated Title', deleted: true })
  })

  it('appends new entry to pagesList', () => {
    useResolveStore.getState().set('ID_1', 'Page A', false)

    const pagesList = useResolveStore.getState().pagesList
    expect(pagesList).toHaveLength(1)
    expect(pagesList[0]).toEqual({ id: 'ID_1', title: 'Page A' })
  })

  it('does not duplicate in pagesList', () => {
    useResolveStore.getState().set('ID_1', 'Page A', false)
    useResolveStore.getState().set('ID_1', 'Page A Updated', false)

    const pagesList = useResolveStore.getState().pagesList
    expect(pagesList).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// batchSet
// ---------------------------------------------------------------------------
describe('batchSet', () => {
  it('adds multiple entries', () => {
    useResolveStore.getState().batchSet([
      { id: 'A', title: 'Alpha', deleted: false },
      { id: 'B', title: 'Beta', deleted: false },
      { id: 'C', title: 'Charlie', deleted: true },
    ])

    const cache = useResolveStore.getState().cache
    expect(cache.size).toBe(3)
    expect(cache.get('A')).toEqual({ title: 'Alpha', deleted: false })
    expect(cache.get('B')).toEqual({ title: 'Beta', deleted: false })
    expect(cache.get('C')).toEqual({ title: 'Charlie', deleted: true })
  })

  it('is no-op for empty array', () => {
    const versionBefore = useResolveStore.getState().version

    useResolveStore.getState().batchSet([])

    expect(useResolveStore.getState().version).toBe(versionBefore)
    expect(useResolveStore.getState().cache.size).toBe(0)
  })

  it('bumps version once', () => {
    const versionBefore = useResolveStore.getState().version

    useResolveStore.getState().batchSet([
      { id: 'A', title: 'Alpha', deleted: false },
      { id: 'B', title: 'Beta', deleted: false },
    ])

    expect(useResolveStore.getState().version).toBe(versionBefore + 1)
  })
})

// ---------------------------------------------------------------------------
// resolveTitle
// ---------------------------------------------------------------------------
describe('resolveTitle', () => {
  it('returns cached title', () => {
    useResolveStore.getState().set('ID_KNOWN', 'Known Page', false)

    const title = useResolveStore.getState().resolveTitle('ID_KNOWN')
    expect(title).toBe('Known Page')
  })

  it('returns fallback for unknown id', () => {
    const unknownId = '01ABCDEF99999999ZZZZZZZZZZ'
    const title = useResolveStore.getState().resolveTitle(unknownId)

    expect(title).toBe(`[[${unknownId.slice(0, 8)}...]]`)
    expect(title).toBe('[[01ABCDEF...]]')
  })
})

// ---------------------------------------------------------------------------
// resolveStatus
// ---------------------------------------------------------------------------
describe('resolveStatus', () => {
  it('returns "active" for non-deleted entry', () => {
    useResolveStore.getState().set('ID_ACTIVE', 'Active Page', false)

    const status = useResolveStore.getState().resolveStatus('ID_ACTIVE')
    expect(status).toBe('active')
  })

  it('returns "deleted" for deleted entry', () => {
    useResolveStore.getState().set('ID_DELETED', 'Deleted Page', true)

    const status = useResolveStore.getState().resolveStatus('ID_DELETED')
    expect(status).toBe('deleted')
  })

  it('returns "active" for unknown id', () => {
    const status = useResolveStore.getState().resolveStatus('NONEXISTENT')
    expect(status).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// cache eviction
// ---------------------------------------------------------------------------
describe('cache eviction', () => {
  it('set() evicts oldest entries when cache exceeds MAX_CACHE_SIZE', () => {
    // Pre-fill cache with exactly 10,000 entries
    const cache = new Map<string, { title: string; deleted: boolean }>()
    for (let i = 0; i < 10_000; i++) {
      cache.set(`id-${i}`, { title: `T${i}`, deleted: false })
    }
    useResolveStore.setState({ cache })

    // Add one more entry — should trigger eviction
    useResolveStore.getState().set('new-id', 'Title', false)

    const state = useResolveStore.getState()
    expect(state.cache.size).toBe(10_000)
    // The first entry added should have been evicted
    expect(state.cache.has('id-0')).toBe(false)
    // The new entry should be present
    expect(state.cache.has('new-id')).toBe(true)
  })

  it('batchSet() evicts when batch pushes cache over limit', () => {
    // Pre-fill cache to 9,998 entries
    const cache = new Map<string, { title: string; deleted: boolean }>()
    for (let i = 0; i < 9_998; i++) {
      cache.set(`id-${i}`, { title: `T${i}`, deleted: false })
    }
    useResolveStore.setState({ cache })

    // Add 3 entries — total would be 10,001, should evict 1 oldest
    useResolveStore.getState().batchSet([
      { id: 'a', title: 'A', deleted: false },
      { id: 'b', title: 'B', deleted: false },
      { id: 'c', title: 'C', deleted: false },
    ])

    const state = useResolveStore.getState()
    expect(state.cache.size).toBe(10_000)
    // The first entry (oldest) should have been evicted
    expect(state.cache.has('id-0')).toBe(false)
    // All new entries should be present
    expect(state.cache.has('a')).toBe(true)
    expect(state.cache.has('b')).toBe(true)
    expect(state.cache.has('c')).toBe(true)
  })

  it('set() evicts oldest pagesList entries at MAX_PAGES_LIST_SIZE', () => {
    // Pre-fill pagesList to 5,000 entries
    const pagesList = Array.from({ length: 5_000 }, (_, i) => ({
      id: `page-${i}`,
      title: `Page ${i}`,
    }))
    useResolveStore.setState({ pagesList })

    // Add one more page — should trigger eviction via slice(-5000)
    useResolveStore.getState().set('new-page', 'New Page', false)

    const state = useResolveStore.getState()
    expect(state.pagesList.length).toBe(5_000)
    // The first page should have been evicted
    expect(state.pagesList.find((p) => p.id === 'page-0')).toBeUndefined()
    // The new page should be at the end
    expect(state.pagesList[state.pagesList.length - 1]).toEqual({
      id: 'new-page',
      title: 'New Page',
    })
  })
})
