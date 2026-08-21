/**
 * Tests for useBacklinkResolution hook (#2635 — delegated to useResolveStore).
 *
 * Validates:
 *  - Real titles/statuses come from the shared `useResolveStore` (one cache).
 *  - Cache hit: an id already in the store is not re-resolved.
 *  - Unresolved ids (backend didn't return them) render as broken links
 *    (deleted status) WITHOUT polluting the shared store.
 *  - `clearCache()` does NOT wipe the shared store; it re-attempts resolution
 *    so a renamed target picks up its fresh title (#2628).
 *  - Tag fallback format; space-scoped resolution (#2543); error handling.
 */

import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #2927 phase 5 — the hook now calls the generated `commands.batchResolve`, so
// mocking only the `@/lib/tauri` wrapper no longer intercepts. Back the
// generated surface instead, resolving the same typed-result envelope `unwrap`
// expects.
const mockedBatchResolve = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      batchResolve: (...args: unknown[]) =>
        mockedBatchResolve(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

import { renderBlockRef } from '@/components/RichContentRenderer/marks/blockRef'
import { useBacklinkResolution } from '@/hooks/useBacklinkResolution'
import type { BacklinkGroup, BlockRow } from '@/lib/bindings'
import { resolveBlockDisplay } from '@/lib/query-result-utils'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

// 26-char uppercase ULIDs for matching the [0-9A-Z]{26} regex
const ULID_A = '01HAAAAA0000000000000000AA'
const ULID_B = '01HBBBBB0000000000000000BB'
const ULID_TAG = '01HTTTTT0000000000000000TT'

function makeGroup(blocks: Array<{ id: string; content: string | null }>): BacklinkGroup {
  return {
    page_id: 'P1',
    page_title: 'Source',
    blocks: blocks.map((b) => ({
      id: b.id,
      block_type: 'content',
      content: b.content,
      parent_id: 'P1',
      position: 1,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
    })),
  }
}

const initialSpaceState = useSpaceStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  // Fresh shared store per test — the hook now delegates all real resolution
  // to `useResolveStore`, so isolate its cache between cases.
  useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
  // Default: no active space — `keyFor(null, id)` resolves to the
  // `__global__::id` slot so existing tests behave as before.
  useSpaceStore.setState({ ...initialSpaceState, currentSpaceId: null })
})

afterEach(() => {
  vi.useRealTimers()
  useSpaceStore.setState({ ...initialSpaceState })
})

