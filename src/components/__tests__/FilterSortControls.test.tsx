/**
 * Tests for FilterSortControls component.
 *
 * Validates:
 *  - Renders sort dropdown and direction button
 *  - Shows property keys as sort options
 *  - Calls onSortTypeChange when sort option is selected
 *  - Calls onSortTypeChange with empty string when default option is selected
 *  - Calls onSortDirToggle when direction button is clicked
 *  - Disables direction button when sort is null
 *  - Enables direction button when sort is active
 *  - Shows correct direction label (ASC/DESC)
 *  - a11y compliance
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { FilterSortControls } from '../FilterSortControls'

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

beforeEach(() => {
  vi.clearAllMocks()
})

describe('FilterSortControls', () => {
  const defaultProps = {
    sort: null,
    propertyKeys: ['todo', 'priority', 'due'],
    onSortTypeChange: vi.fn(),
    onSortDirToggle: vi.fn(),
  }

  it('renders sort dropdown', () => {
    render(<FilterSortControls {...defaultProps} />)

    expect(screen.getByLabelText(t('backlink.sortByLabel'))).toBeInTheDocument()
  })

  it('renders sort direction toggle button', () => {
    render(<FilterSortControls {...defaultProps} />)

    expect(screen.getByRole('button', { name: /Toggle sort direction/i })).toBeInTheDocument()
  })

  it('shows property keys as sort options', () => {
    render(<FilterSortControls {...defaultProps} />)

    const select = screen.getByLabelText(t('backlink.sortByLabel'))
    const options = select.querySelectorAll('option')

    // __none__ + Created + 3 property keys = 5 options
    expect(options).toHaveLength(5)
    expect(options[0]).toHaveTextContent(t('backlink.defaultOrderOption'))
    expect(options[1]).toHaveTextContent(t('backlink.createdOption'))
    expect(options[2]).toHaveTextContent('todo')
    expect(options[3]).toHaveTextContent('priority')
    expect(options[4]).toHaveTextContent('due')
  })

  it('calls onSortTypeChange when Created is selected', async () => {
    const user = userEvent.setup()
    const onSortTypeChange = vi.fn()

    render(<FilterSortControls {...defaultProps} onSortTypeChange={onSortTypeChange} />)

    await user.selectOptions(screen.getByLabelText(t('backlink.sortByLabel')), 'Created')

    expect(onSortTypeChange).toHaveBeenCalledWith('Created')
  })

  it('calls onSortTypeChange with property key when a property is selected', async () => {
    const user = userEvent.setup()
    const onSortTypeChange = vi.fn()

    render(<FilterSortControls {...defaultProps} onSortTypeChange={onSortTypeChange} />)

    await user.selectOptions(screen.getByLabelText(t('backlink.sortByLabel')), 'due')

    expect(onSortTypeChange).toHaveBeenCalledWith('due')
  })

  it('calls onSortTypeChange with empty string when default option is selected', async () => {
    const user = userEvent.setup()
    const onSortTypeChange = vi.fn()

    render(
      <FilterSortControls
        {...defaultProps}
        sort={{ type: 'Created', dir: 'Desc' }}
        onSortTypeChange={onSortTypeChange}
      />,
    )

    await user.selectOptions(screen.getByLabelText(t('backlink.sortByLabel')), '__none__')

    expect(onSortTypeChange).toHaveBeenCalledWith('')
  })

  it('disables direction button when sort is null', () => {
    render(<FilterSortControls {...defaultProps} sort={null} />)

    const btn = screen.getByRole('button', { name: /Toggle sort direction/i })
    expect(btn).toBeDisabled()
  })

  it('enables direction button when sort is active', () => {
    render(<FilterSortControls {...defaultProps} sort={{ type: 'Created', dir: 'Desc' }} />)

    const btn = screen.getByRole('button', { name: /Toggle sort direction/i })
    expect(btn).not.toBeDisabled()
  })

  it('calls onSortDirToggle when direction button is clicked', async () => {
    const user = userEvent.setup()
    const onSortDirToggle = vi.fn()

    render(
      <FilterSortControls
        {...defaultProps}
        sort={{ type: 'Created', dir: 'Desc' }}
        onSortDirToggle={onSortDirToggle}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Toggle sort direction/i }))

    expect(onSortDirToggle).toHaveBeenCalledTimes(1)
  })

  it('shows Desc label when sort direction is Desc', () => {
    render(<FilterSortControls {...defaultProps} sort={{ type: 'Created', dir: 'Desc' }} />)

    expect(screen.getByText(t('backlink.descSort'))).toBeInTheDocument()
  })

  it('shows Asc label when sort direction is Asc', () => {
    render(<FilterSortControls {...defaultProps} sort={{ type: 'Created', dir: 'Asc' }} />)

    expect(screen.getByText(t('backlink.ascSort'))).toBeInTheDocument()
  })

  it('reflects current sort value in the select when sort is Created', () => {
    render(<FilterSortControls {...defaultProps} sort={{ type: 'Created', dir: 'Desc' }} />)

    const select = screen.getByLabelText(t('backlink.sortByLabel'))
    expect(select).toHaveValue('Created')
  })

  it('reflects current sort value in the select when sort is a property key', () => {
    render(
      <FilterSortControls
        {...defaultProps}
        sort={{ type: 'PropertyText', key: 'due', dir: 'Asc' }}
      />,
    )

    const select = screen.getByLabelText(t('backlink.sortByLabel'))
    expect(select).toHaveValue('due')
  })

  it('shows __none__ as selected when sort is null', () => {
    render(<FilterSortControls {...defaultProps} sort={null} />)

    const select = screen.getByLabelText(t('backlink.sortByLabel'))
    expect(select).toHaveValue('__none__')
  })

  it('applies size="sm" to sort select trigger', () => {
    render(<FilterSortControls {...defaultProps} />)

    const select = screen.getByLabelText(t('backlink.sortByLabel'))
    expect(select).toHaveAttribute('data-size', 'sm')
  })

  describe('a11y', () => {
    it('has no a11y violations with no sort', async () => {
      const { container } = render(<FilterSortControls {...defaultProps} />)

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    it('has no a11y violations with active sort', async () => {
      const { container } = render(
        <FilterSortControls {...defaultProps} sort={{ type: 'Created', dir: 'Desc' }} />,
      )

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
