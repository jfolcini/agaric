/**
 * Tests for TrashListView (#740 — virtualization).
 *
 * The trash list used to render every row with a plain `.map()`; each
 * `TrashRowItem` runs a heavy `renderRichContent` parse plus two
 * `TooltipProvider`s, so hundreds of trashed rows janked. It now windows
 * through `@tanstack/react-virtual` — the SAME primitive
 * AgendaResults / DuePanel / DonePanel / PageBrowser use — mirroring the
 * DonePanel pattern (ScrollArea viewport as the scroll element,
 * absolute-positioned rows, `measureElement`, `overscan: 5`).
 *
 * These tests mirror the DonePanel / PageBrowser virtualization tests:
 *
 *  1. Windowing: with a capped window the DOM holds only the visible
 *     slice, NOT every row (the regression guard for #740).
 *  2. Full render (mock returns all rows): selection state, actions,
 *     focus wiring (`aria-activedescendant`) and tag clicks are
 *     preserved through the virtualized markup.
 *  3. Empty / no-match states still render.
 *  4. A11y audit passes (axe).
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'

// Render the rich content as plain text so row content is queryable and
// the heavy parse is skipped in tests (mirrors DonePanel/TrashView tests).
vi.mock('@/components/RichContentRenderer', () => ({
  renderRichContent: vi.fn((markdown: string) => markdown),
}))

// Windowed via a mutable holder so each test can choose between "window
// the list" (the regression guard) and "lay out every row" (behaviour /
// axe). The holder + the spy-wrapped `useVirtualizer` live in
// `vi.hoisted` so they are available inside the hoisted `vi.mock` factory.
// Passing `windowSize` as a *getter* lets the factory re-read the holder
// on every render, so flipping it between tests takes effect immediately.
const { WINDOW_SIZE, virtualState } = vi.hoisted(() => {
  const WINDOW_SIZE = 4
  // `null` window = render every row; a number = cap to that many rows.
  const virtualState: { window: number | null } = { window: WINDOW_SIZE }
  return { WINDOW_SIZE, virtualState }
})

vi.mock('@tanstack/react-virtual', async () => {
  const { mockReactVirtual } = await import('@/__tests__/mocks/react-virtual')
  const { vi } = await import('vitest')
  const impl = mockReactVirtual({ windowSize: () => virtualState.window }).useVirtualizer
  return { useVirtualizer: vi.fn(impl) }
})

import { useVirtualizer } from '@tanstack/react-virtual'

import { makeBlock } from '@/__tests__/fixtures'
import type { RichContentCallbacks } from '@/hooks/useRichContentCallbacks'
import type { BlockRow } from '@/lib/tauri'

import { TrashListView } from '../TrashListView'

const callbacks: RichContentCallbacks = {
  resolveBlockTitle: () => undefined,
  resolveBlockStatus: () => 'active',
  resolveTagName: () => undefined,
  resolveTagStatus: () => 'active',
}

function makeBlocks(n: number): BlockRow[] {
  return Array.from({ length: n }, (_, i) =>
    makeBlock({ id: `B${i}`, content: `deleted item ${i}`, deleted_at: 1736899200000 + i }),
  )
}

function renderList(props: Partial<React.ComponentProps<typeof TrashListView>> = {}): {
  rerender: (ui: React.ReactElement) => void
  container: HTMLElement
} {
  const blocks = props.blocks ?? makeBlocks(50)
  const onRowClick = vi.fn()
  const onToggleSelection = vi.fn()
  const onRestore = vi.fn()
  const onRequestPurge = vi.fn()
  const onTagClick = vi.fn()
  const onClearFilter = vi.fn()
  const node = (
    <TrashListView
      blocks={blocks}
      filteredBlocks={props.filteredBlocks ?? blocks}
      loading={props.loading ?? false}
      debouncedFilter={props.debouncedFilter ?? ''}
      focusedIndex={props.focusedIndex ?? -1}
      selectedIds={props.selectedIds ?? new Set<string>()}
      descendantCounts={props.descendantCounts ?? {}}
      callbacks={callbacks}
      onTagClick={onTagClick}
      onClearFilter={onClearFilter}
      onRowClick={onRowClick}
      onToggleSelection={onToggleSelection}
      onRestore={onRestore}
      onRequestPurge={onRequestPurge}
      getParentLabel={props.getParentLabel ?? (() => null)}
    />
  )
  const result = render(node)
  return result
}

afterEach(() => {
  vi.clearAllMocks()
  // Restore the default windowed behaviour between tests.
  virtualState.window = WINDOW_SIZE
})

describe('TrashListView virtualization (#740)', () => {
  // 1. Windowing — the regression guard. The mock caps the window at
  //    WINDOW_SIZE, so the DOM must hold only that slice, not all 50 rows.
  it('windows rows instead of rendering all of them', () => {
    renderList({ blocks: makeBlocks(50) })

    const rows = screen.getAllByTestId('trash-item')
    expect(rows).toHaveLength(WINDOW_SIZE)
    // The far-off rows exist in the data but not in the DOM.
    expect(screen.queryByText('deleted item 40')).not.toBeInTheDocument()
    // The windowed slice IS rendered.
    expect(screen.getByText('deleted item 0')).toBeInTheDocument()
  })

  // 1b. Uses @tanstack/react-virtual with the same overscan as the
  //     sibling lists (DonePanel / PageBrowser use overscan: 5).
  it('constructs the virtualizer with overscan 5 over the filtered count', () => {
    renderList({ blocks: makeBlocks(50) })

    expect(useVirtualizer).toHaveBeenCalledWith(expect.objectContaining({ count: 50, overscan: 5 }))
  })

  // 2. The virtualized grid carries the listbox/grid role + label and is
  //    a tab stop (keyboard-nav container preserved).
  it('renders a labelled grid container that is a tab stop', () => {
    renderList({ blocks: makeBlocks(50) })

    const grid = screen.getByRole('grid', { name: t('trash.listLabel') })
    expect(grid).toHaveAttribute('tabindex', '0')
    expect(grid).toHaveClass('trash-view-list')
  })
})

describe('TrashListView behaviour preserved through virtualization', () => {
  // Lay out every row (no window cap) so behaviour / axe see the full list.
  function renderAll(props: Partial<React.ComponentProps<typeof TrashListView>> = {}) {
    virtualState.window = null
    return renderList(props)
  }

  // 3. Selection state flows through to the windowed rows.
  it('reflects selected rows via aria-selected + checkbox', () => {
    const blocks = makeBlocks(3)
    renderAll({ blocks, selectedIds: new Set(['B1']) })

    const selectedRow = screen.getByText('deleted item 1').closest('[data-trash-item]')
    expect(selectedRow).toHaveAttribute('aria-selected', 'true')
    const otherRow = screen.getByText('deleted item 0').closest('[data-trash-item]')
    expect(otherRow).toHaveAttribute('aria-selected', 'false')
  })

  // 4. Row actions (restore / purge) still fire their callbacks.
  it('fires restore + purge actions from a virtualized row', async () => {
    const user = userEvent.setup()
    const blocks = makeBlocks(3)
    const onRestore = vi.fn()
    const onRequestPurge = vi.fn()
    virtualState.window = null
    render(
      <TrashListView
        blocks={blocks}
        filteredBlocks={blocks}
        loading={false}
        debouncedFilter=""
        focusedIndex={-1}
        selectedIds={new Set<string>()}
        descendantCounts={{}}
        callbacks={callbacks}
        onTagClick={vi.fn()}
        onClearFilter={vi.fn()}
        onRowClick={vi.fn()}
        onToggleSelection={vi.fn()}
        onRestore={onRestore}
        onRequestPurge={onRequestPurge}
        getParentLabel={() => null}
      />,
    )

    const row = screen.getByText('deleted item 1').closest('[data-trash-item]') as HTMLElement
    await user.click(within(row).getByTestId('trash-restore-btn'))
    expect(onRestore).toHaveBeenCalledWith(blocks[1])

    await user.click(within(row).getByTestId('trash-purge-btn'))
    expect(onRequestPurge).toHaveBeenCalledWith('B1')
  })

  // 5. Checkbox toggles selection (multi-select path).
  it('toggles selection via the row checkbox', async () => {
    const user = userEvent.setup()
    const blocks = makeBlocks(3)
    const onToggleSelection = vi.fn()
    virtualState.window = null
    render(
      <TrashListView
        blocks={blocks}
        filteredBlocks={blocks}
        loading={false}
        debouncedFilter=""
        focusedIndex={-1}
        selectedIds={new Set<string>()}
        descendantCounts={{}}
        callbacks={callbacks}
        onTagClick={vi.fn()}
        onClearFilter={vi.fn()}
        onRowClick={vi.fn()}
        onToggleSelection={onToggleSelection}
        onRestore={vi.fn()}
        onRequestPurge={vi.fn()}
        getParentLabel={() => null}
      />,
    )

    const row = screen.getByText('deleted item 2').closest('[data-trash-item]') as HTMLElement
    await user.click(within(row).getByTestId('trash-item-checkbox'))
    expect(onToggleSelection).toHaveBeenCalledWith('B2')
  })

  // 6. Focus wiring — aria-activedescendant points at the focused row id.
  it('wires aria-activedescendant to the focused row', () => {
    renderAll({ blocks: makeBlocks(3), focusedIndex: 1 })

    const grid = screen.getByRole('grid', { name: t('trash.listLabel') })
    expect(grid).toHaveAttribute('aria-activedescendant', 'trash-item-B1')
  })

  // 7. Empty trash → empty state (not a grid).
  it('shows the empty state when there are no blocks', () => {
    renderAll({ blocks: [], filteredBlocks: [] })

    expect(screen.getByText(t('trash.emptyMessage'))).toBeInTheDocument()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })

  // 8. Active filter with zero matches → no-match state + clear button.
  it('shows the no-match state when a filter excludes every row', async () => {
    const user = userEvent.setup()
    const blocks = makeBlocks(3)
    const onClearFilter = vi.fn()
    virtualState.window = null
    render(
      <TrashListView
        blocks={blocks}
        filteredBlocks={[]}
        loading={false}
        debouncedFilter="zzz"
        focusedIndex={-1}
        selectedIds={new Set<string>()}
        descendantCounts={{}}
        callbacks={callbacks}
        onTagClick={vi.fn()}
        onClearFilter={onClearFilter}
        onRowClick={vi.fn()}
        onToggleSelection={vi.fn()}
        onRestore={vi.fn()}
        onRequestPurge={vi.fn()}
        getParentLabel={() => null}
      />,
    )

    expect(screen.getByText(t('trash.noMatchMessage'))).toBeInTheDocument()
    await user.click(screen.getByTestId('trash-clear-filter-btn'))
    expect(onClearFilter).toHaveBeenCalled()
  })

  // 9. A11y audit passes over the virtualized grid (axe).
  it('a11y: no violations', async () => {
    const { container } = renderAll({ blocks: makeBlocks(3), selectedIds: new Set(['B0']) })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
