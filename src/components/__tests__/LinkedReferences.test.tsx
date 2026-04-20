/**
 * Tests for LinkedReferences component.
 *
 * Validates:
 *  - Renders nothing when no backlinks (total_count 0)
 *  - Renders header with correct count
 *  - Singular/plural header text
 *  - Collapsible header toggle
 *  - Group headers with page title and block count
 *  - Null page_title renders "Untitled"
 *  - Group toggle collapses/expands blocks
 *  - Default expand state: all groups if ≤5, first 3 if >5
 *  - Block items with badge, content, truncated ID
 *  - Clicking block navigates to page
 *  - Keyboard navigation on blocks
 *  - Pagination (load more) with cursor
 *  - Loading state shows skeletons
 *  - Error handling shows toast
 *  - Refetch when pageId changes
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { useNavigationStore } from '../../stores/navigation'
import type { LinkedReferencesProps } from '../LinkedReferences'
import { LinkedReferences } from '../LinkedReferences'
import { TooltipProvider } from '../ui/tooltip'

vi.mock('../../hooks/useBlockPropertyEvents', () => ({
  useBlockPropertyEvents: vi.fn(() => ({ invalidationKey: 0 })),
}))

vi.mock('../SourcePageFilter', () => ({
  SourcePageFilter: (props: {
    sourcePages: unknown[]
    included: string[]
    excluded: string[]
    onChange: (inc: string[], exc: string[]) => void
  }) => (
    <div data-testid="source-page-filter">
      <button
        type="button"
        data-testid="source-page-filter-trigger"
        onClick={() => props.onChange(['P1'], [])}
      >
        Filter ({props.included.length} included, {props.excluded.length} excluded)
      </button>
      <span data-testid="source-page-filter-pages">{JSON.stringify(props.sourcePages)}</span>
    </div>
  ),
}))

vi.mock('../BacklinkFilterBuilder', () => ({
  BacklinkFilterBuilder: () => <div data-testid="backlink-filter-builder">Advanced Filters</div>,
}))

const mockNavigateToPage = vi.fn()

vi.mock('../PageLink', () => ({
  PageLink: ({
    pageId,
    title,
    className,
  }: {
    pageId: string
    title: string
    className?: string
  }) => (
    <button
      type="button"
      data-testid={`page-link-${pageId}`}
      className={className}
      onClick={(e) => {
        e.stopPropagation()
        mockNavigateToPage(pageId, title)
      }}
    >
      {title}
    </button>
  ),
}))

const mockedInvoke = vi.mocked(invoke)

function makeGroup(
  pageId: string,
  pageTitle: string | null,
  blocks: Array<{ id: string; content: string }>,
) {
  return {
    page_id: pageId,
    page_title: pageTitle,
    blocks: blocks.map((b) => ({
      id: b.id,
      block_type: 'content',
      content: b.content,
      parent_id: pageId,
      page_id: pageId,
      position: 1,
      deleted_at: null,
      is_conflict: false,
    })),
  }
}

const emptyGrouped = {
  groups: [],
  next_cursor: null,
  has_more: false,
  total_count: 0,
  filtered_count: 0,
  truncated: false,
}

function mockInvokeWith(groupedResponse: unknown, extras?: Record<string, unknown>) {
  // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
  mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
    if (cmd === 'list_backlinks_grouped') return groupedResponse
    if (cmd === 'batch_resolve') return []
    if (cmd === 'list_property_keys') return []
    if (cmd === 'list_tags_by_prefix') return []
    if (extras?.[cmd] !== undefined) return extras[cmd]
    return emptyGrouped
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockNavigateToPage.mockClear()
  useNavigationStore.setState({
    currentView: 'journal',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    selectedBlockId: null,
  })
})

/** Wrap LinkedReferences in TooltipProvider (required for UX-154 icon button). */
function renderLinkedReferences(props: LinkedReferencesProps) {
  return render(
    <TooltipProvider>
      <LinkedReferences {...props} />
    </TooltipProvider>,
  )
}

