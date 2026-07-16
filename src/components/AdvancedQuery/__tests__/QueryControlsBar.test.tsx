import { render, screen, waitFor, within } from '@testing-library/react'
import type React from 'react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { QueryControlsBarProps } from '@/components/AdvancedQuery/QueryControlsBar'
import { QueryControlsBar } from '@/components/AdvancedQuery/QueryControlsBar'
import type { SortKey } from '@/lib/tauri'

const noop = (): void => {}

const baseProps: QueryControlsBarProps = {
  fulltext: '',
  onFulltextChange: noop,
  sort: [],
  onSortChange: noop,
  groupBy: null,
  onGroupByChange: noop,
  aggregates: [],
  onAggregatesChange: noop,
}

describe('QueryControlsBar', () => {
  it('re-syncs the full-text input when the committed prop changes (e.g. a space switch)', () => {
    const { rerender } = render(<QueryControlsBar {...baseProps} fulltext="hello" />)
    const input = screen.getByTestId('advanced-query-fulltext') as HTMLInputElement
    expect(input.value).toBe('hello')

    // A space switch resets the committed `fulltext` to the new space's value.
    // Without the sync effect the input would keep showing the stale 'hello'
    // while the query sends nothing — the bug this guards against.
    rerender(<QueryControlsBar {...baseProps} fulltext="" />)
    expect(input.value).toBe('')

    rerender(<QueryControlsBar {...baseProps} fulltext="world" />)
    expect(input.value).toBe('world')
  })

  // #2216 — clearing the full-text term must downgrade a `Relevance` sort key.
  // The `Relevance` option is only offered while `hasFulltext`; if the user
  // empties the term with a Relevance sort active, the Select would go blank
  // (option gone) and the query would send an engine-rejected sort. The control
  // reconciles the committed sort array down to the in-vocabulary default.
  it('#2216 — downgrades a Relevance sort to Column/created when the full-text term is cleared', async () => {
    const onSortChange = vi.fn()

    // Owns the sort array so the reconcile (onSortChange) is applied and
    // reflected, mirroring the real parent store; fulltext is driven via prop.
    function Harness({ fulltext }: { fulltext: string }): React.ReactElement {
      const [sort, setSort] = useState<SortKey[]>([{ source: { type: 'Relevance' }, desc: false }])
      const handleSort = (next: SortKey[]): void => {
        onSortChange(next)
        setSort(next)
      }
      return (
        <QueryControlsBar
          {...baseProps}
          fulltext={fulltext}
          sort={sort}
          onSortChange={handleSort}
        />
      )
    }

    const { rerender } = render(<Harness fulltext="hello" />)

    // With a full-text term set, the Relevance option is available and selected.
    const row = screen.getByTestId('advanced-query-sort-row')
    const sourceSelect = within(row).getAllByRole('combobox')[0] as HTMLSelectElement
    expect(sourceSelect.value).toBe('__relevance__')
    expect(sourceSelect.querySelector('option[value="__relevance__"]')).not.toBeNull()

    // Clear the full-text term → the effect downgrades the Relevance sort key.
    rerender(<Harness fulltext="" />)

    await waitFor(() => {
      expect(onSortChange).toHaveBeenCalledWith([
        { source: { type: 'Column', name: 'created' }, desc: false },
      ])
    })
    // The Select now shows an in-vocabulary column value (not a blank/missing option).
    expect(sourceSelect.value).toBe('created')
    // The Relevance option is no longer offered without a full-text term.
    expect(sourceSelect.querySelector('option[value="__relevance__"]')).toBeNull()
  })

  // #2216 — the reconcile must be surgical: only Relevance keys are rewritten;
  // other keys keep their source, direction, and position in the ordered list.
  it('#2216 — downgrades only the Relevance key, preserving other sort keys in order', async () => {
    const onSortChange = vi.fn()
    render(
      <QueryControlsBar
        {...baseProps}
        fulltext=""
        sort={[
          { source: { type: 'Column', name: 'title' }, desc: true },
          { source: { type: 'Relevance' }, desc: true },
          { source: { type: 'Column', name: 'priority' }, desc: false },
        ]}
        onSortChange={onSortChange}
      />,
    )

    await waitFor(() => {
      expect(onSortChange).toHaveBeenCalledWith([
        { source: { type: 'Column', name: 'title' }, desc: true },
        { source: { type: 'Column', name: 'created' }, desc: true },
        { source: { type: 'Column', name: 'priority' }, desc: false },
      ])
    })
  })

  // #2216 — a saved query that legitimately pairs Relevance with a full-text
  // term must NOT be downgraded on mount.
  it('#2216 — leaves a Relevance sort untouched while a full-text term is set', () => {
    const onSortChange = vi.fn()
    render(
      <QueryControlsBar
        {...baseProps}
        fulltext="hello"
        sort={[{ source: { type: 'Relevance' }, desc: false }]}
        onSortChange={onSortChange}
      />,
    )
    expect(onSortChange).not.toHaveBeenCalled()
  })
})
