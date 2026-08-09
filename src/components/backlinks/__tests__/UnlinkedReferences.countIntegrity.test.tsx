// @vitest-environment jsdom
// Pinned to jsdom for the same reason as `BacklinkFilterBuilder.test.tsx`: this
// file renders the REAL filter builder, whose "active filters" path crashes
// deep in the runner under happy-dom.

/**
 * #3733 notes 1, 2 and 4 — the reference panel's numbers must never contradict
 * its rows.
 *
 * #3316 item 1 set out to stop the header asserting a count the list does not
 * show. Two reachable states were not covered by it, and are pinned here
 * against the RENDERED output rather than against the query cache, because the
 * cache shape is an implementation detail and the contradiction is what the
 * user sees:
 *
 *  1. The optimistic "Link it" removal decremented `total_count` only. With a
 *     filter active, "Showing {filtered} of {total}" kept counting the row it
 *     had just removed — "Showing 4 of 39" over 3 rows — until the next
 *     refetch healed it.
 *  2. `groupLimit` is part of the query key, so the first expand switched the
 *     observer to an empty cache entry, `totalCount` fell back to 0, and the
 *     header read "No Unlinked References" over a panel that had just said 12.
 *
 * Note 4 (also #3732 item 1's sibling) is a class-string concern: under
 * windowing `last:border-b-0` matches the last MOUNTED row, so the divider
 * disappears mid-group. jsdom computes no Tailwind, so the class list is the
 * assertion.
 *
 * The virtualizer window is a lever here (`virtualWindow.size`), unlike in
 * `UnlinkedReferences.test.tsx` which lays out every row. The windowing itself
 * is pinned by
 * `src/components/common/__tests__/CollapsibleGroupList.virtualization.test.tsx`.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'

/** `null` = lay out every row. Set to a number to window. Reset per test. */
const virtualWindow = vi.hoisted(() => ({ size: null as number | null }))
vi.mock('@tanstack/react-virtual', () => mockReactVirtual({ windowSize: () => virtualWindow.size }))

const { mockListPropertyKeys, mockListTagsByPrefix } = vi.hoisted(() => ({
  mockListPropertyKeys: vi.fn(),
  mockListTagsByPrefix: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  listUnlinkedReferences: vi.fn(),
  editBlock: vi.fn(),
  listTagsByPrefix: mockListTagsByPrefix,
  listPropertyKeys: mockListPropertyKeys,
  getPageAliases: vi.fn(),
  paginationLimit: (n: number) => n,
}))

vi.mock('@/lib/bindings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bindings')>('@/lib/bindings')
  return {
    ...actual,
    commands: {
      ...actual.commands,
      listPropertyKeys: mockListPropertyKeys,
      listTagsByPrefix: mockListTagsByPrefix,
    },
  }
})

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/components/pages/PageLink', () => ({
  PageLink: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <button type="button">{children ?? title}</button>
  ),
}))

import { UnlinkedReferences } from '@/components/backlinks/UnlinkedReferences'
import { TooltipProvider } from '@/components/ui/tooltip'
import { _resetPropertyKeysCacheForTest } from '@/hooks/usePropertyKeysCache'
import { t } from '@/lib/i18n'
import { queryClient } from '@/lib/query-client'
import type { GroupedBacklinkResponse } from '@/lib/tauri'
import { editBlock, getPageAliases, listUnlinkedReferences } from '@/lib/tauri'

const mockedListUnlinked = vi.mocked(listUnlinkedReferences)
const mockedEditBlock = vi.mocked(editBlock)
const mockedGetPageAliases = vi.mocked(getPageAliases)

const PAGE_TITLE = 'Alpha'

function makeBlocks(ids: string[]) {
  return ids.map((id, i) => ({
    id,
    block_type: 'content' as const,
    content: `${PAGE_TITLE} mention ${id}`,
    parent_id: 'P1',
    position: i,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
  }))
}

function makeResponse(opts: { ids: string[]; total: number; filtered: number }) {
  return {
    groups: [{ page_id: 'P1', page_title: 'Page One', blocks: makeBlocks(opts.ids) }],
    next_cursor: null,
    has_more: false,
    total_count: opts.total,
    filtered_count: opts.filtered,
    truncated: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  virtualWindow.size = null
  queryClient.clear()
  _resetPropertyKeysCacheForTest()
  mockListTagsByPrefix.mockResolvedValue({ status: 'ok', data: [] })
  mockListPropertyKeys.mockResolvedValue({ status: 'ok', data: [] })
  mockedGetPageAliases.mockResolvedValue([])
  mockedEditBlock.mockResolvedValue({
    id: 'B1',
    block_type: 'content',
    content: '',
    parent_id: 'P1',
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
    op_refs: [],
  } as never)
})

function renderPanel() {
  return render(
    <TooltipProvider>
      <UnlinkedReferences pageId="PAGE1" pageTitle={PAGE_TITLE} />
    </TooltipProvider>,
  )
}

/** Rows currently committed to the DOM. */
function rowCount(container: HTMLElement): number {
  return container.querySelectorAll('.unlinked-reference-item').length
}

/**
 * The `filtered`/`total` pair the panel is currently ASSERTING, read back out
 * of the rendered aria-live line rather than out of the cache.
 */
