/**
 * Tests for QueryBuilderModal (F-24).
 *
 * Validates:
 *  - Renders 3 query type buttons
 *  - Tag form shown by default
 *  - Switching to property shows property fields
 *  - Switching to backlinks shows target field
 *  - Generates tag expression
 *  - Generates property expression with operator
 *  - Generates backlinks expression
 *  - "table:true" appended when checkbox checked
 *  - Insert button disabled when required fields empty
 *  - Insert button calls onSave with expression
 *  - Parses initialExpression to populate form (tag)
 *  - Parses initialExpression to populate form (property with operator)
 *  - Expression preview shows generated syntax
 *  - Parses initialExpression to populate form (backlinks)
 *  - Parses initialExpression with table:true flag
 *  - Parses initialExpression with gte operator and value
 *  - Parses initialExpression with property key only (no value or operator)
 *  - Disables Insert button when property key is empty
 *  - a11y audit
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { QueryBuilderModal } from '../QueryBuilderModal'

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

vi.mocked(invoke)

describe('QueryBuilderModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSave: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders with 3 query type buttons', () => {
    render(<QueryBuilderModal {...defaultProps} />)

    const radioGroup = screen.getByRole('radiogroup', { name: /query type/i })
    expect(radioGroup).toBeInTheDocument()

    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)

    expect(screen.getByRole('radio', { name: /^Tag$/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^Property$/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^Backlinks$/i })).toBeInTheDocument()
  })

  it('shows tag form by default', () => {
    render(<QueryBuilderModal {...defaultProps} />)

    // Tag is selected by default
    expect(screen.getByRole('radio', { name: /^Tag$/i })).toHaveAttribute('aria-checked', 'true')

    // Tag prefix input should be visible
    expect(screen.getByLabelText(/tag prefix/i)).toBeInTheDocument()
  })

  it('switches to property and shows property fields', async () => {
    const user = userEvent.setup()
    render(<QueryBuilderModal {...defaultProps} />)

    await user.click(screen.getByRole('radio', { name: /^Property$/i }))

    expect(screen.getByRole('radio', { name: /^Property$/i })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByLabelText(/property key/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/operator/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^value$/i)).toBeInTheDocument()
  })

  it('switches to backlinks and shows target field', async () => {
    const user = userEvent.setup()
    render(<QueryBuilderModal {...defaultProps} />)

    await user.click(screen.getByRole('radio', { name: /^Backlinks$/i }))

    expect(screen.getByRole('radio', { name: /^Backlinks$/i })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByLabelText(/target page id/i)).toBeInTheDocument()
  })

  it('generates tag expression', async () => {
    const user = userEvent.setup()
    render(<QueryBuilderModal {...defaultProps} />)

    await user.type(screen.getByLabelText(/tag prefix/i), 'work')

    const preview = screen.getByTestId('expression-preview')
    expect(preview).toHaveTextContent('type:tag expr:work')
  })

  it('generates property expression with operator', async () => {
    const user = userEvent.setup()
    render(<QueryBuilderModal {...defaultProps} />)

    await user.click(screen.getByRole('radio', { name: /^Property$/i }))

    await user.type(screen.getByLabelText(/property key/i), 'priority')
    await user.type(screen.getByLabelText(/^value$/i), '1')

    // Default operator is eq, which is omitted
    const preview = screen.getByTestId('expression-preview')
    expect(preview).toHaveTextContent('type:property key:priority value:1')

    // Change operator to neq via the native <select> (mocked from Radix Select)
    await user.selectOptions(screen.getByRole('combobox', { name: /operator/i }), 'neq')

    expect(preview).toHaveTextContent('type:property key:priority value:1 operator:neq')
  })

  it('generates backlinks expression', async () => {
    const user = userEvent.setup()
    render(<QueryBuilderModal {...defaultProps} />)

    await user.click(screen.getByRole('radio', { name: /^Backlinks$/i }))
    await user.type(screen.getByLabelText(/target page id/i), '01ABC123')

    const preview = screen.getByTestId('expression-preview')
    expect(preview).toHaveTextContent('type:backlinks target:01ABC123')
  })

  it('appends table:true when checkbox checked', async () => {
    const user = userEvent.setup()
    render(<QueryBuilderModal {...defaultProps} />)

    await user.type(screen.getByLabelText(/tag prefix/i), 'work')
    await user.click(screen.getByLabelText(/show results as table/i))

    const preview = screen.getByTestId('expression-preview')
    expect(preview).toHaveTextContent('type:tag expr:work table:true')
  })

  it('disables Insert button when required fields are empty', () => {
    render(<QueryBuilderModal {...defaultProps} />)

    const insertBtn = screen.getByRole('button', { name: /insert query/i })
    expect(insertBtn).toBeDisabled()
  })

  it('Insert button calls onSave with expression', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<QueryBuilderModal {...defaultProps} onSave={onSave} />)

    await user.type(screen.getByLabelText(/tag prefix/i), 'project')
    await user.click(screen.getByRole('button', { name: /insert query/i }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('type:tag expr:project')
  })

  it('parses initialExpression to populate form (tag)', () => {
    render(<QueryBuilderModal {...defaultProps} initialExpression="type:tag expr:work" />)

    expect(screen.getByRole('radio', { name: /^Tag$/i })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText(/tag prefix/i)).toHaveValue('work')

    const preview = screen.getByTestId('expression-preview')
    expect(preview).toHaveTextContent('type:tag expr:work')
  })

  it('parses initialExpression to populate form (property with operator)', () => {
    render(
      <QueryBuilderModal
        {...defaultProps}
        initialExpression="type:property key:priority value:1 operator:neq"
      />,
    )

    expect(screen.getByRole('radio', { name: /^Property$/i })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByLabelText(/property key/i)).toHaveValue('priority')
    expect(screen.getByLabelText(/^value$/i)).toHaveValue('1')

    const preview = screen.getByTestId('expression-preview')
    expect(preview).toHaveTextContent('type:property key:priority value:1 operator:neq')
  })

  it('shows expression preview with generated syntax', async () => {
    const user = userEvent.setup()
    render(<QueryBuilderModal {...defaultProps} />)

    // Preview should not be visible when expression is empty
    expect(screen.queryByTestId('expression-preview')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText(/tag prefix/i), 'test')

    // Preview should appear after typing
    const preview = screen.getByTestId('expression-preview')
    expect(preview).toBeInTheDocument()
    expect(preview).toHaveTextContent('type:tag expr:test')
  })

  it('parses initialExpression to populate form (backlinks)', () => {
    render(
      <QueryBuilderModal {...defaultProps} initialExpression="type:backlinks target:01ABC123" />,
    )

    expect(screen.getByRole('radio', { name: /^Backlinks$/i })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByLabelText(/target page id/i)).toHaveValue('01ABC123')
  })

  it('parses initialExpression with table:true flag', () => {
    render(
      <QueryBuilderModal {...defaultProps} initialExpression="type:tag prefix:todo table:true" />,
    )

    expect(screen.getByLabelText(/show results as table/i)).toBeChecked()
  })

  it('parses initialExpression with gte operator and value', () => {
    render(
      <QueryBuilderModal
        {...defaultProps}
        initialExpression="type:property key:effort operator:gte value:5"
      />,
    )

    expect(screen.getByRole('combobox', { name: /operator/i })).toHaveValue('gte')
    expect(screen.getByLabelText(/^value$/i)).toHaveValue('5')
  })

  it('parses initialExpression with property key only (no value or operator)', () => {
    render(<QueryBuilderModal {...defaultProps} initialExpression="type:property key:status" />)

    expect(screen.getByLabelText(/property key/i)).toHaveValue('status')
    expect(screen.getByLabelText(/^value$/i)).toHaveValue('')
  })

  it('disables Insert button when property key is empty', async () => {
    const user = userEvent.setup()
    render(<QueryBuilderModal {...defaultProps} />)

    await user.click(screen.getByRole('radio', { name: /^Property$/i }))

    // Key is empty, so the button should be disabled
    const insertBtn = screen.getByRole('button', { name: /insert query/i })
    expect(insertBtn).toBeDisabled()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<QueryBuilderModal {...defaultProps} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
