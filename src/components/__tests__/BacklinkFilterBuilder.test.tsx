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

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { BacklinkFilter } from '../../lib/tauri'
import type { BacklinkFilterBuilderProps } from '../BacklinkFilterBuilder'
import { BacklinkFilterBuilder } from '../BacklinkFilterBuilder'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

const defaultProps: BacklinkFilterBuilderProps = {
  filters: [],
  sort: null,
  onFiltersChange: vi.fn(),
  onSortChange: vi.fn(),
  totalCount: 10,
  filteredCount: 10,
  propertyKeys: ['todo', 'priority', 'due'],
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

      expect(onFiltersChange).toHaveBeenCalledWith([{ type: 'BlockType', block_type: 'page' }])
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
        { type: 'PropertyText', key: 'todo', op: 'Eq', value: 'DONE' },
      ])
    })

    it('adds a Priority filter', async () => {
      const user = userEvent.setup()
      const onFiltersChange = vi.fn()
      renderBuilder({ onFiltersChange })

      await user.click(screen.getByRole('button', { name: /Add filter/i }))
      await user.selectOptions(screen.getByLabelText('Filter category'), 'priority')
      await user.selectOptions(screen.getByLabelText('Priority value'), 'A')
      await user.click(screen.getByRole('button', { name: /Apply filter/i }))

      expect(onFiltersChange).toHaveBeenCalledWith([
        { type: 'PropertyText', key: 'priority', op: 'Eq', value: 'A' },
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

      expect(onFiltersChange).toHaveBeenCalledWith([{ type: 'Contains', query: 'hello world' }])
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
        { type: 'PropertyText', key: 'due', op: 'Eq', value: 'tomorrow' },
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
        { type: 'CreatedInRange', after: '2024-01-01', before: null },
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

      await user.selectOptions(screen.getByLabelText('Sort by'), '')

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
  })
})