function shownCounts(): { filtered: number; total: number } {
  const line = screen.getByText(/Showing \d+ of \d+/)
  const m = /Showing (\d+) of (\d+)/.exec(line.textContent ?? '')
  if (!m) throw new Error(`unparsable count line: ${line.textContent}`)
  return { filtered: Number(m[1]), total: Number(m[2]) }
}

async function expand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Unlinked References?/i }))
}

/** Drive the REAL BacklinkFilterBuilder to apply a BlockType filter. */
async function applyBlockTypeFilter(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Add filter/i }))
  await user.selectOptions(screen.getByLabelText('Filter category'), 'type')
  await user.selectOptions(screen.getByLabelText('Block type value'), 'page')
  await user.click(screen.getByRole('button', { name: /Apply filter/i }))
}

describe('UnlinkedReferences — the count must agree with the rows', () => {
  // #3733 note 1.
  it('"Link it" under an active filter leaves "Showing N of M" agreeing with the rows', async () => {
    const user = userEvent.setup()
    mockedListUnlinked.mockImplementation(async (args) =>
      args.filters
        ? makeResponse({ ids: ['B1', 'B2', 'B3', 'B4'], total: 40, filtered: 4 })
        : makeResponse({ ids: ['B1'], total: 40, filtered: 40 }),
    )

    const { container } = renderPanel()
    await expand(user)
    await applyBlockTypeFilter(user)

    await waitFor(() => {
      expect(rowCount(container)).toBe(4)
    })
    expect(shownCounts()).toEqual({ filtered: 4, total: 40 })

    // Link the first row away. Nothing refetches (editBlock emits no property
    // event), so what is on screen afterwards is the optimistic update alone.
    await user.click(screen.getAllByRole('button', { name: /^Link it:/i })[0] as HTMLElement)

    await waitFor(() => {
      expect(rowCount(container)).toBe(3)
    })
    // THE property: the number the panel asserts is the number of rows it shows.
    const shown = shownCounts()
    expect(shown.filtered).toBe(rowCount(container))
    // …and the unfiltered total still drops by exactly one.
    expect(shown).toEqual({ filtered: 3, total: 39 })
  })

  // #3733 note 2.
  it('expanding does not flash "No Unlinked References" over a known count', async () => {
    const user = userEvent.setup()
    let releaseExpanded: ((v: GroupedBacklinkResponse) => void) | undefined
    mockedListUnlinked.mockImplementation(async (args) => {
      // The collapsed panel asks for a single group (#3316 item 2) and gets the
      // exact counts back; expanding re-keys the query to the full page.
      if (Number(args.limit) === 1) return makeResponse({ ids: ['B1'], total: 12, filtered: 12 })
      return new Promise<GroupedBacklinkResponse>((resolve) => {
        releaseExpanded = resolve
      })
    })

    renderPanel()

    const twelve = t('unlinkedRefs.header', { count: 12 })
    await screen.findByRole('button', { name: new RegExp(twelve, 'i') })

    await expand(user)

    // The expand fetch is in flight — the count was already known, so nothing
    // may claim there are none.
    await waitFor(() => {
      expect(mockedListUnlinked).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }))
    })
    expect(screen.queryByText(t('unlinkedRefs.headerNone'))).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(twelve, 'i') })).toBeInTheDocument()

    releaseExpanded?.(makeResponse({ ids: ['B1', 'B2'], total: 12, filtered: 12 }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: new RegExp(twelve, 'i') })).toBeInTheDocument()
    })
  })

  // #3733 note 4 / #3732's sibling concern.
  describe('row divider under windowing', () => {
    it('keeps the divider on the last MOUNTED row when the group continues', async () => {
      const user = userEvent.setup()
      virtualWindow.size = 3
      mockedListUnlinked.mockResolvedValue(
        makeResponse({ ids: ['B1', 'B2', 'B3', 'B4', 'B5'], total: 5, filtered: 5 }),
      )

      const { container } = renderPanel()
      await expand(user)
      await waitFor(() => {
        expect(rowCount(container)).toBe(3)
      })

      const rows = container.querySelectorAll('.unlinked-reference-item')
      const lastMounted = [...rows].at(-1) as HTMLElement
      expect(lastMounted.getAttribute('data-backlink-item')).toBe('B3')
      expect(lastMounted).toHaveClass('border-b')
      expect(lastMounted).not.toHaveClass('border-b-0')
      // The `last:` variant would resolve against the WINDOW, so it must be gone.
      expect(lastMounted.className).not.toMatch(/(?:^|\s)last:border-b-0(?:\s|$)/)
    })

    it('drops the divider on the real last row of the group', async () => {
      const user = userEvent.setup()
      mockedListUnlinked.mockResolvedValue(
        makeResponse({ ids: ['B1', 'B2', 'B3'], total: 3, filtered: 3 }),
      )

      const { container } = renderPanel()
      await expand(user)
      await waitFor(() => {
        expect(rowCount(container)).toBe(3)
      })

      expect(container.querySelector('[data-backlink-item="B3"]')).toHaveClass('border-b-0')
      expect(container.querySelector('[data-backlink-item="B2"]')).not.toHaveClass('border-b-0')
    })
  })
})
