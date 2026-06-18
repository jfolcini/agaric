/**
 * Tests for AutocompletePopover (PEND-60 Phase 1).
 *
 * Covers:
 *  - Hidden when `open=false`, `anchorRect=null`, or `items=[]`.
 *  - Renders all items as role=option when open + anchored + non-empty.
 *  - `onSelect` fires with item.value on click.
 *  - `onSelectedValueChange` fires when cmdk's internal selection
 *    changes (hover).
 *  - `selectedValue` controls aria-selected.
 *  - Custom `label` is applied as the listbox aria-label.
 *  - vitest-axe scan: zero violations.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { type AutocompleteItem, AutocompletePopover } from '../search/AutocompletePopover'

const SAMPLE_RECT = DOMRect.fromRect({ x: 100, y: 200, width: 0, height: 16 })

const SAMPLE_ITEMS: ReadonlyArray<AutocompleteItem> = [
  { value: 'TODO' },
  { value: 'DOING' },
  { value: 'DONE', label: 'Done!' },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AutocompletePopover', () => {
  it('renders nothing when open=false', () => {
    render(
      <AutocompletePopover
        open={false}
        anchorRect={SAMPLE_RECT}
        items={SAMPLE_ITEMS}
        selectedValue={null}
        onSelectedValueChange={vi.fn()}
        onSelect={vi.fn()}
        label="Values"
      />,
    )
    expect(screen.queryByTestId('autocomplete-popover')).not.toBeInTheDocument()
  })

  it('renders nothing when anchorRect=null', () => {
    render(
      <AutocompletePopover
        open
        anchorRect={null}
        items={SAMPLE_ITEMS}
        selectedValue={null}
        onSelectedValueChange={vi.fn()}
        onSelect={vi.fn()}
        label="Values"
      />,
    )
    expect(screen.queryByTestId('autocomplete-popover')).not.toBeInTheDocument()
  })

  it('renders nothing when items=[]', () => {
    render(
      <AutocompletePopover
        open
        anchorRect={SAMPLE_RECT}
        items={[]}
        selectedValue={null}
        onSelectedValueChange={vi.fn()}
        onSelect={vi.fn()}
        label="Values"
      />,
    )
    expect(screen.queryByTestId('autocomplete-popover')).not.toBeInTheDocument()
  })

  it('renders the loading hint when items=[] but loading=true', async () => {
    render(
      <AutocompletePopover
        open
        anchorRect={SAMPLE_RECT}
        items={[]}
        selectedValue={null}
        onSelectedValueChange={vi.fn()}
        onSelect={vi.fn()}
        label="Values"
        loading
        loadingLabel="Searching tags…"
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('autocomplete-popover')).toBeInTheDocument()
    })
    const hint = screen.getByTestId('autocomplete-loading')
    expect(hint).toHaveTextContent('Searching tags…')
    expect(hint).toHaveAttribute('role', 'status')
    // No selectable items rendered while loading with empty list.
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  it('renders all items as options when open + anchored + non-empty', async () => {
    render(
      <AutocompletePopover
        open
        anchorRect={SAMPLE_RECT}
        items={SAMPLE_ITEMS}
        selectedValue={null}
        onSelectedValueChange={vi.fn()}
        onSelect={vi.fn()}
        label="Values"
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('autocomplete-popover')).toBeInTheDocument()
    })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(screen.getByTestId('autocomplete-item-TODO')).toBeInTheDocument()
    expect(screen.getByTestId('autocomplete-item-DOING')).toBeInTheDocument()
    // label overrides display text
    expect(
      within(screen.getByTestId('autocomplete-item-DONE')).getByText('Done!'),
    ).toBeInTheDocument()
  })

  it('fires onSelect with item.value on click', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <AutocompletePopover
        open
        anchorRect={SAMPLE_RECT}
        items={SAMPLE_ITEMS}
        selectedValue={null}
        onSelectedValueChange={vi.fn()}
        onSelect={onSelect}
        label="Values"
      />,
    )
    const item = await screen.findByTestId('autocomplete-item-DOING')
    await user.click(item)
    expect(onSelect).toHaveBeenCalledWith('DOING')
  })

  it('fires onSelectedValueChange when cmdk selection changes (hover)', async () => {
    const user = userEvent.setup()
    const onSelectedValueChange = vi.fn()
    render(
      <AutocompletePopover
        open
        anchorRect={SAMPLE_RECT}
        items={SAMPLE_ITEMS}
        selectedValue="TODO"
        onSelectedValueChange={onSelectedValueChange}
        onSelect={vi.fn()}
        label="Values"
      />,
    )
    const target = await screen.findByTestId('autocomplete-item-DONE')
    await user.hover(target)
    await waitFor(() => {
      expect(onSelectedValueChange).toHaveBeenCalledWith('DONE')
    })
  })

  it('controls aria-selected via selectedValue', async () => {
    render(
      <AutocompletePopover
        open
        anchorRect={SAMPLE_RECT}
        items={SAMPLE_ITEMS}
        selectedValue="TODO"
        onSelectedValueChange={vi.fn()}
        onSelect={vi.fn()}
        label="Values"
      />,
    )
    const todo = await screen.findByTestId('autocomplete-item-TODO')
    const doing = screen.getByTestId('autocomplete-item-DOING')
    const done = screen.getByTestId('autocomplete-item-DONE')
    await waitFor(() => {
      expect(todo).toHaveAttribute('aria-selected', 'true')
    })
    expect(doing).toHaveAttribute('aria-selected', 'false')
    expect(done).toHaveAttribute('aria-selected', 'false')
  })

  it('applies custom label as the listbox aria-label', async () => {
    render(
      <AutocompletePopover
        open
        anchorRect={SAMPLE_RECT}
        items={SAMPLE_ITEMS}
        selectedValue={null}
        onSelectedValueChange={vi.fn()}
        onSelect={vi.fn()}
        label="Tag values"
      />,
    )
    await waitFor(() => {
      expect(screen.getByRole('listbox', { name: 'Tag values' })).toBeInTheDocument()
    })
  })

  it('passes a vitest-axe scan rendering property-value suggestions (#1425)', async () => {
    // The property-VALUE editor surfaces its suggestions through this same
    // popover; audit the value-list rendering for a11y violations.
    const PROP_VALUES: ReadonlyArray<AutocompleteItem> = [
      { value: 'todo' },
      { value: 'doing' },
      { value: 'done' },
      { value: 'archived' },
    ]
    render(
      <AutocompletePopover
        open
        anchorRect={SAMPLE_RECT}
        items={PROP_VALUES}
        selectedValue="todo"
        onSelectedValueChange={vi.fn()}
        onSelect={vi.fn()}
        label="Property values"
      />,
    )
    await waitFor(() => {
      expect(screen.getByRole('listbox', { name: 'Property values' })).toBeInTheDocument()
    })
    expect(screen.getAllByRole('option')).toHaveLength(4)
    await waitFor(
      async () => {
        expect(await axe(document.body)).toHaveNoViolations()
      },
      { timeout: 8000 },
    )
  }, 15000)

  it('passes a vitest-axe scan with the popover open', async () => {
    render(
      <AutocompletePopover
        open
        anchorRect={SAMPLE_RECT}
        items={SAMPLE_ITEMS}
        selectedValue="TODO"
        onSelectedValueChange={vi.fn()}
        onSelect={vi.fn()}
        label="Values"
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('autocomplete-popover')).toBeInTheDocument()
    })
    // Audit document.body because Radix Popover renders to a portal
    // outside the render container. Bumped timeout: cold-load of the
    // axe rule set under contention can exceed 1s on the first scan.
    await waitFor(
      async () => {
        expect(await axe(document.body)).toHaveNoViolations()
      },
      { timeout: 8000 },
    )
  }, 15000)
})
