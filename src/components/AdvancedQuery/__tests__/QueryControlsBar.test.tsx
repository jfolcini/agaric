import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import type { QueryControlsBarProps } from '@/components/AdvancedQuery/QueryControlsBar'
import { QueryControlsBar } from '@/components/AdvancedQuery/QueryControlsBar'
import type { AggregateSpec, GroupSpec, SortKey } from '@/lib/bindings'

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

// #4553 Phase 1 — `AggregateTarget::Property`: a fourth target option
// alongside `Rows`/`priority`/`position`, revealing a property-key input.
describe('QueryControlsBar — aggregate target Property (#4553 Phase 1)', () => {
  /** A small controlled harness so selecting "Property" and typing a key are
   * reflected back into the rendered row, mirroring how the real per-space
   * store round-trips `onAggregatesChange` into `aggregates`. */
  function Harness({
    onChange,
  }: {
    onChange: (aggregates: AggregateSpec[]) => void
  }): React.ReactElement {
    const [aggregates, setAggregates] = useState<AggregateSpec[]>([{ op: 'sum', target: null }])
    const handle = (next: AggregateSpec[]): void => {
      onChange(next)
      setAggregates(next)
    }
    return <QueryControlsBar {...baseProps} aggregates={aggregates} onAggregatesChange={handle} />
  }

  it('offers a Property option; no key input until it is selected', () => {
    render(<Harness onChange={vi.fn()} />)
    const row = screen.getByTestId('advanced-query-aggregate-row')
    const targetSelect = within(row).getByLabelText('Aggregate target') as HTMLSelectElement
    expect(Array.from(targetSelect.options).map((o) => o.value)).toEqual([
      '__none__',
      'priority',
      'position',
      '__property__',
    ])
    expect(within(row).queryByLabelText('Property key to aggregate')).not.toBeInTheDocument()
  })

  it('selecting Property reveals a key input; typing emits { type: "Property", key }', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const row = screen.getByTestId('advanced-query-aggregate-row')
    const targetSelect = within(row).getByLabelText('Aggregate target') as HTMLSelectElement

    await user.selectOptions(targetSelect, 'Property')
    expect(onChange).toHaveBeenLastCalledWith([
      { op: 'sum', target: { type: 'Property', key: '' } },
    ])

    const keyInput = within(row).getByLabelText('Property key to aggregate')
    await user.type(keyInput, 'estimate')
    expect(onChange).toHaveBeenLastCalledWith([
      { op: 'sum', target: { type: 'Property', key: 'estimate' } },
    ])
    expect(keyInput).toHaveValue('estimate')
  })

  it('switching back to a Column target hides the key input again', async () => {
    const user = userEvent.setup()
    render(<Harness onChange={vi.fn()} />)
    const row = screen.getByTestId('advanced-query-aggregate-row')
    const targetSelect = within(row).getByLabelText('Aggregate target') as HTMLSelectElement

    await user.selectOptions(targetSelect, 'Property')
    await user.type(within(row).getByLabelText('Property key to aggregate'), 'estimate')

    await user.selectOptions(targetSelect, 'Priority')
    expect(within(row).queryByLabelText('Property key to aggregate')).not.toBeInTheDocument()
  })
})

