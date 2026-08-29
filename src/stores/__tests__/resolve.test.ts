/**
 * Tests for the resolve store — preload, set, batchSet, resolveTitle, resolveStatus.
 *
 * Covers the global resolve cache that maps block/tag ULIDs to display titles.
 * The preload function calls listBlocks and listAllTagsInSpace (#1343) (which wrap invoke).
 *
 * # Cache key encoding (cross-space link enforcement)
 *
 * The cache `Map` is keyed by `${spaceId}::${ulid}`. Tests fix
 * `useSpaceStore.currentSpaceId = TEST_SPACE_ID` in `beforeEach` so every
 * `set` / `batchSet` / lookup uses the same prefix; tests that explicitly
 * exercise multi-space behaviour switch the active space via
 * `useSpaceStore.setState({ currentSpaceId: ... })` before reading.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from '@/lib/logger'
import { GLOBAL_SPACE_ID, keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

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
  // Pin the active space so composite-key encoding is
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
      // #2277 item 7 — list_blocks params (including `cursor`) now nest under
      // the single `request` DTO; `scope` stays a separate top-level arg.
      const req = (params?.['request'] as Record<string, unknown> | undefined) ?? params
      if (cmd === 'list_blocks') {
        if (!req?.['cursor']) {
          // First page
          return { items: [mockPages[0]], next_cursor: 'cursor_1', has_more: true }
        }
        // Second page
        return { items: [mockPages[1]], next_cursor: null, has_more: false }
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
      resolved: true,
    })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'PAGE_2'))).toEqual({
      title: 'Page Two',
      deleted: false,
      resolved: true,
    })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'TAG_1'))).toEqual({
      title: 'tag-one',
      deleted: false,
      resolved: true,
    })
    expect(state._preloaded).toBe(true)
    // Should have called list_blocks twice (pagination)
    const listBlocksCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
    expect(listBlocksCalls).toHaveLength(2)
    // ListBlocks call must forward the active-space scope (#2248) so the
    // backend filters out other-space pages.
    const firstListBlocksArgs = listBlocksCalls[0]?.[1] as Record<string, unknown> | undefined
    expect(firstListBlocksArgs?.['scope']).toEqual({ kind: 'active', space_id: TEST_SPACE_ID })
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
      resolved: true,
    })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'TAG_200'))).toEqual({
      title: 'tag-200',
      deleted: false,
      resolved: true,
    })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'TAG_249'))).toEqual({
      title: 'tag-249',
      deleted: false,
      resolved: true,
    })
    // The space-scoped IPC must be forwarded the active spaceId.
    const tagCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_all_tags_in_space')
    expect(tagCalls).toHaveLength(1)
    // b1 — `list_all_tags_in_space` now takes `scope: SpaceScope`.
    expect((tagCalls[0]?.[1] as Record<string, unknown> | undefined)?.['scope']).toEqual({
      kind: 'active',
      space_id: TEST_SPACE_ID,
    })
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
    expect(entry).toEqual({ title: 'Untitled', deleted: false, resolved: true })
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
    expect(entry).toEqual({ title: 'Deleted Page', deleted: true, resolved: true })
  })

  it('does not set _preloaded on error so retry is possible', async () => {
    mockedInvoke.mockRejectedValue(new Error('network failure'))

    await useResolveStore.getState().preload(TEST_SPACE_ID)

    const state = useResolveStore.getState()
    expect(state._preloaded).toBe(false)
    expect(state.cache.size).toBe(0)
  })

  it('logs a warning when listBlocks rejects', async () => {
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

  it('logs a warning when listAllTagsInSpace rejects', async () => {
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

  it('bumps version when the scan actually changes something', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks')
        return {
          items: [{ id: 'PAGE_1', content: 'Page One', deleted_at: null }],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    const versionBefore = useResolveStore.getState().version
    await useResolveStore.getState().preload(TEST_SPACE_ID)
    const versionAfter = useResolveStore.getState().version

    expect(versionAfter).toBe(versionBefore + 1)
  })

  // #3321 — the bulk writer must diff like its two siblings (`set`'s #1073
  // guard, `batchSet`'s #753 guard). `reloadChangedPageStores` fires
  // `preload(spaceId, true)` on EVERY `sync:complete` with `ops_received > 0`
  // and every MCP `blocks:changed`; a remote edit to a block's CONTENT cannot
  // change a page title or a tag name, so the rescan re-fetches identical
  // rows. `version` is a load-bearing `useMemo` dep in `useRichContent` /
  // `BlockListItem`, so an unconditional bump re-parsed markdown for every
  // mounted row for zero gain.
  it('does not bump version when every fetched row already matches the cache', async () => {
    const mockPages = [
      { id: 'PAGE_1', content: 'Page One', deleted_at: null },
      { id: 'PAGE_2', content: 'Page Two', deleted_at: null },
    ]
    const mockTags = [
      { tag_id: 'TAG_1', name: 'tag-one', usage_count: 5, updated_at: '2025-01-01' },
    ]
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_all_tags_in_space') return mockTags
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID)
    const versionAfterFirst = useResolveStore.getState().version
    expect(versionAfterFirst).toBe(1)

    // A version-subscribed consumer (BlockListItem / useRichContent) counts
    // its re-render triggers across the second, content-only sync tick.
    let versionNotifications = 0
    const unsubscribe = useResolveStore.subscribe((state, prev) => {
      if (state.version !== prev.version) versionNotifications++
    })
    await useResolveStore.getState().preload(TEST_SPACE_ID, true)
    unsubscribe()

    expect(useResolveStore.getState().version).toBe(versionAfterFirst)
    expect(versionNotifications).toBe(0)
    // The cache is still correct — the no-op merge did not drop anything.
    expect(useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, 'PAGE_2'))).toEqual({
      title: 'Page Two',
      deleted: false,
      resolved: true,
    })
  })

  it('bumps version once when a single fetched row changed', async () => {
    let title = 'Page One'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks')
        return {
          items: [
            { id: 'PAGE_1', content: title, deleted_at: null },
            { id: 'PAGE_2', content: 'Page Two', deleted_at: null },
          ],
          next_cursor: null,
          has_more: false,
        }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID)
    const versionAfterFirst = useResolveStore.getState().version

    title = 'Page One Renamed'
    await useResolveStore.getState().preload(TEST_SPACE_ID, true)

    expect(useResolveStore.getState().version).toBe(versionAfterFirst + 1)
    expect(useResolveStore.getState().resolveTitle('PAGE_1')).toBe('Page One Renamed')
  })

  it('marks _preloaded even when an empty space fetches nothing', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: [], next_cursor: null, has_more: false }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID)

    expect(useResolveStore.getState()._preloaded).toBe(true)
    expect(useResolveStore.getState().version).toBe(0)
  })

  // Perf (#2267) — preload's merge must mutate the existing cache Map in
  // place (`cache.set` per fetched entry) rather than spreading it into a
  // fresh Map on every sync:complete. Consumers re-render off `version`,
  // not the Map reference, so the Map object should stay the same across
  // preload while still bumping version, merging fetched data in, and
  // preserving pre-existing entries that preload didn't touch.
  it('mutates the cache Map in place (same reference) rather than cloning it', async () => {
    useResolveStore.getState().set('PRE_EXISTING', 'Pre-existing Page', false)
    const cacheBefore = useResolveStore.getState().cache
    const versionBefore = useResolveStore.getState().version

    const mockPages = [{ id: 'PAGE_1', content: 'Page One', deleted_at: null }]
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockPages, next_cursor: null, has_more: false }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID)

    const state = useResolveStore.getState()
    expect(state.cache).toBe(cacheBefore)
    expect(state.version).toBe(versionBefore + 1)
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'PAGE_1'))).toEqual({
      title: 'Page One',
      deleted: false,
      resolved: true,
    })
    // Pre-existing entry (not returned by this fetch) survives the merge.
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'PRE_EXISTING'))).toEqual({
      title: 'Pre-existing Page',
      deleted: false,
      resolved: true,
    })
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
      resolved: true,
    })
    // Other fetched entries should still be present
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'PAGE_1'))).toEqual({
      title: 'Page One',
      deleted: false,
      resolved: true,
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
      resolved: true,
    })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'CREATED_DURING'))).toEqual({
      title: 'New Page',
      deleted: false,
      resolved: true,
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
      resolved: true,
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
      resolved: true,
    })
  })

  it('fresh data overwrites stale cache on non-force-refresh preload', async () => {
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
      resolved: true,
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
      resolved: true,
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
      resolved: true,
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
// preload — targeted rescan (#3321)
// ---------------------------------------------------------------------------
//
// `reloadChangedPageStores` already computes the owning-page id set an inbound
// sync / MCP write touched, uses it to target the page-store reloads, and used
// to throw it away before calling `preload`. The scan then paginated the WHOLE
// space (`LIST_BLOCKS_MAX = 100` per round-trip, so 30 sequential round-trips
// in a 3,000-page vault) on every `sync:complete` with `ops_received > 0` —
// roughly every 3 s while a peer types.
//
// The page half of the scan now collapses to ONE `batch_resolve` when the set
// is present. The TAG half deliberately does not: tags carry no changed-id
// signal, so skipping them would leave a remotely-renamed tag rendering its old
// name until the next space switch. That trade was the reason this half of
// #3321 was held back, and the tag test below is what pins it.
describe('preload targeted rescan (#3321)', () => {
  const PAGE_SIZE = 100

  function countCalls(cmd: string): number {
    return mockedInvoke.mock.calls.filter(([c]) => c === cmd).length
  }

  /**
   * Install a backend mock for a space of `pageCount` pages plus `tags`, wired
   * so the full walk (`list_blocks`), the targeted half (`batch_resolve`) and
   * the tag fetch all read the SAME mutable source of truth. A remote rename is
   * therefore visible to whichever half of the scan actually runs, which is what
   * makes "the targeted path still sees real changes" a meaningful assertion.
   *
   * `missing` models an id the backend does not return (purged, or moved to
   * another space) — `batch_resolve` drops it exactly as the space-scoped
   * `list_blocks` walk would.
   */
  function installSpaceMock(pageCount: number, tags: Array<{ tag_id: string; name: string }> = []) {
    const titles = new Map<string, string | null>()
    const deleted = new Set<string>()
    const missing = new Set<string>()
    const tagRows = tags.map((t) => ({ ...t, usage_count: 1, updated_at: '2025-01-01' }))
    for (let i = 0; i < pageCount; i++) titles.set(`PAGE_${i}`, `Page ${i}`)

    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      const params = args as Record<string, unknown> | undefined
      // #2277 item 7 — list_blocks params nest under the `request` DTO.
      const req = (params?.['request'] as Record<string, unknown> | undefined) ?? params
      if (cmd === 'list_blocks') {
        // The real `pagination::list_by_type` (hierarchy.rs:112) filters `deleted_at IS NULL`
        // (`src-tauri/agaric-store/src/pagination/hierarchy.rs`), so the full
        // walk can never observe a soft-deleted page — only the targeted
        // `batch_resolve` half can (it applies no `deleted_at` predicate).
        // Mirror that here, or the soft-delete assertion below would pass on
        // either arm and stop distinguishing them.
        const ids = [...titles.keys()].filter((id) => !missing.has(id) && !deleted.has(id))
        const offset = Number(req?.['cursor'] ?? 0)
        const next = offset + PAGE_SIZE
        return {
          items: ids.slice(offset, next).map((id) => ({
            id,
            content: titles.get(id) ?? null,
            deleted_at: null,
          })),
          next_cursor: next < ids.length ? String(next) : null,
          has_more: next < ids.length,
        }
      }
      if (cmd === 'batch_resolve') {
        const ids = (params?.['ids'] as string[] | undefined) ?? []
        return ids
          .filter((id) => titles.has(id) && !missing.has(id))
          .map((id) => ({
            id,
            title: titles.get(id) ?? null,
            block_type: 'page',
            deleted: deleted.has(id),
          }))
      }
      if (cmd === 'list_all_tags_in_space') return tagRows
      return null
    })

    return { titles, deleted, missing, tagRows }
  }

  it('collapses a 3,000-page walk into ONE batch_resolve round-trip', async () => {
    const PAGE_COUNT = 3000
    installSpaceMock(PAGE_COUNT)

    // The boot scan — and, before this change, EVERY sync tick — paginates the
    // whole space: 3,000 / 100 = 30 sequential `list_blocks` round-trips.
    await useResolveStore.getState().preload(TEST_SPACE_ID)
    expect(countCalls('list_blocks')).toBe(PAGE_COUNT / PAGE_SIZE)
    expect(countCalls('list_all_tags_in_space')).toBe(1)
    expect(useResolveStore.getState().cache.size).toBe(PAGE_COUNT)

    // The sync tick: one page changed, so exactly one page is re-resolved.
    mockedInvoke.mockClear()
    await useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_7']))

    expect(countCalls('list_blocks')).toBe(0)
    expect(countCalls('batch_resolve')).toBe(1)
    // The tag half is unconditional — see the tag test below.
    expect(countCalls('list_all_tags_in_space')).toBe(1)
  })

  it('applies a remote rename of a targeted page (version bumps)', async () => {
    const { titles } = installSpaceMock(3)
    await useResolveStore.getState().preload(TEST_SPACE_ID)
    const versionAfterBoot = useResolveStore.getState().version

    titles.set('PAGE_1', 'Renamed by peer')
    await useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_1']))

    expect(useResolveStore.getState().resolveTitle('PAGE_1')).toBe('Renamed by peer')
    expect(useResolveStore.getState().version).toBe(versionAfterBoot + 1)
  })

  it('applies a remote soft-delete of a targeted page', async () => {
    const { deleted } = installSpaceMock(3)
    await useResolveStore.getState().preload(TEST_SPACE_ID)
    expect(useResolveStore.getState().resolveStatus('PAGE_1')).toBe('active')

    deleted.add('PAGE_1')
    await useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_1']))

    expect(useResolveStore.getState().resolveStatus('PAGE_1')).toBe('deleted')
  })

  it('does not bump version when the targeted page is unchanged', async () => {
    installSpaceMock(3)
    await useResolveStore.getState().preload(TEST_SPACE_ID)
    const versionAfterBoot = useResolveStore.getState().version

    let versionNotifications = 0
    const unsubscribe = useResolveStore.subscribe((state, prev) => {
      if (state.version !== prev.version) versionNotifications++
    })
    await useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_1']))
    unsubscribe()

    expect(versionNotifications).toBe(0)
    expect(useResolveStore.getState().version).toBe(versionAfterBoot)
    expect(useResolveStore.getState().resolveTitle('PAGE_1')).toBe('Page 1')
  })

  it('still refreshes tags on a targeted rescan (tags have no changed-id signal)', async () => {
    const { tagRows } = installSpaceMock(3, [{ tag_id: 'TAG_1', name: 'tag-one' }])
    await useResolveStore.getState().preload(TEST_SPACE_ID)
    const versionAfterBoot = useResolveStore.getState().version

    // A peer renames the tag. No page changed except the one carrying the op,
    // and the tag id is NOT in `changed_page_ids` — the exact case that made
    // skipping the tag half a correctness regression.
    const firstTag = tagRows[0]
    if (firstTag) firstTag.name = 'tag-one-renamed'
    await useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_1']))

    expect(countCalls('list_all_tags_in_space')).toBe(2)
    expect(useResolveStore.getState().resolveTitle('TAG_1')).toBe('tag-one-renamed')
    expect(useResolveStore.getState().version).toBe(versionAfterBoot + 1)
  })

  it('falls back to the full walk when the changed set is empty', async () => {
    installSpaceMock(3)
    await useResolveStore.getState().preload(TEST_SPACE_ID)
    mockedInvoke.mockClear()

    await useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set())

    expect(countCalls('list_blocks')).toBe(1)
    expect(countCalls('batch_resolve')).toBe(0)
  })

  it('targets at the batch cap and falls back to the full walk past it', async () => {
    installSpaceMock(3)
    await useResolveStore.getState().preload(TEST_SPACE_ID)

    // Exactly `TARGETED_PRELOAD_MAX_IDS` (1000) — still one batch_resolve.
    mockedInvoke.mockClear()
    const atCap = new Set(Array.from({ length: 1000 }, (_, i) => `PAGE_${i}`))
    await useResolveStore.getState().preload(TEST_SPACE_ID, true, atCap)
    expect(countCalls('batch_resolve')).toBe(1)
    expect(countCalls('list_blocks')).toBe(0)

    // One past the cap — `batch_resolve` would reject, so walk instead.
    mockedInvoke.mockClear()
    const pastCap = new Set(Array.from({ length: 1001 }, (_, i) => `PAGE_${i}`))
    await useResolveStore.getState().preload(TEST_SPACE_ID, true, pastCap)
    expect(countCalls('batch_resolve')).toBe(0)
    expect(countCalls('list_blocks')).toBe(1)
  })

  it('leaves a cached entry untouched when the backend returns no row for it', async () => {
    const { missing } = installSpaceMock(3)
    await useResolveStore.getState().preload(TEST_SPACE_ID)
    const versionAfterBoot = useResolveStore.getState().version

    // Purged, or moved to another space: `batch_resolve` drops the id.
    missing.add('PAGE_1')
    await useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_1']))

    // Merge-only semantics, identical to the full walk: the stale entry stays
    // rather than being wiped, and nothing re-renders.
    expect(useResolveStore.getState().resolveTitle('PAGE_1')).toBe('Page 1')
    expect(useResolveStore.getState().version).toBe(versionAfterBoot)
  })

  it('does not mark _preloaded — a targeted rescan is not a full preload', async () => {
    const { titles } = installSpaceMock(3)

    titles.set('PAGE_1', 'Changed so the commit path runs')
    await useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_1']))
    expect(useResolveStore.getState().version).toBe(1)
    expect(useResolveStore.getState()._preloaded).toBe(false)

    await useResolveStore.getState().preload(TEST_SPACE_ID)
    expect(useResolveStore.getState()._preloaded).toBe(true)
  })

  it('leaves _preloaded false when a targeted rescan fetches nothing at all', async () => {
    installSpaceMock(3)

    // The backend returns no row for the id (purged / moved), so nothing
    // merges and the scan takes the "unmutated" early return. THAT arm must
    // not claim `_preloaded` either — it is still not a full scan.
    await useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['GONE']))

    expect(useResolveStore.getState()._preloaded).toBe(false)
    expect(useResolveStore.getState().version).toBe(0)
  })

  // A scan that THREW consumed its scope without applying it. A full walk
  // self-heals — the next one re-reads the whole space — but a targeted scan's
  // ids are the only thing that would ever have re-resolved those pages, since
  // the next tick carries the NEXT write's ids. Without an escalation, one
  // transient `batch_resolve` failure leaves a peer-renamed page rendering its
  // old title until a space switch.
  it('escalates a FAILED targeted rescan to the full walk', async () => {
    installSpaceMock(3)
    await useResolveStore.getState().preload(TEST_SPACE_ID)
    mockedInvoke.mockClear()

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'batch_resolve') throw new Error('transport failure')
      if (cmd === 'list_blocks')
        return {
          items: [{ id: 'PAGE_1', content: 'Renamed by peer', deleted_at: null }],
          next_cursor: null,
          has_more: false,
        }
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_1']))

    expect(countCalls('batch_resolve')).toBe(1)
    expect(countCalls('list_blocks')).toBe(1)
    expect(useResolveStore.getState().resolveTitle('PAGE_1')).toBe('Renamed by peer')
  })

  // The escalation above is for the PAGE half. A tag failure must not trigger
  // it: escalating re-runs the same failing tag IPC inside a 30-round-trip
  // walk, so the "cheap targeted rescan" becomes ~33 IPCs — worse than the 31
  // this whole change exists to replace.
  it('does not escalate to a full walk when only the TAG half fails', async () => {
    installSpaceMock(3)
    await useResolveStore.getState().preload(TEST_SPACE_ID)
    mockedInvoke.mockClear()

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'batch_resolve')
        return [{ id: 'PAGE_1', title: 'Renamed by peer', deleted: false }]
      if (cmd === 'list_all_tags_in_space') throw new Error('tag transport failure')
      if (cmd === 'list_blocks') return { items: [], next_cursor: null, has_more: false }
      return null
    })

    await useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_1']))

    expect(countCalls('batch_resolve')).toBe(1)
    // The escalation would show up here as a `list_blocks` walk.
    expect(countCalls('list_blocks')).toBe(0)
    // The page result is deliberately NOT applied: a tag failure still aborts
    // the whole scan and leaves the cache untouched, which is the pre-existing
    // contract (`logs a warning when listAllTagsInSpace rejects` pins it, and
    // the next unconditional tick re-fetches both halves). Only the ESCALATION
    // decision was made half-aware — asserting the stale title here keeps this
    // test honest about what did and did not change.
    expect(useResolveStore.getState().resolveTitle('PAGE_1')).toBe('Page 1')
  })

  it('does not re-escalate a FAILED full walk — the retry chain is bounded', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'batch_resolve' || cmd === 'list_blocks') throw new Error('transport failure')
      if (cmd === 'list_all_tags_in_space') return []
      return null
    })

    // targeted (fails) → ONE full walk (fails) → stop. A test timeout here
    // means the escalation loops forever against a down backend.
    await useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_1']))

    expect(countCalls('batch_resolve')).toBe(1)
    expect(countCalls('list_blocks')).toBe(1)
  })

  // The coalescing hazard this change introduces: #753 collapses every caller
  // arriving mid-scan into ONE trailing re-scan. With every scan full that was
  // lossless. With targeted scans, a joiner's ids must survive into that
  // trailing scan or its page renders a stale title until the next space
  // switch. The three tests below pin the widening rule.
  describe('mid-scan coalescing keeps every joiner’s scope', () => {
    /** Make `batch_resolve` deferrable; records the ids of each call. */
    function deferBatchResolve() {
      const deferred: Array<(v: unknown) => void> = []
      const batchIds: string[][] = []
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const params = args as Record<string, unknown> | undefined
        if (cmd === 'batch_resolve') {
          batchIds.push((params?.['ids'] as string[] | undefined) ?? [])
          return new Promise((resolve) => deferred.push(resolve))
        }
        if (cmd === 'list_blocks') return { items: [], next_cursor: null, has_more: false }
        if (cmd === 'list_all_tags_in_space') return []
        return null
      })
      return { deferred, batchIds }
    }

    it('unions two mid-scan targeted callers into one trailing rescan', async () => {
      const { deferred, batchIds } = deferBatchResolve()

      const p1 = useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_0']))
      const p2 = useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_1']))
      const p3 = useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_2']))

      await vi.waitFor(() => expect(deferred).toHaveLength(1))
      deferred[0]?.([])
      await vi.waitFor(() => expect(deferred).toHaveLength(2))
      deferred[1]?.([
        { id: 'PAGE_1', title: 'One renamed', block_type: 'page', deleted: false },
        { id: 'PAGE_2', title: 'Two renamed', block_type: 'page', deleted: false },
      ])
      await Promise.all([p1, p2, p3])

      expect(batchIds).toHaveLength(2)
      expect(batchIds[0]).toEqual(['PAGE_0'])
      expect((batchIds[1] ?? []).toSorted()).toEqual(['PAGE_1', 'PAGE_2'])
      expect(useResolveStore.getState().resolveTitle('PAGE_1')).toBe('One renamed')
      expect(useResolveStore.getState().resolveTitle('PAGE_2')).toBe('Two renamed')
    })

    it('a mid-scan force caller with no set upgrades the trailing rescan to a full walk', async () => {
      const { deferred, batchIds } = deferBatchResolve()

      const p1 = useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_0']))
      const p2 = useResolveStore.getState().preload(TEST_SPACE_ID, true)

      await vi.waitFor(() => expect(deferred).toHaveLength(1))
      deferred[0]?.([])
      await vi.waitFor(() => expect(countCalls('list_blocks')).toBe(1))
      await Promise.all([p1, p2])

      expect(batchIds).toHaveLength(1)
    })

    it('a full-scan demand arriving AFTER a targeted one still wins', async () => {
      const { deferred, batchIds } = deferBatchResolve()

      // Leading scan targeted; then a targeted joiner (so the trailing scan is
      // already a Set), then a force caller with no set. The trailing scan must
      // widen to the full walk rather than keep the accumulated Set.
      const p1 = useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_0']))
      const p2 = useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_1']))
      const p3 = useResolveStore.getState().preload(TEST_SPACE_ID, true)

      await vi.waitFor(() => expect(deferred).toHaveLength(1))
      deferred[0]?.([])
      // Assert on the trailing scan's IPC as soon as it starts: a targeted
      // trailing scan would call the (deferred) `batch_resolve` instead and
      // never reach `list_blocks`.
      await vi.waitFor(() => expect(countCalls('list_blocks')).toBe(1))
      await Promise.all([p1, p2, p3])

      expect(batchIds).toHaveLength(1)
    })

    it('a targeted demand arriving AFTER a full one does not narrow it back', async () => {
      const { deferred, batchIds } = deferBatchResolve()

      const p1 = useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_0']))
      const p2 = useResolveStore.getState().preload(TEST_SPACE_ID, true)
      const p3 = useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_1']))

      await vi.waitFor(() => expect(deferred).toHaveLength(1))
      deferred[0]?.([])
      // Still exactly one targeted call (the leading one) and a full trailing
      // walk — the late targeted set must not downgrade the pending full scan.
      await vi.waitFor(() => expect(countCalls('list_blocks')).toBe(1))
      await Promise.all([p1, p2, p3])

      expect(batchIds).toHaveLength(1)
    })

    it('a mid-scan plain caller (boot / space switch) upgrades it to a full walk too', async () => {
      const { deferred, batchIds } = deferBatchResolve()

      const p1 = useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_0']))
      const p2 = useResolveStore.getState().preload(TEST_SPACE_ID)

      await vi.waitFor(() => expect(deferred).toHaveLength(1))
      deferred[0]?.([])
      await vi.waitFor(() => expect(countCalls('list_blocks')).toBe(1))
      await Promise.all([p1, p2])

      expect(batchIds).toHaveLength(1)
      expect(useResolveStore.getState()._preloaded).toBe(true)
    })

    it('a plain caller joining a TARGETED trailing scan still gets a full walk', async () => {
      // The leading scan here is FULL, so the only thing that can flip the
      // entry back to "currently targeted" is the TRAILING scan. A plain caller
      // (boot / space switch, right after `clearAllForSpace` flushed this
      // space) arriving while that trailing targeted scan runs must still be
      // served a full walk — otherwise it resolves against a cache holding
      // nothing but the handful of targeted ids and every other chip in the
      // space renders `[[ULID]]`.
      const listDeferred: Array<(v: unknown) => void> = []
      const batchDeferred: Array<(v: unknown) => void> = []
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_blocks') return new Promise((resolve) => listDeferred.push(resolve))
        if (cmd === 'batch_resolve') return new Promise((resolve) => batchDeferred.push(resolve))
        if (cmd === 'list_all_tags_in_space') return []
        return null
      })

      const p1 = useResolveStore.getState().preload(TEST_SPACE_ID)
      const p2 = useResolveStore.getState().preload(TEST_SPACE_ID, true, new Set(['PAGE_0']))

      await vi.waitFor(() => expect(listDeferred).toHaveLength(1))
      listDeferred[0]?.({ items: [], next_cursor: null, has_more: false })
      // Trailing scan is now targeted.
      await vi.waitFor(() => expect(batchDeferred).toHaveLength(1))

      const p3 = useResolveStore.getState().preload(TEST_SPACE_ID)
      batchDeferred[0]?.([])
      await vi.waitFor(() => expect(listDeferred).toHaveLength(2))
      listDeferred[1]?.({ items: [], next_cursor: null, has_more: false })
      await Promise.all([p1, p2, p3])

      expect(countCalls('list_blocks')).toBe(2)
      expect(countCalls('batch_resolve')).toBe(1)
    })
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
      resolved: true,
    })
    // FE-H-21 — `set` bumps `version` synchronously (no microtask wait).
    expect(state.version).toBe(versionBefore + 1)
  })

  it('updates existing entry', () => {
    useResolveStore.getState().set('ID_1', 'First Title', false)
    useResolveStore.getState().set('ID_1', 'Updated Title', true)

    const entry = useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, 'ID_1'))
    expect(entry).toEqual({ title: 'Updated Title', deleted: true, resolved: true })
  })

  // Perf (#2267) — set() must mutate the cache Map in place (write the
  // changed key + evict) rather than cloning the whole Map on every write.
  // Consumers re-render off `version`, not the Map reference, so a real
  // (non-no-op) write should keep the SAME Map object while still bumping
  // version and remaining readable.
  it('mutates the cache Map in place (same reference) on a real write, bumping version', () => {
    useResolveStore.getState().set('ID_1', 'First Title', false)
    const cacheBefore = useResolveStore.getState().cache
    const versionBefore = useResolveStore.getState().version

    useResolveStore.getState().set('ID_1', 'Second Title', true)

    const state = useResolveStore.getState()
    expect(state.cache).toBe(cacheBefore)
    expect(state.version).toBe(versionBefore + 1)
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'ID_1'))).toEqual({
      title: 'Second Title',
      deleted: true,
      resolved: true,
    })
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
      resolved: true,
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
      resolved: true,
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
      resolved: true,
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
    expect(cache.get(keyFor(TEST_SPACE_ID, 'A'))).toEqual({
      title: 'Alpha',
      deleted: false,
      resolved: true,
    })
    expect(cache.get(keyFor(TEST_SPACE_ID, 'B'))).toEqual({
      title: 'Beta',
      deleted: false,
      resolved: true,
    })
    expect(cache.get(keyFor(TEST_SPACE_ID, 'C'))).toEqual({
      title: 'Charlie',
      deleted: true,
      resolved: true,
    })
  })

  // Perf (#2267) — batchSet() must mutate the cache Map in place (write
  // only the changed subset + evict) rather than cloning the whole Map.
  // A real (non-no-op) batch write should keep the SAME Map object while
  // still bumping version and remaining readable.
  it('mutates the cache Map in place (same reference) on a real batch write, bumping version', () => {
    useResolveStore.getState().batchSet([{ id: 'A', title: 'Alpha', deleted: false }])
    const cacheBefore = useResolveStore.getState().cache
    const versionBefore = useResolveStore.getState().version

    useResolveStore.getState().batchSet([
      { id: 'A', title: 'Alpha Renamed', deleted: false },
      { id: 'D', title: 'Delta', deleted: false },
    ])

    const state = useResolveStore.getState()
    expect(state.cache).toBe(cacheBefore)
    expect(state.version).toBe(versionBefore + 1)
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'A'))).toEqual({
      title: 'Alpha Renamed',
      deleted: false,
      resolved: true,
    })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'D'))).toEqual({
      title: 'Delta',
      deleted: false,
      resolved: true,
    })
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
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'A'))).toEqual({
      title: 'Alpha',
      deleted: false,
      resolved: true,
    })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'B'))).toEqual({
      title: 'Beta Renamed',
      deleted: false,
      resolved: true,
    })
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'C'))).toEqual({
      title: 'Charlie',
      deleted: true,
      resolved: true,
    })
  })

  it('a deleted-flag-only change is detected as a change (#753)', () => {
    useResolveStore.getState().batchSet([{ id: 'A', title: 'Alpha', deleted: false }])
    const versionBefore = useResolveStore.getState().version

    useResolveStore.getState().batchSet([{ id: 'A', title: 'Alpha', deleted: true }])

    const state = useResolveStore.getState()
    expect(state.version).toBe(versionBefore + 1)
    expect(state.cache.get(keyFor(TEST_SPACE_ID, 'A'))).toEqual({
      title: 'Alpha',
      deleted: true,
      resolved: true,
    })
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
// has
// ---------------------------------------------------------------------------
describe('has', () => {
  it('returns true only for a real cached entry under the active space', () => {
    useResolveStore.getState().set('ID_KNOWN', 'Known Page', false)

    expect(useResolveStore.getState().has('ID_KNOWN')).toBe(true)
    // Unknown id — `resolveTitle` would return the `[[…]]` fallback, but `has`
    // reports the entry is absent so a delegating consumer can apply its OWN
    // fallback without writing a placeholder back.
    expect(useResolveStore.getState().has('ID_UNKNOWN')).toBe(false)
  })

  it('is space-scoped — an entry from another space is not visible', () => {
    // Cache only holds an entry under OTHER_SPACE_ID.
    useResolveStore.setState({
      cache: new Map([
        [keyFor(OTHER_SPACE_ID, 'FOREIGN'), { title: 'Foreign', deleted: false, resolved: true }],
      ]),
    })

    // Active space is TEST_SPACE_ID (beforeEach) — the foreign entry is hidden.
    expect(useResolveStore.getState().has('FOREIGN')).toBe(false)

    useSpaceStore.setState({ currentSpaceId: OTHER_SPACE_ID })
    expect(useResolveStore.getState().has('FOREIGN')).toBe(true)
  })

  it('does not bump version or touch LRU order (pure probe)', () => {
    useResolveStore.getState().set('ID_HOT', 'Hot Page', false)
    const versionBefore = useResolveStore.getState().version
    const cacheBefore = useResolveStore.getState().cache

    useResolveStore.getState().has('ID_HOT')

    expect(useResolveStore.getState().version).toBe(versionBefore)
    expect(useResolveStore.getState().cache).toBe(cacheBefore)
  })
})

// ---------------------------------------------------------------------------
// Cross-space cache scoping
// ---------------------------------------------------------------------------
describe('cross-space cache scoping', () => {
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
      resolved: true,
    })
    expect(cache.get(keyFor(OTHER_SPACE_ID, 'SHARED_ULID'))).toEqual({
      title: 'B-side title',
      deleted: false,
      resolved: true,
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
    const cache = new Map<string, { title: string; deleted: boolean; resolved: boolean }>([
      [keyFor(TEST_SPACE_ID, 'A1'), { title: 'A page 1', deleted: false, resolved: true }],
      [keyFor(TEST_SPACE_ID, 'A2'), { title: 'A page 2', deleted: false, resolved: true }],
      [keyFor(OTHER_SPACE_ID, 'B1'), { title: 'B page 1', deleted: false, resolved: true }],
      [keyFor(OTHER_SPACE_ID, 'B2'), { title: 'B page 2', deleted: true, resolved: true }],
      [keyFor(GLOBAL_SPACE_ID, 'GLOBAL'), { title: 'global', deleted: false, resolved: true }],
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
      resolved: true,
    })
    expect(after.get(keyFor(OTHER_SPACE_ID, 'B2'))).toEqual({
      title: 'B page 2',
      deleted: true,
      resolved: true,
    })
    expect(after.get(keyFor(GLOBAL_SPACE_ID, 'GLOBAL'))).toEqual({
      title: 'global',
      deleted: false,
      resolved: true,
    })
    // version bumped so memoised consumers recompute
    expect(useResolveStore.getState().version).toBe(2)
  })

  it('clearAllForSpace on a space with no entries is a no-op (still bumps version)', () => {
    const cache = new Map<string, { title: string; deleted: boolean; resolved: boolean }>([
      [keyFor(TEST_SPACE_ID, 'A1'), { title: 'A1', deleted: false, resolved: true }],
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
        [
          keyFor(OTHER_SPACE_ID, 'FOREIGN_ULID'),
          { title: 'Foreign Page', deleted: false, resolved: true },
        ],
      ]),
    })

    // Active space is SPACE_TEST — looking up FOREIGN_ULID must NOT
    // surface "Foreign Page".
    expect(useResolveStore.getState().resolveTitle('FOREIGN_ULID')).toBe('[[FOREIGN_...]]')
  })
})

