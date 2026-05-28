// @vitest-environment jsdom
// PEND-37: the "active filters" a11y test throws STACK_TRACE_ERROR (not a clean
// assertion failure) under happy-dom — render or axe walk crashes deep in the
// runner. Other tests in this file would work under happy-dom but pinning the
// whole file is the conservative call until that crash is investigated.

/**
 * Tests for BacklinkFilterBuilder component.
 *
 * Validates:
 *  - Renders "Add filter" button
 *  - Adding a BlockType filter
 *  - Adding a Status filter (PropertyText key=todo)
 *  - Adding a Contains filter
 *  - Adding a Property filter (PropertyText)
 *  - Adding a Date filter (CreatedInRange)
 *  - Date filter validation (empty dates)
 *  - Property filter validation (empty key)
 *  - Removing a filter pill
 *  - Clear all filters
 *  - Sort control
 *  - a11y compliance
 *  - Empty state
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'

import type { BacklinkFilter } from '../../lib/tauri'
import { listTagsByPrefix } from '../../lib/tauri'
import type { BacklinkFilterBuilderProps } from '../BacklinkFilterBuilder'
import { BacklinkFilterBuilder } from '../BacklinkFilterBuilder'

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

vi.mock('../../lib/tauri', () => ({
  listTagsByPrefix: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const defaultProps: BacklinkFilterBuilderProps = {
  filters: [],
  sort: null,
  onFiltersChange: vi.fn(),
  onSortChange: vi.fn(),
  totalCount: 10,
  filteredCount: 10,
  propertyKeys: ['todo', 'priority', 'due'],
  tags: [],
}

function renderBuilder(overrides?: Partial<BacklinkFilterBuilderProps>) {
  const props = { ...defaultProps, ...overrides }
  return render(<BacklinkFilterBuilder {...props} />)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('BacklinkFilterBuilder', () => {
  it('renders "Add filter" button', () => {
    renderBuilder()
    expect(screen.getByRole('button', { name: /Add filter/i })).toBeInTheDocument()
  })

  it('renders group with proper aria-label', () => {
    renderBuilder()
    expect(screen.getByRole('group', { name: /Backlink filters/i })).toBeInTheDocument()
  })

  it('does not show count when no filters are active', () => {
    renderBuilder()
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument()
  })

  it('shows count when filters are active', () => {
    renderBuilder({
      filters: [{ type: 'BlockType', block_type: 'content' }],
      filteredCount: 5,
      totalCount: 10,
    })
    expect(screen.getByText('Showing 5 of 10 backlinks')).toBeInTheDocument()
  })

  describe('adding filters', () => {
    it('adds a BlockType filter', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      // Click "Add filter"
      await user.click(screen.getByRole('button', { name: /Add filter/i }))

      // Select filter category
      await user.selectOptions(screen.getByLabelText('Filter category'), 'type')

      // Select block type value
      await user.selectOptions(screen.getByLabelText('Block type value'), 'page')

      // Apply
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'BlockType', block_type: 'page' }),
      ])
    })

    it('clicking Apply fires onFiltersChange exactly once (L-137)', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'type')
      await user.selectOptions(screen.getByLabelText('Block type value'), 'page')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledTimes(1)
    })

    it('adds a Status filter (shortcut for PropertyText key=todo)', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'status')
      await user.selectOptions(screen.getByLabelText('Status value'), 'DONE')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'PropertyText', key: 'todo', op: 'Eq', value: 'DONE' }),
      ])
    })

    it('adds a Priority filter', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'priority')
      await user.selectOptions(screen.getByLabelText('Priority value'), '1')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'PropertyText', key: 'priority', op: 'Eq', value: '1' }),
      ])
    })

    it('adds a Contains filter', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'contains')
      await user.type(screen.getByLabelText('Contains text'), 'hello world')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'Contains', query: 'hello world' }),
      ])
    })

    it('adds a Property filter (PropertyText)', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property')

      // Select key from dropdown
      await user.selectOptions(screen.getByLabelText('Property key'), 'due')

      // Operator defaults to Eq, type defaults to Text
      await user.type(screen.getByLabelText('Property value'), 'tomorrow')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'PropertyText', key: 'due', op: 'Eq', value: 'tomorrow' }),
      ])
    })

    it('adds a Date filter (CreatedInRange)', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'date')

      // Fill in the after date
      const afterInput = screen.getByLabelText('Date after')
      await user.clear(afterInput)
      await user.type(afterInput, '2024-01-01')

      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'CreatedInRange', after: '2024-01-01', before: null }),
      ])
    })

    it('shows toast error when date filter has no dates', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'date')

      // Don't fill in any dates, just click Apply
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(toast.error).toHaveBeenCalledWith('At least one date boundary is required')
      expect(onFiltersChange).not.toHaveBeenCalled()
    })

    it('shows toast error when property filter has empty key', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      // No property keys so we get the text input instead of dropdown
      renderBuilder({ onFiltersChange, propertyKeys: [] })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property')

      // Leave key empty, just click Apply
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(toast.error).toHaveBeenCalledWith('Property key is required')
      expect(onFiltersChange).not.toHaveBeenCalled()
    })

    it('shows i18n toast error when property is not found in propertyKeys', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      // Start with no propertyKeys so the SearchInput renders, allowing free-form input
      const { rerender } = renderBuilder({ onFiltersChange, propertyKeys: [] })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property')

      // Type an unknown key into the free-form SearchInput
      await user.type(screen.getByLabelText('Property key'), 'unknownKey')

      // Re-render with a non-empty propertyKeys list that does NOT include 'unknownKey'.
      // The form's propKey state persists across the re-render; the validator's
      // propertyKeys snapshot now flags 'unknownKey' as not present.
      rerender(
        <BacklinkFilterBuilder
          {...defaultProps}
          onFiltersChange={onFiltersChange}
          propertyKeys={['knownKey']}
        />,
      )

      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(toast.error).toHaveBeenCalledWith('No blocks have property "unknownKey"')
      expect(onFiltersChange).not.toHaveBeenCalled()
    })

    it('adds a PropertyNum filter', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property')
      // Change property type to Number
      await user.selectOptions(screen.getByLabelText('Property type'), 'num')
      await user.type(screen.getByLabelText('Property value'), '42')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'PropertyNum', key: 'todo', op: 'Eq', value: 42 }),
      ])
    })

    it('adds a PropertyDate filter', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property')
      // Change property type to Date
      await user.selectOptions(screen.getByLabelText('Property type'), 'date')
      await user.type(screen.getByLabelText('Property value'), '2024-06-15')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'PropertyDate',
          key: 'todo',
          op: 'Eq',
          value: '2024-06-15',
        }),
      ])
    })

    it('adds a PropertyIsSet filter', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property-set')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'PropertyIsSet', key: 'todo' }),
      ])
    })

    it('adds a PropertyIsEmpty filter', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property-empty')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'PropertyIsEmpty', key: 'todo' }),
      ])
    })

    it('adds a HasTagPrefix filter', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'tag-prefix')
      await user.type(screen.getByLabelText('Tag prefix'), 'work')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'HasTagPrefix', prefix: 'work' }),
      ])
    })

    it('shows toast error when PropertyNum has invalid number', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property')
      await user.selectOptions(screen.getByLabelText('Property type'), 'num')
      await user.type(screen.getByLabelText('Property value'), 'abc')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(toast.error).toHaveBeenCalledWith('Invalid number')
      expect(onFiltersChange).not.toHaveBeenCalled()
    })

    it('shows toast error when PropertyDate has empty value', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property')
      await user.selectOptions(screen.getByLabelText('Property type'), 'date')
      // Leave value empty, just click Apply
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(toast.error).toHaveBeenCalledWith('Date value is required')
      expect(onFiltersChange).not.toHaveBeenCalled()
    })

    it('shows toast error when PropertyIsSet has empty key', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange, propertyKeys: [] })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property-set')
      // Leave key empty, just click Apply
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(toast.error).toHaveBeenCalledWith('Property key is required')
      expect(onFiltersChange).not.toHaveBeenCalled()
    })

    it('shows toast error when PropertyIsEmpty has empty key', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange, propertyKeys: [] })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property-empty')
      // Leave key empty, just click Apply
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(toast.error).toHaveBeenCalledWith('Property key is required')
      expect(onFiltersChange).not.toHaveBeenCalled()
    })

    it('shows toast error when HasTagPrefix has empty prefix', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'tag-prefix')
      // Leave prefix empty, just click Apply
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(toast.error).toHaveBeenCalledWith('Tag prefix is required')
      expect(onFiltersChange).not.toHaveBeenCalled()
    })

    it('cancels adding a filter', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      expect(screen.getByLabelText('Filter category')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /Cancel adding filter/i }))

      expect(screen.queryByLabelText('Filter category')).not.toBeInTheDocument()
      expect(onFiltersChange).not.toHaveBeenCalled()
    })

    // PEND-28b H6 — Apply / Cancel rows hard-code `h-7`, which overrides the
    // `Button size="xs"` coarse-pointer height bump. Without an explicit
    // `[@media(pointer:coarse)]:h-11` the buttons render at 28 px on touch,
    // below the 44 px minimum touch target.
    it('Apply and Cancel buttons carry [@media(pointer:coarse)]:h-11 (44 px touch target)', async () => {
      const user = userEvent.setup()
      renderBuilder()

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      // Pick a category so the Apply button renders.
      await user.selectOptions(screen.getByLabelText('Filter category'), 'contains')

      const applyBtn = screen.getByRole('button', { name: /Apply filter/i })
      const cancelBtn = screen.getByRole('button', { name: /Cancel adding filter/i })

      expect(applyBtn.className).toContain('[@media(pointer:coarse)]:h-11')
      expect(cancelBtn.className).toContain('[@media(pointer:coarse)]:h-11')
    })
  })

  describe('removing filters', () => {
    it('removes a filter pill when X is clicked', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      const filters: BacklinkFilter[] = [
        { type: 'BlockType', block_type: 'content' },
        { type: 'Contains', query: 'test' },
      ]
      renderBuilder({ filters, onFiltersChange })

      // Should see both pills
      expect(screen.getByText('type = content')).toBeInTheDocument()
      expect(screen.getByText('contains "test"')).toBeInTheDocument()

      // Remove the first filter
      await user.click(screen.getByLabelText('Remove filter type = content'))

      expect(onFiltersChange).toHaveBeenCalledWith([{ type: 'Contains', query: 'test' }])
    })
  })

  describe('clear all', () => {
    it('clears all filters and sort when Clear all is clicked', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      const onSortChange = vi.fn()
      renderBuilder({
        filters: [{ type: 'BlockType', block_type: 'page' }],
        sort: { type: 'Created', dir: 'Desc' },
        onFiltersChange,
        onSortChange,
      })

      await user.click(screen.getByText('Clear all'))

      expect(onFiltersChange).toHaveBeenCalledWith([])
      expect(onSortChange).toHaveBeenCalledWith(null)
    })

    it('does not show Clear all button when no filters are active', () => {
      renderBuilder()
      expect(screen.queryByText('Clear all')).not.toBeInTheDocument()
    })
  })

  describe('sort control', () => {
    it('changes sort when a sort option is selected', async () => {
      const user = userEvent.setup()
      const onSortChange = vi.fn()
      renderBuilder({ onSortChange })

      await user.selectOptions(screen.getByLabelText('Sort by'), 'Created')

      expect(onSortChange).toHaveBeenCalledWith({ type: 'Created', dir: 'Desc' })
    })

    it('toggles sort direction', async () => {
      const user = userEvent.setup()
      const onSortChange = vi.fn()
      renderBuilder({
        sort: { type: 'Created', dir: 'Desc' },
        onSortChange,
      })

      await user.click(screen.getByLabelText(/Toggle sort direction/i))

      expect(onSortChange).toHaveBeenCalledWith({ type: 'Created', dir: 'Asc' })
    })

    it('clears sort when default option is selected', async () => {
      const user = userEvent.setup()
      const onSortChange = vi.fn()
      renderBuilder({
        sort: { type: 'Created', dir: 'Desc' },
        onSortChange,
      })

      await user.selectOptions(screen.getByLabelText('Sort by'), '__none__')

      expect(onSortChange).toHaveBeenCalledWith(null)
    })
  })

  describe('a11y', () => {
    it('has no a11y violations with no filters', async () => {
      const { container } = renderBuilder()
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    it('has no a11y violations with active filters', async () => {
      const { container } = renderBuilder({
        filters: [
          { type: 'BlockType', block_type: 'content' },
          { type: 'Contains', query: 'test' },
        ],
        sort: { type: 'Created', dir: 'Desc' },
      })
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    it('renders sr-only legend inside fieldset (#336)', () => {
      const { container } = renderBuilder()
      const legend = container.querySelector('fieldset legend')
      expect(legend).toBeInTheDocument()
      expect(legend).toHaveTextContent('Backlink filters')
      expect(legend).toHaveClass('sr-only')
    })

    it('wraps filter pills in a semantic list (#332)', () => {
      const { container } = renderBuilder({
        filters: [
          { type: 'BlockType', block_type: 'content' },
          { type: 'Contains', query: 'test' },
        ],
      })
      const list = container.querySelector('ul[aria-label="Applied filters"]')
      expect(list).toBeInTheDocument()
      const items = list?.querySelectorAll('li')
      expect(items).toHaveLength(2)
    })

    it('does not render applied filters list when no filters active (#332)', () => {
      const { container } = renderBuilder()
      expect(container.querySelector('ul[aria-label="Applied filters"]')).not.toBeInTheDocument()
    })

    it('Clear all button has explicit aria-label (#331)', () => {
      renderBuilder({
        filters: [{ type: 'BlockType', block_type: 'page' }],
      })
      expect(screen.getByRole('button', { name: 'Clear all filters and sort' })).toBeInTheDocument()
    })
  })

  describe('sort direction always visible (#333)', () => {
    it('renders sort direction button even when sort is null', () => {
      renderBuilder()
      const btn = screen.getByRole('button', { name: /Toggle sort direction/i })
      expect(btn).toBeInTheDocument()
      expect(btn).toBeDisabled()
    })

    it('enables sort direction button when sort is active', () => {
      renderBuilder({ sort: { type: 'Created', dir: 'Desc' } })
      const btn = screen.getByRole('button', { name: /Toggle sort direction/i })
      expect(btn).not.toBeDisabled()
    })
  })

  describe('structural duplicate detection (#329)', () => {
    it('detects duplicates using full filter structure, not display summary', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      // Two HasTag filters with same 8-char prefix but different full IDs
      // Old string-based comparison would consider these duplicates
      const TAG_A = '01ABCDEFGHIJKLMNOPQRSTUVWX'
      const TAG_B = '01ABCDEFZZZZZZZZZZZZZZZZZZ'
      const tags = [
        { id: TAG_A, name: 'Alpha' },
        { id: TAG_B, name: 'Beta' },
      ]
      renderBuilder({
        filters: [{ type: 'HasTag', tag_id: TAG_A }],
        tags,
        onFiltersChange,
      })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'has-tag')

      // Open tag search popover (trigger shows "Alpha" since tagValue defaults to TAG_A)
      await user.click(screen.getByRole('button', { name: 'Alpha' }))
      // Select TAG_B from the popover
      await user.click(screen.getByRole('option', { name: 'Beta' }))

      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      // Should NOT be flagged as duplicate since full tag_ids differ
      expect(toast.error).not.toHaveBeenCalledWith('Filter already applied')
      expect(onFiltersChange).toHaveBeenCalledWith([
        { type: 'HasTag', tag_id: TAG_A },
        expect.objectContaining({ type: 'HasTag', tag_id: TAG_B }),
      ])
    })

    it('still detects true duplicates', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({
        filters: [{ type: 'BlockType', block_type: 'content' }],
        onFiltersChange,
      })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'type')
      await user.selectOptions(screen.getByLabelText('Block type value'), 'content')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(toast.error).toHaveBeenCalledWith('Filter already applied')
      expect(onFiltersChange).not.toHaveBeenCalled()
    })
  })

  // ====================================================================
  // MAINT-190 — `_addId` per-add monotonic React key on filter pills.
  //
  // Replaces the previous `key={index}` + biome-ignore workaround. Each
  // add stamps a fresh `_addId`, so byte-identical filters that bypass
  // the data-level dedup (or any future code that injects duplicates)
  // still get distinct React identities — no "two children with the
  // same key" warning.
  //
  // The reorder-preserves-identity scenario from the original brief
  // does not apply here: `BacklinkFilterBuilder` exposes only add /
  // remove / clear-all, no reorder UI. The collision-free key is still
  // useful: it pre-empts a class of bugs around future filter
  // reorder / animation work.
  // ====================================================================
  describe('per-add React key stamping (MAINT-190)', () => {
    it('does not emit React duplicate-key warnings on rapid identical add', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const user = userEvent.setup()
        const onFiltersChange = vi.fn()
        const { rerender } = renderBuilder({ onFiltersChange })

        // First add — produces a stamped filter via handleAddFilter.
        await user.click(screen.getByRole('button', { name: /Add filter/i }))
        await user.selectOptions(screen.getByLabelText('Filter category'), 'type')
        await user.selectOptions(screen.getByLabelText('Block type value'), 'page')
        await user.click(screen.getByRole('button', { name: /Apply filter/i }))

        expect(onFiltersChange).toHaveBeenCalled()
        const stamped = (onFiltersChange.mock.calls[0]?.[0] as BacklinkFilter[]) ?? []
        // Reflect the parent's state update back into the controlled component.
        rerender(
          <BacklinkFilterBuilder
            {...defaultProps}
            filters={stamped}
            onFiltersChange={onFiltersChange}
          />,
        )

        expect(onFiltersChange).toHaveBeenCalledTimes(1)

        // Second add of the byte-identical filter — dedup must reject it.
        await user.click(screen.getByRole('button', { name: /Add filter/i }))
        await user.selectOptions(screen.getByLabelText('Filter category'), 'type')
        await user.selectOptions(screen.getByLabelText('Block type value'), 'page')
        await user.click(screen.getByRole('button', { name: /Apply filter/i }))

        expect(toast.error).toHaveBeenCalledWith('Filter already applied')
        expect(onFiltersChange).toHaveBeenCalledTimes(1)

        const keyWarnings = consoleErrorSpy.mock.calls.filter(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('Encountered two children with the same key'),
        )
        expect(keyWarnings).toEqual([])
      } finally {
        consoleErrorSpy.mockRestore()
      }
    })

    it('renders distinct list items with unique `_addId` keys for two filters', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const user = userEvent.setup()
        const onFiltersChange = vi.fn()
        const { rerender } = renderBuilder({ onFiltersChange })

        // Add filter A.
        await user.click(screen.getByRole('button', { name: /Add filter/i }))
        await user.selectOptions(screen.getByLabelText('Filter category'), 'contains')
        await user.type(screen.getByLabelText('Contains text'), 'alpha')
        await user.click(screen.getByRole('button', { name: /Apply filter/i }))

        const afterFirst = (onFiltersChange.mock.calls.at(-1)?.[0] as BacklinkFilter[]) ?? []
        rerender(
          <BacklinkFilterBuilder
            {...defaultProps}
            filters={afterFirst}
            onFiltersChange={onFiltersChange}
          />,
        )

        // Add filter B.
        await user.click(screen.getByRole('button', { name: /Add filter/i }))
        await user.selectOptions(screen.getByLabelText('Filter category'), 'contains')
        await user.type(screen.getByLabelText('Contains text'), 'beta')
        await user.click(screen.getByRole('button', { name: /Apply filter/i }))

        const afterSecond = (onFiltersChange.mock.calls.at(-1)?.[0] as BacklinkFilter[]) ?? []
        rerender(
          <BacklinkFilterBuilder
            {...defaultProps}
            filters={afterSecond}
            onFiltersChange={onFiltersChange}
          />,
        )

        // Both pills are mounted as distinct list items.
        const list = screen.getByRole('list', { name: /Applied filters/i })
        const items = list.querySelectorAll('li')
        expect(items).toHaveLength(2)

        // Each stamped filter has its own monotonic `_addId`; the values
        // must differ so the React keys collide-free.
        const stampedFilters = afterSecond as Array<BacklinkFilter & { _addId?: number }>
        expect(stampedFilters).toHaveLength(2)
        expect(typeof stampedFilters[0]?._addId).toBe('number')
        expect(typeof stampedFilters[1]?._addId).toBe('number')
        expect(stampedFilters[0]?._addId).not.toBe(stampedFilters[1]?._addId)

        const keyWarnings = consoleErrorSpy.mock.calls.filter(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('Encountered two children with the same key'),
        )
        expect(keyWarnings).toEqual([])
      } finally {
        consoleErrorSpy.mockRestore()
      }
    })
  })

  describe('has-tag with no tags available', () => {
    it('shows toast error when no tag is selected', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'has-tag')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(toast.error).toHaveBeenCalledWith('Tag is required')
      expect(onFiltersChange).not.toHaveBeenCalled()
    })
  })

  describe('tag prefix maxLength (#340)', () => {
    it('has maxLength attribute on tag prefix input', async () => {
      const user = userEvent.setup()
      renderBuilder()

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'tag-prefix')

      const input = screen.getByLabelText('Tag prefix')
      expect(input).toHaveAttribute('maxLength', '100')
    })
  })

  // ====================================================================
  // #400 — Tag select rendering with actual tags (updated for B-72 SearchablePopover)
  // ====================================================================

  describe('tag select with actual tags (#400)', () => {
    const tagsData = [
      { id: '01ARZTAGAAAAAAAAAAAAAAAAAA', name: 'Project' },
      { id: '01ARZTAGBBBBBBBBBBBBBBBBBB', name: 'Review' },
    ]

    it('renders SearchablePopover trigger when has-tag category is selected', async () => {
      const user = userEvent.setup()
      renderBuilder({ tags: tagsData })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'has-tag')

      // tagValue defaults to first tag ID, so trigger shows "Project"
      expect(screen.getByTestId('tag-search-popover')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Project' })).toBeInTheDocument()
    })

    it('shows tag items when popover is opened', async () => {
      const user = userEvent.setup()
      renderBuilder({ tags: tagsData })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'has-tag')

      // Open the popover
      await user.click(screen.getByRole('button', { name: 'Project' }))

      // Both tags should be visible as options
      expect(screen.getByRole('option', { name: 'Project' })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: 'Review' })).toBeInTheDocument()
    })

    it('calls onFiltersChange with selected tag_id when Apply is clicked', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ tags: tagsData, onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'has-tag')
      // tagValue defaults to first tag; click Apply directly
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'HasTag', tag_id: '01ARZTAGAAAAAAAAAAAAAAAAAA' }),
      ])
    })

    it('uses tagResolver in pill aria-label (#388)', () => {
      const tagResolver = (id: string) => {
        const tag = tagsData.find((t) => t.id === id)
        return tag ? tag.name : id
      }
      renderBuilder({
        tags: tagsData,
        tagResolver,
        filters: [{ type: 'HasTag', tag_id: '01ARZTAGAAAAAAAAAAAAAAAAAA' }],
      })

      expect(screen.getByRole('group', { name: 'Filter: has tag Project' })).toBeInTheDocument()
      expect(screen.getByLabelText('Remove filter has tag Project')).toBeInTheDocument()
    })
  })

  // ====================================================================
  // #401 — Enter-to-submit in AddFilterRow
  // ====================================================================

  describe('Enter-to-submit (#401)', () => {
    it('submits filter on Enter key press', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'contains')
      const input = screen.getByLabelText('Contains text')
      await user.type(input, 'hello{Enter}')

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'Contains', query: 'hello' }),
      ])
    })
  })

  // ====================================================================
  // #402 — Escape returning focus to Add filter button
  // ====================================================================

  describe('Escape returns focus to Add filter button (#402)', () => {
    it('closes form and focuses Add filter button on Escape', async () => {
      const user = userEvent.setup()
      renderBuilder()

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      const categorySelect = screen.getByLabelText('Filter category')
      expect(categorySelect).toBeInTheDocument()

      // Focus an element inside the form so Escape bubbles through the form
      categorySelect.focus()
      await user.keyboard('{Escape}')

      expect(screen.queryByLabelText('Filter category')).not.toBeInTheDocument()
      // Wait for requestAnimationFrame focus
      await new Promise((r) => requestAnimationFrame(r))
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /Add filter/i }))
    })
  })

  // ====================================================================
  // #403 — aria-live SR announcement content
  // ====================================================================

  describe('aria-live announcement (#403)', () => {
    it('announces "2 filters applied" when 2 filters are active', () => {
      renderBuilder({
        filters: [
          { type: 'BlockType', block_type: 'content' },
          { type: 'Contains', query: 'test' },
        ],
      })

      const liveRegion = document.querySelector('[aria-live="polite"][aria-atomic="true"].sr-only')
      expect(liveRegion).toBeInTheDocument()
      expect(liveRegion).toHaveTextContent('2 filters applied')
    })

    it('announces "1 filter applied" for a single filter', () => {
      renderBuilder({
        filters: [{ type: 'BlockType', block_type: 'page' }],
      })

      const liveRegion = document.querySelector('[aria-live="polite"][aria-atomic="true"].sr-only')
      expect(liveRegion).toBeInTheDocument()
      expect(liveRegion).toHaveTextContent('1 filter applied')
    })

    it('announces "0 filters applied" when no filters active', () => {
      renderBuilder()

      const liveRegion = document.querySelector('[aria-live="polite"][aria-atomic="true"].sr-only')
      expect(liveRegion).toBeInTheDocument()
      expect(liveRegion).toHaveTextContent('0 filters applied')
    })
  })

  // ====================================================================
  // #404 — Infinity/NaN rejection in PropertyNum
  // ====================================================================

  describe('Infinity/NaN rejection in PropertyNum (#404)', () => {
    it('rejects Infinity as property num value', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property')
      await user.selectOptions(screen.getByLabelText('Property type'), 'num')
      await user.type(screen.getByLabelText('Property value'), 'Infinity')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(toast.error).toHaveBeenCalledWith('Invalid number')
      expect(onFiltersChange).not.toHaveBeenCalled()
    })

    it('rejects NaN as property num value', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property')
      await user.selectOptions(screen.getByLabelText('Property type'), 'num')
      await user.type(screen.getByLabelText('Property value'), 'NaN')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(toast.error).toHaveBeenCalledWith('Invalid number')
      expect(onFiltersChange).not.toHaveBeenCalled()
    })
  })

  // ====================================================================
  // #393 — Date format validation in CreatedInRange
  // ====================================================================

  describe('date format validation (#393)', () => {
    it('accepts valid YYYY-MM-DD date for "after"', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'date')

      const afterInput = screen.getByLabelText('Date after')
      await user.clear(afterInput)
      await user.type(afterInput, '2024-06-15')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'CreatedInRange', after: '2024-06-15', before: null }),
      ])
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('rejects invalid "after" date format', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'date')

      const afterInput = screen.getByLabelText('Date after')
      // Simulate pasting an invalid date format
      await user.clear(afterInput)
      // Use fireEvent to bypass native date picker validation
      afterInput.setAttribute('type', 'text')
      await user.type(afterInput, '06/15/2024')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(toast.error).toHaveBeenCalledWith(
        'Invalid date format for "after" (expected YYYY-MM-DD)',
      )
      expect(onFiltersChange).not.toHaveBeenCalled()
    })

    it('rejects invalid "before" date format', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'date')

      const afterInput = screen.getByLabelText('Date after')
      await user.clear(afterInput)
      await user.type(afterInput, '2024-01-01')

      const beforeInput = screen.getByLabelText('Date before')
      beforeInput.setAttribute('type', 'text')
      await user.clear(beforeInput)
      await user.type(beforeInput, 'not-a-date')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(toast.error).toHaveBeenCalledWith(
        'Invalid date format for "before" (expected YYYY-MM-DD)',
      )
      expect(onFiltersChange).not.toHaveBeenCalled()
    })

    it('accepts valid dates for both "after" and "before"', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'date')

      const afterInput = screen.getByLabelText('Date after')
      await user.clear(afterInput)
      await user.type(afterInput, '2024-01-01')

      const beforeInput = screen.getByLabelText('Date before')
      await user.clear(beforeInput)
      await user.type(beforeInput, '2024-12-31')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'CreatedInRange',
          after: '2024-01-01',
          before: '2024-12-31',
        }),
      ])
      expect(toast.error).not.toHaveBeenCalled()
    })
  })

  // ====================================================================
  // #394 — Property key existence check (defense-in-depth).
  // When propertyKeys is populated, a <select> dropdown is shown — the user
  // can only pick valid keys, so the error path (unknown key) is unreachable
  // through normal UI interaction.  The validation guards against programmatic
  // state bugs.  Tests below cover the two reachable UI paths.
  describe('property key existence check (#394)', () => {
    it('allows freeform property key when propertyKeys is empty', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange, propertyKeys: [] })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property')
      await user.type(screen.getByLabelText('Property key'), 'custom_key')
      await user.type(screen.getByLabelText('Property value'), 'val')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'PropertyText',
          key: 'custom_key',
          op: 'Eq',
          value: 'val',
        }),
      ])
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('allows valid key selected from dropdown', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange, propertyKeys: ['todo', 'priority', 'due'] })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property')
      await user.selectOptions(screen.getByLabelText('Property key'), 'due')
      await user.type(screen.getByLabelText('Property value'), 'tomorrow')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'PropertyText', key: 'due', op: 'Eq', value: 'tomorrow' }),
      ])
      expect(toast.error).not.toHaveBeenCalled()
    })
  })

  // ====================================================================
  // #405 — Touch target sizes h-11/44px (#323/#324 fix)
  // ====================================================================

  describe('SelectTrigger size="sm" on select elements (#405)', () => {
    it('applies size="sm" to filter category select trigger', async () => {
      const user = userEvent.setup()
      renderBuilder()

      // Open the add-filter form
      await user.click(screen.getByRole('button', { name: /Add filter/i }))

      // The filter category select should have data-size="sm" (from SelectTrigger size prop)
      const categorySelect = screen.getByLabelText('Filter category')
      expect(categorySelect).toHaveAttribute('data-size', 'sm')
    })

    it('applies size="sm" to sort select trigger', () => {
      renderBuilder()
      const sortSelect = screen.getByLabelText('Sort by')
      expect(sortSelect).toHaveAttribute('data-size', 'sm')
    })
  })

  // ====================================================================
  // B-72 — Searchable tag filter in backlink filter panel
  // ====================================================================

  describe('searchable tag filter (B-72)', () => {
    const tagsData = [
      { id: '01TAG_PROJ', name: 'Project' },
      { id: '01TAG_REVW', name: 'Review' },
    ]

    it('renders SearchablePopover trigger when has-tag is selected', async () => {
      const user = userEvent.setup()
      renderBuilder({ tags: tagsData })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'has-tag')

      expect(screen.getByTestId('tag-search-popover')).toBeInTheDocument()
      // Trigger shows first tag name since tagValue defaults to first tag
      expect(screen.getByRole('button', { name: 'Project' })).toBeInTheDocument()
    })

    it('calls listTagsByPrefix on search query change', async () => {
      const user = userEvent.setup()
      vi.mocked(listTagsByPrefix).mockResolvedValue([
        { tag_id: '01TAG_PROJ', name: 'Project', usage_count: 5, updated_at: '' },
      ])
      renderBuilder({ tags: tagsData })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'has-tag')

      // Open the popover
      await user.click(screen.getByRole('button', { name: 'Project' }))

      // Type in search
      const searchInput = screen.getByLabelText('Search tags...')
      await user.type(searchInput, 'proj')

      // Wait for the debounced IPC call
      await waitFor(() => {
        expect(listTagsByPrefix).toHaveBeenCalledWith({ prefix: 'proj', limit: 50 })
      })
    })

    // PEND-74 — flake hardening. Two changes together remove the race:
    //   1. Pre-seed `listTagsByPrefix` with the same `tagsData` shape so
    //      the 150 ms debounced IPC's `setTagSearchResults` swaps `items`
    //      to an array whose keys match the initial `tags` prop — no
    //      `CommandItem` remount around the click.
    //   2. Sync on the IPC mock BEFORE clicking the option so the
    //      `tagSearchLoading` flicker has already settled; then assert on
    //      the trigger-button label flipping to "Review", which only
    //      happens if `handleSelect` actually ran. Radix's outside-click
    //      path can satisfy the old popover-unmount waitFor without
    //      `handleSelect` having fired, hiding the missed click.
    function preseedTagSearchMock(): void {
      vi.mocked(listTagsByPrefix).mockResolvedValue(
        tagsData.map((t) => ({ tag_id: t.id, name: t.name, usage_count: 0, updated_at: '' })),
      )
    }

    it('selects a tag from popover and sets tagValue', async () => {
      preseedTagSearchMock()
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ tags: tagsData, onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'has-tag')

      await user.click(screen.getByRole('button', { name: 'Project' }))
      await waitFor(() => {
        expect(listTagsByPrefix).toHaveBeenCalled()
      })
      await user.click(screen.getByRole('option', { name: 'Review' }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument()
      })
    })

    it('creates HasTag filter when tag is selected and Apply clicked', async () => {
      preseedTagSearchMock()
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ tags: tagsData, onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'has-tag')

      await user.click(screen.getByRole('button', { name: 'Project' }))
      await waitFor(() => {
        expect(listTagsByPrefix).toHaveBeenCalled()
      })
      await user.click(screen.getByRole('option', { name: 'Review' }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'HasTag', tag_id: '01TAG_REVW' }),
      ])
    })

    it('shows "Select tag" label when no tags are available', async () => {
      const user = userEvent.setup()
      renderBuilder({ tags: [] })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'has-tag')

      expect(screen.getByRole('button', { name: 'Select tag' })).toBeInTheDocument()
    })
  })

  // ====================================================================
  // UX-246 — SearchInput clear-button coverage across filter categories
  // ====================================================================

  describe('SearchInput clear button (UX-246)', () => {
    it('shows clear button in the Contains filter when value is non-empty and clears it', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'contains')

      const input = screen.getByLabelText('Contains text') as HTMLInputElement
      expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()

      await user.type(input, 'needle')
      expect(input.value).toBe('needle')

      const clearBtn = screen.getByTestId('search-input-clear')
      expect(clearBtn).toBeInTheDocument()

      await user.click(clearBtn)
      expect(input.value).toBe('')
      expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()
    })

    it('shows clear button on the Property value input and clears it', async () => {
      const user = userEvent.setup()
      renderBuilder({ propertyKeys: ['todo', 'priority', 'due'] })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property')

      const valueInput = screen.getByLabelText('Property value') as HTMLInputElement
      expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()

      await user.type(valueInput, 'tomorrow')
      expect(valueInput.value).toBe('tomorrow')

      const clearBtn = screen.getByTestId('search-input-clear')
      await user.click(clearBtn)
      expect(valueInput.value).toBe('')
      expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()
    })

    it('shows clear button on the freeform Property key input when propertyKeys is empty', async () => {
      const user = userEvent.setup()
      renderBuilder({ propertyKeys: [] })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'property')

      const keyInput = screen.getByLabelText('Property key') as HTMLInputElement
      await user.type(keyInput, 'custom_key')

      const clearBtn = screen.getByTestId('search-input-clear')
      expect(clearBtn).toBeInTheDocument()

      await user.click(clearBtn)
      expect(keyInput.value).toBe('')
    })

    it('shows clear button on the Tag prefix input and clears it', async () => {
      const user = userEvent.setup()
      renderBuilder()

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'tag-prefix')

      const prefixInput = screen.getByLabelText('Tag prefix') as HTMLInputElement
      await user.type(prefixInput, 'work')

      const clearBtn = screen.getByTestId('search-input-clear')
      expect(clearBtn).toBeInTheDocument()

      await user.click(clearBtn)
      expect(prefixInput.value).toBe('')
      expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()
    })

    it('has no a11y violations when a clear button is visible', async () => {
      const user = userEvent.setup()
      const { container } = renderBuilder()

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'contains')
      await user.type(screen.getByLabelText('Contains text'), 'hello')

      // The clear button must be present for this assertion to be meaningful.
      expect(screen.getByTestId('search-input-clear')).toBeInTheDocument()

      await waitFor(
        async () => {
          const results = await axe(container)
          expect(results).toHaveNoViolations()
        },
        { timeout: 5000 },
      )
    })
  })
})