// #4553 Phase 2 — `GroupKey::Property` and `GroupKey::DateBucket` in the
// group-by picker. Both variants already existed on the wire; the picker just
// never offered them.
describe('QueryControlsBar — group by Property / DateBucket (#4553 Phase 2)', () => {
  /** Controlled harness so a picked group key is reflected back into the
   * rendered controls, mirroring the per-space store round-trip. */
  function Harness({
    initial = null,
    onChange,
  }: {
    initial?: GroupSpec | null
    onChange: (groupBy: GroupSpec | null) => void
  }): React.ReactElement {
    const [groupBy, setGroupBy] = useState<GroupSpec | null>(initial)
    const handle = (next: GroupSpec | null): void => {
      onChange(next)
      setGroupBy(next)
    }
    return <QueryControlsBar {...baseProps} groupBy={groupBy} onGroupByChange={handle} />
  }

  const groupSelect = (): HTMLSelectElement =>
    screen.getByLabelText('Group by') as HTMLSelectElement

  it('offers Property and Date after the five simple keys; no secondary controls until picked', () => {
    render(<Harness onChange={vi.fn()} />)
    expect(Array.from(groupSelect().options).map((o) => o.value)).toEqual([
      '__none__',
      'Tag',
      'Page',
      'State',
      'BlockType',
      'Priority',
      '__property__',
      '__date__',
    ])
    expect(screen.queryByTestId('advanced-query-group-property-key')).not.toBeInTheDocument()
    expect(screen.queryByTestId('advanced-query-group-date')).not.toBeInTheDocument()
  })

  it('picking Property reveals a key input; typing emits { type: "Property", key }', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await user.selectOptions(groupSelect(), 'Property')
    expect(onChange).toHaveBeenLastCalledWith({ key: { type: 'Property', key: '' } })

    const keyInput = screen.getByLabelText('Property key to group by')
    await user.type(keyInput, 'status')
    expect(onChange).toHaveBeenLastCalledWith({ key: { type: 'Property', key: 'status' } })
    expect(keyInput).toHaveValue('status')
    expect(groupSelect().value).toBe('__property__')
  })

  it('picking Date seeds due/week and reveals source + unit selects that emit the pair', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await user.selectOptions(groupSelect(), 'Date')
    expect(onChange).toHaveBeenLastCalledWith({
      key: { type: 'DateBucket', source: 'due', unit: 'week' },
    })
    expect(groupSelect().value).toBe('__date__')

    const dateRow = screen.getByTestId('advanced-query-group-date')
    const source = within(dateRow).getByLabelText('Date to group by') as HTMLSelectElement
    const unit = within(dateRow).getByLabelText('Bucket size') as HTMLSelectElement
    expect(Array.from(source.options).map((o) => o.value)).toEqual([
      'due',
      'scheduled',
      'created',
      'lastEdited',
    ])
    expect(Array.from(unit.options).map((o) => o.value)).toEqual(['day', 'week', 'month'])

    await user.selectOptions(source, 'Last edited')
    expect(onChange).toHaveBeenLastCalledWith({
      key: { type: 'DateBucket', source: 'lastEdited', unit: 'week' },
    })
    await user.selectOptions(unit, 'Month')
    expect(onChange).toHaveBeenLastCalledWith({
      key: { type: 'DateBucket', source: 'lastEdited', unit: 'month' },
    })
  })

  it('a loaded Property / DateBucket grouping (e.g. a saved view) selects its option, not None', () => {
    const { rerender } = render(
      <Harness initial={{ key: { type: 'Property', key: 'estimate' } }} onChange={vi.fn()} />,
    )
    expect(groupSelect().value).toBe('__property__')
    expect(screen.getByLabelText('Property key to group by')).toHaveValue('estimate')

    rerender(
      <QueryControlsBar
        {...baseProps}
        groupBy={{ key: { type: 'DateBucket', source: 'scheduled', unit: 'day' } }}
      />,
    )
    expect(groupSelect().value).toBe('__date__')
    expect(screen.getByLabelText('Date to group by')).toHaveValue('scheduled')
    expect(screen.getByLabelText('Bucket size')).toHaveValue('day')
  })

  it('switching back to a simple key drops the secondary controls', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ key: { type: 'Property', key: 'estimate' } }} onChange={onChange} />)

    await user.selectOptions(groupSelect(), 'Tag')
    expect(onChange).toHaveBeenLastCalledWith({ key: { type: 'Tag' } })
    expect(screen.queryByLabelText('Property key to group by')).not.toBeInTheDocument()
    expect(screen.queryByTestId('advanced-query-group-date')).not.toBeInTheDocument()
  })

  it('has no a11y violations with the Date controls revealed', async () => {
    const { container } = render(
      <Harness
        initial={{ key: { type: 'DateBucket', source: 'due', unit: 'week' } }}
        onChange={vi.fn()}
      />,
    )
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
