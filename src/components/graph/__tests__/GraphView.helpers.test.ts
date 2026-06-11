/**
 * Tests for GraphView.helpers.fetchGraphData.
 *
 * Verifies the all-pages-in-space fetch, the page/link/template join,
 * the backlink-count computation, and the tag-filter pass-through.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchGraphData } from '@/components/graph/GraphView.helpers'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('fetchGraphData', () => {
  it('calls list_all_pages_in_space with tagIds=null when no tag filter', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve([])
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    const result = await fetchGraphData([], null)

    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_all_pages_in_space',
      expect.objectContaining({ spaceId: '', tagIds: null }),
    )
    // No legacy paths.
    expect(mockedInvoke).not.toHaveBeenCalledWith('list_blocks', expect.anything())
    expect(mockedInvoke).not.toHaveBeenCalledWith('query_by_tags', expect.anything())
  })

  it('threads a single tag id through tagIds', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve([])
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    await fetchGraphData(['tag-a'], null)

    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_all_pages_in_space',
      expect.objectContaining({ tagIds: ['tag-a'] }),
    )
  })

  it('threads multiple tag ids through tagIds', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve([])
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    await fetchGraphData(['tag-a', 'tag-b'], null)

    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_all_pages_in_space',
      expect.objectContaining({ tagIds: ['tag-a', 'tag-b'] }),
    )
  })

  it('passes tagIds to listPageLinks when a tag filter is active (Tier 4.5)', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve([])
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    await fetchGraphData(['tag-a', 'tag-b'], null)

    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_page_links',
      expect.objectContaining({ tagIds: ['tag-a', 'tag-b'] }),
    )
  })

  it('passes tagIds=null to listPageLinks when no tag filter is active (Tier 4.5)', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve([])
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    await fetchGraphData([], null)

    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_page_links',
      expect.objectContaining({ tagIds: null }),
    )
  })

  it('populates is_template for pages flagged as templates', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space')
        return Promise.resolve([
          { id: 'page-1', content: 'Page One' },
          { id: 'page-2', content: 'Template Page' },
        ])
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve(['page-2'])
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
      if (cmd === 'list_all_pages_in_space')
        return Promise.resolve([
          { id: 'page-1', content: 'Page One' },
          { id: 'page-2', content: 'Page Two' },
          { id: 'page-3', content: 'Page Three' },
        ])
      if (cmd === 'list_page_links')
        return Promise.resolve([
          { source_id: 'page-1', target_id: 'page-2', ref_count: 1 },
          { source_id: 'page-3', target_id: 'page-2', ref_count: 2 },
          { source_id: 'page-1', target_id: 'page-3', ref_count: 1 },
          { source_id: 'page-1', target_id: 'unknown', ref_count: 1 },
        ])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
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
      if (cmd === 'list_all_pages_in_space')
        return Promise.resolve([{ id: 'page-1', content: 'Page One' }])
      if (cmd === 'list_page_links')
        return Promise.resolve([
          { source_id: 'page-1', target_id: 'missing', ref_count: 1 },
          { source_id: 'missing', target_id: 'page-1', ref_count: 1 },
        ])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    const result = await fetchGraphData([], null)
    expect(result.edges).toHaveLength(0)
  })

  it('falls back to "Untitled" for missing or empty content', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space')
        return Promise.resolve([
          { id: 'page-1', content: '' },
          { id: 'page-2', content: null },
        ])
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    const result = await fetchGraphData([], null)
    expect(result.nodes.map((n) => n.label)).toEqual(['Untitled', 'Untitled'])
  })

  it('rejects when any concurrent fetch fails', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space')
        return Promise.resolve([{ id: 'page-1', content: 'Page One' }])
      if (cmd === 'list_page_links') return Promise.reject(new Error('boom'))
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    await expect(fetchGraphData([], null)).rejects.toThrow('boom')
  })
})