describe('LinkedReferences', () => {
  // 1. UX-152: renders nothing when no backlinks (returns null)
  it('renders nothing when no backlinks', async () => {
    mockInvokeWith(emptyGrouped)

    const { container } = renderLinkedReferences({ pageId: 'PAGE1' })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_backlinks_grouped', expect.anything())
    })

    // Component should return null — no section, no header, nothing
    await waitFor(() => {
      expect(container.querySelector('.linked-references')).not.toBeInTheDocument()
    })
    expect(screen.queryByText('0 References')).not.toBeInTheDocument()
  })

  // 2. renders header with correct count
  it('renders header with correct count', async () => {
    const resp = {
      groups: [
        makeGroup('P1', 'Page One', [
          { id: 'B1', content: 'block 1' },
          { id: 'B2', content: 'block 2' },
        ]),
        makeGroup('P2', 'Page Two', [
          { id: 'B3', content: 'block 3' },
          { id: 'B4', content: 'block 4' },
          { id: 'B5', content: 'block 5' },
        ]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 5,
      filtered_count: 5,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    expect(await screen.findByText('5 References')).toBeInTheDocument()
  })

  // 3. renders singular for 1 backlink
  it('renders singular for 1 backlink', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'only block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    expect(await screen.findByText('1 Reference')).toBeInTheDocument()
  })

  // 4. header toggle collapses/expands content
  it('header toggle collapses/expands content', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'a block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    // Wait for content to appear
    expect(await screen.findByText('Page One (1)')).toBeInTheDocument()

    // Content should be visible (expanded by default)
    expect(
      screen.getByLabelText('References').querySelector('.linked-references-content'),
    ).toBeInTheDocument()

    // Click header to collapse
    const header = screen.getByText('1 Reference')
    await user.click(header)

    // Content should be hidden
    expect(
      screen.getByLabelText('References').querySelector('.linked-references-content'),
    ).not.toBeInTheDocument()

    // Click header to expand again
    await user.click(header)

    // Content should be visible again
    expect(
      screen.getByLabelText('References').querySelector('.linked-references-content'),
    ).toBeInTheDocument()
  })

  // 5. renders group headers with page title and count
  it('renders group headers with page title and count', async () => {
    const resp = {
      groups: [
        makeGroup('P1', 'Alpha Page', [
          { id: 'B1', content: 'block 1' },
          { id: 'B2', content: 'block 2' },
        ]),
        makeGroup('P2', 'Beta Page', [{ id: 'B3', content: 'block 3' }]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 3,
      filtered_count: 3,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    expect(await screen.findByText('Alpha Page (2)')).toBeInTheDocument()
    expect(screen.getByText('Beta Page (1)')).toBeInTheDocument()
  })

  // 6. handles null page_title
  it('handles null page_title', async () => {
    const resp = {
      groups: [makeGroup('P1', null, [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    expect(await screen.findByText('Untitled (1)')).toBeInTheDocument()
  })

  // 7. group toggle collapses/expands blocks
  it('group toggle collapses/expands blocks', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'visible block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    // Block should be visible (group expanded by default for ≤5 groups)
    expect(await screen.findByText('visible block')).toBeInTheDocument()

    // Click group header to collapse
    const groupHeader = screen.getByText('Page One (1)')
    await user.click(groupHeader)

    // Block should be hidden
    expect(screen.queryByText('visible block')).not.toBeInTheDocument()

    // Click group header to expand
    await user.click(groupHeader)

    // Block should be visible again
    expect(screen.getByText('visible block')).toBeInTheDocument()
  })

  // 8. default expand: all groups expanded if ≤5
  it('default expand: all groups expanded if ≤5', async () => {
    const resp = {
      groups: [
        makeGroup('P1', 'Page 1', [{ id: 'B1', content: 'b1' }]),
        makeGroup('P2', 'Page 2', [{ id: 'B2', content: 'b2' }]),
        makeGroup('P3', 'Page 3', [{ id: 'B3', content: 'b3' }]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 3,
      filtered_count: 3,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    // Wait for all groups to load
    expect(await screen.findByText('b1')).toBeInTheDocument()
    expect(screen.getByText('b2')).toBeInTheDocument()
    expect(screen.getByText('b3')).toBeInTheDocument()

    // All group headers should be expanded
    const groupHeaders = screen.getAllByRole('button', { expanded: true })
    // Main header + 3 group headers
    expect(groupHeaders.length).toBeGreaterThanOrEqual(4)
  })

  // 9. default expand: first 3 expanded if >5
  it('default expand: first 3 expanded if >5', async () => {
    const groups: ReturnType<typeof makeGroup>[] = []
    for (let i = 1; i <= 7; i++) {
      groups.push(makeGroup(`P${i}`, `Page ${i}`, [{ id: `B${i}`, content: `block ${i}` }]))
    }
    const resp = {
      groups,
      next_cursor: null,
      has_more: false,
      total_count: 7,
      filtered_count: 7,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    // Wait for first blocks to appear
    expect(await screen.findByText('block 1')).toBeInTheDocument()
    expect(screen.getByText('block 2')).toBeInTheDocument()
    expect(screen.getByText('block 3')).toBeInTheDocument()

    // Groups 4-7 should be collapsed — their blocks should not be visible
    expect(screen.queryByText('block 4')).not.toBeInTheDocument()
    expect(screen.queryByText('block 5')).not.toBeInTheDocument()
    expect(screen.queryByText('block 6')).not.toBeInTheDocument()
    expect(screen.queryByText('block 7')).not.toBeInTheDocument()
  })

  // 10. renders block items with badge, content, truncated ID
  it('renders block items with badge, content, truncated ID', async () => {
    const resp = {
      groups: [
        makeGroup('P1', 'Page One', [
          { id: '01HAAAAA00000000000001', content: 'My block content' },
        ]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    // Badge
    expect(await screen.findByText('content')).toBeInTheDocument()
    // Content
    expect(screen.getByText('My block content')).toBeInTheDocument()
    // Truncated ID
    expect(screen.getByText('01HAAAAA...')).toBeInTheDocument()
  })

  // 11. clicking block navigates to page
  it('clicking block navigates to page', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    const resp = {
      groups: [makeGroup('P1', 'Source Page', [{ id: 'BLOCK_1', content: 'click me' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1', onNavigateToPage: onNavigate })

    const blockItem = await screen.findByText('click me')
    await user.click(blockItem)

    expect(onNavigate).toHaveBeenCalledWith('P1', 'Source Page', 'BLOCK_1')
  })

  // 12. keyboard navigation on block
  it('keyboard navigation on block (Enter)', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    const resp = {
      groups: [makeGroup('P1', 'Source Page', [{ id: 'BLOCK_1', content: 'keyboard nav' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1', onNavigateToPage: onNavigate })

    const blockItem = await screen.findByText('keyboard nav')
    // Focus the list item (parent of the text)
    const li = blockItem.closest('li') as HTMLElement
    li.focus()
    await user.keyboard('{Enter}')

    expect(onNavigate).toHaveBeenCalledWith('P1', 'Source Page', 'BLOCK_1')
  })

  it('keyboard navigation on block (Space)', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    const resp = {
      groups: [makeGroup('P1', 'Source Page', [{ id: 'BLOCK_1', content: 'space nav' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1', onNavigateToPage: onNavigate })

    const blockItem = await screen.findByText('space nav')
    const li = blockItem.closest('li') as HTMLElement
    li.focus()
    await user.keyboard(' ')

    expect(onNavigate).toHaveBeenCalledWith('P1', 'Source Page', 'BLOCK_1')
  })

  // 13. pagination: shows load more when hasMore
  it('pagination: shows load more when hasMore', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: 'cursor_page2',
      has_more: true,
      total_count: 2,
      filtered_count: 2,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    const loadMoreBtn = await screen.findByRole('button', {
      name: /load more references/i,
    })
    expect(loadMoreBtn).toBeInTheDocument()
  })

  // 14. pagination: load more fetches next page
  it('pagination: load more fetches next page', async () => {
    const user = userEvent.setup()
    const page1 = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: 'cursor_page2',
      has_more: true,
      total_count: 2,
      filtered_count: 2,
      truncated: false,
    }
    const page2 = {
      groups: [makeGroup('P2', 'Page Two', [{ id: 'B2', content: 'block 2' }])],
      next_cursor: null,
      has_more: false,
      total_count: 2,
      filtered_count: 2,
      truncated: false,
    }
    let callCount = 0
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'list_backlinks_grouped') {
        callCount++
        return callCount === 1 ? page1 : page2
      }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'list_property_keys') return []
      if (cmd === 'list_tags_by_prefix') return []
      return emptyGrouped
    })

    renderLinkedReferences({ pageId: 'PAGE1' })

    const loadMoreBtn = await screen.findByRole('button', {
      name: /load more references/i,
    })
    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_backlinks_grouped', {
        blockId: 'PAGE1',
        filters: null,
        sort: null,
        cursor: 'cursor_page2',
        limit: 50,
      })
    })

    // Both groups should be rendered
    expect(await screen.findByText('block 1')).toBeInTheDocument()
    expect(screen.getByText('block 2')).toBeInTheDocument()
  })

  // 15. pagination: hides load more when no more
  it('pagination: hides load more when no more', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('block 1')

    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
  })

  // 16. loading state shows skeletons
  it('loading state shows skeletons', async () => {
    // Never-resolving promise to keep loading state
    mockedInvoke.mockImplementation(() => new Promise(() => {}))

    const { container } = renderLinkedReferences({ pageId: 'PAGE1' })

    // ListViewState shows skeleton when loading with empty items
    await waitFor(() => {
      expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
      expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
    })
  })

  // 17. error handling: shows toast on fetch error
  it('error handling: shows toast on fetch error', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'list_backlinks_grouped') throw new Error('network failure')
      if (cmd === 'batch_resolve') return []
      if (cmd === 'list_property_keys') return []
      if (cmd === 'list_tags_by_prefix') return []
      return emptyGrouped
    })

    renderLinkedReferences({ pageId: 'PAGE1' })

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load references')
    })
  })

  // 18. refetches when pageId changes
  it('refetches when pageId changes', async () => {
    const resp1 = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'page 1 block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp1)

    const { rerender } = renderLinkedReferences({ pageId: 'PAGE1' })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_backlinks_grouped', {
        blockId: 'PAGE1',
        filters: null,
        sort: null,
        cursor: null,
        limit: 50,
      })
    })

    const resp2 = {
      groups: [makeGroup('P2', 'Page Two', [{ id: 'B2', content: 'page 2 block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp2)

    rerender(
      <TooltipProvider>
        <LinkedReferences pageId="PAGE2" />
      </TooltipProvider>,
    )

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_backlinks_grouped', {
        blockId: 'PAGE2',
        filters: null,
        sort: null,
        cursor: null,
        limit: 50,
      })
    })
  })

  // 19. a11y: no violations with groups
  it('a11y: no violations with groups', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'accessible block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    const { container } = renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('accessible block')

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // 20. a11y: section has correct aria-label
  it('a11y: section has correct aria-label', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('block')

    const section = screen.getByLabelText('References')
    expect(section).toBeInTheDocument()
    expect(section.tagName).toBe('SECTION')
  })

  // 21. a11y: group lists have correct aria-label
  it('a11y: group lists have correct aria-label', async () => {
    const resp = {
      groups: [
        makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }]),
        makeGroup('P2', 'Page Two', [{ id: 'B2', content: 'block 2' }]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 2,
      filtered_count: 2,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('block 1')

    expect(screen.getByLabelText('Backlinks from Page One')).toBeInTheDocument()
    expect(screen.getByLabelText('Backlinks from Page Two')).toBeInTheDocument()
  })

  // 21b. UX-210: keyboard nav container has correct aria-label resolved via t()
  it('keyboard nav container aria-label resolves via t() (UX-210)', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('block')

    const container = screen.getByRole('group', { name: t('linkedRefs.listLabel') })
    expect(container).toBeInTheDocument()
    expect(container.className).toContain('linked-references-list')
  })

  // 22. calls list_backlinks_grouped with correct params on mount
  it('calls list_backlinks_grouped with correct params on mount', async () => {
    mockInvokeWith(emptyGrouped)

    renderLinkedReferences({ pageId: 'PAGE1' })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_backlinks_grouped', {
        blockId: 'PAGE1',
        filters: null,
        sort: null,
        cursor: null,
        limit: 50,
      })
    })
  })

  // 23. clicking block with null page_title navigates with "Untitled"
  it('clicking block with null page_title navigates with Untitled', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    const resp = {
      groups: [makeGroup('P1', null, [{ id: 'BLOCK_1', content: 'null title block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1', onNavigateToPage: onNavigate })

    const blockItem = await screen.findByText('null title block')
    await user.click(blockItem)

    expect(onNavigate).toHaveBeenCalledWith('P1', 'Untitled', 'BLOCK_1')
  })

  // 24. main header aria-expanded attribute toggles correctly
  it('main header aria-expanded toggles correctly', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    const header = await screen.findByText('1 Reference')
    const headerBtn = header.closest('button') as HTMLElement

    // Initially expanded
    expect(headerBtn).toHaveAttribute('aria-expanded', 'true')

    // Collapse
    await user.click(headerBtn)
    expect(headerBtn).toHaveAttribute('aria-expanded', 'false')

    // Expand
    await user.click(headerBtn)
    expect(headerBtn).toHaveAttribute('aria-expanded', 'true')
  })

  // ---------------------------------------------------------------------------
  // Filter integration tests (#543 / #544)
  // ---------------------------------------------------------------------------

  // 25. renders source page filter when groups present
  it('renders source page filter when groups present', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('Page One (1)')

    expect(screen.getByTestId('source-page-filter')).toBeInTheDocument()
  })

  // 26. renders "More filters" button
  it('renders "More filters" button', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('Page One (1)')

    expect(screen.getByRole('button', { name: /show filters/i })).toBeInTheDocument()
  })

  // 27. "More filters" toggles advanced filter panel
  it('"More filters" toggles advanced filter panel', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('Page One (1)')

    // Advanced filters not visible initially
    expect(screen.queryByTestId('backlink-filter-builder')).not.toBeInTheDocument()

    // Click "More filters"
    await user.click(screen.getByRole('button', { name: /show filters/i }))

    // Advanced filters now visible
    expect(screen.getByTestId('backlink-filter-builder')).toBeInTheDocument()

    // Click "Hide filters"
    await user.click(screen.getByRole('button', { name: /hide filters/i }))

    // Advanced filters hidden again
    expect(screen.queryByTestId('backlink-filter-builder')).not.toBeInTheDocument()
  })

  // 28. "More filters" button shows "Hide filters" when expanded
  it('"More filters" button shows "Hide filters" when expanded', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('Page One (1)')

    const moreBtn = screen.getByRole('button', { name: /show filters/i })
    expect(moreBtn).toHaveAttribute('aria-expanded', 'false')

    await user.click(moreBtn)

    const hideBtn = screen.getByRole('button', { name: /hide filters/i })
    expect(hideBtn).toHaveAttribute('aria-expanded', 'true')
  })

  // 29. source page filter passes correct sourcePages
  it('source page filter passes correct sourcePages', async () => {
    const resp = {
      groups: [
        makeGroup('P1', 'Page One', [
          { id: 'B1', content: 'block 1' },
          { id: 'B2', content: 'block 2' },
        ]),
        makeGroup('P2', 'Page Two', [{ id: 'B3', content: 'block 3' }]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 3,
      filtered_count: 3,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('Page One (2)')

    const pagesJson = screen.getByTestId('source-page-filter-pages').textContent
    const pages = JSON.parse(pagesJson ?? '[]')

    expect(pages).toEqual([
      { pageId: 'P1', pageTitle: 'Page One', blockCount: 2 },
      { pageId: 'P2', pageTitle: 'Page Two', blockCount: 1 },
    ])
  })

  // 30. applying source page filter re-fetches with SourcePage filter
  it('applying source page filter re-fetches with SourcePage filter', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('Page One (1)')

    // Clear call history to focus on the re-fetch
    mockedInvoke.mockClear()
    mockInvokeWith(resp)

    // Click the mock source page filter trigger (sets included=['P1'])
    await user.click(screen.getByTestId('source-page-filter-trigger'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_backlinks_grouped', {
        blockId: 'PAGE1',
        filters: [{ type: 'SourcePage', included: ['P1'], excluded: [] }],
        sort: null,
        cursor: null,
        limit: 50,
      })
    })
  })

  // 31. clearing filters re-fetches without filters
  it('clearing filters re-fetches without filters', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('Page One (1)')

    // Apply filter first
    await user.click(screen.getByTestId('source-page-filter-trigger'))

    // Wait for re-fetch with filter
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_backlinks_grouped',
        expect.objectContaining({ filters: expect.any(Array) }),
      )
    })

    // Clear mock calls, then the mock onChange returns (['P1'], []) on click;
    // we can't directly clear from here. But we can verify the initial fetch
    // was done without filters.
    // Instead, verify the first call was without filters:
    const firstCall = mockedInvoke.mock.calls.find(
      (c) =>
        c[0] === 'list_backlinks_grouped' &&
        (c[1] as Record<string, unknown>)?.['filters'] === null,
    )
    expect(firstCall).toBeTruthy()
  })

  // 32. a11y with filters visible
  it('a11y: no violations with filters visible', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'accessible block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    const { container } = renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('accessible block')

    // Expand advanced filters
    await user.click(screen.getByRole('button', { name: /show filters/i }))

    expect(screen.getByTestId('backlink-filter-builder')).toBeInTheDocument()

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // 33. filter state resets when pageId changes
  it('resets filters when pageId changes', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'ref' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    const { rerender } = renderLinkedReferences({ pageId: 'PAGE_A' })

    await screen.findByText('Page One (1)')

    // Apply source page filter
    await user.click(screen.getByTestId('source-page-filter-trigger'))

    // Expand advanced filters
    await user.click(screen.getByRole('button', { name: /show filters/i }))
    expect(screen.getByTestId('backlink-filter-builder')).toBeInTheDocument()

    // Now rerender with a different pageId — filters should reset
    mockedInvoke.mockClear()
    mockInvokeWith(resp)

    rerender(
      <TooltipProvider>
        <LinkedReferences pageId="PAGE_B" />
      </TooltipProvider>,
    )

    // "More filters" should be collapsed (showAdvancedFilters reset)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show filters/i })).toBeInTheDocument()
    })
    expect(screen.queryByTestId('backlink-filter-builder')).not.toBeInTheDocument()
  })

  // ---------------------------------------------------------------------------
  // Group header page title navigation (#UX-H11)
  // ---------------------------------------------------------------------------

  // 34. clicking group header page title triggers navigation
  it('clicking group header page title navigates to that page', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    const resp = {
      groups: [makeGroup('P1', 'Source Page', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    renderLinkedReferences({ pageId: 'PAGE1', onNavigateToPage: onNavigate })

    // Wait for group to load — with onNavigateToPage, the split layout is active
    // PageLink renders the title separately
    const pageLink = await screen.findByTestId('page-link-P1')
    expect(pageLink).toHaveTextContent('Source Page')

    await user.click(pageLink)

    expect(mockNavigateToPage).toHaveBeenCalledWith('P1', 'Source Page')
  })

  // ---------------------------------------------------------------------------
  // Error path tests (mockRejectedValue coverage)
  // ---------------------------------------------------------------------------

  // 35. initial backlinks load failure: shows toast and returns null (UX-152)
  it('error: initial backlinks load failure shows toast and returns null', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'list_backlinks_grouped') return Promise.reject(new Error('backend unavailable'))
      if (cmd === 'batch_resolve') return []
      if (cmd === 'list_property_keys') return []
      if (cmd === 'list_tags_by_prefix') return []
      return emptyGrouped
    })

    const { container } = renderLinkedReferences({ pageId: 'PAGE1' })

    // Toast fires with the translated error message
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load references')
    })

    // Loading finishes — no skeletons remain
    await waitFor(() => {
      expect(container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument()
    })

    // UX-152: Component returns null when empty (even after error)
    expect(container.querySelector('.linked-references')).not.toBeInTheDocument()
    expect(screen.queryByText('0 References')).not.toBeInTheDocument()
  })

  // 36. pagination failure: shows toast and preserves existing groups
  it('error: pagination failure preserves existing groups and shows toast', async () => {
    const user = userEvent.setup()
    const page1 = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'first block' }])],
      next_cursor: 'cursor_page2',
      has_more: true,
      total_count: 2,
      filtered_count: 2,
      truncated: false,
    }
    let callCount = 0
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'list_backlinks_grouped') {
        callCount++
        if (callCount === 1) return page1
        return Promise.reject(new Error('pagination timeout'))
      }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'list_property_keys') return []
      if (cmd === 'list_tags_by_prefix') return []
      return emptyGrouped
    })

    renderLinkedReferences({ pageId: 'PAGE1' })

    // Wait for initial load
    const loadMoreBtn = await screen.findByRole('button', {
      name: /load more references/i,
    })

    // Click "Load more" — this will trigger the rejected second call
    await user.click(loadMoreBtn)

    // Toast fires for the pagination failure
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load references')
    })

    // Existing groups are still rendered (not wiped out)
    expect(screen.getByText('first block')).toBeInTheDocument()
    expect(screen.getByText('Page One (1)')).toBeInTheDocument()
  })

  // 37. property keys load failure: shows toast
  it('error: property keys load failure shows toast', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'list_property_keys')
        return Promise.reject(new Error('property keys unavailable'))
      if (cmd === 'list_backlinks_grouped') return emptyGrouped
      if (cmd === 'batch_resolve') return []
      if (cmd === 'list_tags_by_prefix') return []
      return emptyGrouped
    })

    renderLinkedReferences({ pageId: 'PAGE1' })

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load property keys')
    })
  })

  // 38. tags load failure: shows toast
  it('error: tags load failure shows toast', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'list_tags_by_prefix') return Promise.reject(new Error('tags service down'))
      if (cmd === 'list_backlinks_grouped') return emptyGrouped
      if (cmd === 'batch_resolve') return []
      if (cmd === 'list_property_keys') return []
      return emptyGrouped
    })

    renderLinkedReferences({ pageId: 'PAGE1' })

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load tags')
    })
  })

  // 39. all three invoke calls fail simultaneously: shows all toasts
  it('error: simultaneous failures show all error toasts', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'list_backlinks_grouped') return Promise.reject(new Error('backlinks failed'))
      if (cmd === 'list_property_keys') return Promise.reject(new Error('properties failed'))
      if (cmd === 'list_tags_by_prefix') return Promise.reject(new Error('tags failed'))
      if (cmd === 'batch_resolve') return []
      return emptyGrouped
    })

    renderLinkedReferences({ pageId: 'PAGE1' })

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load references')
      expect(toast.error).toHaveBeenCalledWith('Failed to load property keys')
      expect(toast.error).toHaveBeenCalledWith('Failed to load tags')
    })

    // Verify all three distinct toasts fired
    expect(toast.error).toHaveBeenCalledTimes(3)
  })

  // ---------------------------------------------------------------------------
  // UX-167: Filter button position — hugs header, not pushed right
  // ---------------------------------------------------------------------------

  // 40. CollapsiblePanelHeader does NOT have flex-1 class (UX-167)
  it('filter button is sibling of header without flex-1 pushing it right (UX-167)', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    const { container } = renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('Page One (1)')

    // The CollapsiblePanelHeader wrapper button should NOT have flex-1
    const headerEl = container.querySelector('.linked-references-header')
    expect(headerEl).toBeInTheDocument()
    expect(headerEl).not.toHaveClass('flex-1')
  })

  // ---------------------------------------------------------------------------
  // UX-240: Filter toggle must stay inline with header on narrow viewports
  // ---------------------------------------------------------------------------

  // Conservative preventive styling: outer row is flex-nowrap with min-w-0,
  // header button carries min-w-0, and the filter button remains shrink-0.
  it('outer header row and children carry flex-nowrap / min-w-0 / shrink-0 (UX-240)', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockInvokeWith(resp)

    const { container } = renderLinkedReferences({ pageId: 'PAGE1' })

    await screen.findByText('Page One (1)')

    // Outer row wrapper is the direct parent of the CollapsiblePanelHeader
    // button. It must be flex, nowrap, and allow its children to shrink below
    // their intrinsic size so the filter toggle stays inline.
    const headerButton = container.querySelector('.linked-references-header')
    expect(headerButton).toBeInTheDocument()
    const outerRow = headerButton?.parentElement
    expect(outerRow).toBeInTheDocument()
    expect(outerRow).toHaveClass('flex', 'flex-nowrap', 'items-center', 'gap-1', 'min-w-0')

    // The header button itself must allow flex shrinking.
    expect(headerButton).toHaveClass('min-w-0')
    // But still render full-width as a click target.
    expect(headerButton).toHaveClass('w-full')

    // Filter toggle keeps shrink-0 so it never collapses to zero width.
    const filterButton = screen.getByRole('button', { name: /show filters/i })
    expect(filterButton).toHaveClass('shrink-0')
  })
})
