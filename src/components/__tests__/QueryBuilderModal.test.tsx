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

const mockedInvoke = vi.mocked(invoke)

describe('QueryBuilderModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSave: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_property_defs') return []
      return null
    })
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

  // -----------------------------------------------------------------------
  // UX-274: property-key validation against listPropertyDefs()
  // -----------------------------------------------------------------------
  describe('property-key validation', () => {
    it('populates the datalist with known property definitions', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_property_defs') {
          return [
            { key: 'priority', value_type: 'number', options: null, created_at: '2026-01-01' },
            { key: 'status', value_type: 'text', options: null, created_at: '2026-01-01' },
          ]
        }
        return null
      })

      const user = userEvent.setup()
      render(<QueryBuilderModal {...defaultProps} />)

      await user.click(screen.getByRole('radio', { name: /^Property$/i }))

      // Datalist exists with 2 options
      await waitFor(() => {
        const datalist = screen.getByTestId('qb-prop-key-list')
        const options = datalist.querySelectorAll('option')
        expect(options.length).toBe(2)
        expect((options[0] as HTMLOptionElement).value).toBe('priority')
        expect((options[1] as HTMLOptionElement).value).toBe('status')
      })

      // Input is wired to the datalist
      const keyInput = screen.getByLabelText(/property key/i) as HTMLInputElement
      expect(keyInput.getAttribute('list')).toBe('qb-prop-key-list')
      // UX-8: input also exposes ARIA autocomplete semantics for the datalist
      expect(keyInput.getAttribute('aria-autocomplete')).toBe('list')
      expect(keyInput.getAttribute('aria-controls')).toBe('qb-prop-key-list')
    })

    it('shows inline warning when entered key is not a known definition', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_property_defs') {
          return [{ key: 'priority', value_type: 'number', options: null, created_at: 'x' }]
        }
        return null
      })

      const user = userEvent.setup()
      render(<QueryBuilderModal {...defaultProps} />)

      await user.click(screen.getByRole('radio', { name: /^Property$/i }))

      // Wait for definitions to load before typing
      await waitFor(() => {
        const datalist = screen.getByTestId('qb-prop-key-list')
        expect(datalist.querySelectorAll('option').length).toBe(1)
      })

      const keyInput = screen.getByLabelText(/property key/i) as HTMLInputElement
      await user.type(keyInput, 'unknown_key')

      // Warning is announced (aria-live=polite) and input is marked invalid (UX-8)
      const warning = screen.getByText(/not yet defined/i)
      expect(warning).toBeInTheDocument()
      expect(warning.getAttribute('aria-live')).toBe('polite')
      expect(warning.getAttribute('role')).not.toBe('status')
      expect(keyInput).toHaveAttribute('aria-invalid', 'true')
      expect(keyInput.className).toContain('border-destructive')
    })

    it('does NOT show warning for a known property key', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_property_defs') {
          return [{ key: 'priority', value_type: 'number', options: null, created_at: 'x' }]
        }
        return null
      })

      const user = userEvent.setup()
      render(<QueryBuilderModal {...defaultProps} />)

      await user.click(screen.getByRole('radio', { name: /^Property$/i }))

      await waitFor(() => {
        const datalist = screen.getByTestId('qb-prop-key-list')
        expect(datalist.querySelectorAll('option').length).toBe(1)
      })

      const keyInput = screen.getByLabelText(/property key/i) as HTMLInputElement
      await user.type(keyInput, 'priority')

      expect(screen.queryByText(/not yet defined/i)).not.toBeInTheDocument()
      expect(keyInput).toHaveAttribute('aria-invalid', 'false')
    })

    it('suppresses warning when listPropertyDefs() returns empty (loader fail-safe)', async () => {
      // beforeEach already returns [] for list_property_defs
      const user = userEvent.setup()
      render(<QueryBuilderModal {...defaultProps} />)

      await user.click(screen.getByRole('radio', { name: /^Property$/i }))

      const keyInput = screen.getByLabelText(/property key/i) as HTMLInputElement
      await user.type(keyInput, 'anything')

      // No warning when there are zero known keys (avoids false positive)
      expect(screen.queryByText(/not yet defined/i)).not.toBeInTheDocument()
      expect(keyInput).toHaveAttribute('aria-invalid', 'false')
    })

    it('still allows submission of an unknown key (soft warning, not blocking)', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_property_defs') {
          return [{ key: 'priority', value_type: 'number', options: null, created_at: 'x' }]
        }
        return null
      })

      const user = userEvent.setup()
      const onSave = vi.fn()
      render(<QueryBuilderModal {...defaultProps} onSave={onSave} />)

      await user.click(screen.getByRole('radio', { name: /^Property$/i }))

      await waitFor(() => {
        const datalist = screen.getByTestId('qb-prop-key-list')
        expect(datalist.querySelectorAll('option').length).toBe(1)
      })

      await user.type(screen.getByLabelText(/property key/i), 'future_key')

      // The Insert button stays enabled despite the warning
      const insertBtn = screen.getByRole('button', { name: /insert query/i })
      expect(insertBtn).not.toBeDisabled()

      await user.click(insertBtn)
      expect(onSave).toHaveBeenCalledWith('type:property key:future_key')
    })

    it('does NOT call list_property_defs while modal is closed', async () => {
      render(<QueryBuilderModal {...defaultProps} open={false} />)
      // Allow any pending microtasks to settle
      await waitFor(() => {
        const calls = mockedInvoke.mock.calls.filter((c) => c[0] === 'list_property_defs')
        expect(calls.length).toBe(0)
      })
    })

    it('warning region has no a11y violations', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_property_defs') {
          return [{ key: 'priority', value_type: 'number', options: null, created_at: 'x' }]
        }
        return null
      })

      const user = userEvent.setup()
      const { container } = render(<QueryBuilderModal {...defaultProps} />)

      await user.click(screen.getByRole('radio', { name: /^Property$/i }))

      await waitFor(() => {
        const datalist = screen.getByTestId('qb-prop-key-list')
        expect(datalist.querySelectorAll('option').length).toBe(1)
      })

      await user.type(screen.getByLabelText(/property key/i), 'unknown_key')
      expect(screen.getByText(/not yet defined/i)).toBeInTheDocument()

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
