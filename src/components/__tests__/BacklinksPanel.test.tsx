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
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { BacklinksPanel } from '../BacklinksPanel'

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

beforeEach(() => {
  vi.clearAllMocks()
})

describe('BacklinksPanel', () => {
  it('renders null blockId state', () => {
    render(<BacklinksPanel blockId={null} />)

    expect(screen.getByText('Select a block to see backlinks')).toBeInTheDocument()
  })

  it('renders empty state when no backlinks found', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<BacklinksPanel blockId="BLOCK001" />)

    expect(await screen.findByText('No backlinks found')).toBeInTheDocument()
  })

  it('calls get_backlinks with correct params on mount', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

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
    mockedInvoke.mockResolvedValueOnce(page)

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
    mockedInvoke.mockResolvedValueOnce(page1)

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
    mockedInvoke.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)

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
    mockedInvoke.mockResolvedValue(emptyPage)

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
    mockedInvoke.mockResolvedValueOnce(page)

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
    mockedInvoke.mockRejectedValueOnce(new Error('network failure'))

    render(<BacklinksPanel blockId="BLOCK001" />)

    // Should render empty state (error silently caught), not crash
    await waitFor(() => {
      expect(screen.getByText('No backlinks found')).toBeInTheDocument()
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
        if (cmd === 'get_block') {
          if ((args as { blockId: string })?.blockId === PAGE_ULID) {
            return makeBlock(PAGE_ULID, 'My Resolved Page', 'page')
          }
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
        if (cmd === 'get_block') {
          if ((args as { blockId: string })?.blockId === TAG_ULID) {
            return makeBlock(TAG_ULID, 'Important', 'tag')
          }
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

    it('calls get_block for ULIDs found in backlink content', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'get_backlinks') {
          return {
            items: [makeBlock('BL00000000000000000000004', `Link to [[${PAGE_ULID}]]`)],
            next_cursor: null,
            has_more: false,
          }
        }
        if (cmd === 'get_block') {
          return makeBlock(PAGE_ULID, 'Resolved Title', 'page')
        }
        return emptyPage
      })

      render(<BacklinksPanel blockId="TARGET01" />)

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('get_block', { blockId: PAGE_ULID })
      })
    })

    it('shows truncated ULID fallback when getBlock fails', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'get_backlinks') {
          return {
            items: [makeBlock('BL00000000000000000000005', `Broken [[${PAGE_ULID}]]`)],
            next_cursor: null,
            has_more: false,
          }
        }
        if (cmd === 'get_block') {
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
        if (cmd === 'get_block') {
          return makeBlock(PAGE_ULID, 'Accessible Page', 'page')
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
})