// ---------------------------------------------------------------------------
// the cache-miss signal (#4238)
// ---------------------------------------------------------------------------
/**
 * #4238 — the signal that used to ride on the title's BYTES.
 *
 * `useBacklinkResolution` stored the `[[id…]]` broken-link shape as the title
 * of a resolved-but-blank row purely so `resolveBlockDisplay` would keep
 * treating it as a miss, which is what stopped that writer from normalising
 * blank like its three siblings. The verdict now lives on
 * `ResolveEntry.resolved`, and these pin that it is genuinely the FIELD that
 * decides — not a string that happens to look like a miss, and not `deleted`.
 */
describe('resolved flag — the cache-miss signal, off the title string', () => {
  it('resolveTitle ignores the stored title of an unresolved entry', () => {
    // A title that is NOT the broken-link shape, on an entry flagged
    // unresolved. Under the old design the bytes were the whole signal, so
    // this row would have rendered "A Real Looking Title" and been treated as
    // resolved everywhere. The flag has to win, or the separation is cosmetic.
    useResolveStore
      .getState()
      .batchSet([
        { id: 'MISSING_ULID', title: 'A Real Looking Title', deleted: true, resolved: false },
      ])

    expect(useResolveStore.getState().resolveTitle('MISSING_ULID')).toBe('[[MISSING_...]]')
    expect(useResolveStore.getState().isResolved('MISSING_ULID')).toBe(false)
    // `has` still says yes — that is its job, and it is why the two probes had
    // to be separated: the entry exists precisely so the id is NOT re-fetched
    // on every pass.
    expect(useResolveStore.getState().has('MISSING_ULID')).toBe(true)
  })

  it('resolveTitle serves a BLANK resolved row its placeholder, not the miss label', () => {
    // The input the two jobs disagreed on. It is resolved, so the stored
    // presentational title wins — this is the cell four writers now agree on.
    useResolveStore.getState().batchSet([{ id: 'BLANK_ULID', title: 'Untitled', deleted: false }])

    expect(useResolveStore.getState().resolveTitle('BLANK_ULID')).toBe('Untitled')
    expect(useResolveStore.getState().isResolved('BLANK_ULID')).toBe(true)
  })

  it('a soft-DELETED row is still resolved — which is why `deleted` could not carry the signal', () => {
    // `batch_resolve` returns soft-deleted blocks WITH their real title, so
    // `deleted: true` is an ordinary resolved state. Folding the two fields
    // together would put every trashed block's chip back on `[[id…]]`.
    useResolveStore.getState().set('TRASHED_ULID', 'Real Title', true)

    expect(useResolveStore.getState().isResolved('TRASHED_ULID')).toBe(true)
    expect(useResolveStore.getState().resolveTitle('TRASHED_ULID')).toBe('Real Title')
    expect(useResolveStore.getState().resolveStatus('TRASHED_ULID')).toBe('deleted')
  })

  it('isResolved is false for an id that is not cached at all', () => {
    expect(useResolveStore.getState().isResolved('NEVER_SEEN')).toBe(false)
  })

  it('flipping only `resolved` is a real change — batchSet must not diff it away', () => {
    useResolveStore.getState().batchSet([{ id: 'FLIP_ULID', title: 'Same Bytes', deleted: true }])
    const versionAfterFirst = useResolveStore.getState().version

    // Same title, same deleted, different verdict. If the diff ignored
    // `resolved` this would be dropped as a no-op and the entry would keep
    // claiming to be resolved.
    useResolveStore
      .getState()
      .batchSet([{ id: 'FLIP_ULID', title: 'Same Bytes', deleted: true, resolved: false }])

    expect(useResolveStore.getState().version).toBe(versionAfterFirst + 1)
    expect(useResolveStore.getState().isResolved('FLIP_ULID')).toBe(false)
    expect(useResolveStore.getState().resolveTitle('FLIP_ULID')).toBe('[[FLIP_ULI...]]')
  })

  it('set() defaults `resolved` to true, and re-writing it stays a no-op', () => {
    useResolveStore.getState().set('ECHO_ULID', 'Echoed Title', false)
    expect(useResolveStore.getState().isResolved('ECHO_ULID')).toBe(true)

    const versionAfterFirst = useResolveStore.getState().version
    useResolveStore.getState().set('ECHO_ULID', 'Echoed Title', false)
    // The #1073 no-op guard still holds with the extra field in the diff.
    expect(useResolveStore.getState().version).toBe(versionAfterFirst)
  })
})

