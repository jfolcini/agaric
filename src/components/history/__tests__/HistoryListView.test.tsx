/**
 * #2245 — HistoryListView: the polite live region that announces newly-loaded
 * history pages. This a11y branch (grow → announce delta, shrink → clear) was
 * previously untested. The presentational list is exercised in isolation:
 * HistoryListItem is stubbed and the virtualizer is the shared render-all mock,
 * so the assertions target only the announcement contract.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makeHistoryEntry } from '@/__tests__/fixtures'
import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { HistoryListView } from '@/components/history/HistoryListView'
import { t } from '@/lib/i18n'
import type { HistoryEntry } from '@/lib/tauri'

vi.mock('@tanstack/react-virtual', () => mockReactVirtual())

// Stub the row: the live-region contract depends only on `entries.length`
// changing across renders, not on row internals.
vi.mock('@/components/HistoryListItem', () => ({
  HistoryListItem: ({ index }: { index: number }) => <div data-testid={`row-${index}`} />,
}))

function makeEntries(n: number): HistoryEntry[] {
  return Array.from({ length: n }, (_, i) => makeHistoryEntry(i + 1, 'insert_block', { i }))
}

/** Wrapper owning the list ref so `entries` can be driven via `rerender`. */
function Harness({ entries }: { entries: HistoryEntry[] }) {
  const listRef = useRef<HTMLDivElement | null>(null)
  return (
    <HistoryListView
      entries={entries}
      selectedIds={new Set()}
      focusedIndex={-1}
      expandedKeys={new Set()}
      diffCache={new Map()}
      loadingDiffs={new Set()}
      listRef={listRef}
      hasMore={false}
      loading={false}
      onLoadMore={vi.fn()}
      onRowClick={vi.fn()}
      onToggleSelection={vi.fn()}
      onToggleDiff={vi.fn()}
      onRestoreToHere={vi.fn()}
    />
  )
}

describe('HistoryListView live region (#2245)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stays silent on initial mount (no prior length to compare)', () => {
    render(<Harness entries={makeEntries(3)} />)
    // The <output> (implicit role=status) exists but announces nothing yet.
    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  it('announces the pluralized delta when entries grow', async () => {
    const { rerender } = render(<Harness entries={makeEntries(3)} />)
    expect(screen.getByRole('status')).toHaveTextContent('')

    // Load 3 more (3 → 6): the polite region announces the delta.
    rerender(<Harness entries={makeEntries(6)} />)
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        t('history.loadedMoreEntries', { count: 3 }),
      )
    })
  })

  it('clears the announcement when entries shrink', async () => {
    const { rerender } = render(<Harness entries={makeEntries(3)} />)
    rerender(<Harness entries={makeEntries(6)} />)
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        t('history.loadedMoreEntries', { count: 3 }),
      ),
    )

    // Shrink (6 → 2, e.g. a filter change) clears the stale announcement.
    rerender(<Harness entries={makeEntries(2)} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(''))
  })

  it('has no a11y violations', async () => {
    const { container } = render(<Harness entries={makeEntries(3)} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
