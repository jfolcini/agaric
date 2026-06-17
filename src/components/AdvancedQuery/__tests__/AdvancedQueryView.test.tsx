import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import type { ActiveBlockRow, AdvancedQueryResponse } from '@/lib/tauri'
import { useAdvancedQueryStore } from '@/stores/advancedQuery'
import { useSpaceStore } from '@/stores/space'

import { AdvancedQueryView } from '../AdvancedQueryView'

const mockedInvoke = vi.mocked(invoke)

const SPACE_ID = 'SPACE_A'

/** Build a `QueryResultRow`-shaped row (ActiveBlockRow + optional score). */
function makeRow(overrides: Partial<ActiveBlockRow> = {}): ActiveBlockRow & { score: null } {
  return {
    id: 'BLK001',
    block_type: 'content',
    content: 'Hello world',
    parent_id: 'PAGE001',
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: 'PAGE001',
    score: null,
    ...overrides,
  }
}

function makeResponse(over: Partial<AdvancedQueryResponse> = {}): AdvancedQueryResponse {
  return { rows: [], nextCursor: null, hasMore: false, totalCount: 0, ...over }
}

/**
 * Route IPC by command. `run_advanced_query` resolves the supplied response;
 * `batch_resolve` resolves a single title so the result rows render a page link.
 */
function routeInvoke(response: AdvancedQueryResponse): void {
  mockedInvoke.mockImplementation(async (cmd) => {
    if (cmd === 'run_advanced_query') return response
    if (cmd === 'batch_resolve') return [{ id: 'PAGE001', title: 'Parent page' }]
    return null
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({ currentSpaceId: SPACE_ID })
  useAdvancedQueryStore.setState({ filtersBySpace: {}, nextAddId: 0 })
  routeInvoke(makeResponse())
})

afterEach(() => {
  useAdvancedQueryStore.setState({ filtersBySpace: {}, nextAddId: 0 })
})

describe('AdvancedQueryView', () => {
  it('runs the engine on mount with an empty conjunction and shows the empty state', async () => {
    render(<AdvancedQueryView />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('run_advanced_query', {
        request: {
          spaceId: SPACE_ID,
          filter: { type: 'And', children: [] },
          limit: 50,
        },
      })
    })
    expect(await screen.findByText('No blocks match these filters')).toBeInTheDocument()
  })

  it('renders matched rows and the total count', async () => {
    routeInvoke(
      makeResponse({
        rows: [makeRow({ id: 'BLK_A', content: 'First match' })],
        totalCount: 1,
      }),
    )
    render(<AdvancedQueryView />)

    expect(await screen.findByText('First match')).toBeInTheDocument()
    expect(screen.getByTestId('advanced-query-total')).toHaveTextContent('1 matching block')
  })

  it('adds a tag chip and re-runs the query wrapping it as an And of a Leaf', async () => {
    const user = userEvent.setup()
    render(<AdvancedQueryView />)
    // Wait for the initial (empty-filter) fetch to settle.
    await screen.findByText('No blocks match these filters')

    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await user.click(await screen.findByText('Tag'))
    await user.type(screen.getByLabelText('Tag id'), 'project')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('run_advanced_query', {
        request: {
          spaceId: SPACE_ID,
          filter: {
            type: 'And',
            children: [{ type: 'Leaf', primitive: { type: 'Tag', tag: 'project' } }],
          },
          limit: 50,
        },
      })
    })
    // The chip is visible in the builder row.
    expect(screen.getByText('tag: project')).toBeInTheDocument()
  })

  it('does NOT offer the Pages-only facets (Orphan/Stub/No inbound links)', async () => {
    const user = userEvent.setup()
    render(<AdvancedQueryView />)
    await screen.findByText('No blocks match these filters')

    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    // Shared facet is present…
    expect(await screen.findByText('Tag')).toBeInTheDocument()
    // …but the Pages-only facet is gated out.
    expect(screen.queryByText('Orphan')).not.toBeInTheDocument()
  })

  it('paginates via load-more, carrying the cursor', async () => {
    const user = userEvent.setup()
    // First page has more; second page completes.
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'run_advanced_query') {
        const cursor = (args as { request: { cursor?: string } }).request.cursor
        if (cursor === 'CUR1') {
          return makeResponse({ rows: [makeRow({ id: 'BLK_B', content: 'Second page' })] })
        }
        return makeResponse({
          rows: [makeRow({ id: 'BLK_A', content: 'First page' })],
          nextCursor: 'CUR1',
          hasMore: true,
          totalCount: 2,
        })
      }
      if (cmd === 'batch_resolve') return [{ id: 'PAGE001', title: 'Parent page' }]
      return null
    })
    render(<AdvancedQueryView />)

    expect(await screen.findByText('First page')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /load more/i }))

    expect(await screen.findByText('Second page')).toBeInTheDocument()
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('run_advanced_query', {
        request: {
          spaceId: SPACE_ID,
          filter: { type: 'And', children: [] },
          limit: 50,
          cursor: 'CUR1',
        },
      })
    })
  })

  it('surfaces a backend error and retries', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementationOnce(async () => {
      throw new Error('engine exploded')
    })
    render(<AdvancedQueryView />)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('engine exploded')).toBeInTheDocument()

    // Retry — IPC now succeeds and the error clears.
    routeInvoke(makeResponse())
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No blocks match these filters')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<AdvancedQueryView />)
    await screen.findByText('No blocks match these filters')
    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
