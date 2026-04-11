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
import { FilterSortControls } from '../FilterSortControls'

// Mock the Radix-based Select to render as native <select>/<option> for jsdom compatibility.
vi.mock('@/components/ui/select', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')
  const Ctx = React.createContext({})

  function Select({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (v: string) => void
    children?: React.ReactNode
  }) {
    const triggerPropsRef = React.useRef({})
    return React.createElement(
      Ctx.Provider,
      { value: { value, onValueChange, triggerPropsRef } },
      children,
    )
  }

  function SelectTrigger({ size, className, ...props }: Record<string, unknown>) {
    const ctx = React.useContext(Ctx)
    Object.assign(ctx.triggerPropsRef.current, { size, className, ...props })
    return null
  }

  function SelectValue() {
    return null
  }

  function SelectContent({ children }: { children?: React.ReactNode }) {
    const ctx = React.useContext(Ctx)
    const tp = ctx.triggerPropsRef.current
    return React.createElement(
      'select',
      {
        value: ctx.value ?? '',
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => ctx.onValueChange?.(e.target.value),
        'aria-label': tp['aria-label'],
        className: tp.className,
        'data-size': tp.size,
      },
      children,
    )
  }

  function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
    return React.createElement('option', { value }, children)
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

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

    expect(screen.getByLabelText('Sort by')).toBeInTheDocument()
  })

  it('renders sort direction toggle button', () => {
    render(<FilterSortControls {...defaultProps} />)

    expect(screen.getByRole('button', { name: /Toggle sort direction/i })).toBeInTheDocument()
  })

  it('shows property keys as sort options', () => {
    render(<FilterSortControls {...defaultProps} />)

    const select = screen.getByLabelText('Sort by')
    const options = select.querySelectorAll('option')

    // __none__ + Created + 3 property keys = 5 options
    expect(options).toHaveLength(5)
    expect(options[0]).toHaveTextContent('Default order')
    expect(options[1]).toHaveTextContent('Created')
    expect(options[2]).toHaveTextContent('todo')
    expect(options[3]).toHaveTextContent('priority')
    expect(options[4]).toHaveTextContent('due')
  })

  it('calls onSortTypeChange when Created is selected', async () => {
    const user = userEvent.setup()
    const onSortTypeChange = vi.fn()

    render(<FilterSortControls {...defaultProps} onSortTypeChange={onSortTypeChange} />)

    await user.selectOptions(screen.getByLabelText('Sort by'), 'Created')

    expect(onSortTypeChange).toHaveBeenCalledWith('Created')
  })

  it('calls onSortTypeChange with property key when a property is selected', async () => {
    const user = userEvent.setup()
    const onSortTypeChange = vi.fn()

    render(<FilterSortControls {...defaultProps} onSortTypeChange={onSortTypeChange} />)

    await user.selectOptions(screen.getByLabelText('Sort by'), 'due')

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

    await user.selectOptions(screen.getByLabelText('Sort by'), '__none__')

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

    expect(screen.getByText('Desc')).toBeInTheDocument()
  })

  it('shows Asc label when sort direction is Asc', () => {
    render(<FilterSortControls {...defaultProps} sort={{ type: 'Created', dir: 'Asc' }} />)

    expect(screen.getByText('Asc')).toBeInTheDocument()
  })

  it('reflects current sort value in the select when sort is Created', () => {
    render(<FilterSortControls {...defaultProps} sort={{ type: 'Created', dir: 'Desc' }} />)

    const select = screen.getByLabelText('Sort by')
    expect(select).toHaveValue('Created')
  })

  it('reflects current sort value in the select when sort is a property key', () => {
    render(
      <FilterSortControls
        {...defaultProps}
        sort={{ type: 'PropertyText', key: 'due', dir: 'Asc' }}
      />,
    )

    const select = screen.getByLabelText('Sort by')
    expect(select).toHaveValue('due')
  })

  it('shows __none__ as selected when sort is null', () => {
    render(<FilterSortControls {...defaultProps} sort={null} />)

    const select = screen.getByLabelText('Sort by')
    expect(select).toHaveValue('__none__')
  })

  it('applies size="sm" to sort select trigger', () => {
    render(<FilterSortControls {...defaultProps} />)

    const select = screen.getByLabelText('Sort by')
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
