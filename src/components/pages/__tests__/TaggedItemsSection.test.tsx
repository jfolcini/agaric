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
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

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

    render(<TaggedItemsSection tagId={TAG} />)

    expect(await within(pagesPanel()).findByText('Plans')).toBeInTheDocument()
    expect(await within(blocksPanel()).findByText('Call the plumber')).toBeInTheDocument()
    expect(within(pagesPanel()).queryByText('Call the plumber')).not.toBeInTheDocument()
    expect(within(blocksPanel()).queryByText('Plans')).not.toBeInTheDocument()
  })

  it('asks for the direct tag set of each block type, newest first, in the active space', async () => {
    stub({ page: () => response([]), content: () => response([]) })

    render(<TaggedItemsSection tagId={TAG} />)

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

    render(<TaggedItemsSection tagId={TAG} />)

    await within(blocksPanel()).findByText(/^Work/)
    const text = blocksPanel().textContent ?? ''
    expect(text.indexOf('Home')).toBeLessThan(text.indexOf('Work'))
    expect(text.indexOf('Call the plumber')).toBeLessThan(text.indexOf('Fix the sink'))
    expect(text.indexOf('Fix the sink')).toBeLessThan(text.indexOf('Work'))
  })

  it('collapses a page group', async () => {
    const user = userEvent.setup()
    stub({ page: () => response([]), content: () => response([PLUMBER, REPORT]) })

    render(<TaggedItemsSection tagId={TAG} onNavigateToPage={vi.fn()} />)
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

    render(<TaggedItemsSection tagId={TAG} onNavigateToPage={onNavigateToPage} />)

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

    render(<TaggedItemsSection tagId={TAG} />)

    const first = (await screen.findByText('Plans')).closest('li') as HTMLElement
    first.focus()
    await user.keyboard('{ArrowDown}')

    expect(screen.getByText('Ideas').closest('li')).toHaveFocus()
  })

  it('moves the block cursor across page groups', async () => {
    const user = userEvent.setup()
    stub({ page: () => response([]), content: () => response([PLUMBER, REPORT]) })

    render(<TaggedItemsSection tagId={TAG} />)
    await within(blocksPanel()).findByText(/^Work/)

    const group = within(blocksPanel()).getByRole('group')
    group.focus()
    await user.keyboard('{ArrowDown}')

    expect(group).toHaveAttribute('aria-activedescendant', `tagged-block-${REPORT.id}`)
  })

  it('shows its own empty state in each panel', async () => {
    stub({ page: () => response([]), content: () => response([PLUMBER]) })

    render(<TaggedItemsSection tagId={TAG} />)

    expect(await within(pagesPanel()).findByText('No pages have this tag.')).toBeInTheDocument()
    expect(await within(blocksPanel()).findByText('Call the plumber')).toBeInTheDocument()
    expect(screen.queryByText('No blocks have this tag.')).not.toBeInTheDocument()
  })

  it('shows a skeleton while the first load is in flight', async () => {
    stub({ page: () => new Promise<never>(() => {}), content: () => new Promise<never>(() => {}) })

    const { container } = render(<TaggedItemsSection tagId={TAG} />)

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

    render(<TaggedItemsSection tagId={TAG} />)

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

    render(<TaggedItemsSection tagId={TAG} />)

    await screen.findByText('Call the plumber')
    await user.click(within(blocksPanel()).getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('Fix the sink')).toBeInTheDocument()
    expect(screen.getByText('Call the plumber')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('re-queries when a sync invalidates names', async () => {
    let pages: BlockRow[] = []
    stub({ page: () => response(pages), content: () => response([]) })

    render(<TaggedItemsSection tagId={TAG} />)
    await screen.findByText('No pages have this tag.')

    pages = [PLANS]
    act(() => invalidateNameCaches())

    expect(await screen.findByText('Plans')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    stub({ page: () => response([PLANS]), content: () => response([PLUMBER, REPORT]) })

    const { container } = render(<TaggedItemsSection tagId={TAG} />)
    await within(blocksPanel()).findByText(/^Work/)

    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('has no a11y violations when empty', async () => {
    stub({ page: () => response([]), content: () => response([]) })

    const { container } = render(<TaggedItemsSection tagId={TAG} />)
    await screen.findByText('No blocks have this tag.')

    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
