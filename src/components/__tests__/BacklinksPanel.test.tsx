/**
 * Tests for BacklinksPanel component.
 *
 * Validates:
 *  - Renders "Select a block" when blockId is null
 *  - Renders empty state when no backlinks found
 *  - Renders backlink items with type badge, content preview, truncated ID
 *  - Cursor-based pagination (Load more)
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

const emptyPage = { items: [], next_cursor: null, has_more: false }

/** Default mock: route invoke calls by command name. */
function mockInvokeWith(backlinksResponse: unknown, extras?: Record<string, unknown>) {
  // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
  mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
    if (cmd === 'get_backlinks') return backlinksResponse
    if (cmd === 'get_properties') return [] // no properties by default
    if (cmd === 'batch_resolve') return []
    if (extras?.[cmd] !== undefined) return extras[cmd]
    return emptyPage
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
    mockInvokeWith(emptyPage)

    render(<BacklinksPanel blockId="BLOCK001" />)

    expect(await screen.findByText('No backlinks found')).toBeInTheDocument()
  })

  it('calls get_backlinks with correct params on mount', async () => {
    mockInvokeWith(emptyPage)

    render(<BacklinksPanel blockId="BLOCK001" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_backlinks', {
        blockId: 'BLOCK001',
        cursor: null,
        limit: 50,
      })
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
    }
    const page2 = {
      items: [makeBlock('B2', 'item 2')],
      next_cursor: null,
      has_more: false,
    }
    let callCount = 0
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'get_backlinks') {
        callCount++
        return callCount === 1 ? page1 : page2
      }
      if (cmd === 'get_properties') return []
      return emptyPage
    })

    render(<BacklinksPanel blockId="TARGET01" />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_backlinks', {
        blockId: 'TARGET01',
        cursor: 'cursor_page2',
        limit: 50,
      })
    })

    // Both items should be rendered
    expect(await screen.findByText('item 1')).toBeInTheDocument()
    expect(screen.getByText('item 2')).toBeInTheDocument()
  })

  it('reloads when blockId changes', async () => {
    mockInvokeWith(emptyPage)

    const { rerender } = render(<BacklinksPanel blockId="BLOCK_A" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_backlinks', {
        blockId: 'BLOCK_A',
        cursor: null,
        limit: 50,
      })
    })

    rerender(<BacklinksPanel blockId="BLOCK_B" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_backlinks', {
        blockId: 'BLOCK_B',
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

  it('handles error from getBacklinks without crashing', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'get_backlinks') throw new Error('network failure')
      if (cmd === 'get_properties') return []
      return emptyPage
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

  // -- Rich content rendering (Bug 5 fix) ------------------------------------

  describe('rich content rendering', () => {
    const PAGE_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const TAG_ULID = '01BRZ3NDEKTSV4RRFFQ69G5FAV'

    it('renders [[ULID]] as a block-link chip with resolved title', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
      mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === 'get_backlinks') {
          return {
            items: [makeBlock('BL00000000000000000000001', `See [[${PAGE_ULID}]] for details`)],
            next_cursor: null,
            has_more: false,
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
        return emptyPage
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
        if (cmd === 'get_backlinks') {
          return {
            items: [makeBlock('BL00000000000000000000002', '**bold text** here')],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
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
        if (cmd === 'get_backlinks') {
          return {
            items: [makeBlock('BL00000000000000000000003', `Tagged #[${TAG_ULID}] here`)],
            next_cursor: null,
            has_more: false,
          }
        }
        if (cmd === 'batch_resolve') {
          const ids = (args as { ids: string[] })?.ids ?? []
          return ids
            .filter((id: string) => id === TAG_ULID)
            .map((id: string) => ({ id, title: 'Important', block_type: 'tag', deleted: false }))
        }
        return emptyPage
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
        if (cmd === 'get_backlinks') {
          return {
            items: [makeBlock('BL00000000000000000000004', `Link to [[${PAGE_ULID}]]`)],
            next_cursor: null,
            has_more: false,
          }
        }
        if (cmd === 'batch_resolve') {
          return [{ id: PAGE_ULID, title: 'Resolved Title', block_type: 'page', deleted: false }]
        }
        return emptyPage
      })

      render(<BacklinksPanel blockId="TARGET01" />)

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('batch_resolve', { ids: [PAGE_ULID] })
      })
    })

    it('shows truncated ULID fallback when batch_resolve fails', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'get_backlinks') {
          return {
            items: [makeBlock('BL00000000000000000000005', `Broken [[${PAGE_ULID}]]`)],
            next_cursor: null,
            has_more: false,
          }
        }
        if (cmd === 'batch_resolve') {
          throw new Error('not found')
        }
        return emptyPage
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
        if (cmd === 'get_backlinks') {
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
          }
        }
        return emptyPage
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
        if (cmd === 'get_backlinks') {
          callCount++
          if (callCount === 1) {
            return {
              items: [makeBlock('BL1AAAAAAAAAAAAAAAAAAAAAA', `See [[${ULID_P1}]]`)],
              next_cursor: 'cursor1',
              has_more: true,
            }
          }
          return {
            items: [makeBlock('BL2BBBBBBBBBBBBBBBBBBBBBB', `Also [[${ULID_P2}]]`)],
            next_cursor: null,
            has_more: false,
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
        return emptyPage
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
        if (cmd === 'get_backlinks') {
          return {
            items: [makeBlock('BL1CCCCCCCCCCCCCCCCCCCCCC', `See [[${BAD_ULID}]]`)],
            next_cursor: null,
            has_more: false,
          }
        }
        if (cmd === 'batch_resolve') {
          throw new Error('Network error')
        }
        return emptyPage
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
        if (cmd === 'get_backlinks') {
          return {
            items: [makeBlock('BL1DDDDDDDDDDDDDDDDDDDDDD', 'Just plain text, no links')],
            next_cursor: null,
            has_more: false,
          }
        }
        if (cmd === 'batch_resolve') {
          throw new Error('Should not be called')
        }
        return emptyPage
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
        if (cmd === 'get_backlinks') {
          return {
            items: [
              makeBlock('BL00000000000000000000006', `See **bold** and [[${PAGE_ULID}]] link`),
            ],
            next_cursor: null,
            has_more: false,
          }
        }
        if (cmd === 'batch_resolve') {
          return [{ id: PAGE_ULID, title: 'Accessible Page', block_type: 'page', deleted: false }]
        }
        return emptyPage
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

  // -- Filter tests -----------------------------------------------------------

  describe('filters', () => {
    const backlinkItems = [
      makeBlock('01HAAAAA00000000000001', 'Content block', 'content'),
      makeBlock('01HBBBBB00000000000002', 'Page block', 'page'),
      makeBlock('01HCCCCC00000000000003', 'Tag block', 'tag'),
    ]

    it('renders filter dropdowns', async () => {
      mockInvokeWith({ items: backlinkItems, next_cursor: null, has_more: false })
      render(<BacklinksPanel blockId="TARGET01" />)

      await screen.findByText('Content block')

      expect(screen.getByLabelText('Filter by type')).toBeInTheDocument()
      expect(screen.getByLabelText('Filter by status')).toBeInTheDocument()
      expect(screen.getByLabelText('Filter by date')).toBeInTheDocument()
    })

    it('filters by block type', async () => {
      const user = userEvent.setup()
      mockInvokeWith({ items: backlinkItems, next_cursor: null, has_more: false })
      render(<BacklinksPanel blockId="TARGET01" />)

      await screen.findByText('Content block')
      expect(screen.getByText('Page block')).toBeInTheDocument()
      expect(screen.getByText('Tag block')).toBeInTheDocument()

      // Filter to pages only
      await user.selectOptions(screen.getByLabelText('Filter by type'), 'page')

      expect(screen.getByText('Page block')).toBeInTheDocument()
      expect(screen.queryByText('Content block')).not.toBeInTheDocument()
      expect(screen.queryByText('Tag block')).not.toBeInTheDocument()
    })

    it('filters by task status', async () => {
      const user = userEvent.setup()
      const items = [
        makeBlock('01HAAAAA00000000000001', 'Todo item', 'content'),
        makeBlock('01HBBBBB00000000000002', 'Done item', 'content'),
        makeBlock('01HCCCCC00000000000003', 'No status item', 'content'),
      ]

      // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
      mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === 'get_backlinks') {
          return { items, next_cursor: null, has_more: false }
        }
        if (cmd === 'get_properties') {
          const blockId = (args as { blockId: string }).blockId
          if (blockId === '01HAAAAA00000000000001')
            return [
              {
                key: 'todo',
                value_text: 'TODO',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ]
          if (blockId === '01HBBBBB00000000000002')
            return [
              {
                key: 'todo',
                value_text: 'DONE',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ]
          return []
        }
        return emptyPage
      })

      render(<BacklinksPanel blockId="TARGET01" />)

      await screen.findByText('Todo item')

      // Filter to TODO only
      await user.selectOptions(screen.getByLabelText('Filter by status'), 'TODO')

      await waitFor(() => {
        expect(screen.getByText('Todo item')).toBeInTheDocument()
        expect(screen.queryByText('Done item')).not.toBeInTheDocument()
        expect(screen.queryByText('No status item')).not.toBeInTheDocument()
      })
    })

    it('shows "no match" message when filters exclude all results', async () => {
      const user = userEvent.setup()
      mockInvokeWith({
        items: [makeBlock('01HAAAAA00000000000001', 'Only content', 'content')],
        next_cursor: null,
        has_more: false,
      })
      render(<BacklinksPanel blockId="TARGET01" />)

      await screen.findByText('Only content')

      // Filter to tags — no tags exist
      await user.selectOptions(screen.getByLabelText('Filter by type'), 'tag')

      expect(screen.getByText('No backlinks match the current filters')).toBeInTheDocument()
    })

    it('clears all filters with Clear button', async () => {
      const user = userEvent.setup()
      mockInvokeWith({
        items: [makeBlock('01HAAAAA00000000000001', 'Block A', 'content')],
        next_cursor: null,
        has_more: false,
      })
      render(<BacklinksPanel blockId="TARGET01" />)

      await screen.findByText('Block A')

      // Apply a filter
      await user.selectOptions(screen.getByLabelText('Filter by type'), 'page')
      expect(screen.queryByText('Block A')).not.toBeInTheDocument()

      // Click Clear
      await user.click(screen.getByText('Clear'))

      // Block should reappear
      expect(screen.getByText('Block A')).toBeInTheDocument()
    })

    it('shows task status badge for TODO/DOING/DONE blocks', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
      mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
        if (cmd === 'get_backlinks') {
          return {
            items: [makeBlock('01HAAAAA00000000000001', 'In progress item', 'content')],
            next_cursor: null,
            has_more: false,
          }
        }
        if (cmd === 'get_properties') {
          return [
            {
              key: 'todo',
              value_text: 'DOING',
              value_num: null,
              value_date: null,
              value_ref: null,
            },
          ]
        }
        return emptyPage
      })

      render(<BacklinksPanel blockId="TARGET01" />)

      await waitFor(() => {
        expect(screen.getByText('DOING')).toBeInTheDocument()
      })
    })

    it('has no a11y violations with filter bar', async () => {
      mockInvokeWith({
        items: [makeBlock('B1', 'accessible')],
        next_cursor: null,
        has_more: false,
      })

      const { container } = render(<BacklinksPanel blockId="TARGET01" />)

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })

    it('combines type and status filters to show only matching blocks', async () => {
      const user = userEvent.setup()
      const items = [
        makeBlock('01HAAAAA00000000000001', 'Content with TODO', 'content'),
        makeBlock('01HBBBBB00000000000002', 'Page with TODO', 'page'),
        makeBlock('01HCCCCC00000000000003', 'Content no status', 'content'),
      ]

      // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
      mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === 'get_backlinks') {
          return { items, next_cursor: null, has_more: false }
        }
        if (cmd === 'get_properties') {
          const blockId = (args as { blockId: string }).blockId
          if (blockId === '01HAAAAA00000000000001')
            return [
              {
                key: 'todo',
                value_text: 'TODO',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ]
          if (blockId === '01HBBBBB00000000000002')
            return [
              {
                key: 'todo',
                value_text: 'TODO',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ]
          return []
        }
        return emptyPage
      })

      render(<BacklinksPanel blockId="TARGET01" />)

      await screen.findByText('Content with TODO')
      // Wait for status properties to load (badges appear)
      await waitFor(() => {
        expect(screen.queryAllByText('TODO').length).toBeGreaterThanOrEqual(1)
      })

      // Apply type=content AND status=TODO
      await user.selectOptions(screen.getByLabelText('Filter by type'), 'content')
      await user.selectOptions(screen.getByLabelText('Filter by status'), 'TODO')

      // Only the content-type block with TODO status should remain
      expect(screen.getByText('Content with TODO')).toBeInTheDocument()
      expect(screen.queryByText('Page with TODO')).not.toBeInTheDocument()
      expect(screen.queryByText('Content no status')).not.toBeInTheDocument()
    })

    it('filters persist across pagination when loading more', async () => {
      const user = userEvent.setup()
      let callCount = 0
      // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
      mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
        if (cmd === 'get_backlinks') {
          callCount++
          if (callCount === 1) {
            return {
              items: [
                makeBlock('01HAAAAA00000000000001', 'First content', 'content'),
                makeBlock('01HBBBBB00000000000002', 'First tag', 'tag'),
              ],
              next_cursor: 'cursor_2',
              has_more: true,
            }
          }
          return {
            items: [
              makeBlock('01HCCCCC00000000000003', 'Second content', 'content'),
              makeBlock('01HDDDDD00000000000004', 'Second tag', 'tag'),
            ],
            next_cursor: null,
            has_more: false,
          }
        }
        if (cmd === 'get_properties') return []
        return emptyPage
      })

      render(<BacklinksPanel blockId="TARGET01" />)

      await screen.findByText('First content')

      // Apply type filter to content only
      await user.selectOptions(screen.getByLabelText('Filter by type'), 'content')
      expect(screen.getByText('First content')).toBeInTheDocument()
      expect(screen.queryByText('First tag')).not.toBeInTheDocument()

      // Load more
      await user.click(screen.getByRole('button', { name: /Load more/i }))

      // Filter should still apply to both old and new items
      await waitFor(() => {
        expect(screen.getByText('Second content')).toBeInTheDocument()
      })
      expect(screen.getByText('First content')).toBeInTheDocument()
      expect(screen.queryByText('First tag')).not.toBeInTheDocument()
      expect(screen.queryByText('Second tag')).not.toBeInTheDocument()
    })

    it('filters by priority', async () => {
      const user = userEvent.setup()
      const items = [
        makeBlock('01HAAAAA00000000000001', 'High priority item', 'content'),
        makeBlock('01HBBBBB00000000000002', 'Low priority item', 'content'),
        makeBlock('01HCCCCC00000000000003', 'No priority item', 'content'),
      ]

      // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
      mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === 'get_backlinks') {
          return { items, next_cursor: null, has_more: false }
        }
        if (cmd === 'get_properties') {
          const blockId = (args as { blockId: string }).blockId
          if (blockId === '01HAAAAA00000000000001')
            return [
              {
                key: 'priority',
                value_text: 'A',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ]
          if (blockId === '01HBBBBB00000000000002')
            return [
              {
                key: 'priority',
                value_text: 'C',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ]
          return []
        }
        return emptyPage
      })

      render(<BacklinksPanel blockId="TARGET01" />)

      await screen.findByText('High priority item')
      // Wait for priority properties to load (badges appear)
      await waitFor(() => {
        expect(screen.getByText('HIGH')).toBeInTheDocument()
      })

      // Filter to high priority only (A)
      await user.selectOptions(screen.getByLabelText('Filter by priority'), 'A')

      expect(screen.getByText('High priority item')).toBeInTheDocument()
      expect(screen.queryByText('Low priority item')).not.toBeInTheDocument()
      expect(screen.queryByText('No priority item')).not.toBeInTheDocument()
    })
  })
})
