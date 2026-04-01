/**
 * Tests for BacklinksPanel component.
 *
 * Validates:
 *  - Renders "Select a block" when blockId is null
 *  - Renders empty state when no backlinks found
 *  - Renders backlink items with type badge, content preview, truncated ID
 *  - Cursor-based pagination (Load more)
 *  - Calls query_backlinks_filtered with correct params
 *  - Passes filters and sort to query_backlinks_filtered
 *  - Resets pagination when filters change
 *  - Displays total count from response
 *  - Loads property keys on mount
 *  - Rich content rendering
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { BacklinksPanel } from '../BacklinksPanel'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

const mockedInvoke = vi.mocked(invoke)

function makeBlock(id: string, content: string, blockType = 'content') {
  return {
    id,
    block_type: blockType,
    content,
    parent_id: null,
    position: null,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
  }
}

const emptyResponse = { items: [], next_cursor: null, has_more: false, total_count: 0 }

/** Default mock: route invoke calls by command name. */
function mockInvokeWith(backlinksResponse: unknown, extras?: Record<string, unknown>) {
  // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
  mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
    if (cmd === 'query_backlinks_filtered') return backlinksResponse
    if (cmd === 'list_property_keys') return ['todo', 'priority']
    if (cmd === 'batch_resolve') return []
    if (extras?.[cmd] !== undefined) return extras[cmd]
    return emptyResponse
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('BacklinksPanel', () => {
  it('renders null blockId state', () => {
    render(<BacklinksPanel blockId={null} />)

    expect(screen.getByText('Select a block to see backlinks')).toBeInTheDocument()
  })

  it('renders empty state when no backlinks found', async () => {
    mockInvokeWith(emptyResponse)

    render(<BacklinksPanel blockId="BLOCK001" />)

    expect(await screen.findByText('No backlinks found')).toBeInTheDocument()
  })

  it('calls query_backlinks_filtered with correct params on mount', async () => {
    mockInvokeWith(emptyResponse)

    render(<BacklinksPanel blockId="BLOCK001" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('query_backlinks_filtered', {
        blockId: 'BLOCK001',
        filters: null,
        sort: null,
        cursor: null,
        limit: 50,
      })
    })
  })

  it('loads property keys on mount', async () => {
    mockInvokeWith(emptyResponse)

    render(<BacklinksPanel blockId="BLOCK001" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_property_keys')
    })
  })

  it('renders backlink items with type badge and content', async () => {
    const page = {
      items: [
        makeBlock('01HAAAAA00000000000001', 'Links to this block', 'content'),
        makeBlock('01HBBBBB00000000000002', 'Another reference', 'page'),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 2,
    }
    mockInvokeWith(page)

    render(<BacklinksPanel blockId="TARGET01" />)

    expect(await screen.findByText('Links to this block')).toBeInTheDocument()
    expect(screen.getByText('Another reference')).toBeInTheDocument()

    // Type badges
    expect(screen.getByText('content')).toBeInTheDocument()
    expect(screen.getByText('page')).toBeInTheDocument()

    // Truncated IDs (first 8 chars + ...)
    expect(screen.getByText('01HAAAAA...')).toBeInTheDocument()
    expect(screen.getByText('01HBBBBB...')).toBeInTheDocument()
  })

  it('shows Load More button when has_more is true', async () => {
    const page1 = {
      items: [makeBlock('B1', 'item 1')],
      next_cursor: 'cursor_page2',
      has_more: true,
      total_count: 2,
    }
    mockInvokeWith(page1)

    render(<BacklinksPanel blockId="TARGET01" />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()
  })

  it('loads next page with cursor when Load More is clicked', async () => {
    const user = userEvent.setup()
    const page1 = {
      items: [makeBlock('B1', 'item 1')],
      next_cursor: 'cursor_page2',
      has_more: true,
      total_count: 2,
    }
    const page2 = {
      items: [makeBlock('B2', 'item 2')],
      next_cursor: null,
      has_more: false,
      total_count: 2,
    }
    let callCount = 0
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'query_backlinks_filtered') {
        callCount++
        return callCount === 1 ? page1 : page2
      }
      if (cmd === 'list_property_keys') return ['todo', 'priority']
      return emptyResponse
    })

    render(<BacklinksPanel blockId="TARGET01" />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('query_backlinks_filtered', {
        blockId: 'TARGET01',
        filters: null,
        sort: null,
        cursor: 'cursor_page2',
        limit: 50,
      })
    })

    // Both items should be rendered
    expect(await screen.findByText('item 1')).toBeInTheDocument()
    expect(screen.getByText('item 2')).toBeInTheDocument()
  })

  it('reloads when blockId changes', async () => {
    mockInvokeWith(emptyResponse)

    const { rerender } = render(<BacklinksPanel blockId="BLOCK_A" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('query_backlinks_filtered', {
        blockId: 'BLOCK_A',
        filters: null,
        sort: null,
        cursor: null,
        limit: 50,
      })
    })

    rerender(<BacklinksPanel blockId="BLOCK_B" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('query_backlinks_filtered', {
        blockId: 'BLOCK_B',
        filters: null,
        sort: null,
        cursor: null,
        limit: 50,
      })
    })
  })

  it('has no a11y violations with items', async () => {
    const page = {
      items: [makeBlock('B1', 'accessible backlink')],
      next_cursor: null,
      has_more: false,
      total_count: 1,
    }
    mockInvokeWith(page)

    const { container } = render(<BacklinksPanel blockId="TARGET01" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with null blockId', async () => {
    const { container } = render(<BacklinksPanel blockId={null} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('handles error from queryBacklinksFiltered without crashing', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'query_backlinks_filtered') throw new Error('network failure')
      if (cmd === 'list_property_keys') return ['todo', 'priority']
      return emptyResponse
    })

    render(<BacklinksPanel blockId="BLOCK001" />)

    // Should render empty state (error caught), not crash
    await waitFor(() => {
      expect(screen.getByText('No backlinks found')).toBeInTheDocument()
    })

    // Should show error toast
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load backlinks')
    })
  })

  // -- Filter integration tests -----------------------------------------------

  describe('filters', () => {
    it('passes filters to query_backlinks_filtered when filter is added', async () => {
      const user = userEvent.setup()
      mockInvokeWith({
        items: [makeBlock('B1', 'some block')],
        next_cursor: null,
        has_more: false,
        total_count: 1,
      })

      render(<BacklinksPanel blockId="TARGET01" />)

      await screen.findByText('some block')

      // Add a BlockType filter via the filter builder
      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'type')
      await user.selectOptions(screen.getByLabelText('Block type value'), 'page')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      // Should call query_backlinks_filtered with the filter
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('query_backlinks_filtered', {
          blockId: 'TARGET01',
          filters: [{ type: 'BlockType', block_type: 'page' }],
          sort: null,
          cursor: null,
          limit: 50,
        })
      })
    })

    it('passes sort to query_backlinks_filtered', async () => {
      const user = userEvent.setup()
      mockInvokeWith({
        items: [makeBlock('B1', 'some block')],
        next_cursor: null,
        has_more: false,
        total_count: 1,
      })

      render(<BacklinksPanel blockId="TARGET01" />)

      await screen.findByText('some block')

      // Change sort via the sort control
      await user.selectOptions(screen.getByLabelText('Sort by'), 'Created')

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('query_backlinks_filtered', {
          blockId: 'TARGET01',
          filters: null,
          sort: { type: 'Created', dir: 'Desc' },
          cursor: null,
          limit: 50,
        })
      })
    })

    it('resets pagination when filters change', async () => {
      const user = userEvent.setup()
      let callCount = 0
      // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
      mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
        if (cmd === 'query_backlinks_filtered') {
          callCount++
          if (callCount === 1) {
            return {
              items: [makeBlock('B1', 'page one')],
              next_cursor: 'cursor_2',
              has_more: true,
              total_count: 2,
            }
          }
          return {
            items: [],
            next_cursor: null,
            has_more: false,
            total_count: 0,
          }
        }
        if (cmd === 'list_property_keys') return ['todo', 'priority']
        return emptyResponse
      })

      render(<BacklinksPanel blockId="TARGET01" />)

      await screen.findByText('page one')

      // Add filter — should reset cursor to null
      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'type')
      await user.selectOptions(screen.getByLabelText('Block type value'), 'page')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      // The second call should be with cursor: null (pagination reset)
      await waitFor(() => {
        const filteredCalls = mockedInvoke.mock.calls.filter(
          (c) => c[0] === 'query_backlinks_filtered',
        )
        const lastCall = filteredCalls[filteredCalls.length - 1]
        expect((lastCall[1] as Record<string, unknown>).cursor).toBeNull()
      })
    })

    it('displays total count from response', async () => {
      const user = userEvent.setup()
      mockInvokeWith({
        items: [makeBlock('B1', 'some block')],
        next_cursor: null,
        has_more: false,
        total_count: 5,
      })

      render(<BacklinksPanel blockId="TARGET01" />)

      await screen.findByText('some block')

      // Add a filter to make the count display visible
      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'type')
      await user.selectOptions(screen.getByLabelText('Block type value'), 'content')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      // Wait for the filter to be applied and count to update
      await waitFor(() => {
        // The filter count shows "Showing X of Y backlinks" when filters are active
        const countEl = document.querySelector('.filter-count')
        expect(countEl).toBeInTheDocument()
      })
    })

    it('renders filter builder toolbar', async () => {
      mockInvokeWith(emptyResponse)

      render(<BacklinksPanel blockId="TARGET01" />)

      await waitFor(() => {
        expect(screen.getByRole('toolbar', { name: /Backlink filters/i })).toBeInTheDocument()
      })
    })
  })

  // -- Rich content rendering (Bug 5 fix) ------------------------------------

  describe('rich content rendering', () => {
    const PAGE_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const TAG_ULID = '01BRZ3NDEKTSV4RRFFQ69G5FAV'

    it('renders [[ULID]] as a block-link chip with resolved title', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
      mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === 'query_backlinks_filtered') {
          return {
            items: [makeBlock('BL00000000000000000000001', `See [[${PAGE_ULID}]] for details`)],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          }
        }
        if (cmd === 'batch_resolve') {
          const ids = (args as { ids: string[] })?.ids ?? []
          return ids
            .filter((id: string) => id === PAGE_ULID)
            .map((id: string) => ({
              id,
              title: 'My Resolved Page',
              block_type: 'page',
              deleted: false,
            }))
        }
        if (cmd === 'list_property_keys') return ['todo', 'priority']
        return emptyResponse
      })

      const { container } = render(<BacklinksPanel blockId="TARGET01" />)

      await waitFor(() => {
        const chip = container.querySelector('.block-link-chip')
        expect(chip).toBeInTheDocument()
        expect(chip).toHaveTextContent('My Resolved Page')
      })

      // Surrounding text should also be rendered
      expect(screen.getByText(/See/)).toBeInTheDocument()
      expect(screen.getByText(/for details/)).toBeInTheDocument()
    })

    it('renders **bold** content with <strong> element', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'query_backlinks_filtered') {
          return {
            items: [makeBlock('BL00000000000000000000002', '**bold text** here')],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          }
        }
        if (cmd === 'list_property_keys') return ['todo', 'priority']
        return emptyResponse
      })

      const { container } = render(<BacklinksPanel blockId="TARGET01" />)

      await waitFor(() => {
        const strong = container.querySelector('strong')
        expect(strong).toBeInTheDocument()
        expect(strong).toHaveTextContent('bold text')
      })
    })

    it('renders #[ULID] as a tag-ref chip with resolved name', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
      mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === 'query_backlinks_filtered') {
          return {
            items: [makeBlock('BL00000000000000000000003', `Tagged #[${TAG_ULID}] here`)],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          }
        }
        if (cmd === 'batch_resolve') {
          const ids = (args as { ids: string[] })?.ids ?? []
          return ids
            .filter((id: string) => id === TAG_ULID)
            .map((id: string) => ({ id, title: 'Important', block_type: 'tag', deleted: false }))
        }
        if (cmd === 'list_property_keys') return ['todo', 'priority']
        return emptyResponse
      })

      const { container } = render(<BacklinksPanel blockId="TARGET01" />)

      await waitFor(() => {
        const chip = container.querySelector('.tag-ref-chip')
        expect(chip).toBeInTheDocument()
        expect(chip).toHaveTextContent('Important')
      })
    })

    it('calls batch_resolve for ULIDs found in backlink content', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'query_backlinks_filtered') {
          return {
            items: [makeBlock('BL00000000000000000000004', `Link to [[${PAGE_ULID}]]`)],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          }
        }
        if (cmd === 'batch_resolve') {
          return [{ id: PAGE_ULID, title: 'Resolved Title', block_type: 'page', deleted: false }]
        }
        if (cmd === 'list_property_keys') return ['todo', 'priority']
        return emptyResponse
      })

      render(<BacklinksPanel blockId="TARGET01" />)

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('batch_resolve', { ids: [PAGE_ULID] })
      })
    })

    it('shows truncated ULID fallback when batch_resolve fails', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'query_backlinks_filtered') {
          return {
            items: [makeBlock('BL00000000000000000000005', `Broken [[${PAGE_ULID}]]`)],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          }
        }
        if (cmd === 'batch_resolve') {
          throw new Error('not found')
        }
        if (cmd === 'list_property_keys') return ['todo', 'priority']
        return emptyResponse
      })

      const { container } = render(<BacklinksPanel blockId="TARGET01" />)

      await waitFor(() => {
        const chip = container.querySelector('.block-link-chip')
        expect(chip).toBeInTheDocument()
        // Fallback: [[first8chars...]]
        expect(chip).toHaveTextContent(`[[${PAGE_ULID.slice(0, 8)}...]]`)
      })
    })

    it('renders "(empty)" for blocks with null content', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'query_backlinks_filtered') {
          return {
            items: [
              {
                id: 'BLEMPTY0000000000000000001',
                block_type: 'content',
                content: null,
                parent_id: null,
                position: null,
                deleted_at: null,
                archived_at: null,
                is_conflict: false,
              },
            ],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          }
        }
        if (cmd === 'list_property_keys') return ['todo', 'priority']
        return emptyResponse
      })

      render(<BacklinksPanel blockId="TARGET01" />)

      expect(await screen.findByText('(empty)')).toBeInTheDocument()
    })

    it('resolves ULIDs from paginated Load more results', async () => {
      const ULID_P1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
      const ULID_P2 = '01CRZ3NDEKTSV4RRFFQ69G5FAV'
      let callCount = 0
      // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
      mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === 'query_backlinks_filtered') {
          callCount++
          if (callCount === 1) {
            return {
              items: [makeBlock('BL1AAAAAAAAAAAAAAAAAAAAAA', `See [[${ULID_P1}]]`)],
              next_cursor: 'cursor1',
              has_more: true,
              total_count: 2,
            }
          }
          return {
            items: [makeBlock('BL2BBBBBBBBBBBBBBBBBBBBBB', `Also [[${ULID_P2}]]`)],
            next_cursor: null,
            has_more: false,
            total_count: 2,
          }
        }
        if (cmd === 'batch_resolve') {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          const ids = ((args as any)?.ids as string[]) ?? []
          const results: Array<{
            id: string
            title: string
            block_type: string
            deleted: boolean
          }> = []
          for (const id of ids) {
            if (id === ULID_P1)
              results.push({ id, title: 'Page One', block_type: 'page', deleted: false })
            if (id === ULID_P2)
              results.push({ id, title: 'Page Two', block_type: 'page', deleted: false })
          }
          return results
        }
        if (cmd === 'list_property_keys') return ['todo', 'priority']
        return emptyResponse
      })

      const { container } = render(<BacklinksPanel blockId="TARGET01" />)

      // First page should resolve
      await waitFor(() => {
        expect(container.querySelector('.block-link-chip')).toHaveTextContent('Page One')
      })

      // Click Load more
      const loadMoreBtn = screen.getByText('Load more')
      await userEvent.click(loadMoreBtn)

      // Second page ULIDs should also resolve
      await waitFor(() => {
        const chips = container.querySelectorAll('.block-link-chip')
        expect(chips).toHaveLength(2)
        expect(chips[1]).toHaveTextContent('Page Two')
      })
    })

    it('handles batch_resolve network error without crashing', async () => {
      const BAD_ULID = '01ZZZ3NDEKTSV4RRFFQ69G5FAV'
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'query_backlinks_filtered') {
          return {
            items: [makeBlock('BL1CCCCCCCCCCCCCCCCCCCCCC', `See [[${BAD_ULID}]]`)],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          }
        }
        if (cmd === 'batch_resolve') {
          throw new Error('Network error')
        }
        if (cmd === 'list_property_keys') return ['todo', 'priority']
        return emptyResponse
      })

      const { container } = render(<BacklinksPanel blockId="TARGET01" />)

      // Should show fallback text, not crash
      await waitFor(() => {
        const chip = container.querySelector('.block-link-chip')
        expect(chip).toBeInTheDocument()
        expect(chip).toHaveTextContent(`[[${BAD_ULID.slice(0, 8)}...]]`)
      })
    })

    it('renders plain text backlinks without unnecessary batch_resolve calls', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'query_backlinks_filtered') {
          return {
            items: [makeBlock('BL1DDDDDDDDDDDDDDDDDDDDDD', 'Just plain text, no links')],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          }
        }
        if (cmd === 'batch_resolve') {
          throw new Error('Should not be called')
        }
        if (cmd === 'list_property_keys') return ['todo', 'priority']
        return emptyResponse
      })

      render(<BacklinksPanel blockId="TARGET01" />)

      await waitFor(() => {
        expect(screen.getByText('Just plain text, no links')).toBeInTheDocument()
      })
      // batch_resolve should NOT have been called since there are no ULID tokens
      expect(mockedInvoke).not.toHaveBeenCalledWith('batch_resolve', expect.anything())
    })

    it('has no a11y violations with rich content', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'query_backlinks_filtered') {
          return {
            items: [
              makeBlock('BL00000000000000000000006', `See **bold** and [[${PAGE_ULID}]] link`),
            ],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          }
        }
        if (cmd === 'batch_resolve') {
          return [{ id: PAGE_ULID, title: 'Accessible Page', block_type: 'page', deleted: false }]
        }
        if (cmd === 'list_property_keys') return ['todo', 'priority']
        return emptyResponse
      })

      const { container } = render(<BacklinksPanel blockId="TARGET01" />)

      // Wait for rich content to render (chip appears after resolution)
      await waitFor(() => {
        expect(container.querySelector('.block-link-chip')).toBeInTheDocument()
      })

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
