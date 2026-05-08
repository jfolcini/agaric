/**
 * Tests for GraphView.helpers.fetchGraphData (MAINT-56).
 *
 * Verifies the tag-dimension fetch branching (no tag / single tag / multi tag),
 * the page/link/template join, and the backlink-count computation.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchGraphData } from '../GraphView.helpers'

const mockedInvoke = vi.mocked(invoke)
const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('fetchGraphData', () => {
  it('uses listBlocks with blockType=page when no tag filter', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.resolve(emptyPage)
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'query_by_property') return Promise.resolve(emptyPage)
      return Promise.resolve(null)
    })

    const result = await fetchGraphData([], null)

    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
    expect(result.hasMore).toBe(false)
    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_blocks',
      expect.objectContaining({ blockType: 'page', tagId: null }),
    )
    expect(mockedInvoke).not.toHaveBeenCalledWith('query_by_tags', expect.anything())
  })

  it('uses listBlocks with tagId when a single tag filter is provided', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.resolve(emptyPage)
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'query_by_property') return Promise.resolve(emptyPage)
      return Promise.resolve(null)
    })

    await fetchGraphData(['tag-a'], null)

    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_blocks',
      expect.objectContaining({ tagId: 'tag-a' }),
    )
  })

  it('uses queryByTags (OR mode, blockType=page) when multiple tag filters are provided', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'query_by_tags') return Promise.resolve(emptyPage)
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'query_by_property') return Promise.resolve(emptyPage)
      return Promise.resolve(null)
    })

    await fetchGraphData(['tag-a', 'tag-b'], null)

    // PEND-35 Tier 2.9 — `blockType: 'page'` is pushed into SQL so the
    // unbounded `limit:5000` over-fetch can no longer ship up to 5000
    // non-page rows for the renderer to discard.
    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_tags',
      expect.objectContaining({
        tagIds: ['tag-a', 'tag-b'],
        prefixes: [],
        mode: 'or',
        blockType: 'page',
      }),
    )
  })

  it('passes tagIds to listPageLinks when a tag filter is active (Tier 4.5)', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.resolve(emptyPage)
      if (cmd === 'query_by_tags') return Promise.resolve(emptyPage)
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'query_by_property') return Promise.resolve(emptyPage)
      return Promise.resolve(null)
    })

    await fetchGraphData(['tag-a', 'tag-b'], null)

    // PEND-35 Tier 4.5 — tag filter pushed into list_page_links so the
    // backend ships only edges whose target page carries one of the
    // requested tags.
    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_page_links',
      expect.objectContaining({ tagIds: ['tag-a', 'tag-b'] }),
    )
  })

  it('passes tagIds=null to listPageLinks when no tag filter is active (Tier 4.5)', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.resolve(emptyPage)
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'query_by_property') return Promise.resolve(emptyPage)
      return Promise.resolve(null)
    })

    await fetchGraphData([], null)

    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_page_links',
      expect.objectContaining({ tagIds: null }),
    )
  })

  it('does not post-filter non-page blocks when a tag filter is active (Tier 2.9)', async () => {
    // PEND-35 Tier 2.9 — `queryByTags` now applies `block_type = 'page'`
    // server-side. The mock's `query_by_tags` honours `blockType` so the
    // result is already shape-restricted by the time it reaches
    // `fetchGraphData`. The previous JS post-filter is gone.
    const onlyPages = {
      items: [
        { id: 'page-1', content: 'Page One', block_type: 'page' },
        { id: 'page-2', content: 'Page Two', block_type: 'page' },
      ],
      next_cursor: null,
      has_more: false,
    }

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'query_by_tags') return Promise.resolve(onlyPages)
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'query_by_property') return Promise.resolve(emptyPage)
      return Promise.resolve(null)
    })

    const result = await fetchGraphData(['tag-a', 'tag-b'], null)

    expect(result.nodes).toHaveLength(2)
    expect(result.nodes.map((n) => n.id)).toEqual(['page-1', 'page-2'])
  })

  it('does not filter when there is no tag filter (trusts the server)', async () => {
    const mixedResponse = {
      items: [
        { id: 'page-1', content: 'Page One', block_type: 'page' },
        { id: 'block-1', content: 'Heading', block_type: 'heading' },
      ],
      next_cursor: null,
      has_more: false,
    }

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.resolve(mixedResponse)
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'query_by_property') return Promise.resolve(emptyPage)
      return Promise.resolve(null)
    })

    const result = await fetchGraphData([], null)

    expect(result.nodes).toHaveLength(2)
  })

  it('populates is_template for pages flagged as templates', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks')
        return Promise.resolve({
          items: [
            { id: 'page-1', content: 'Page One', block_type: 'page' },
            { id: 'page-2', content: 'Template Page', block_type: 'page' },
          ],
          next_cursor: null,
          has_more: false,
        })
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'query_by_property')
        return Promise.resolve({
          items: [{ id: 'page-2' }],
          next_cursor: null,
          has_more: false,
        })
      return Promise.resolve(null)
    })

    const result = await fetchGraphData([], null)

    const page1 = result.nodes.find((n) => n.id === 'page-1')
    const page2 = result.nodes.find((n) => n.id === 'page-2')
    expect(page1?.is_template).toBe(false)
    expect(page2?.is_template).toBe(true)
  })

  it('computes backlink_count by counting incoming edges between known nodes', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks')
        return Promise.resolve({
          items: [
            { id: 'page-1', content: 'Page One', block_type: 'page' },
            { id: 'page-2', content: 'Page Two', block_type: 'page' },
            { id: 'page-3', content: 'Page Three', block_type: 'page' },
          ],
          next_cursor: null,
          has_more: false,
        })
      if (cmd === 'list_page_links')
        return Promise.resolve([
          { source_id: 'page-1', target_id: 'page-2', ref_count: 1 },
          { source_id: 'page-3', target_id: 'page-2', ref_count: 2 },
          { source_id: 'page-1', target_id: 'page-3', ref_count: 1 },
          { source_id: 'page-1', target_id: 'unknown', ref_count: 1 },
        ])
      if (cmd === 'query_by_property') return Promise.resolve(emptyPage)
      return Promise.resolve(null)
    })

    const result = await fetchGraphData([], null)
    const byId = new Map(result.nodes.map((n) => [n.id, n]))
    expect(byId.get('page-1')?.backlink_count).toBe(0)
    expect(byId.get('page-2')?.backlink_count).toBe(2)
    expect(byId.get('page-3')?.backlink_count).toBe(1)
  })

  it('drops edges referencing unknown nodes', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks')
        return Promise.resolve({
          items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
          next_cursor: null,
          has_more: false,
        })
      if (cmd === 'list_page_links')
        return Promise.resolve([
          { source_id: 'page-1', target_id: 'missing', ref_count: 1 },
          { source_id: 'missing', target_id: 'page-1', ref_count: 1 },
        ])
      if (cmd === 'query_by_property') return Promise.resolve(emptyPage)
      return Promise.resolve(null)
    })

    const result = await fetchGraphData([], null)
    expect(result.edges).toHaveLength(0)
  })

  it('falls back to "Untitled" for missing or empty content', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks')
        return Promise.resolve({
          items: [
            { id: 'page-1', content: '', block_type: 'page' },
            { id: 'page-2', content: null, block_type: 'page' },
          ],
          next_cursor: null,
          has_more: false,
        })
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'query_by_property') return Promise.resolve(emptyPage)
      return Promise.resolve(null)
    })

    const result = await fetchGraphData([], null)
    expect(result.nodes.map((n) => n.label)).toEqual(['Untitled', 'Untitled'])
  })

  it('propagates has_more from the pages response', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks')
        return Promise.resolve({
          items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
          next_cursor: 'c',
          has_more: true,
        })
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'query_by_property') return Promise.resolve(emptyPage)
      return Promise.resolve(null)
    })

    const result = await fetchGraphData([], null)
    expect(result.hasMore).toBe(true)
  })

  it('rejects when any concurrent fetch fails', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks')
        return Promise.resolve({
          items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
          next_cursor: null,
          has_more: false,
        })
      if (cmd === 'list_page_links') return Promise.reject(new Error('boom'))
      if (cmd === 'query_by_property') return Promise.resolve(emptyPage)
      return Promise.resolve(null)
    })

    await expect(fetchGraphData([], null)).rejects.toThrow('boom')
  })
})
