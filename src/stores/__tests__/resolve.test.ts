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
