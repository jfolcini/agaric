/**
 * The search stub (#6529): a case-insensitive substring match on a block's
 * text, in id order, scoped to the spaces the filter names, with the limits
 * validated as the backend validates them.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { clearMock, id, setSpace } from '@/lib/tauri-mock/__tests__/mock-store-helpers'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock } from '@/lib/tauri-mock/seed'

const SPACE_A = id('SPACEA')
const SPACE_B = id('SPACEB')
const SPACE_C = id('SPACEC')
const ALL_SPACES = { kind: 'all_spaces' }

interface SearchResponse {
  items: Array<Record<string, unknown>>
  next_cursor: string | null
  has_more: boolean
  total_count: number | null
}

interface PartitionedResponse {
  pages: SearchResponse
  blocks: SearchResponse
}

function partitioned(args: Record<string, unknown>): PartitionedResponse {
  return dispatch('search_blocks_partitioned', {
    pageLimit: 10,
    blockLimit: 10,
    ...args,
    filter: { scope: ALL_SPACES, ...(args['filter'] as Record<string, unknown> | undefined) },
  }) as PartitionedResponse
}

function ids(res: SearchResponse): string[] {
  return res.items.map((b) => b['id'] as string)
}

describe('search_blocks — a substring match in id order', () => {
  const PAGE = id('STB1')
  const ONCE = id('STB2')
  const DENSE = id('STB3')
  const OTHER = id('STB4')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Widget Plans', null, 0))
    blocks.set(ONCE, makeBlock(ONCE, 'content', 'a long note that mentions a widget once', PAGE, 1))
    blocks.set(DENSE, makeBlock(DENSE, 'content', 'WIDGET widget', PAGE, 2))
    blocks.set(OTHER, makeBlock(OTHER, 'content', 'nothing to see', PAGE, 3))
  })

  function search(query: string): SearchResponse {
    return dispatch('search_blocks', {
      query,
      limit: 50,
      filter: { scope: ALL_SPACES },
    }) as SearchResponse
  }

  it('matches a page title and block content in any case, in id order with no ranking', () => {
    // DENSE is the closer match, and still comes after ONCE.
    expect(ids(search('wIdGeT'))).toEqual([PAGE, ONCE, DENSE])
  })

  it('answers a blank query with nothing', () => {
    expect(ids(search('  '))).toEqual([])
  })

  it('splits the same matches into the two partitions', () => {
    const res = partitioned({ query: 'widget' })
    expect(ids(res.pages)).toEqual([PAGE])
    expect(ids(res.blocks)).toEqual([PAGE, ONCE, DENSE])
  })
})

describe('search_blocks — the scope is an explicit choice (#5415)', () => {
  const PAGE_A = id('QSS1')
  const PAGE_B = id('QSS2')
  const PAGE_C = id('QSS3')

  beforeEach(() => {
    clearMock()
    for (const [page, space] of [
      [PAGE_A, SPACE_A],
      [PAGE_B, SPACE_B],
      [PAGE_C, SPACE_C],
    ] as const) {
      blocks.set(page, makeBlock(page, 'page', 'Gizmo Roadmap', null, 0))
      setSpace(page, space)
    }
  })

  function search(filter: Record<string, unknown>): SearchResponse {
    return dispatch('search_blocks', { query: 'gizmo', limit: 50, filter }) as SearchResponse
  }

  it('covers exactly the listed spaces', () => {
    const res = search({ scope: { kind: 'spaces', space_ids: [SPACE_A, SPACE_B] } })
    expect(ids(res).toSorted()).toEqual([PAGE_A, PAGE_B].toSorted())
  })

  it('covers every space on all_spaces', () => {
    const res = search({ scope: ALL_SPACES })
    expect(ids(res).toSorted()).toEqual([PAGE_A, PAGE_B, PAGE_C].toSorted())
  })

  it.each([
    ['an omitted scope', {}],
    ['an empty spaces list', { scope: { kind: 'spaces', space_ids: [] } }],
    ['a SpaceScope', { scope: { kind: 'active', space_id: SPACE_A } }],
  ])('refuses %s with a validation error, as the backend fails to deserialize it', (_, filter) => {
    expect(() => search(filter)).toThrow(expect.objectContaining({ kind: 'validation' }))
    expect(() => partitionedWithFilter(filter)).toThrow(
      expect.objectContaining({ kind: 'validation' }),
    )
  })

  function partitionedWithFilter(filter: Record<string, unknown>): PartitionedResponse {
    return dispatch('search_blocks_partitioned', {
      query: 'gizmo',
      pageLimit: 10,
      blockLimit: 10,
      filter,
    }) as PartitionedResponse
  }
})

describe('search_blocks_partitioned — validates limits to [0, 100] (#4065)', () => {
  const PAGE = id('QSB1')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'gizmo page', null, 0))
  })

  it('rejects an over-cap blockLimit instead of silently serving it', () => {
    expect(() => partitioned({ query: 'gizmo', pageLimit: 10, blockLimit: 101 })).toThrow(
      expect.objectContaining({
        kind: 'validation',
        message:
          'partitioned search limits must each be in [0, 100]; got page_limit=10, block_limit=101',
      }),
    )
  })

  it('rejects an over-cap pageLimit too', () => {
    expect(() => partitioned({ query: 'gizmo', pageLimit: 150, blockLimit: 10 })).toThrow(
      expect.objectContaining({
        kind: 'validation',
        message:
          'partitioned search limits must each be in [0, 100]; got page_limit=150, block_limit=10',
      }),
    )
  })

  // The other half of the pair: zero is legal HERE (unlike `search_blocks`).
  it('still accepts a zero limit', () => {
    expect(() => partitioned({ query: 'gizmo', pageLimit: 0, blockLimit: 0 })).not.toThrow()
  })
})