describe('useBacklinkResolution', () => {
  it('returns fallback titles when groups have no ULID tokens', () => {
    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: 'plain text' }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    expect(result.current.resolveBlockTitle('UNKNOWN_ID')).toBe('[[UNKNOWN_...]]')
    expect(result.current.resolveTagName('UNKNOWN_ID')).toBe('#UNKNOWN_...')
    expect(result.current.resolveBlockStatus('UNKNOWN_ID')).toBe('active')
  })

  it('resolves ULID tokens via batchResolve on cache miss', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'My Page', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [
      makeGroup([{ id: 'B1', content: `Link to [[${ULID_A}]] here` }]),
    ]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith([ULID_A], { kind: 'global' })
    })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('My Page')
    })
    expect(result.current.resolveBlockStatus(ULID_A)).toBe('active')
  })

  it('writes real resolutions into the shared useResolveStore (single cache)', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Shared Title', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    renderHook(() => useBacklinkResolution(groups))

    // The resolution is visible to ANY other consumer of the shared store,
    // not just via the hook — proving there is one cache, not two.
    await waitFor(() => {
      expect(useResolveStore.getState().resolveTitle(ULID_A)).toBe('Shared Title')
    })
    expect(useResolveStore.getState().has(ULID_A)).toBe(true)
  })

  it('reads a title already present in the shared store without invoking batchResolve', async () => {
    // Pre-seed the shared store, as if another consumer already resolved it.
    useResolveStore.getState().set(ULID_A, 'Preseeded Title', false)

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    expect(result.current.resolveBlockTitle(ULID_A)).toBe('Preseeded Title')
    // Already in the store → no IPC.
    await waitFor(() => {
      expect(mockedBatchResolve).not.toHaveBeenCalled()
    })
  })

  it('returns cached value without invoking on cache hit', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Cached Title', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result, rerender } = renderHook(({ g }) => useBacklinkResolution(g), {
      initialProps: { g: groups },
    })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('Cached Title')
    })

    mockedBatchResolve.mockClear()

    // Re-render with same ULID — now in the store, so no re-resolve.
    rerender({ g: [...groups] })

    await waitFor(() => {
      expect(mockedBatchResolve).not.toHaveBeenCalled()
    })
    expect(result.current.resolveBlockTitle(ULID_A)).toBe('Cached Title')
  })

  it('resolves tag tokens with #[] syntax', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_TAG, title: 'important', block_type: 'tag', deleted: false },
    ])

    const groups: BacklinkGroup[] = [
      makeGroup([{ id: 'B1', content: `Tagged #[${ULID_TAG}] content` }]),
    ]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(result.current.resolveTagName(ULID_TAG)).toBe('important')
    })
  })

  it('marks deleted blocks correctly', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Deleted Page', block_type: 'page', deleted: true },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(result.current.resolveBlockStatus(ULID_A)).toBe('deleted')
    })
    expect(result.current.resolveBlockTitle(ULID_A)).toBe('Deleted Page')
  })

  it('renders a broken link for IDs not returned by batchResolve WITHOUT polluting the store', async () => {
    // batchResolve returns empty — ULID_A not found (foreign-space / deleted).
    mockedBatchResolve.mockResolvedValue([])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalled()
    })

    await waitFor(() => {
      // Broken-link fallback title + deleted status (backlink-local).
      expect(result.current.resolveBlockTitle(ULID_A)).toBe(`[[${ULID_A.slice(0, 8)}...]]`)
    })
    expect(result.current.resolveBlockStatus(ULID_A)).toBe('deleted')

    // The unresolved id must NOT have leaked into the app-wide store — that
    // would corrupt the cache for every other consumer (#2635).
    expect(useResolveStore.getState().has(ULID_A)).toBe(false)
    expect(useResolveStore.getState().cache.size).toBe(0)
  })

  it('clearCache re-attempts resolution so a renamed target picks up its fresh title (#2628)', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Old Title', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result, rerender } = renderHook(({ g }) => useBacklinkResolution(g), {
      initialProps: { g: groups },
    })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('Old Title')
    })

    // Target was renamed on the backend.
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'New Title', block_type: 'page', deleted: false },
    ])

    // clearCache does NOT wipe the shared store (still holds "Old Title")...
    act(() => {
      result.current.clearCache()
    })
    expect(useResolveStore.getState().resolveTitle(ULID_A)).toBe('Old Title')

    // ...but it latches a forced re-resolve: the next groups change re-fetches
    // even though the id is already cached, refreshing the store to "New Title".
    rerender({ g: [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])] })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('New Title')
    })
    expect(useResolveStore.getState().resolveTitle(ULID_A)).toBe('New Title')
  })

  it('clearCache does not clear the shared store for other consumers', async () => {
    // A sibling consumer's entry lives in the shared store.
    useResolveStore.getState().set(ULID_B, 'Sibling Page', false)

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: 'plain text' }])]
    const { result } = renderHook(() => useBacklinkResolution(groups))

    act(() => {
      result.current.clearCache()
    })

    // The sibling's cached title survives clearCache().
    expect(useResolveStore.getState().resolveTitle(ULID_B)).toBe('Sibling Page')
  })

  it('handles batchResolve errors gracefully', async () => {
    mockedBatchResolve.mockRejectedValue(new Error('network error'))

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalled()
    })

    // Should not throw — returns fallback, active (not marked deleted on error).
    expect(result.current.resolveBlockTitle(ULID_A)).toBe(`[[${ULID_A.slice(0, 8)}...]]`)
    expect(result.current.resolveBlockStatus(ULID_A)).toBe('active')
  })

  it('resolves multiple ULIDs in a single batch', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Page A', block_type: 'page', deleted: false },
      { id: ULID_B, title: 'Page B', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [
      makeGroup([{ id: 'B1', content: `[[${ULID_A}]] and [[${ULID_B}]]` }]),
    ]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith(expect.arrayContaining([ULID_A, ULID_B]), {
        kind: 'global',
      })
    })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('Page A')
    })
    expect(result.current.resolveBlockTitle(ULID_B)).toBe('Page B')
  })

  it('skips blocks with null content', async () => {
    mockedBatchResolve.mockResolvedValue([])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: null }])]

    renderHook(() => useBacklinkResolution(groups))

    // batchResolve should not be called since there are no ULIDs to resolve.
    await waitFor(() => {
      expect(mockedBatchResolve).not.toHaveBeenCalled()
    })
  })

  it('uses tag fallback format for tags without titles', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_TAG, title: null, block_type: 'tag', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `#[${ULID_TAG}]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(result.current.resolveTagName(ULID_TAG)).toBe(`#${ULID_TAG.slice(0, 8)}...`)
    })
  })

  it('returns different titles for the same ULID in two spaces (space-scoped store)', async () => {
    // Same backlink id resolves to different titles in two different spaces.
    // The shared store is composite-keyed by space, so switching spaces is a
    // cache miss that re-resolves, and switching back is a hit.
    useSpaceStore.setState({ ...initialSpaceState, currentSpaceId: 'SPACE_AAAA' })

    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Title in A', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('Title in A')
    })
    expect(mockedBatchResolve).toHaveBeenCalledTimes(1)

    // Switch space — cache miss under `keyFor('SPACE_BBBB', ULID_A)`.
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Title in B', block_type: 'page', deleted: false },
    ])
    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_BBBB' })
    })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('Title in B')
    })
    expect(mockedBatchResolve).toHaveBeenCalledTimes(2)

    // Switch back to space A — still cached, no third IPC.
    mockedBatchResolve.mockClear()
    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_AAAA' })
    })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('Title in A')
    })
    expect(mockedBatchResolve).not.toHaveBeenCalled()
  })

  // #2543 — scope resolution to the active space, not the literal 'global'.
  it('scopes batchResolve to the active space instead of the literal global (#2543)', async () => {
    useSpaceStore.setState({ ...initialSpaceState, currentSpaceId: 'SPACE_AAAA' })

    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Title in A', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith([ULID_A], {
        kind: 'active',
        space_id: 'SPACE_AAAA',
      })
    })
    expect(mockedBatchResolve).not.toHaveBeenCalledWith([ULID_A], { kind: 'global' })
  })

  it('falls back to global scope when there is no active space', async () => {
    // Default beforeEach state: currentSpaceId is null.
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Some Title', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith([ULID_A], { kind: 'global' })
    })
  })

  it('does not re-fetch an id that was already attempted-but-unresolved', async () => {
    mockedBatchResolve.mockResolvedValue([])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]
    const { rerender } = renderHook(({ g }) => useBacklinkResolution(g), {
      initialProps: { g: groups },
    })

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledTimes(1)
    })

    // Re-render with a new groups reference containing the same unresolved id —
    // the attempted-unresolved set suppresses a redundant IPC.
    rerender({ g: [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])] })

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledTimes(1)
    })
  })
})

