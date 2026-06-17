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
  useAdvancedQueryStore.setState({
    filtersBySpace: {},
    buildersBySpace: {},
    controlsBySpace: {},
    nextAddId: 0,
  })
  routeInvoke(makeResponse())
})

afterEach(() => {
  useAdvancedQueryStore.setState({
    filtersBySpace: {},
    buildersBySpace: {},
    controlsBySpace: {},
    nextAddId: 0,
  })
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

  /** Add a `tag: <value>` leaf into the root group via the Add-filter popover. */
  async function addTagLeaf(user: ReturnType<typeof userEvent.setup>, tag: string): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    // Scope to the facet popover dialog — "Tag" also appears as a group-by
    // option, so the bare-text lookup is ambiguous.
    const popover = await screen.findByRole('dialog')
    await user.click(within(popover).getByText('Tag'))
    await user.type(screen.getByLabelText('Tag id'), tag)
    await user.click(screen.getByRole('button', { name: 'Apply' }))
  }

  it('adds a tag leaf and re-runs the query wrapping it as an And of a Leaf', async () => {
    const user = userEvent.setup()
    render(<AdvancedQueryView />)
    // Wait for the initial (empty-builder) fetch to settle.
    await screen.findByText('No blocks match these filters')

    await addTagLeaf(user, 'project')

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
    // The leaf chip is visible in the builder.
    expect(screen.getByText('tag: project')).toBeInTheDocument()
  })

  it('does NOT offer the Pages-only facets (Orphan/Stub/No inbound links)', async () => {
    const user = userEvent.setup()
    render(<AdvancedQueryView />)
    await screen.findByText('No blocks match these filters')

    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    const popover = await screen.findByRole('dialog')
    // Shared facet is present…
    expect(within(popover).getByText('Tag')).toBeInTheDocument()
    // …but the Pages-only facet is gated out.
    expect(within(popover).queryByText('Orphan')).not.toBeInTheDocument()
  })

  it('toggles the root combinator to Or and re-runs the query', async () => {
    const user = userEvent.setup()
    render(<AdvancedQueryView />)
    await screen.findByText('No blocks match these filters')

    await addTagLeaf(user, 'a')
    await addTagLeaf(user, 'b')

    // Flip the root group's combinator from All (And) to Any (Or).
    await user.click(screen.getByRole('radio', { name: 'Any' }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('run_advanced_query', {
        request: {
          spaceId: SPACE_ID,
          filter: {
            type: 'Or',
            children: [
              { type: 'Leaf', primitive: { type: 'Tag', tag: 'a' } },
              { type: 'Leaf', primitive: { type: 'Tag', tag: 'b' } },
            ],
          },
          limit: 50,
        },
      })
    })
  })

  it('negates the root group, wrapping the compiled expr in Not', async () => {
    const user = userEvent.setup()
    render(<AdvancedQueryView />)
    await screen.findByText('No blocks match these filters')

    await addTagLeaf(user, 'a')
    // The root group's NOT toggle is the first NOT button on the surface.
    await user.click(screen.getAllByRole('button', { name: 'NOT' })[0] as HTMLElement)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('run_advanced_query', {
        request: {
          spaceId: SPACE_ID,
          filter: {
            type: 'Not',
            child: {
              type: 'And',
              children: [{ type: 'Leaf', primitive: { type: 'Tag', tag: 'a' } }],
            },
          },
          limit: 50,
        },
      })
    })
  })

  it('adds a nested group with its own leaf and compiles the tree', async () => {
    const user = userEvent.setup()
    render(<AdvancedQueryView />)
    await screen.findByText('No blocks match these filters')

    await addTagLeaf(user, 'top')
    // "+ Group" appends an empty And sub-group to the root.
    await user.click(screen.getByRole('button', { name: 'Add group' }))

    // The nested group renders at depth 1. Add a leaf into it via the nested
    // group's OWN Add-filter button (scoped to the depth-1 group section).
    const nestedGroup = await waitFor(() => {
      const g = screen.getAllByTestId('filter-group').find((el) => el.dataset['depth'] === '1')
      if (!g) throw new Error('nested group not yet rendered')
      return g
    })
    await user.click(within(nestedGroup).getByRole('button', { name: 'Add filter' }))
    const popover = await screen.findByRole('dialog')
    await user.click(within(popover).getByText('Tag'))
    await user.type(screen.getByLabelText('Tag id'), 'nested')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('run_advanced_query', {
        request: {
          spaceId: SPACE_ID,
          filter: {
            type: 'And',
            children: [
              { type: 'Leaf', primitive: { type: 'Tag', tag: 'top' } },
              {
                type: 'And',
                children: [{ type: 'Leaf', primitive: { type: 'Tag', tag: 'nested' } }],
              },
            ],
          },
          limit: 50,
        },
      })
    })
    // Two groups now render (root + nested).
    expect(screen.getAllByTestId('filter-group').length).toBe(2)
  })

  it('removes a leaf, returning the compiled expr to an empty conjunction', async () => {
    const user = userEvent.setup()
    render(<AdvancedQueryView />)
    await screen.findByText('No blocks match these filters')

    await addTagLeaf(user, 'gone')
    expect(screen.getByText('tag: gone')).toBeInTheDocument()

    // Remove the leaf via its pill remove control.
    await user.click(screen.getByRole('button', { name: 'Remove condition' }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenLastCalledWith('run_advanced_query', {
        request: {
          spaceId: SPACE_ID,
          filter: { type: 'And', children: [] },
          limit: 50,
        },
      })
    })
    expect(screen.queryByText('tag: gone')).not.toBeInTheDocument()
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

  // --- D2 controls --------------------------------------------------------

  it('renders the D2 controls bar (full-text / sort / group-by / aggregates)', async () => {
    render(<AdvancedQueryView />)
    await screen.findByText('No blocks match these filters')

    expect(screen.getByTestId('advanced-query-fulltext')).toBeInTheDocument()
    expect(screen.getByLabelText('Group by')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add sort key' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add aggregate' })).toBeInTheDocument()
  })

  it('typing a debounced full-text term sends fulltext in the request', async () => {
    const user = userEvent.setup()
    render(<AdvancedQueryView />)
    await screen.findByText('No blocks match these filters')

    await user.type(screen.getByTestId('advanced-query-fulltext'), 'roadmap')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('run_advanced_query', {
        request: {
          spaceId: SPACE_ID,
          filter: { type: 'And', children: [] },
          limit: 50,
          fulltext: 'roadmap',
        },
      })
    })
  })

  it('only offers the Relevance sort option once a full-text term is set', async () => {
    const user = userEvent.setup()
    render(<AdvancedQueryView />)
    await screen.findByText('No blocks match these filters')

    // Add a sort key — with no full-text term, Relevance is absent.
    await user.click(screen.getByRole('button', { name: 'Add sort key' }))
    const sourceSelect = screen.getByLabelText('Sort field') as HTMLSelectElement
    const optionTexts = (): string[] => Array.from(sourceSelect.options).map((o) => o.text)
    expect(optionTexts()).not.toContain('Relevance')

    // Set a full-text term → Relevance becomes available.
    await user.type(screen.getByTestId('advanced-query-fulltext'), 'q')
    await waitFor(() => {
      expect(optionTexts()).toContain('Relevance')
    })
  })

  it('renders a global aggregate summary in flat mode', async () => {
    routeInvoke(
      makeResponse({
        rows: [makeRow({ id: 'BLK_A', content: 'Row' })],
        totalCount: 1,
        aggregates: [{ op: 'count', value: null, count: 5 }],
      }),
    )
    render(<AdvancedQueryView />)

    const summary = await screen.findByTestId('advanced-query-aggregate-summary')
    expect(within(summary).getByText('Count: 5')).toBeInTheDocument()
  })

  it('renders grouped results with per-group count and aggregate chips', async () => {
    routeInvoke(
      makeResponse({
        rows: [],
        groups: [
          {
            key: 'project',
            count: 2,
            members: [makeRow({ id: 'BLK_M', content: 'Member row' })],
            aggregates: [{ op: 'count', value: null, count: 2 }],
          },
        ],
        totalCount: 1,
      }),
    )
    // Seed a group-by so the hook runs the GROUPED path on first fetch.
    useAdvancedQueryStore.setState({
      controlsBySpace: {
        [SPACE_ID]: { fulltext: '', sort: [], groupBy: { key: { type: 'Tag' } }, aggregates: [] },
      },
    })
    render(<AdvancedQueryView />)

    const group = await screen.findByTestId('advanced-query-group-section')
    expect(within(group).getByText('project')).toBeInTheDocument()
    expect(within(group).getByText('2 blocks')).toBeInTheDocument()
    // Per-group aggregate chip.
    expect(within(group).getByText('Count: 2')).toBeInTheDocument()
    // Previewed member row renders via the shared result list.
    expect(within(group).getByText('Member row')).toBeInTheDocument()
  })

  it('resolves a Tag group-key id to its title in the header (#1447)', async () => {
    const tagId = '01J000000000000000000TAG00'
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'run_advanced_query') {
        return makeResponse({
          rows: [],
          groups: [{ key: tagId, count: 2, members: [makeRow({ id: 'BLK_M' })] }],
          totalCount: 1,
        })
      }
      if (cmd === 'batch_resolve') {
        // The hook folds the Tag group key into the SAME batch_resolve call as
        // the member rows' page ids — assert both ids are requested.
        const ids = (args as { ids: string[] }).ids
        expect(ids).toContain(tagId)
        return [
          { id: tagId, title: 'project' },
          { id: 'PAGE001', title: 'Parent page' },
        ]
      }
      return null
    })
    useAdvancedQueryStore.setState({
      controlsBySpace: {
        [SPACE_ID]: { fulltext: '', sort: [], groupBy: { key: { type: 'Tag' } }, aggregates: [] },
      },
    })
    render(<AdvancedQueryView />)

    const group = await screen.findByTestId('advanced-query-group-section')
    // Header shows the resolved tag title, not the raw id.
    expect(within(group).getByTestId('advanced-query-group-key')).toHaveTextContent('project')
    expect(within(group).queryByText(tagId)).not.toBeInTheDocument()
  })

  it('shows the empty state in grouped mode when there are no groups', async () => {
    routeInvoke(makeResponse({ rows: [], groups: [], totalCount: 0 }))
    // Pre-seed a group-by so the very first fetch is grouped.
    useAdvancedQueryStore.setState({
      controlsBySpace: {
        [SPACE_ID]: { fulltext: '', sort: [], groupBy: { key: { type: 'Tag' } }, aggregates: [] },
      },
    })
    render(<AdvancedQueryView />)

    expect(await screen.findByText('No blocks match these filters')).toBeInTheDocument()
  })

  it('has no a11y violations with grouped results and aggregates rendered', async () => {
    routeInvoke(
      makeResponse({
        rows: [],
        groups: [
          {
            key: 'project',
            count: 1,
            // No parent_id/page_id ⇒ no nested PageLink in the member row, so
            // the axe audit targets MY grouped structure (headers + aggregate
            // chips + controls), not QueryResultRow's pre-existing
            // nested-interactive row-with-link pattern.
            members: [
              makeRow({ id: 'BLK_M', content: 'Member row', parent_id: null, page_id: null }),
            ],
            aggregates: [{ op: 'count', value: null, count: 1 }],
          },
        ],
        totalCount: 1,
        aggregates: [{ op: 'count', value: null, count: 1 }],
      }),
    )
    useAdvancedQueryStore.setState({
      controlsBySpace: {
        [SPACE_ID]: { fulltext: '', sort: [], groupBy: { key: { type: 'Tag' } }, aggregates: [] },
      },
    })
    const { container } = render(<AdvancedQueryView />)
    await screen.findByTestId('advanced-query-group-section')
    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
