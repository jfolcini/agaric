/**
 * A search asked again after an edit reads the backend again.
 *
 * A content edit fires no `block:properties-changed`, so the query key of a
 * search already answered is unchanged when the user asks it again; served
 * from cache, it listed a block for a word the block no longer held. Driven
 * through the in-memory backend model (`src/lib/tauri-mock`), whose
 * `search_blocks` reads the blocks as they are now.
 */

import { invoke } from '@tauri-apps/api/core'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSearchResults } from '@/components/SearchPanel/useSearchResults'
import { queryClient } from '@/lib/query-client'
import { parse } from '@/lib/search-query'
import { SEED_IDS } from '@/lib/tauri-mock'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'

const SPACE = 'SPACE_PERSONAL'
const BLOCK = SEED_IDS.BLOCK_QN_1
const toggles = { caseSensitive: false, wholeWord: false, isRegex: false }

function useSearch({ query }: { query: string }) {
  return useSearchResults({
    debouncedAst: parse(query),
    debouncedQuery: query,
    currentSpaceId: SPACE,
    spaceIsReady: true,
    toggles,
  })
}

beforeEach(() => {
  seedBlocks()
  queryClient.clear()
  vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
    try {
      return Promise.resolve(dispatch(cmd, args)) as Promise<never>
    } catch (err) {
      return Promise.reject(err) as Promise<never>
    }
  })
})

describe('useSearchResults after a content edit', () => {
  it('drops a block from a repeated search once its content lost the word', async () => {
    dispatch('edit_block', { blockId: BLOCK, toText: 'a quartz note' })
    const { result, rerender } = renderHook(useSearch, { initialProps: { query: 'quartz' } })
    await waitFor(() => expect(result.current.results.map((row) => row.id)).toEqual([BLOCK]))

    dispatch('edit_block', { blockId: BLOCK, toText: 'a violet note' })
    rerender({ query: 'violet' })
    await waitFor(() => expect(result.current.results.map((row) => row.id)).toEqual([BLOCK]))
    rerender({ query: 'quartz' })

    await waitFor(() => expect(result.current.results).toEqual([]))
  })
})