/**
 * #4228 — this hook is the FOURTH writer of the shared resolve store's block
 * title (`storeTitle` → `batchSet`), alongside the three seeders covered by
 * `@/components/block-tree/__tests__/resolve-store-title-seed-parity.test.ts`.
 *
 * `batch_resolve` returns the RAW `content` column as `title` (untruncated,
 * possibly multi-line), and since #4228 `renderBlockRef` no longer re-derives
 * its own first line and cap — it renders the stored value verbatim into the
 * chip's text node, its deleted `aria-label` and its hover tooltip. So the
 * bound has to come from the seed here, or an id first seeded by the backlink
 * path renders unbounded raw content. The CSS `nowrap`/`ellipsis` masks the
 * chip visually; the announced `aria-label` and the tooltip are unmasked.
 *
 * The symmetric arm matters just as much: a resolved-but-BLANK row must keep
 * the `[[id...]]` placeholder rather than being normalised into "Untitled",
 * because `resolveBlockDisplay` (`@/lib/query-result-utils`) pattern-matches
 * exactly that shape to detect a cache miss and fall back to the block's own
 * content.
 */
describe('useBacklinkResolution — stored title is normalised at the seed (#4228)', () => {
  /** A chip rendered through the real renderer, wired to the hook's resolvers. */
  function renderChip(resolution: {
    resolveBlockTitle: (id: string) => string
    resolveBlockStatus: (id: string) => 'active' | 'deleted'
  }): HTMLElement {
    render(
      renderBlockRef({ type: 'block_ref', attrs: { id: ULID_A } }, 'k', {
        interactive: true,
        resolveBlockTitle: resolution.resolveBlockTitle,
        resolveBlockStatus: resolution.resolveBlockStatus,
      }),
    )
    return screen.getByTestId('block-ref-chip')
  }

  function makeBlockRow(overrides: Partial<BlockRow>): BlockRow {
    return {
      id: ULID_A,
      block_type: 'content',
      content: '',
      parent_id: null,
      position: 0,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      ...overrides,
    } as BlockRow
  }

  it('renders a bounded, single-line chip AND aria-label for multi-line backend content', async () => {
    // What `batch_resolve` actually hands back: `b.content AS title`, raw.
    const rawContent = `${'A'.repeat(80)}\nsecond line of the block\nthird line`
    // What the shared normaliser stores for it: first line, capped 57 + '...'.
    const expectedTitle = `${'A'.repeat(57)}...`

    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: rawContent, block_type: 'content', deleted: true },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]
    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(useResolveStore.getState().has(ULID_A)).toBe(true)
    })

    const chip = renderChip(result.current)

    // The chip's TEXT NODE (what a copy/paste or a screen reader walking the
    // text picks up), not just what CSS happens to clip. Asserted BEFORE the
    // store so a regression's failure output shows the rendered damage.
    const chipText = chip.textContent ?? ''
    expect(chipText).not.toContain('\n')
    expect(chipText.length).toBeLessThanOrEqual(60)
    expect(chipText).toBe(expectedTitle)

    // The deleted `aria-label` is announced in full — CSS truncation does not
    // touch it, so its bound has to come from the stored title.
    const ariaLabel = chip.getAttribute('aria-label') ?? ''
    expect(ariaLabel).not.toContain('\n')
    expect(ariaLabel.length).toBeLessThanOrEqual(60 + ' (deleted)'.length)
    expect(ariaLabel).toBe(`${expectedTitle} (deleted)`)

    // And the seed itself — the raw multi-line content never reaches the store.
    expect(useResolveStore.getState().cache.get(keyFor(null, ULID_A))?.title).toBe(expectedTitle)
  })

  it('keeps the [[id...]] placeholder for a resolved-but-blank block so cache-miss detection still fires', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: '', block_type: 'content', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]
    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(useResolveStore.getState().has(ULID_A)).toBe(true)
    })

    // The load-bearing consequence, asserted through the real consumer rather
    // than a copy of its private regex: `resolveBlockDisplay` must still see a
    // cache miss and fall back to the block's own content. Normalising the
    // blank row into "Untitled" would make it look resolved and swallow the
    // content fallback — so this is asserted FIRST, ahead of the shape pins.
    const row = makeBlockRow({ content: 'the row own content' })
    expect(resolveBlockDisplay(row, new Map(), result.current.resolveBlockTitle).title).toBe(
      'the row own content',
    )

    const fallback = `[[${ULID_A.slice(0, 8)}...]]`
    expect(result.current.resolveBlockTitle(ULID_A)).toBe(fallback)
    expect(useResolveStore.getState().cache.get(keyFor(null, ULID_A))?.title).toBe(fallback)
  })

  it('keeps the #id... placeholder for a resolved-but-blank tag', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_TAG, title: null, block_type: 'tag', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `#[${ULID_TAG}]` }])]
    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(useResolveStore.getState().has(ULID_TAG)).toBe(true)
    })
    expect(result.current.resolveTagName(ULID_TAG)).toBe(`#${ULID_TAG.slice(0, 8)}...`)
  })

  it('leaves a short single-line title byte-identical (no gratuitous rewrite)', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'a real short title', block_type: 'content', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]
    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('a real short title')
    })
  })
})

// Reference `keyFor` so the import is exercised by a lightweight sanity check
// (the hook keys its attempted-unresolved set with the same helper).
describe('useBacklinkResolution — key encoding', () => {
  it('uses the shared composite key encoding', () => {
    expect(keyFor(null, ULID_A)).toBe(`__global__::${ULID_A}`)
    expect(keyFor('SPACE_AAAA', ULID_A)).toBe(`SPACE_AAAA::${ULID_A}`)
  })
})
