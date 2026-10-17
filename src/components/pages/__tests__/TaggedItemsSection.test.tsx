import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { TaggedItemsSection } from '@/components/pages/TaggedItemsSection'
import type { AdvancedQueryResponse, BlockRow } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { invalidateNameCaches } from '@/lib/name-change-bus'
import { queryClient } from '@/lib/query-client'
import { useNavigationStore } from '@/stores/navigation'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@tanstack/react-virtual', () => mockReactVirtual())

const mockedInvoke = vi.mocked(invoke)

const TAG = 'TAG00000000000000000000001'
const HOME = 'PAGE0000000000000000000002'
const WORK = 'PAGE0000000000000000000003'
const PLANS = makeBlockRow({
  id: 'PAGE0000000000000000000001',
  block_type: 'page',
  content: 'Plans',
})
const IDEAS = makeBlockRow({
  id: 'PAGE0000000000000000000004',
  block_type: 'page',
  content: 'Ideas',
})
const PLUMBER = makeBlockRow({
  id: 'BLOCK000000000000000000003',
  content: 'Call the plumber',
  parent_id: HOME,
  page_id: HOME,
})
const REPORT = makeBlockRow({
  id: 'BLOCK000000000000000000002',
  content: 'Write the report',
  parent_id: WORK,
  page_id: WORK,
})
const SINK = makeBlockRow({
  id: 'BLOCK000000000000000000001',
  content: 'Fix the sink',
  parent_id: HOME,
  page_id: HOME,
})

// Home's outline: the tagged PLUMBER holds BOLTS, which holds WRENCH; SINK
// is PLUMBER's sibling.
const BOLTS = makeBlockRow({
  id: 'BLOCK000000000000000000004',
  content: 'Buy bolts',
  parent_id: PLUMBER.id,
  page_id: HOME,
  position: 1,
})
const WRENCH = makeBlockRow({
  id: 'BLOCK000000000000000000005',
  content: 'Borrow a wrench',
  parent_id: BOLTS.id,
  page_id: HOME,
  position: 1,
})
const HOME_OUTLINE = [{ ...PLUMBER, position: 1 }, BOLTS, WRENCH, { ...SINK, position: 2 }]

function response(rows: BlockRow[], nextCursor: string | null = null): AdvancedQueryResponse {
  return { rows, nextCursor, hasMore: nextCursor != null, totalCount: null }
}

type Answer = (cursor: string | null) => AdvancedQueryResponse | Promise<never>

/** `run_advanced_query` answering per block type. */
function stub(byType: { page: Answer; content: Answer }): void {
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      run_advanced_query: (args) => {
        const request = args['request'] as {
          filter: { children: { primitive: { values?: string[] } }[] }
          cursor: string | null
        }
        const kind = request.filter.children[1]?.primitive.values?.[0]
        if (kind !== 'page' && kind !== 'content') throw new Error(`unexpected ${String(kind)}`)
        return byType[kind](request.cursor)
      },
      batch_resolve: () => [
        { id: HOME, title: 'Home', block_type: 'page', deleted: false },
        { id: WORK, title: 'Work', block_type: 'page', deleted: false },
      ],
      load_page_subtree: (args) => {
        const blocks = args['rootBlockId'] === HOME ? HOME_OUTLINE : []
        return { blocks, truncated: false, total: blocks.length }
      },
    }),
  )
}

const pagesPanel = () => screen.getByRole('region', { name: 'Pages' })
const blocksPanel = () => screen.getByRole('region', { name: 'Blocks' })

beforeEach(() => {
  vi.clearAllMocks()
  queryClient.clear()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
  useResolveStore.setState({ cache: new Map(), version: 0 })
})