// ---------------------------------------------------------------------------
// cache eviction
// ---------------------------------------------------------------------------
describe('cache eviction', () => {
  it('set() evicts oldest entries when cache exceeds MAX_CACHE_SIZE', () => {
    // Pre-fill cache with exactly 10,000 entries
    const cache = new Map<string, { title: string; deleted: boolean; resolved: boolean }>()
    for (let i = 0; i < 10_000; i++) {
      cache.set(keyFor(TEST_SPACE_ID, `id-${i}`), {
        title: `T${i}`,
        deleted: false,
        resolved: true,
      })
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
    const cache = new Map<string, { title: string; deleted: boolean; resolved: boolean }>()
    for (let i = 0; i < 9_998; i++) {
      cache.set(keyFor(TEST_SPACE_ID, `id-${i}`), {
        title: `T${i}`,
        deleted: false,
        resolved: true,
      })
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
    const cache = new Map<string, { title: string; deleted: boolean; resolved: boolean }>()
    for (let i = 0; i < 10_000; i++) {
      cache.set(keyFor(TEST_SPACE_ID, `id-${i}`), {
        title: `T${i}`,
        deleted: false,
        resolved: true,
      })
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

  // #1640 — eviction is LRU, not insertion-order FIFO. A frequently-read
  // entry must survive eviction even if it was inserted early; the truly
  // least-recently-used entry is the one that gets dropped.
  it('resolveTitle marks an entry as recently used so it survives eviction (#1640)', () => {
    // Fill the cache exactly to capacity. id-0 is the oldest by insertion.
    const cache = new Map<string, { title: string; deleted: boolean; resolved: boolean }>()
    for (let i = 0; i < 10_000; i++) {
      cache.set(keyFor(TEST_SPACE_ID, `id-${i}`), {
        title: `T${i}`,
        deleted: false,
        resolved: true,
      })
    }
    useResolveStore.setState({ cache })

    // Read the oldest-inserted entry — under LRU this moves it to the tail
    // (most-recently-used), so it must NOT be the next one evicted.
    expect(useResolveStore.getState().resolveTitle('id-0')).toBe('T0')

    // Add a new entry, pushing the cache 1 over capacity.
    useResolveStore.getState().set('new-id', 'Title', false)

    const state = useResolveStore.getState()
    expect(state.cache.size).toBe(10_000)
    // The hot (recently-read) early entry survives...
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'id-0'))).toBe(true)
    // ...while the genuine least-recently-used entry (id-1, the new front)
    // is the one evicted.
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'id-1'))).toBe(false)
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'new-id'))).toBe(true)
  })

  // A pure read that refreshes LRU recency must not trigger a re-render:
  // the Map reference and `version` are unchanged on a cache-hit read.
  it('resolveTitle does not clone the Map or bump version on a hit (#1640)', () => {
    useResolveStore.getState().set('ID_HOT', 'Hot Page', false)
    const versionBefore = useResolveStore.getState().version
    const cacheBefore = useResolveStore.getState().cache

    expect(useResolveStore.getState().resolveTitle('ID_HOT')).toBe('Hot Page')

    const state = useResolveStore.getState()
    expect(state.version).toBe(versionBefore)
    expect(state.cache).toBe(cacheBefore)
  })

  // resolveStatus is the second read path; it must also refresh recency.
  it('resolveStatus marks an entry as recently used so it survives eviction (#1640)', () => {
    const cache = new Map<string, { title: string; deleted: boolean; resolved: boolean }>()
    for (let i = 0; i < 10_000; i++) {
      cache.set(keyFor(TEST_SPACE_ID, `id-${i}`), {
        title: `T${i}`,
        deleted: false,
        resolved: true,
      })
    }
    useResolveStore.setState({ cache })

    expect(useResolveStore.getState().resolveStatus('id-0')).toBe('active')

    useResolveStore.getState().set('new-id', 'Title', false)

    const state = useResolveStore.getState()
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'id-0'))).toBe(true)
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'id-1'))).toBe(false)
  })

  // Perf (#2200/#2267) — LRU touch bookkeeping on read is skipped while the
  // cache is under MAX_CACHE_SIZE, since eviction order only matters once
  // eviction can actually happen. Below capacity, repeated reads must NOT
  // reorder the Map's insertion order (the delete+re-set is a no-op).
  it('resolveTitle skips LRU touch bookkeeping while the cache is under capacity (#2200)', () => {
    const cache = new Map<string, { title: string; deleted: boolean; resolved: boolean }>()
    for (let i = 0; i < 100; i++) {
      cache.set(keyFor(TEST_SPACE_ID, `id-${i}`), {
        title: `T${i}`,
        deleted: false,
        resolved: true,
      })
    }
    useResolveStore.setState({ cache })
    expect(useResolveStore.getState().cache.size).toBeLessThan(10_000)

    const keysBefore = Array.from(useResolveStore.getState().cache.keys())

    // Read the oldest entry repeatedly — well under capacity, so touch
    // bookkeeping must be skipped and iteration order left untouched.
    for (let i = 0; i < 5; i++) {
      expect(useResolveStore.getState().resolveTitle('id-0')).toBe('T0')
    }

    const keysAfter = Array.from(useResolveStore.getState().cache.keys())
    expect(keysAfter).toEqual(keysBefore)
    expect(keysAfter[0]).toBe(keyFor(TEST_SPACE_ID, 'id-0'))
  })

  // Same gating, resolveStatus read path.
  it('resolveStatus skips LRU touch bookkeeping while the cache is under capacity (#2200)', () => {
    const cache = new Map<string, { title: string; deleted: boolean; resolved: boolean }>()
    for (let i = 0; i < 100; i++) {
      cache.set(keyFor(TEST_SPACE_ID, `id-${i}`), {
        title: `T${i}`,
        deleted: false,
        resolved: true,
      })
    }
    useResolveStore.setState({ cache })

    const keysBefore = Array.from(useResolveStore.getState().cache.keys())
    useResolveStore.getState().resolveStatus('id-0')
    const keysAfter = Array.from(useResolveStore.getState().cache.keys())

    expect(keysAfter).toEqual(keysBefore)
  })

  // Combined scenario requested by #2267: fill under capacity (touch
  // no-ops), then flood past MAX_CACHE_SIZE. The size bound must still
  // hold, and only entries touched AFTER the cache reached capacity get
  // LRU protection — touches recorded while under capacity are not
  // retroactively honored (documented trade-off, not a correctness bug:
  // nothing could have been evicted yet at the time of those reads).
  it('enforces the MAX_CACHE_SIZE bound after flooding past capacity from a partially-filled cache', () => {
    const cache = new Map<string, { title: string; deleted: boolean; resolved: boolean }>()
    for (let i = 0; i < 9_999; i++) {
      cache.set(keyFor(TEST_SPACE_ID, `id-${i}`), {
        title: `T${i}`,
        deleted: false,
        resolved: true,
      })
    }
    useResolveStore.setState({ cache })

    // Under capacity (9,999 < 10,000) — this read is a no-op for LRU order.
    useResolveStore.getState().resolveTitle('id-0')

    // Crosses capacity: 9,999 + 1 = 10,000 (at capacity, no eviction yet).
    useResolveStore.getState().set('at-capacity', 'At Capacity', false)
    expect(useResolveStore.getState().cache.size).toBe(10_000)

    // Now AT capacity — this read DOES perform LRU bookkeeping and moves
    // id-1 (not id-0, which was never touched post-capacity) to the tail.
    useResolveStore.getState().resolveTitle('id-1')

    // One more write pushes past capacity, triggering eviction of the
    // genuinely coldest entry.
    useResolveStore.getState().set('over-capacity', 'Over Capacity', false)

    const state = useResolveStore.getState()
    expect(state.cache.size).toBe(10_000)
    // id-1 was touched at capacity, so it survives.
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'id-1'))).toBe(true)
    // id-0's under-capacity read did not protect it — it's evicted as the
    // coldest (front-of-Map) entry.
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'id-0'))).toBe(false)
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'at-capacity'))).toBe(true)
    expect(state.cache.has(keyFor(TEST_SPACE_ID, 'over-capacity'))).toBe(true)
  })
})
