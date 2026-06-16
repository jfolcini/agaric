/**
 * Tests for the resolve store — preload, set, batchSet, resolveTitle, resolveStatus.
 *
 * Covers the global resolve cache that maps block/tag ULIDs to display titles.
 * The preload function calls listBlocks and listAllTagsInSpace (#1343) (which wrap invoke).
 *
 * # FEAT-3p7 — Cache key encoding (cross-space link enforcement)
 *
 * The cache `Map` is keyed by `${spaceId}::${ulid}`. Tests fix
 * `useSpaceStore.currentSpaceId = TEST_SPACE_ID` in `beforeEach` so every
 * `set` / `batchSet` / lookup uses the same prefix; tests that explicitly
 * exercise multi-space behaviour switch the active space via
 * `useSpaceStore.setState({ currentSpaceId: ... })` before reading.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from '../../lib/logger'
import { GLOBAL_SPACE_ID, keyFor, useResolveStore } from '../resolve'
import { useSpaceStore } from '../space'

const mockedInvoke = vi.mocked(invoke)

const TEST_SPACE_ID = 'SPACE_TEST'
const OTHER_SPACE_ID = 'SPACE_OTHER'

beforeEach(async () => {
  // Flush any pending microtasks from previous test (e.g., debounced version bumps)
  await new Promise<void>((r) => queueMicrotask(r))
  useResolveStore.setState({
    cache: new Map(),
    version: 0,
    _preloaded: false,
  })
  // FEAT-3p7 — pin the active space so composite-key encoding is
  // deterministic for every test in this file.
  useSpaceStore.setState({
    currentSpaceId: TEST_SPACE_ID,
    availableSpaces: [
      { id: TEST_SPACE_ID, name: 'Test', accent_color: null },
      { id: OTHER_SPACE_ID, name: 'Other', accent_color: null },
    ],
    isReady: true,
  })
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// preload
// ---------------------------------------------------------------------------
describe('preload', () => {
  it('populates cache from pages and tags (with pagination)', async () => {
    const mockPages = [
      { id: 'PAGE_1', content: 'Page One', deleted_at: null },
      { id: 'PAGE_2', content: 'Page Two', deleted_at: null },
    ]
    const mockTags = [
      { tag_id: 'TAG_1', name: 'tag-one', usage_count: 5, updated_at: '2025-01-01' },
      { tag_id: 'TAG_2', name: 'tag-two', usage_count: 3, updated_at: '2025-01-01' },
    ]

    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      const params = args as Record<string, unknown> | undefined
      if (cmd === 'list_blocks') {
        if (!params?.['cursor']) {
          // First page
          return { items: [mockPages[0]], next_cursor: 'cursor_1', has_more: true }
        } else {
          // Second page
          return { items: [mockPages[1]], next_cursor: null, has_more: false }
        }
      }
      if (cmd === 'list_all_tags_in_space') return mockTags
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID)

    const state = useResolveStore.getState()
    expect(state.cache.size).toBe(4)
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'PAGE_1'))).toEqual({
      title: 'Page One',
      deleted: false,
    })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'PAGE_2'))).toEqual({
      title: 'Page Two',
      deleted: false,
    })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'TAG_1'))).toEqual({
      title: 'tag-one',
      deleted: false,
    })
    expect(state._preloaded).toBe(true)
    // Should have called list_blocks twice (pagination)
    const listBlocksCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
    expect(listBlocksCalls).toHaveLength(2)
    // FEAT-3p7 — listBlocks call must forward the spaceId so the
    // backend filters out other-space pages.
    const firstListBlocksArgs = listBlocksCalls[0]?.[1] as Record<string, unknown> | undefined
    expect(firstListBlocksArgs?.['spaceId']).toBe(TEST_SPACE_ID)
  })

  it('caches more than 200 tags — no MAX_TAGS_PREFIX truncation (#1343)', async () => {
    // The preload used to call `listTagsByPrefix({ prefix: '' })`, which the
    // backend silently clamped to `MAX_TAGS_PREFIX = 200`, so chips beyond
    // the first 200 tags rendered broken in large vaults. The no-clamp IPC
    // `listAllTagsInSpace(spaceId)` returns every tag; assert all 250 land in
    // the cache (none truncated).
    const TAG_COUNT = 250
    const mockTags = Array.from({ length: TAG_COUNT }, (_, i) => ({
      tag_id: `TAG_${i}`,
      name: `tag-${i}`,
      usage_count: 1,
      updated_at: '2025-01-01',
    }))

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks')
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      if (cmd === 'list_all_tags_in_space') return mockTags
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID)

    const state = useResolveStore.getState()
    expect(state.cache.size).toBe(TAG_COUNT)
    // First, the 200th boundary, and last tag are all present.
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'TAG_0'))).toEqual({
      title: 'tag-0',
      deleted: false,
    })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'TAG_200'))).toEqual({
      title: 'tag-200',
      deleted: false,
    })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'TAG_249'))).toEqual({
      title: 'tag-249',
      deleted: false,
    })
    // The space-scoped IPC must be forwarded the active spaceId.
    const tagCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_all_tags_in_space')
    expect(tagCalls).toHaveLength(1)
    expect((tagCalls[0]?.[1] as Record<string, unknown> | undefined)?.['spaceId']).toBe(
      TEST_SPACE_ID,
    )
  })

  it('uses "Untitled" for pages with null content', async () => {
    const mockPages = [{ id: 'PAGE_NULL', content: null, deleted_at: null }]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID)

    const entry = useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, 'PAGE_NULL'))
    expect(entry).toEqual({ title: 'Untitled', deleted: false })
  })

  it('marks deleted pages', async () => {
    const mockPages = [
      { id: 'PAGE_DEL', content: 'Deleted Page', deleted_at: '2025-06-01T00:00:00Z' },
    ]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID)

    const entry = useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, 'PAGE_DEL'))
    expect(entry).toEqual({ title: 'Deleted Page', deleted: true })
  })

  it('does not set _preloaded on error so retry is possible', async () => {
    mockedInvoke.mockRejectedValue(new Error('network failure'))

    await useResolveStore.getState().preload(TEST_SPACE_ID)

    const state = useResolveStore.getState()
    expect(state._preloaded).toBe(false)
    expect(state.cache.size).toBe(0)
  })

  it('logs a warning when listBlocks rejects (BUG-28)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const fetchErr = new Error('list_blocks boom')
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') throw fetchErr
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      'ResolveStore',
      'preload failed, using fallback',
      {},
      fetchErr,
    )
    expect(useResolveStore.getState()._preloaded).toBe(false)
    warnSpy.mockRestore()
  })

  it('logs a warning when listAllTagsInSpace rejects (BUG-28)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const fetchErr = new Error('list_tags boom')
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks')
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      if (cmd === 'list_all_tags_in_space') throw fetchErr
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      'ResolveStore',
      'preload failed, using fallback',
      {},
      fetchErr,
    )
    expect(useResolveStore.getState()._preloaded).toBe(false)
    warnSpy.mockRestore()
  })

  it('bumps version', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks')
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    const versionBefore = useResolveStore.getState().version
    await useResolveStore.getState().preload(TEST_SPACE_ID)
    const versionAfter = useResolveStore.getState().version

    expect(versionAfter).toBe(versionBefore + 1)
  })

  it('fetched data overwrites concurrent set() calls on preload', async () => {
    // Simulate a set() call that lands before preload finishes
    useResolveStore.getState().set('NEW_PAGE', 'Created During Preload', false)

    const mockPages = [
      { id: 'PAGE_1', content: 'Page One', deleted_at: null },
      // DB also has a version of NEW_PAGE
      { id: 'NEW_PAGE', content: 'DB Title', deleted_at: null },
    ]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID)

    const state = useResolveStore.getState()
    // Fetched data wins over stale cache entries
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'NEW_PAGE'))).toEqual({
      title: 'DB Title',
      deleted: false,
    })
    // Other fetched entries should still be present
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'PAGE_1'))).toEqual({
      title: 'Page One',
      deleted: false,
    })
  })

  it('preserves pages created via set() during preload in the cache (#534)', async () => {
    // Simulate a page created via set() before preload completes
    useResolveStore.getState().set('CREATED_DURING', 'New Page', false)

    const mockPages = [{ id: 'PAGE_1', content: 'Page One', deleted_at: null }]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID)

    const state = useResolveStore.getState()
    // The cache contains both the fetched page AND the page created
    // during preload (the merge never drops non-fetched entries).
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'PAGE_1'))).toEqual({
      title: 'Page One',
      deleted: false,
    })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'CREATED_DURING'))).toEqual({
      title: 'New Page',
      deleted: false,
    })
  })

  it('preload with forceRefresh=true overwrites stale cache entries (B-7)', async () => {
    // Pre-populate cache with an old/stale title (simulates data from a previous preload)
    useResolveStore.getState().set('PAGE_RENAMED', 'Old Title', false)

    // Backend now returns the renamed page
    const mockPages = [{ id: 'PAGE_RENAMED', content: 'New Title After Rename', deleted_at: null }]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID, true)

    const state = useResolveStore.getState()
    // Freshly fetched data must overwrite the stale cache entry
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'PAGE_RENAMED'))).toEqual({
      title: 'New Title After Rename',
      deleted: false,
    })
  })

  it('preload without forceRefresh overwrites stale cache with fetched data (B-7)', async () => {
    // Simulate a set() call that represents stale cached data
    useResolveStore.getState().set('PAGE_EDITED', 'Local Edit Title', false)

    // Backend returns the latest version of the same page
    const mockPages = [{ id: 'PAGE_EDITED', content: 'Fresh Backend Title', deleted_at: null }]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    // Default preload (forceRefresh=false) — fetched data wins
    await useResolveStore.getState().preload(TEST_SPACE_ID)

    const state = useResolveStore.getState()
    // Fetched data overwrites stale cache entries
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'PAGE_EDITED'))).toEqual({
      title: 'Fresh Backend Title',
      deleted: false,
    })
  })

  it('fresh data overwrites stale cache on non-force-refresh preload (BUG-6)', async () => {
    // Prime cache with a stale page title
    useResolveStore.getState().set('PAGE_SYNC', 'Old Title Before Sync', false)

    // After sync, backend returns a DIFFERENT title for the same ID
    const mockPages = [{ id: 'PAGE_SYNC', content: 'Renamed Title After Sync', deleted_at: null }]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    // Normal preload (forceRefresh=false)
    await useResolveStore.getState().preload(TEST_SPACE_ID, false)

    const state = useResolveStore.getState()
    // Fresh fetched data must overwrite the stale cache entry
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'PAGE_SYNC'))).toEqual({
      title: 'Renamed Title After Sync',
      deleted: false,
    })
  })

  it('FE-H-22 — preload(undefined) is a no-op (skips IPC entirely)', async () => {
    // Pre-bootstrap state: the space store has not hydrated yet.
    // Earlier code forwarded `spaceId ?? ''` into `list_blocks` and
    // relied on the backend treating `''` as a no-match SQL filter
    // (entries landed under `__global__::*` until a real space id
    // arrived). FE-H-22 fails closed instead: no IPC, no cache writes
    // — the cross-space barrier is too important to delegate to an
    // unwritten backend contract. `useAppSpaceLifecycle` re-invokes
    // preload once the space store hydrates and a real id is threaded
    // through.
    useSpaceStore.setState({ currentSpaceId: null, isReady: false })
    const cacheSizeBefore = useResolveStore.getState().cache.size

    await useResolveStore.getState().preload()

    expect(mockedInvoke).not.toHaveBeenCalled()
    const state = useResolveStore.getState()
    expect(state.cache.size).toBe(cacheSizeBefore)
    expect(state._preloaded).toBe(false)
    // Belt-and-braces: nothing keyed under the global sentinel either.
    expect(state.cache.has(keyFor(GLOBAL_SPACE_ID, 'PAGE_PRE'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// preload — in-flight coalescing (#753)
// ---------------------------------------------------------------------------
describe('preload in-flight coalescing (#753)', () => {
  /** Build a list_blocks page response with a single page row. */
  function pageSnapshot(title: string) {
    return {
      items: [{ id: 'PAGE_1', content: title, deleted_at: null }],
      next_cursor: null,
      has_more: false,
    }
  }

  it('coalesces concurrent preloads of the same space into one scan', async () => {
    let listBlocksCalls = 0
    const deferred: Array<(v: unknown) => void> = []
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') {
        listBlocksCalls++
        return new Promise((resolve) => deferred.push(resolve))
      }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    // Boot-style double fire: two plain preloads in the same tick.
    const p1 = useResolveStore.getState().preload(TEST_SPACE_ID)
    const p2 = useResolveStore.getState().preload(TEST_SPACE_ID)

    await vi.waitFor(() => expect(deferred).toHaveLength(1))
    deferred[0]?.(pageSnapshot('One'))
    await Promise.all([p1, p2])

    // ONE full scan served both callers.
    expect(listBlocksCalls).toBe(1)
    expect(useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, 'PAGE_1'))).toEqual({
      title: 'One',
      deleted: false,
    })
    expect(useResolveStore.getState()._preloaded).toBe(true)
  })

  it('forceRefresh callers arriving mid-scan collapse into ONE trailing re-scan', async () => {
    let listBlocksCalls = 0
    const deferred: Array<(v: unknown) => void> = []
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') {
        listBlocksCalls++
        return new Promise((resolve) => deferred.push(resolve))
      }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    const p1 = useResolveStore.getState().preload(TEST_SPACE_ID)
    // Two sync:complete-style force refreshes land while scan 1 is in
    // flight — the in-flight snapshot may predate their data, so ONE
    // trailing re-scan must run (not zero, not two).
    const p2 = useResolveStore.getState().preload(TEST_SPACE_ID, true)
    const p3 = useResolveStore.getState().preload(TEST_SPACE_ID, true)

    await vi.waitFor(() => expect(deferred).toHaveLength(1))
    deferred[0]?.(pageSnapshot('Stale'))

    // The trailing re-scan starts after scan 1 settles.
    await vi.waitFor(() => expect(deferred).toHaveLength(2))
    deferred[1]?.(pageSnapshot('Fresh'))
    await Promise.all([p1, p2, p3])

    expect(listBlocksCalls).toBe(2)
    // The trailing scan's data wins.
    expect(useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, 'PAGE_1'))).toEqual({
      title: 'Fresh',
      deleted: false,
    })
  })

  it('a preload after the previous one settled starts a fresh scan', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks')
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID)
    await useResolveStore.getState().preload(TEST_SPACE_ID)

    const listBlocksCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
    expect(listBlocksCalls).toHaveLength(2)
  })

  it('concurrent preloads of DIFFERENT spaces are not coalesced', async () => {
    const deferred: Array<(v: unknown) => void> = []
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') {
        return new Promise((resolve) => deferred.push(resolve))
      }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    const p1 = useResolveStore.getState().preload(TEST_SPACE_ID)
    const p2 = useResolveStore.getState().preload(OTHER_SPACE_ID)

    // Two independent scans, one per space.
    await vi.waitFor(() => expect(deferred).toHaveLength(2))
    deferred[0]?.({ items: [], next_cursor: null, has_more: false })
    deferred[1]?.({ items: [], next_cursor: null, has_more: false })
    await Promise.all([p1, p2])

    const listBlocksCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
    expect(listBlocksCalls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------
describe('set', () => {
  it('adds entry to cache and bumps version inline', () => {
    const versionBefore = useResolveStore.getState().version

    useResolveStore.getState().set('ID_1', 'My Page', false)

    const state = useResolveStore.getState()
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'ID_1'))).toEqual({
      title: 'My Page',
      deleted: false,
    })
    // FE-H-21 — `set` bumps `version` synchronously (no microtask wait).
    expect(state.version).toBe(versionBefore + 1)
  })

  it('updates existing entry', () => {
    useResolveStore.getState().set('ID_1', 'First Title', false)
    useResolveStore.getState().set('ID_1', 'Updated Title', true)

    const entry = useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, 'ID_1'))
    expect(entry).toEqual({ title: 'Updated Title', deleted: true })
  })

  // #1073 — `set` fires on tag rename/delete (TagList) and trash restore
  // (TrashView); an idempotent restore/rename re-writes the identical
  // `{ title, deleted }`. Mirror batchSet's #753 no-op guard: a no-change
  // call must NOT clone the Map or bump `version` (every version-subscribed
  // block row re-renders on a bump).
  it('skips the version bump AND the Map clone when the value is unchanged (#1073)', () => {
    useResolveStore.getState().set('ID_1', 'My Page', false)
    const versionBefore = useResolveStore.getState().version
    const cacheBefore = useResolveStore.getState().cache

    // Same id, same title, same deleted flag — a pure echo.
    useResolveStore.getState().set('ID_1', 'My Page', false)

    const state = useResolveStore.getState()
    expect(state.version).toBe(versionBefore)
    // Reference equality — no clone happened at all.
    expect(state.cache).toBe(cacheBefore)
  })

  it('bumps version when the title changes for an existing id (#1073)', () => {
    useResolveStore.getState().set('ID_1', 'My Page', false)
    const versionBefore = useResolveStore.getState().version

    useResolveStore.getState().set('ID_1', 'Renamed Page', false)

    const state = useResolveStore.getState()
    expect(state.version).toBe(versionBefore + 1)
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'ID_1'))).toEqual({
      title: 'Renamed Page',
      deleted: false,
    })
  })

  it('bumps version when only the deleted flag changes for an existing id (#1073)', () => {
    useResolveStore.getState().set('ID_1', 'My Page', false)
    const versionBefore = useResolveStore.getState().version

    useResolveStore.getState().set('ID_1', 'My Page', true)

    const state = useResolveStore.getState()
    expect(state.version).toBe(versionBefore + 1)
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'ID_1'))).toEqual({
      title: 'My Page',
      deleted: true,
    })
  })

  it('bumps version on the first write of an absent id (#1073)', () => {
    const versionBefore = useResolveStore.getState().version

    // Absent key — even though title/deleted happen to match the would-be
    // default, an absent entry must always be written and bump.
    useResolveStore.getState().set('NEW_ID', 'Fresh', false)

    const state = useResolveStore.getState()
    expect(state.version).toBe(versionBefore + 1)
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'NEW_ID'))).toEqual({
      title: 'Fresh',
      deleted: false,
    })
  })

  it('set and batchSet both bump version inline (FE-H-21 symmetric contract)', () => {
    // FE-H-21 — pin the symmetric inline-bump policy: each `set` and each
    // `batchSet` bumps `version` synchronously, on its own. No microtask
    // coalescing; no asymmetry between the single-entry and batch writers.
    const versionBefore = useResolveStore.getState().version

    useResolveStore.getState().set('A', 'Alpha', false)
    expect(useResolveStore.getState().version).toBe(versionBefore + 1)

    useResolveStore.getState().batchSet([
      { id: 'B', title: 'Beta', deleted: false },
      { id: 'C', title: 'Charlie', deleted: false },
    ])
    expect(useResolveStore.getState().version).toBe(versionBefore + 2)
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
    expect(cache.get(keyFor(TEST_SPACE_ID, 'A'))).toEqual({ title: 'Alpha', deleted: false })
    expect(cache.get(keyFor(TEST_SPACE_ID, 'B'))).toEqual({ title: 'Beta', deleted: false })
    expect(cache.get(keyFor(TEST_SPACE_ID, 'C'))).toEqual({ title: 'Charlie', deleted: true })
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

  // #753 — batchSet fires per picker keystroke with mostly already-cached
  // rows; a no-change call must NOT clone the Map or bump `version`
  // (every version-subscribed block row re-renders on a bump).
  it('skips the version bump AND the Map clone when nothing changed (#753)', () => {
    useResolveStore.getState().batchSet([
      { id: 'A', title: 'Alpha', deleted: false },
      { id: 'B', title: 'Beta', deleted: true },
    ])
    const versionBefore = useResolveStore.getState().version
    const cacheBefore = useResolveStore.getState().cache

    // Same ids, same titles, same deleted flags — a pure echo.
    useResolveStore.getState().batchSet([
      { id: 'A', title: 'Alpha', deleted: false },
      { id: 'B', title: 'Beta', deleted: true },
    ])

    const state = useResolveStore.getState()
    expect(state.version).toBe(versionBefore)
    // Reference equality — no clone happened at all.
    expect(state.cache).toBe(cacheBefore)
  })

  it('bumps version when at least one entry changed (#753)', () => {
    useResolveStore.getState().batchSet([
      { id: 'A', title: 'Alpha', deleted: false },
      { id: 'B', title: 'Beta', deleted: false },
    ])
    const versionBefore = useResolveStore.getState().version

    // One unchanged echo + one title change + one deleted-flag change.
    useResolveStore.getState().batchSet([
      { id: 'A', title: 'Alpha', deleted: false },
      { id: 'B', title: 'Beta Renamed', deleted: false },
      { id: 'C', title: 'Charlie', deleted: true },
    ])

    const state = useResolveStore.getState()
    expect(state.version).toBe(versionBefore + 1)
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'A'))).toEqual({ title: 'Alpha', deleted: false })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'B'))).toEqual({
      title: 'Beta Renamed',
      deleted: false,
    })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'C'))).toEqual({
      title: 'Charlie',
      deleted: true,
    })
  })

  it('a deleted-flag-only change is detected as a change (#753)', () => {
    useResolveStore.getState().batchSet([{ id: 'A', title: 'Alpha', deleted: false }])
    const versionBefore = useResolveStore.getState().version

    useResolveStore.getState().batchSet([{ id: 'A', title: 'Alpha', deleted: true }])

    const state = useResolveStore.getState()
    expect(state.version).toBe(versionBefore + 1)
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'A'))).toEqual({ title: 'Alpha', deleted: true })
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
// FEAT-3p7 — cross-space cache scoping
// ---------------------------------------------------------------------------
describe('FEAT-3p7 — cross-space cache scoping', () => {
  // Test 1 from the spec: Same ULID resolved against two different
  // spaces returns different cached values (cache is space-scoped).
  it('the same ULID can carry different titles in two different spaces', () => {
    // Write under SPACE_A
    useSpaceStore.setState({ currentSpaceId: TEST_SPACE_ID })
    useResolveStore.getState().set('SHARED_ULID', 'A-side title', false)

    // Switch active space and write a DIFFERENT title under the same ULID
    useSpaceStore.setState({ currentSpaceId: OTHER_SPACE_ID })
    useResolveStore.getState().set('SHARED_ULID', 'B-side title', false)

    const cache = useResolveStore.getState().cache
    expect(cache.get(keyFor(TEST_SPACE_ID, 'SHARED_ULID'))).toEqual({
      title: 'A-side title',
      deleted: false,
    })
    expect(cache.get(keyFor(OTHER_SPACE_ID, 'SHARED_ULID'))).toEqual({
      title: 'B-side title',
      deleted: false,
    })

    // resolveTitle picks the active-space entry, never the other space's
    expect(useResolveStore.getState().resolveTitle('SHARED_ULID')).toBe('B-side title')
    useSpaceStore.setState({ currentSpaceId: TEST_SPACE_ID })
    expect(useResolveStore.getState().resolveTitle('SHARED_ULID')).toBe('A-side title')
  })

  // Test 2 from the spec: clearAllForSpace(prevSpaceId) flushes ONLY
  // that space's entries — the other space's cache survives.
  it('clearAllForSpace flushes only the named space and leaves others intact', () => {
    // Pre-populate cache with entries from BOTH spaces. Use direct
    // setState to keep encoding under test (rather than relying on
    // `set` to round-trip through useSpaceStore).
    const cache = new Map<string, { title: string; deleted: boolean }>([
      [keyFor(TEST_SPACE_ID, 'A1'), { title: 'A page 1', deleted: false }],
      [keyFor(TEST_SPACE_ID, 'A2'), { title: 'A page 2', deleted: false }],
      [keyFor(OTHER_SPACE_ID, 'B1'), { title: 'B page 1', deleted: false }],
      [keyFor(OTHER_SPACE_ID, 'B2'), { title: 'B page 2', deleted: true }],
      [keyFor(GLOBAL_SPACE_ID, 'GLOBAL'), { title: 'global', deleted: false }],
    ])
    useResolveStore.setState({ cache, version: 1 })

    useResolveStore.getState().clearAllForSpace(TEST_SPACE_ID)

    const after = useResolveStore.getState().cache
    // SPACE_TEST entries gone
    expect(after.get(keyFor(TEST_SPACE_ID, 'A1'))).toBeUndefined()
    expect(after.get(keyFor(TEST_SPACE_ID, 'A2'))).toBeUndefined()
    // OTHER space and global entries survive
    expect(after.get(keyFor(OTHER_SPACE_ID, 'B1'))).toEqual({
      title: 'B page 1',
      deleted: false,
    })
    expect(after.get(keyFor(OTHER_SPACE_ID, 'B2'))).toEqual({
      title: 'B page 2',
      deleted: true,
    })
    expect(after.get(keyFor(GLOBAL_SPACE_ID, 'GLOBAL'))).toEqual({
      title: 'global',
      deleted: false,
    })
    // version bumped so memoised consumers recompute
    expect(useResolveStore.getState().version).toBe(2)
  })

  it('clearAllForSpace on a space with no entries is a no-op (still bumps version)', () => {
    const cache = new Map<string, { title: string; deleted: boolean }>([
      [keyFor(TEST_SPACE_ID, 'A1'), { title: 'A1', deleted: false }],
    ])
    useResolveStore.setState({ cache, version: 5 })

    useResolveStore.getState().clearAllForSpace('SPACE_NONEXISTENT')

    expect(useResolveStore.getState().cache.size).toBe(1)
    expect(useResolveStore.getState().version).toBe(6)
  })

  // Test 3 from the spec: Resolution from a foreign space falls
  // through to the broken-link fallback string. Belt-and-braces — the
  // chip render relies on `resolveStatus` returning 'active' on miss
  // (and BlockTree priming a deleted placeholder); but `resolveTitle`
  // unambiguously surfaces the fallback.
  it('foreign-space ULID resolves to the [[ULID-prefix...]] fallback (no cross-space leak)', () => {
    // Cache only contains an entry under SPACE_OTHER.
    useResolveStore.setState({
      cache: new Map([
        [keyFor(OTHER_SPACE_ID, 'FOREIGN_ULID'), { title: 'Foreign Page', deleted: false }],
      ]),
    })

    // Active space is SPACE_TEST — looking up FOREIGN_ULID must NOT
    // surface "Foreign Page".
    expect(useResolveStore.getState().resolveTitle('FOREIGN_ULID')).toBe('[[FOREIGN_...]]')
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
      cache.set(keyFor(TEST_SPACE_ID, `id-${i}`), { title: `T${i}`, deleted: false })
    }
    useResolveStore.setState({ cache })

    // Add one more entry — should trigger eviction
    useResolveStore.getState().set('new-id', 'Title', false)

    const state = useResolveStore.getState()
    expect(state.cache.size).toBe(10_000)
    // The first entry added should have been evicted
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'id-0'))).toBe(false)
    // The new entry should be present
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'new-id'))).toBe(true)
  })

  it('batchSet() evicts when batch pushes cache over limit', () => {
    // Pre-fill cache to 9,998 entries
    const cache = new Map<string, { title: string; deleted: boolean }>()
    for (let i = 0; i < 9_998; i++) {
      cache.set(keyFor(TEST_SPACE_ID, `id-${i}`), { title: `T${i}`, deleted: false })
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
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'id-0'))).toBe(false)
    // All new entries should be present
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'a'))).toBe(true)
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'b'))).toBe(true)
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'c'))).toBe(true)
  })

  it('set() and batchSet() share the same eviction policy (FE-L-2)', () => {
    // Pin the eviction-from-both-writers invariant: flooding past
    // MAX_CACHE_SIZE via either writer must evict the oldest entries
    // in identical insertion order, with the cache capped at the limit.
    const cache = new Map<string, { title: string; deleted: boolean }>()
    for (let i = 0; i < 10_000; i++) {
      cache.set(keyFor(TEST_SPACE_ID, `id-${i}`), { title: `T${i}`, deleted: false })
    }
    useResolveStore.setState({ cache })

    // Flood via set() — 5 new entries push the cache 5 over MAX_CACHE_SIZE,
    // so the 5 oldest (id-0..id-4) must be evicted.
    for (let i = 0; i < 5; i++) {
      useResolveStore.getState().set(`set-${i}`, `S${i}`, false)
    }
    let state = useResolveStore.getState()
    expect(state.cache.size).toBe(10_000)
    for (let i = 0; i < 5; i++) {
      expect(state.cache.has(keyFor(TEST_SPACE_ID, `id-${i}`))).toBe(false)
    }
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'id-5'))).toBe(true)

    // Flood via batchSet() — 5 more entries evict the next 5 oldest
    // survivors (id-5..id-9).
    useResolveStore
      .getState()
      .batchSet(
        Array.from({ length: 5 }, (_, i) => ({ id: `batch-${i}`, title: `B${i}`, deleted: false })),
      )
    state = useResolveStore.getState()
    expect(state.cache.size).toBe(10_000)
    for (let i = 5; i < 10; i++) {
      expect(state.cache.has(keyFor(TEST_SPACE_ID, `id-${i}`))).toBe(false)
    }
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'id-10'))).toBe(true)
    // Both writers' inserts survive.
    for (let i = 0; i < 5; i++) {
      expect(state.cache.has(keyFor(TEST_SPACE_ID, `set-${i}`))).toBe(true)
      expect(state.cache.has(keyFor(TEST_SPACE_ID, `batch-${i}`))).toBe(true)
    }
  })
})
