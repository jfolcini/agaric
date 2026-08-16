/**
 * Tests for useBlockResolve hook — resolve callbacks, picker search, and page creation.
 *
 * Validates:
 * - resolveBlockTitle / resolveBlockStatus (cache hit & fallback)
 * - resolveTagName / resolveTagStatus (cache hit & fallback)
 * - All four resolve callbacks re-create when store version changes
 * - searchTags delegates to listAllTagsInSpace (space-scoped) and maps results
 * - searchPages short-query path (cache + fallback to listAllPagesInSpace)
 * - searchPages long-query path (FTS + cache supplementation)
 * - searchPages "Create new" option logic
 * - onCreatePage creates block, updates store, and updates pagesListRef
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #2927 phase 8 — the hook now calls generated `commands.*` directly, so
// mocking only the `@/lib/tauri` wrapper no longer intercepts anything. Mock
// the bindings surface instead, resolving the same typed-result envelope
// `unwrap` expects (mirrors `use-block-link-resolve.test.ts`'s pattern).
const mockedCreateBlock = vi.hoisted(() => vi.fn())
const mockedCreatePageInSpace = vi.hoisted(() => vi.fn())
const mockedListAllPagesInSpace = vi.hoisted(() => vi.fn())
const mockedListAllTagsInSpace = vi.hoisted(() => vi.fn())
const mockedListPageAliasesByPrefix = vi.hoisted(() => vi.fn())
const mockedSearchBlocks = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      createBlock: (...args: unknown[]) =>
        mockedCreateBlock(...args).then((data: unknown) => ({ status: 'ok', data })),
      createPageInSpace: (...args: unknown[]) =>
        mockedCreatePageInSpace(...args).then((data: unknown) => ({ status: 'ok', data })),
      listAllPagesInSpace: (...args: unknown[]) =>
        mockedListAllPagesInSpace(...args).then((data: unknown) => ({ status: 'ok', data })),
      listAllTagsInSpace: (...args: unknown[]) =>
        mockedListAllTagsInSpace(...args).then((data: unknown) => ({ status: 'ok', data })),
      listPageAliasesByPrefix: (...args: unknown[]) =>
        mockedListPageAliasesByPrefix(...args).then((data: unknown) => ({ status: 'ok', data })),
      searchBlocks: (...args: unknown[]) =>
        mockedSearchBlocks(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

import { useBlockResolve } from '@/components/block-tree/use-block-resolve'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

beforeEach(() => {
  vi.clearAllMocks()
  useResolveStore.setState({
    cache: new Map(),
    version: 0,
    _preloaded: false,
  })
  // Phase 2 — `onCreatePage` and the `searchPages` IPC paths now
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
  it('calls listAllTagsInSpace (space-scoped) and maps results to PickerItem[]', async () => {
    mockedListAllTagsInSpace.mockResolvedValueOnce([
      { tag_id: 'T1', name: 'project', usage_count: 5, updated_at: '2024-01-01' },
      { tag_id: 'T2', name: 'priority', usage_count: 3, updated_at: '2024-01-02' },
    ])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('pr')
    })

    // #2543 — space-scoped IPC, not the old space-unscoped listTagsByPrefix.
    expect(mockedListAllTagsInSpace).toHaveBeenCalledWith({
      kind: 'active',
      space_id: 'SPACE_TEST',
    })
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
    mockedListAllTagsInSpace.mockResolvedValueOnce([])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('zzz')
    })

    expect(items).toEqual([{ id: '__create__', label: 'zzz', isCreate: true }])
  })

  it('populates the resolve cache with fetched tags', async () => {
    mockedListAllTagsInSpace.mockResolvedValueOnce([
      { tag_id: 'T10', name: 'important', usage_count: 2, updated_at: '2024-01-01' },
      { tag_id: 'T11', name: 'urgent', usage_count: 1, updated_at: '2024-01-02' },
    ])

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchTags('imp')
    })

    // Verify the resolve store cache was populated.
    // Cache is composite-keyed (`${spaceId}::${ulid}`).
    const cache = useResolveStore.getState().cache
    expect(cache.get(keyFor('SPACE_TEST', 'T10'))).toEqual({ title: 'important', deleted: false })
    expect(cache.get(keyFor('SPACE_TEST', 'T11'))).toEqual({ title: 'urgent', deleted: false })
  })

  it('does not call batchSet when no tags match', async () => {
    mockedListAllTagsInSpace.mockResolvedValueOnce([])

    const initialVersion = useResolveStore.getState().version

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchTags('zzz')
    })

    // Version should not change — no batchSet call
    expect(useResolveStore.getState().version).toBe(initialVersion)
  })

  it('does NOT append "Create new tag" when exact match exists (case-insensitive)', async () => {
    mockedListAllTagsInSpace.mockResolvedValueOnce([
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
    mockedListAllTagsInSpace.mockResolvedValueOnce([
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
    mockedListAllTagsInSpace.mockResolvedValueOnce([])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('  MyTag  ')
    })

    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toEqual({ id: '__create__', label: 'MyTag', isCreate: true })
  })

  it('strips trailing ] from tag query', async () => {
    mockedListAllTagsInSpace.mockResolvedValueOnce([
      { tag_id: 'T40', name: 'todo', usage_count: 2, updated_at: '2024-01-01' },
    ])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('todo]')
    })

    expect(mockedListAllTagsInSpace).toHaveBeenCalledWith({
      kind: 'active',
      space_id: 'SPACE_TEST',
    })
    // Exact match against the STRIPPED query ('todo', not 'todo]') — no
    // create option. This is what actually proves the bracket was
    // stripped before the client-side filter/exact-match check ran (the
    // IPC itself no longer takes a query/prefix argument to inspect).
    const createOption = items.find((i) => i.isCreate)
    expect(createOption).toBeUndefined()
  })
})

// ── onCreateTag ─────────────────────────────────────────────────────────

describe('onCreateTag', () => {
  it('creates the tag atomically space-scoped in ONE createBlock call', async () => {
    mockedCreateBlock.mockResolvedValueOnce({
      id: 'NEW_TAG_1',
      block_type: 'tag',
      content: 'urgent',
      parent_id: null,
      position: null,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
      // #2468 — createBlock resolves WithOps<BlockRow>.
      op_refs: [],
    })

    const { result } = renderHook(() => useBlockResolve())

    let newId = ''
    await act(async () => {
      newId = await result.current.onCreateTag('urgent')
    })

    // #3081 — the active spaceId is threaded through so the backend stamps
    // `blocks.space_id` in the same transaction; there is NO separate
    // best-effort setProperty(space) follow-up.
    expect(mockedCreateBlock).toHaveBeenCalledWith(
      'tag',
      'urgent',
      null,
      null,
      { kind: 'active', space_id: 'SPACE_TEST' },
      null,
    )
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
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
      // #2468 — createBlock resolves WithOps<BlockRow>.
      op_refs: [],
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
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
      // #2468 — createBlock resolves WithOps<BlockRow>.
      op_refs: [],
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

  // #3081 — with no active space the create still happens (Global scope), and
  // `createBlock` must NOT receive a `spaceId` (the backend leaves it unscoped
  // rather than stamping a bogus one).
  it('omits spaceId from createBlock when there is no active space', async () => {
    useSpaceStore.setState({ currentSpaceId: null })
    mockedCreateBlock.mockResolvedValueOnce({
      id: 'NEW_TAG_NOSPACE',
      block_type: 'tag',
      content: 'nospace',
      parent_id: null,
      position: null,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
      op_refs: [],
    })

    const { result } = renderHook(() => useBlockResolve())

    let newId = ''
    await act(async () => {
      newId = await result.current.onCreateTag('nospace')
    })

    expect(newId).toBe('NEW_TAG_NOSPACE')
    expect(mockedCreateBlock).toHaveBeenCalledWith(
      'tag',
      'nospace',
      null,
      null,
      { kind: 'global' },
      null,
    )
  })
})

// ── onCreateTag — tagsListRef cache staleness (#3277 finding 1) ──────────
//
// `searchTags` lazily fills `tagsListRef` once and filters every subsequent
// keystroke client-side (#3277). `onCreatePage` appends the newly-created
// page to the mirror-image `pagesListRef` so it is immediately findable
// through the SAME picker session — `onCreateTag` must do the same for
// `tagsListRef`, or a tag created via the `@`-picker's "Create new tag"
// option stays invisible to that same picker (no new IPC is issued once the
// cache is filled, so nothing ever notices the tag exists) until a space
// switch clears the cache.

describe('onCreateTag — tagsListRef cache staleness (#3277 finding 1)', () => {
  function tagRow(id: string, name: string) {
    return { tag_id: id, name, usage_count: 1, updated_at: '2024-01-01' }
  }

  function tagBlock(id: string, content: string) {
    return {
      id,
      block_type: 'tag',
      content,
      parent_id: null,
      position: null,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
      op_refs: [],
    }
  }

  it('appends the new tag to tagsListRef so it is findable via searchTags without a new IPC call', async () => {
    mockedListAllTagsInSpace.mockResolvedValueOnce([tagRow('T1', 'existing')])
    mockedCreateBlock.mockResolvedValueOnce(tagBlock('NEW_TAG', 'brandnew'))

    const { result } = renderHook(() => useBlockResolve())

    // Prime the cache with one searchTags call.
    await act(async () => {
      await result.current.searchTags('existing')
    })
    expect(mockedListAllTagsInSpace).toHaveBeenCalledTimes(1)

    // Create a brand new tag through the picker's create-new-tag flow.
    await act(async () => {
      await result.current.onCreateTag('brandnew')
    })

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('brandnew')
    })

    // Still exactly ONE IPC call — served entirely from the (now-updated)
    // client-side cache — and the new tag IS present in the results.
    expect(mockedListAllTagsInSpace).toHaveBeenCalledTimes(1)
    const ids = items.filter((i) => !i.isCreate).map((i) => i.id)
    expect(ids).toContain('NEW_TAG')
  })

  it('leaves the cache stale-but-recoverable: a space switch clears the stale entries', async () => {
    mockedListAllTagsInSpace.mockResolvedValueOnce([tagRow('T1', 'existing')])
    mockedCreateBlock.mockResolvedValueOnce(tagBlock('NEW_TAG_2', 'freshtag'))

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchTags('existing')
    })
    await act(async () => {
      await result.current.onCreateTag('freshtag')
    })

    // Switching spaces invalidates the cache exactly like pagesListRef
    // (#732) — the failure mode is a stale cache that self-heals on the
    // next space switch or process restart, never a permanently poisoned
    // one.
    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
    })

    mockedListAllTagsInSpace.mockResolvedValueOnce([tagRow('TB', 'other-space-tag')])
    await act(async () => {
      await result.current.searchTags('other')
    })
    expect(mockedListAllTagsInSpace).toHaveBeenCalledTimes(2)
  })

  it('does NOT poison the cache on an empty first fill — real tags surface once they exist', async () => {
    mockedListAllTagsInSpace.mockResolvedValueOnce([])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('anything')
    })
    expect(items.filter((i) => !i.isCreate)).toEqual([])
    expect(mockedListAllTagsInSpace).toHaveBeenCalledTimes(1)

    // A later query, now that a real tag exists, must not be starved by an
    // empty cache latched from the first fill.
    mockedListAllTagsInSpace.mockResolvedValueOnce([tagRow('T9', 'realtag')])
    await act(async () => {
      items = await result.current.searchTags('real')
    })
    expect(mockedListAllTagsInSpace).toHaveBeenCalledTimes(2)
    expect(items.filter((i) => !i.isCreate).map((i) => i.id)).toContain('T9')
  })

  // #4008 review note 6 — the "empty ⇔ not yet fetched" invariant the test
  // above pins is destroyed by `onCreateTag`'s append when the space has ZERO
  // tags: the append flips the ref from empty (re-fetch every call) to
  // "filled" with a single entry, permanently suppressing the re-fetch for
  // the rest of the session. Every tag created elsewhere (another window, a
  // sync) then stays invisible to this picker until a space switch.
  it('an empty-space create must not latch the cache: searchTags still re-fetches', async () => {
    mockedListAllTagsInSpace.mockResolvedValueOnce([])
    mockedCreateBlock.mockResolvedValueOnce(tagBlock('T_FIRST', 'first'))

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchTags('any')
    })
    expect(mockedListAllTagsInSpace).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.onCreateTag('first')
    })

    // A tag that appeared from somewhere else must still be reachable: the
    // cache was never filled from the server, so the next query must re-fetch.
    mockedListAllTagsInSpace.mockResolvedValueOnce([
      tagRow('T_FIRST', 'first'),
      tagRow('T_ELSEWHERE', 'elsewhere'),
    ])
    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('elsewhere')
    })
    expect(mockedListAllTagsInSpace).toHaveBeenCalledTimes(2)
    expect(items.filter((i) => !i.isCreate).map((i) => i.id)).toContain('T_ELSEWHERE')
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

    // Should NOT call listAllPagesInSpace since cache is populated
    expect(mockedListAllPagesInSpace).not.toHaveBeenCalled()
    expect(items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'P1', label: 'My Page' })]),
    )
    // "Another Page" and "Meeting Notes" don't contain "my"
    const ids = items.filter((i) => !i.isCreate).map((i) => i.id)
    expect(ids).toContain('P1')
    expect(ids).not.toContain('P2')
    expect(ids).not.toContain('P3')
  })

  it('falls back to listAllPagesInSpace when pagesListRef is empty', async () => {
    mockedListAllPagesInSpace.mockResolvedValueOnce([
      {
        id: 'P10',
        content: 'Alpha',
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
      },
      {
        id: 'P11',
        content: 'Beta',
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
      },
    ])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('al')
    })

    expect(mockedListAllPagesInSpace).toHaveBeenCalledWith(
      { kind: 'active', space_id: 'SPACE_TEST' },
      null,
    )
    // Should match "Alpha" (contains "al")
    const matchIds = items.filter((i) => !i.isCreate).map((i) => i.id)
    expect(matchIds).toContain('P10')
    // "Beta" does not contain "al"
    expect(matchIds).not.toContain('P11')
  })

  it('populates pagesListRef cache after listAllPagesInSpace fallback', async () => {
    mockedListAllPagesInSpace.mockResolvedValueOnce([
      {
        id: 'P20',
        content: 'Cached Page',
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
      },
    ])

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchPages('ca')
    })

    expect(result.current.pagesListRef.current).toEqual([{ id: 'P20', title: 'Cached Page' }])
  })

  it('handles null content as "Untitled"', async () => {
    mockedListAllPagesInSpace.mockResolvedValueOnce([
      {
        id: 'P30',
        content: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
      },
    ])

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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('meeting')
    })

    expect(mockedSearchBlocks).toHaveBeenCalledWith('meeting', null, 20, {
      parentId: null,
      tagIds: [],
      scope: { kind: 'active', space_id: 'SPACE_TEST' },
      includePageGlobs: [],
      excludePageGlobs: [],
      caseSensitive: false,
      wholeWord: false,
      isRegex: false,
      blockTypeFilter: null,
      stateFilter: [],
      priorityFilter: [],
      dueFilter: null,
      scheduledFilter: null,
      propertyFilters: [],
      excludedPropertyFilters: [],
      excludedStateFilter: [],
      excludedPriorityFilter: [],
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
      // #2468 — createBlock resolves WithOps<BlockRow>.
      op_refs: [],
    }))

    mockedSearchBlocks.mockResolvedValueOnce({
      items: ftsPages,
      next_cursor: null,
      has_more: false,
      total_count: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
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

  // Unicode-aware fold so the "exact match exists" check
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
      total_count: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('text]]')
    })

    // FTS receives "text" (stripped), not "text]]"
    expect(mockedSearchBlocks).toHaveBeenCalledWith('text', null, 20, {
      parentId: null,
      tagIds: [],
      scope: { kind: 'active', space_id: 'SPACE_TEST' },
      includePageGlobs: [],
      excludePageGlobs: [],
      caseSensitive: false,
      wholeWord: false,
      isRegex: false,
      blockTypeFilter: null,
      stateFilter: [],
      priorityFilter: [],
      dueFilter: null,
      scheduledFilter: null,
      propertyFilters: [],
      excludedPropertyFilters: [],
      excludedStateFilter: [],
      excludedPriorityFilter: [],
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('test]')
    })

    expect(mockedSearchBlocks).toHaveBeenCalledWith('test', null, 20, {
      parentId: null,
      tagIds: [],
      scope: { kind: 'active', space_id: 'SPACE_TEST' },
      includePageGlobs: [],
      excludePageGlobs: [],
      caseSensitive: false,
      wholeWord: false,
      isRegex: false,
      blockTypeFilter: null,
      stateFilter: [],
      priorityFilter: [],
      dueFilter: null,
      scheduledFilter: null,
      propertyFilters: [],
      excludedPropertyFilters: [],
      excludedStateFilter: [],
      excludedPriorityFilter: [],
    })
    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate).toEqual([expect.objectContaining({ id: 'P1', label: 'Test Page' })])
  })

  it('"Create new" label strips trailing ]] too', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('meeting]]')
    })

    // FTS receives "meeting" (stripped), returns Meeting Notes
    expect(mockedSearchBlocks).toHaveBeenCalledWith('meeting', null, 20, {
      parentId: null,
      tagIds: [],
      scope: { kind: 'active', space_id: 'SPACE_TEST' },
      includePageGlobs: [],
      excludePageGlobs: [],
      caseSensitive: false,
      wholeWord: false,
      isRegex: false,
      blockTypeFilter: null,
      stateFilter: [],
      priorityFilter: [],
      dueFilter: null,
      scheduledFilter: null,
      propertyFilters: [],
      excludedPropertyFilters: [],
      excludedStateFilter: [],
      excludedPriorityFilter: [],
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

    expect(mockedCreatePageInSpace).toHaveBeenCalledWith(null, 'Brand New Page', 'SPACE_TEST')
    // Phase 2 — the legacy `createBlock({ blockType: 'page' })`
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

  // Phase 2 — defensive guard for the `!isReady` branch.
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
  it('searchTags returns [] when listAllTagsInSpace rejects', async () => {
    mockedListAllTagsInSpace.mockRejectedValue(new Error('IPC: tags unavailable'))

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

  it('searchPages returns [] when listAllPagesInSpace rejects (short query, empty cache)', async () => {
    mockedListAllPagesInSpace.mockRejectedValue(new Error('DB connection lost'))

    const { result } = renderHook(() => useBlockResolve())
    // pagesListRef is empty by default, so it will fall back to listAllPagesInSpace

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

// ── pagesListRef space-switch invalidation (#732) ───────────────────────
//
// The hook instance survives page-editor→page-editor space switches
// (ViewDispatcher → PageEditor → BlockTree mount without keys), so the
// lazily-filled cache must be dropped when `currentSpaceId` changes —
// otherwise ≤2-char `[[` picker queries keep serving the PREVIOUS
// space's pages.

describe('pagesListRef — space-switch invalidation (#732)', () => {
  function pageRow(id: string, content: string) {
    return {
      id,
      content,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    }
  }

  it('clears the lazily-filled cache when the active space changes', async () => {
    mockedListAllPagesInSpace.mockResolvedValueOnce([pageRow('PA', 'Alpha')])

    const { result } = renderHook(() => useBlockResolve())

    // Short query lazily fills the cache for SPACE_TEST.
    await act(async () => {
      await result.current.searchPages('al')
    })
    expect(result.current.pagesListRef.current).toEqual([{ id: 'PA', title: 'Alpha' }])

    // Space switch → the cache must be invalidated.
    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
    })
    expect(result.current.pagesListRef.current).toEqual([])
  })

  it('refetches from the NEW space on the next short query after a switch', async () => {
    mockedListAllPagesInSpace
      .mockResolvedValueOnce([pageRow('PA', 'Alpha A')])
      .mockResolvedValueOnce([pageRow('PB', 'Alpha B')])

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchPages('al')
    })
    expect(mockedListAllPagesInSpace).toHaveBeenLastCalledWith(
      { kind: 'active', space_id: 'SPACE_TEST' },
      null,
    )

    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
    })

    // Cache was cleared, so the next short query falls back to the IPC,
    // scoped to the NEW space — and serves the new space's pages only.
    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('al')
    })
    expect(mockedListAllPagesInSpace).toHaveBeenLastCalledWith(
      { kind: 'active', space_id: 'SPACE_B' },
      null,
    )
    const ids = items.filter((i) => !i.isCreate).map((i) => i.id)
    expect(ids).toContain('PB')
    expect(ids).not.toContain('PA')
  })

  it('does not persist a lazy fill that resolves after a mid-flight space switch', async () => {
    let resolveFetch: (rows: Array<ReturnType<typeof pageRow>>) => void = () => {}
    mockedListAllPagesInSpace.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
    )

    const { result } = renderHook(() => useBlockResolve())

    // Start a short-query fill for SPACE_TEST, but don't let it resolve.
    let inFlight: Promise<unknown> = Promise.resolve()
    act(() => {
      inFlight = result.current.searchPages('al')
    })

    // Switch spaces while the fetch is in flight…
    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
    })

    // …then let the OLD space's response land. It must not re-seed the
    // just-invalidated cache.
    await act(async () => {
      resolveFetch([pageRow('PA', 'Alpha')])
      await inFlight
    })
    expect(result.current.pagesListRef.current).toEqual([])
  })

  it('does NOT clear the cache on unrelated space-store writes', () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [{ id: 'P1', title: 'Kept' }]
      useSpaceStore.setState({
        isReady: true,
        availableSpaces: [
          { id: 'SPACE_TEST', name: 'Test', accent_color: null },
          { id: 'SPACE_B', name: 'B', accent_color: null },
        ],
      })
    })

    expect(result.current.pagesListRef.current).toEqual([{ id: 'P1', title: 'Kept' }])
  })
})

// ── searchTags caching (#3277 finding 2) ────────────────────────────────
//
// `searchTags` used to call `listAllTagsInSpace` on EVERY keystroke with no
// client-side cache, unlike the sibling `searchPages` path (which fills
// `pagesListRef` once and filters subsequent keystrokes client-side via
// `matchSorter`). The fix mirrors that pattern with a `tagsListRef`: the
// first call fills the cache (and seeds the resolve store once), subsequent
// calls filter the cached list client-side without another IPC round trip.

describe('searchTags — client-side cache (#3277)', () => {
  function tagRow(id: string, name: string) {
    return { tag_id: id, name, usage_count: 1, updated_at: '2024-01-01' }
  }

  // `mockResolvedValueOnce` queues survive `vi.clearAllMocks()` (which only
  // clears call history, not queued implementations) — an unconsumed queued
  // value here would otherwise leak into a LATER, unrelated test in this
  // file and corrupt its IPC response. Every test below fully resets the
  // mock so its queue can never outlive it.
  afterEach(() => {
    mockedListAllTagsInSpace.mockReset()
  })

  it('does not re-fetch listAllTagsInSpace on a second keystroke — filters the cached list client-side', async () => {
    mockedListAllTagsInSpace.mockResolvedValueOnce([
      tagRow('T1', 'project'),
      tagRow('T2', 'projection'),
      tagRow('T3', 'zzz-unrelated'),
    ])

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchTags('p')
    })
    expect(mockedListAllTagsInSpace).toHaveBeenCalledTimes(1)

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('pro')
    })

    // Still exactly ONE IPC call across both keystrokes — the second
    // keystroke was served entirely from the client-side cache.
    expect(mockedListAllTagsInSpace).toHaveBeenCalledTimes(1)
    const tagItems = items.filter((i) => !i.isCreate).map((i) => i.id)
    expect(tagItems).toEqual(expect.arrayContaining(['T1', 'T2']))
    expect(tagItems).not.toContain('T3')
  })

  it('only calls batchSet once (on the fill), not on every subsequent keystroke', async () => {
    // Queue a SECOND, genuinely different response too: if the fix were
    // absent and the hook re-fetched on the second keystroke, that second
    // response would seed the store with NEW rows and bump the spy to 2 —
    // a diffing no-op (like identical repeated data) can't hide behind
    // #753's idempotent-batchSet short-circuit here.
    mockedListAllTagsInSpace
      .mockResolvedValueOnce([tagRow('T10', 'urgent')])
      .mockResolvedValueOnce([tagRow('T10', 'urgent'), tagRow('T11', 'urgent-followup')])
    // Spy directly on the store action so the assertion isn't a proxy
    // measurement — it counts the exact call the "move batchSet behind the
    // fill guard" change targets.
    const batchSetSpy = vi.spyOn(useResolveStore.getState(), 'batchSet')

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchTags('u')
    })
    expect(batchSetSpy).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.searchTags('ur')
    })

    // A second keystroke served from the client-side cache must NOT call
    // batchSet again.
    expect(batchSetSpy).toHaveBeenCalledTimes(1)
    batchSetSpy.mockRestore()
    // Drain the queue in case the fix (correctly) never consumed the
    // second queued value — the shared `afterEach` above resets regardless,
    // this just documents why a leftover queued value here is expected.
  })

  it('refetches from the NEW space on the next query after a space switch', async () => {
    mockedListAllTagsInSpace
      .mockResolvedValueOnce([tagRow('TA', 'alpha-a')])
      .mockResolvedValueOnce([tagRow('TB', 'alpha-b')])

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchTags('al')
    })
    expect(mockedListAllTagsInSpace).toHaveBeenCalledTimes(1)

    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
    })

    let items: Awaited<ReturnType<typeof result.current.searchTags>> = []
    await act(async () => {
      items = await result.current.searchTags('al')
    })

    expect(mockedListAllTagsInSpace).toHaveBeenCalledTimes(2)
    const ids = items.filter((i) => !i.isCreate).map((i) => i.id)
    expect(ids).toContain('TB')
    expect(ids).not.toContain('TA')
  })
})

// ── resolve-store seeding space guard (#853) ────────────────────────────
//
// `populatePageResolveCache` seeds the resolve store, which keys rows by the
// active space at WRITE time (`batchSet` → `activeSpaceId()`). A stale
// in-flight `searchPages` response from the OLD space could still resolve
// after a space switch and seed old-space rows under the NEW space's keys —
// silent cross-space data. The fix captures the active space at request time
// and drops the seed if the space changed (mirrors the #732 captured-space
// guard above, but for the resolve store rather than `pagesListRef`).

describe('searchPages — resolve-store space guard (#853)', () => {
  function ftsPageHit(id: string, content: string) {
    return {
      id,
      block_type: 'page',
      content,
      parent_id: null,
      position: null,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
    }
  }

  function ftsResponse(items: Array<ReturnType<typeof ftsPageHit>>) {
    return { items, next_cursor: null, has_more: false, total_count: null }
  }

  it('does not seed the resolve store for the NEW space with an old-space response', async () => {
    // Resolve store flushes the old space's entries on switch; emulate the
    // post-switch empty bucket for SPACE_B.
    useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })

    let resolveFetch: (resp: ReturnType<typeof ftsResponse>) => void = () => {}
    mockedSearchBlocks.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve as typeof resolveFetch
        }),
    )

    const { result } = renderHook(() => useBlockResolve())

    // Start an FTS search (>2 chars) in SPACE_TEST; keep it in flight.
    let inFlight: Promise<unknown> = Promise.resolve()
    act(() => {
      inFlight = result.current.searchPages('alpha')
    })

    // Switch to SPACE_B while the SPACE_TEST search is still pending.
    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
    })

    // The OLD space's response lands AFTER the switch.
    await act(async () => {
      resolveFetch(ftsResponse([ftsPageHit('PA', 'Alpha (space A page)')]))
      await inFlight
    })

    // The resolve store must NOT have seeded PA under SPACE_B's key — doing so
    // would surface space A's page title while the user is in space B.
    expect(useResolveStore.getState().cache.has(keyFor('SPACE_B', 'PA'))).toBe(false)
  })

  it('still seeds the resolve store when the space is unchanged', async () => {
    useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
    mockedSearchBlocks.mockResolvedValueOnce(ftsResponse([ftsPageHit('PA', 'Alpha')]))

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchPages('alpha')
    })

    // Same space throughout → the resolve store is seeded under SPACE_TEST.
    expect(useResolveStore.getState().cache.get(keyFor('SPACE_TEST', 'PA'))?.title).toBe('Alpha')
  })
})

// #2543 — searchTags and searchBlockRefs seed the SAME shared resolve
// cache as searchPages but, before this fix, neither captured the request
// space nor gated their `batchSet` writeback — the #853 guard existed only
// for `populatePageResolveCache`. Cloned from the searchPages #853 tests
// above.

describe('searchTags — resolve-store space guard (#853)', () => {
  it('does not seed the resolve store for the NEW space with an old-space response', async () => {
    useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })

    let resolveFetch: (
      tags: Array<{
        tag_id: string
        name: string
        usage_count: number
        updated_at: string
      }>,
    ) => void = () => {}
    mockedListAllTagsInSpace.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve as typeof resolveFetch
        }),
    )

    const { result } = renderHook(() => useBlockResolve())

    // Start a tag search in SPACE_TEST; keep it in flight.
    let inFlight: Promise<unknown> = Promise.resolve()
    act(() => {
      inFlight = result.current.searchTags('al')
    })

    // Switch to SPACE_B while the SPACE_TEST fetch is still pending.
    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
    })

    // The OLD space's response lands AFTER the switch.
    await act(async () => {
      resolveFetch([{ tag_id: 'TA', name: 'alpha', usage_count: 1, updated_at: '2024-01-01' }])
      await inFlight
    })

    // Must NOT have seeded TA under SPACE_B's key — doing so would surface
    // space A's tag name while the user is in space B.
    expect(useResolveStore.getState().cache.has(keyFor('SPACE_B', 'TA'))).toBe(false)
  })

  it('still seeds the resolve store when the space is unchanged', async () => {
    useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
    mockedListAllTagsInSpace.mockResolvedValueOnce([
      { tag_id: 'TA', name: 'alpha', usage_count: 1, updated_at: '2024-01-01' },
    ])

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchTags('al')
    })

    expect(useResolveStore.getState().cache.get(keyFor('SPACE_TEST', 'TA'))?.title).toBe('alpha')
  })
})

describe('searchBlockRefs — resolve-store space guard (#853)', () => {
  function blockHit(id: string, content: string) {
    return {
      id,
      block_type: 'block' as const,
      content,
      parent_id: null,
      position: 0,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
    }
  }

  function blocksResponse(items: Array<ReturnType<typeof blockHit>>) {
    return { items, next_cursor: null, has_more: false, total_count: null }
  }

  it('does not seed the resolve store for the NEW space with an old-space response', async () => {
    useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })

    let resolveFetch: (resp: ReturnType<typeof blocksResponse>) => void = () => {}
    mockedSearchBlocks.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve as typeof resolveFetch
        }),
    )

    const { result } = renderHook(() => useBlockResolve())

    let inFlight: Promise<unknown> = Promise.resolve()
    act(() => {
      inFlight = result.current.searchBlockRefs('some block')
    })

    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
    })

    await act(async () => {
      resolveFetch(blocksResponse([blockHit('BRX', 'block from space A')]))
      await inFlight
    })

    expect(useResolveStore.getState().cache.has(keyFor('SPACE_B', 'BRX'))).toBe(false)
  })

  it('still seeds the resolve store when the space is unchanged', async () => {
    useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
    mockedSearchBlocks.mockResolvedValueOnce(blocksResponse([blockHit('BRX', 'some block')]))

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchBlockRefs('some block')
    })

    expect(useResolveStore.getState().cache.get(keyFor('SPACE_TEST', 'BRX'))?.title).toBe(
      'some block',
    )
  })
})

// ── searchPages alias matching ────────────────────────────────
//
// Replaced the exact-match `resolvePageByAlias` call with the
// prefix-indexed `listPageAliasesByPrefix` so every keystroke after `[[`
// folds matching aliases into the result list. Each row of the returned
// `[pageId, alias, title]` tuple becomes one picker item that carries
// the matched `alias` text on `aliasText` (used by the input-rule's
// exact-match disambiguation).

describe('searchPages — alias prefix matching', () => {
  it('prepends every alias prefix match in returned order', async () => {
    // FTS returns no direct matches
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    // Backend returned two prefix-aliased rows for query "w" — both
    // should surface, in the order the backend chose (shortest-first).
    mockedListPageAliasesByPrefix.mockResolvedValueOnce([
      ['PAGE_A', 'wgm', 'WGM'],
      ['PAGE_B', 'weekly', 'Weekly Review'],
    ])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('weekly-meeting')
    })

    expect(mockedListPageAliasesByPrefix).toHaveBeenCalledWith('weekly-meeting', 50, {
      kind: 'active',
      space_id: 'SPACE_TEST',
    })

    // Both alias matches should be at the top, in the returned order.
    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate).toHaveLength(2)
    expect(nonCreate[0]).toEqual({
      id: 'PAGE_A',
      label: 'WGM (alias: wgm)',
      isAlias: true,
      aliasText: 'wgm',
    })
    expect(nonCreate[1]).toEqual({
      id: 'PAGE_B',
      label: 'Weekly Review (alias: weekly)',
      isAlias: true,
      aliasText: 'weekly',
    })
  })

  it('dedupes alias match when page already present from FTS', async () => {
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    // Alias prefix lookup also returns the same page
    mockedListPageAliasesByPrefix.mockResolvedValueOnce([
      ['ALIAS_PAGE_2', 'weekly', 'Weekly Review'],
    ])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('weekly')
    })

    // The alias match should NOT be duplicated — same-page dedupe.
    const nonCreate = items.filter((i) => !i.isCreate)
    expect(nonCreate).toHaveLength(1)
    expect(nonCreate[0]).toEqual(
      expect.objectContaining({ id: 'ALIAS_PAGE_2', label: 'Weekly Review' }),
    )
    // The single match is the FTS row, not the alias row (which would
    // carry `isAlias: true`).
    expect(nonCreate[0]?.isAlias).toBeUndefined()
  })

  it('alias prefix lookup failure does not abort picker', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    // Alias lookup throws
    mockedListPageAliasesByPrefix.mockRejectedValue(new Error('alias service down'))

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      // Should NOT throw — service failure is logged + swallowed
      items = await result.current.searchPages('broken-alias')
    })

    // Only the create option should be present (no FTS matches in fixture)
    expect(items).toEqual([{ id: '__create__', label: 'broken-alias', isCreate: true }])
  })

  it('handles null alias title as "Untitled"', async () => {
    mockedSearchBlocks.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    mockedListPageAliasesByPrefix.mockResolvedValueOnce([['ALIAS_PAGE_3', 'mystery', null]])

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchPages>> = []
    await act(async () => {
      items = await result.current.searchPages('mystery')
    })

    const nonCreate = items.find((i) => !i.isCreate)
    expect(nonCreate).toEqual({
      id: 'ALIAS_PAGE_3',
      label: 'Untitled (alias: mystery)',
      isAlias: true,
      aliasText: 'mystery',
    })
  })

  it('does not call listPageAliasesByPrefix for empty query', async () => {
    const { result } = renderHook(() => useBlockResolve())

    act(() => {
      result.current.pagesListRef.current = [{ id: 'P1', title: 'Some Page' }]
    })

    await act(async () => {
      await result.current.searchPages('')
    })

    expect(mockedListPageAliasesByPrefix).not.toHaveBeenCalled()
  })
})

// ── Priority ordering ────────────────────────────────────────
//
// After the strategy extraction, the dispatcher runs resolvers in a fixed
// priority order:
//   1. Short/long match strategy (cache vs FTS)
//   2. Resolve-cache population
//   3. Alias match prepended
//   4. "Create new page" appended
// These tests lock the observable order so future refactors can't silently
// reshuffle it.

describe('searchPages — strategy priority ordering', () => {
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedListPageAliasesByPrefix.mockResolvedValueOnce([['ALIAS_ONLY', 'meeting', 'Aliased Page']])

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
      aliasText: 'meeting',
    })
    expect(items[1]?.id).toBe('FTS_HIT_1')
    expect(items[2]?.id).toBe('FTS_HIT_2')
    expect(items[3]).toEqual({ id: '__create__', label: 'meeting', isCreate: true })
  })

  it('orders results: alias first, then cache matches, then create last (short query)', async () => {
    mockedListPageAliasesByPrefix.mockResolvedValueOnce([['ALIAS_SHORT', 'ab', 'Alias Target']])

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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedListPageAliasesByPrefix.mockResolvedValueOnce([])

    const { result } = renderHook(() => useBlockResolve())

    await act(async () => {
      await result.current.searchPages('sample')
    })

    // Cache population happens BEFORE alias lookup and BEFORE create option,
    // so only FTS/cache-strategy matches should be in the resolve store,
    // never the "__create__" synthetic id.
    // Cache is composite-keyed (`${spaceId}::${ulid}`).
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
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
        page_id: null,
      })),
      next_cursor: null,
      has_more: false,
      total_count: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedListPageAliasesByPrefix.mockResolvedValueOnce([
      ['ALIAS_FIRST', 'content', 'Canonical Page'],
    ])

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

// ── Icons in picker items ────────────────────────────────────────

describe('searchTags — icons', () => {
  it('includes icon in tag picker items', async () => {
    mockedListAllTagsInSpace.mockResolvedValueOnce([
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

describe('searchPages — icons and breadcrumbs', () => {
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
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

describe('searchBlockRefs — icons', () => {
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchBlockRefs>> = []
    await act(async () => {
      items = await result.current.searchBlockRefs('child block')
    })

    expect(items).toHaveLength(1)
    expect(items[0]?.breadcrumb).toBe('My Page Title')
  })

  it('resolves per-row parent breadcrumbs across multiple results (#1637)', async () => {
    // #1637 — the active space is read once before the per-row map; each row
    // must still resolve its own parent against that single space id.
    useResolveStore.getState().set('PARENT_A', 'Page A', false)
    useResolveStore.getState().set('PARENT_B', 'Page B', false)

    const mkItem = (id: string, parent: string | null) => ({
      id,
      block_type: 'block' as const,
      content: `block ${id}`,
      parent_id: parent,
      position: 0,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
      // #2468 — createBlock resolves WithOps<BlockRow>.
      op_refs: [],
    })

    mockedSearchBlocks.mockResolvedValueOnce({
      items: [mkItem('BRA', 'PARENT_A'), mkItem('BRB', 'PARENT_B'), mkItem('BRC', null)],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    const { result } = renderHook(() => useBlockResolve())

    let items: Awaited<ReturnType<typeof result.current.searchBlockRefs>> = []
    await act(async () => {
      items = await result.current.searchBlockRefs('block')
    })

    expect(items).toHaveLength(3)
    expect(items[0]?.breadcrumb).toBe('Page A')
    expect(items[1]?.breadcrumb).toBe('Page B')
    expect(items[2]?.breadcrumb).toBeUndefined()
  })
})

// ── Fuzzy matching ───────────────────────────────────────────────

describe('searchTags — fuzzy matching', () => {
  it('matches tags via fuzzy matching, not just substring', async () => {
    mockedListAllTagsInSpace.mockResolvedValueOnce([
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

describe('searchPages — fuzzy matching', () => {
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