describe('TaggedItemsSection', () => {
  it('lists tagged pages and blocks, each in its own panel', async () => {
    stub({ page: () => response([PLANS]), content: () => response([PLUMBER]) })

    render(<TaggedItemsSection tagId={TAG} tagName="idea" />)

    expect(await within(pagesPanel()).findByText('Plans')).toBeInTheDocument()
    expect(await within(blocksPanel()).findByText('Call the plumber')).toBeInTheDocument()
    expect(within(pagesPanel()).queryByText('Call the plumber')).not.toBeInTheDocument()
    expect(within(blocksPanel()).queryByText('Plans')).not.toBeInTheDocument()
  })

  it('asks for the direct tag set of each block type, newest first, in the active space', async () => {
    stub({ page: () => response([]), content: () => response([]) })

    render(<TaggedItemsSection tagId={TAG} tagName="idea" />)

    await screen.findByText('No blocks have this tag.')
    for (const kind of ['page', 'content']) {
      expect(mockedInvoke).toHaveBeenCalledWith('run_advanced_query', {
        request: {
          spaceId: 'SPACE_1',
          filter: {
            type: 'And',
            children: [
              { type: 'Leaf', primitive: { type: 'TagOrRef', tag: TAG } },
              { type: 'Leaf', primitive: { type: 'BlockType', values: [kind], exclude: false } },
            ],
          },
          sort: [{ source: { type: 'Column', name: 'created' }, desc: true }],
          cursor: null,
          limit: 50,
        },
      })
    }
  })

  it('groups blocks by page in the order of each page’s newest block', async () => {
    stub({ page: () => response([]), content: () => response([PLUMBER, REPORT, SINK]) })

    render(<TaggedItemsSection tagId={TAG} tagName="idea" />)

    await within(blocksPanel()).findByText(/^Work/)
    const text = blocksPanel().textContent ?? ''
    expect(text.indexOf('Home')).toBeLessThan(text.indexOf('Work'))
    expect(text.indexOf('Call the plumber')).toBeLessThan(text.indexOf('Fix the sink'))
    expect(text.indexOf('Fix the sink')).toBeLessThan(text.indexOf('Work'))
  })

  it('collapses a page group', async () => {
    const user = userEvent.setup()
    stub({ page: () => response([]), content: () => response([PLUMBER, REPORT]) })

    render(<TaggedItemsSection tagId={TAG} tagName="idea" onNavigateToPage={vi.fn()} />)
    await within(blocksPanel()).findByText(/^Work/)

    await user.click(
      within(blocksPanel()).getAllByRole('button', { name: 'Collapse group' })[0] as HTMLElement,
    )

    expect(within(blocksPanel()).queryByText('Call the plumber')).not.toBeInTheDocument()
    expect(within(blocksPanel()).getByText('Write the report')).toBeInTheDocument()
  })

  it('opens a page on click and a block in its page on Enter', async () => {
    const user = userEvent.setup()
    const onNavigateToPage = vi.fn()
    stub({ page: () => response([PLANS]), content: () => response([PLUMBER]) })

    render(<TaggedItemsSection tagId={TAG} tagName="idea" onNavigateToPage={onNavigateToPage} />)

    await user.click(await screen.findByText('Plans'))
    expect(onNavigateToPage).toHaveBeenLastCalledWith(PLANS.id, 'Plans')

    await within(blocksPanel()).findByText('Home')
    within(blocksPanel()).getByRole('group').focus()
    await user.keyboard('{Enter}')
    expect(onNavigateToPage).toHaveBeenLastCalledWith(HOME, 'Home', PLUMBER.id)
  })

  it('moves the page cursor with the arrow keys', async () => {
    const user = userEvent.setup()
    stub({ page: () => response([PLANS, IDEAS]), content: () => response([]) })

    render(<TaggedItemsSection tagId={TAG} tagName="idea" />)

    const first = (await screen.findByText('Plans')).closest('li') as HTMLElement
    first.focus()
    await user.keyboard('{ArrowDown}')

    expect(screen.getByText('Ideas').closest('li')).toHaveFocus()
  })

  it('moves the block cursor across page groups', async () => {
    const user = userEvent.setup()
    stub({ page: () => response([]), content: () => response([PLUMBER, REPORT]) })

    render(<TaggedItemsSection tagId={TAG} tagName="idea" />)
    await within(blocksPanel()).findByText(/^Work/)

    const group = within(blocksPanel()).getByRole('group')
    group.focus()
    await user.keyboard('{ArrowDown}')

    expect(group).toHaveAttribute('aria-activedescendant', `tagged-block-${REPORT.id}`)
  })

  it('shows its own empty state in each panel', async () => {
    stub({ page: () => response([]), content: () => response([PLUMBER]) })

    render(<TaggedItemsSection tagId={TAG} tagName="idea" />)

    expect(await within(pagesPanel()).findByText('No pages have this tag.')).toBeInTheDocument()
    expect(await within(blocksPanel()).findByText('Call the plumber')).toBeInTheDocument()
    expect(screen.queryByText('No blocks have this tag.')).not.toBeInTheDocument()
  })

  it('shows a skeleton while the first load is in flight', async () => {
    stub({ page: () => new Promise<never>(() => {}), content: () => new Promise<never>(() => {}) })

    const { container } = render(<TaggedItemsSection tagId={TAG} tagName="idea" />)

    await waitFor(() => {
      expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    })
    expect(screen.queryByText('No pages have this tag.')).not.toBeInTheDocument()
  })

  it('logs a failed load and retries it', async () => {
    const user = userEvent.setup()
    let fail = true
    stub({
      page: () => (fail ? Promise.reject(new Error('boom')) : response([PLANS])),
      content: () => response([]),
    })

    render(<TaggedItemsSection tagId={TAG} tagName="idea" />)

    expect(await within(pagesPanel()).findByRole('alert')).toHaveTextContent(
      'Failed to load what this tag is on.',
    )
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'TaggedItemsSection',
      'failed to load tagged items',
      { tagId: TAG, kind: 'page' },
      expect.any(Error),
    )

    fail = false
    await user.click(within(pagesPanel()).getByRole('button', { name: 'Retry' }))
    expect(await within(pagesPanel()).findByText('Plans')).toBeInTheDocument()
  })

  it('loads the next page of blocks through the cursor', async () => {
    const user = userEvent.setup()
    stub({
      page: () => response([]),
      content: (cursor) => (cursor === 'C1' ? response([SINK]) : response([PLUMBER], 'C1')),
    })

    render(<TaggedItemsSection tagId={TAG} tagName="idea" />)

    await screen.findByText('Call the plumber')
    await user.click(within(blocksPanel()).getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('Fix the sink')).toBeInTheDocument()
    expect(screen.getByText('Call the plumber')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('re-queries when a sync invalidates names', async () => {
    let pages: BlockRow[] = []
    stub({ page: () => response(pages), content: () => response([]) })

    render(<TaggedItemsSection tagId={TAG} tagName="idea" />)
    await screen.findByText('No pages have this tag.')

    pages = [PLANS]
    act(() => invalidateNameCaches())

    expect(await screen.findByText('Plans')).toBeInTheDocument()
  })

  it('opens Search on under:#tag, which also matches what inherits the tag', async () => {
    const user = userEvent.setup()
    stub({ page: () => response([]), content: () => response([]) })
    useNavigationStore.setState({ currentView: 'page-editor' })

    render(<TaggedItemsSection tagId={TAG} tagName="my idea" />)
    await user.click(screen.getByRole('button', { name: 'Search everything under #my idea' }))

    expect(useCommandPaletteStore.getState().pendingViewQuery).toBe('under:#"my idea"')
    expect(useNavigationStore.getState().currentView).toBe('search')
  })

  it('expands a tagged block to its children and collapses it again', async () => {
    const user = userEvent.setup()
    const onNavigateToPage = vi.fn()
    stub({ page: () => response([]), content: () => response([PLUMBER]) })

    render(<TaggedItemsSection tagId={TAG} tagName="idea" onNavigateToPage={onNavigateToPage} />)
    await within(blocksPanel()).findByText('Home')

    const show = within(blocksPanel()).getByRole('button', { name: 'Show child blocks' })
    expect(show).toHaveAttribute('aria-expanded', 'false')
    await user.click(show)

    const bolts = (await within(blocksPanel()).findByText('Buy bolts')).closest('li')
    const wrench = within(blocksPanel()).getByText('Borrow a wrench').closest('li')
    expect(bolts).toHaveAttribute('aria-level', '1')
    expect(wrench).toHaveAttribute('aria-level', '2')
    // The tagged block is the row itself, and its sibling is not its child.
    expect(within(blocksPanel()).getAllByText('Call the plumber')).toHaveLength(1)
    expect(within(blocksPanel()).queryByText('Fix the sink')).not.toBeInTheDocument()
    expect(onNavigateToPage).not.toHaveBeenCalled()

    const hide = within(blocksPanel()).getByRole('button', { name: 'Hide child blocks' })
    expect(hide).toHaveAttribute('aria-expanded', 'true')
    await user.click(hide)
    expect(within(blocksPanel()).queryByText('Buy bolts')).not.toBeInTheDocument()
  })

  it('toggles children from the keyboard without opening the block', async () => {
    const user = userEvent.setup()
    const onNavigateToPage = vi.fn()
    stub({ page: () => response([]), content: () => response([PLUMBER]) })

    render(<TaggedItemsSection tagId={TAG} tagName="idea" onNavigateToPage={onNavigateToPage} />)
    await within(blocksPanel()).findByText('Home')

    within(blocksPanel()).getByRole('button', { name: 'Show child blocks' }).focus()
    await user.keyboard('{Enter}')

    expect(await within(blocksPanel()).findByText('Buy bolts')).toBeInTheDocument()
    expect(onNavigateToPage).not.toHaveBeenCalled()
  })

  it('says so when a tagged block has no children', async () => {
    const user = userEvent.setup()
    stub({ page: () => response([]), content: () => response([REPORT]) })

    render(<TaggedItemsSection tagId={TAG} tagName="idea" />)
    await within(blocksPanel()).findByText(/^Work/)
    await user.click(within(blocksPanel()).getByRole('button', { name: 'Show child blocks' }))

    expect(await within(blocksPanel()).findByText('No child blocks.')).toBeInTheDocument()
  })

  it('has no a11y violations with a block expanded', async () => {
    const user = userEvent.setup()
    stub({ page: () => response([]), content: () => response([PLUMBER]) })

    const { container } = render(<TaggedItemsSection tagId={TAG} tagName="idea" />)
    await within(blocksPanel()).findByText(/^Home/)
    await user.click(within(blocksPanel()).getByRole('button', { name: 'Show child blocks' }))
    await within(blocksPanel()).findByText('Buy bolts')

    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('has no a11y violations', async () => {
    stub({ page: () => response([PLANS]), content: () => response([PLUMBER, REPORT]) })

    const { container } = render(<TaggedItemsSection tagId={TAG} tagName="idea" />)
    await within(blocksPanel()).findByText(/^Work/)

    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('has no a11y violations when empty', async () => {
    stub({ page: () => response([]), content: () => response([]) })

    const { container } = render(<TaggedItemsSection tagId={TAG} tagName="idea" />)
    await screen.findByText('No blocks have this tag.')

    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
