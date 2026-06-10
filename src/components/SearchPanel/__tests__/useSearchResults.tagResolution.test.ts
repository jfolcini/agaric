/**
 * Tests for the useSearchResults × useTagResolution interaction (#717).
 *
 * Pins the three behaviours the issue demands at the level where the
 * bug lived (the query gate + the filter-param projection):
 *  1. Mixed query + unresolvable tag (`meeting tag:#typo`) → the search
 *     fires WITH the matches-nothing sentinel, never as an unfiltered
 *     FTS query for "meeting".
 *  2. While tag resolution is in flight the search is HELD — zero
 *     `searchBlocks` calls, so no transient unfiltered flash.
 *  3. A valid tag resolves → the search fires with the resolved id, and
 *     the FIRST call already carries it.
 *
 * The AST comes from the real `parse()` so the test exercises the real
 * tagNames projection; the IPC layer is mocked at the `lib/tauri`
 * wrapper (same pattern as useAliasResolution.test.ts).
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/tauri')>()
  return {
    ...actual,
    searchBlocks: vi.fn(),
    listTagsByPrefix: vi.fn(),
    batchResolve: vi.fn(),
    getBlock: vi.fn(),
  }
})

import { parse } from '@/lib/search-query'

import { batchResolve, listTagsByPrefix, searchBlocks, type TagCacheRow } from '../../../lib/tauri'
import { UNRESOLVED_TAG_SENTINEL } from '../searchFilterParams'
import { useSearchResults } from '../useSearchResults'

const mockedSearchBlocks = vi.mocked(searchBlocks)
const mockedListTags = vi.mocked(listTagsByPrefix)
const mockedBatchResolve = vi.mocked(batchResolve)

const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }
const toggles = { caseSensitive: false, wholeWord: false, isRegex: false }

const wipTag: TagCacheRow = {
  tag_id: 'TAG_WIP',
  name: 'wip',
  usage_count: 1,
  updated_at: '2026-01-01T00:00:00Z',
}

function renderSearch(query: string) {
  // Parse once, outside the hook render, so `debouncedAst` stays
  // referentially stable across re-renders (mirrors SearchPanel's memo).
  const debouncedAst = parse(query)
  return renderHook(() =>
    useSearchResults({
      debouncedAst,
      debouncedQuery: query,
      currentSpaceId: 'SPACE_A',
      spaceIsReady: true,
      toggles,
    }),
  )
}

/** All `searchBlocks` payloads observed so far. */
function searchPayloads() {
  return mockedSearchBlocks.mock.calls.map((c) => c[0])
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockedSearchBlocks.mockResolvedValue(emptyPage)
  mockedBatchResolve.mockResolvedValue([])
})

describe('useSearchResults — tag resolution gating (#717)', () => {
  it('mixed query + unresolvable tag fires with the sentinel, never unfiltered', async () => {
    // The tag name resolves to nothing (typo'd / nonexistent tag).
    mockedListTags.mockResolvedValue([])

    renderSearch('meeting tag:#typo')

    await waitFor(() => {
      expect(mockedSearchBlocks).toHaveBeenCalled()
    })
    // EVERY call must carry the matches-nothing sentinel: the old
    // behaviour sent `tagIds: undefined` and returned all FTS matches
    // for "meeting" while the tag chip rendered as active.
    for (const payload of searchPayloads()) {
      expect(payload.tagIds).toEqual([UNRESOLVED_TAG_SENTINEL])
      expect(payload.query).toBe('meeting')
    }
  })

  it('holds the search while tag resolution is in flight (no unfiltered flash)', async () => {
    let resolveLookup!: (tags: TagCacheRow[]) => void
    mockedListTags.mockReturnValue(
      new Promise<TagCacheRow[]>((resolve) => {
        resolveLookup = resolve
      }),
    )

    renderSearch('meeting tag:#wip')

    // Give any (wrong) eager fetch a chance to fire before asserting.
    await act(async () => {
      await Promise.resolve()
    })
    expect(mockedSearchBlocks).not.toHaveBeenCalled()

    await act(async () => {
      resolveLookup([wipTag])
    })

    await waitFor(() => {
      expect(mockedSearchBlocks).toHaveBeenCalled()
    })
    // The FIRST call already carries the resolved id — there was never an
    // unfiltered intermediate.
    expect(searchPayloads()[0]?.tagIds).toEqual(['TAG_WIP'])
    expect(searchPayloads()[0]?.query).toBe('meeting')
  })

  it('applies the resolved tag id once resolution settles', async () => {
    mockedListTags.mockResolvedValue([wipTag])

    renderSearch('meeting tag:#wip')

    await waitFor(() => {
      expect(mockedSearchBlocks).toHaveBeenCalled()
    })
    for (const payload of searchPayloads()) {
      expect(payload.tagIds).toEqual(['TAG_WIP'])
    }
  })

  it('a query without tag filters fires immediately and untouched', async () => {
    renderSearch('meeting')

    await waitFor(() => {
      expect(mockedSearchBlocks).toHaveBeenCalled()
    })
    expect(mockedListTags).not.toHaveBeenCalled()
    expect(searchPayloads()[0]?.tagIds).toBeUndefined()
    expect(searchPayloads()[0]?.query).toBe('meeting')
  })
})
