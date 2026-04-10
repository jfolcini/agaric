/**
 * Tests for PropertyDefinitionsList component.
 *
 * Validates:
 *  - Renders property definitions list
 *  - Search/filter functionality
 *  - Delete with confirmation
 *  - Has no a11y violations (axe)
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { PropertyDefinitionsList } from '../PropertyDefinitionsList'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('@/components/ui/select', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')
  const Ctx = React.createContext({})

  function Select({ value, onValueChange, children }: any) {
    const triggerPropsRef = React.useRef({})
    return React.createElement(
      Ctx.Provider,
      { value: { value, onValueChange, triggerPropsRef } },
      children,
    )
  }

  function SelectTrigger({ size, className, ...props }: any) {
    const ctx = React.useContext(Ctx)
    Object.assign(ctx.triggerPropsRef.current, { size, className, ...props })
    return null
  }

  function SelectValue() {
    return null
  }

  function SelectContent({ children }: any) {
    const ctx = React.useContext(Ctx)
    const tp = ctx.triggerPropsRef.current
    return React.createElement(
      'select',
      {
        value: ctx.value ?? '',
        onChange: (e: any) => ctx.onValueChange?.(e.target.value),
        'aria-label': tp['aria-label'],
        id: tp.id,
      },
      children,
    )
  }

  function SelectItem({ value, children }: any) {
    return React.createElement('option', { value }, children)
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

const mockedInvoke = vi.mocked(invoke)

function makePropDef(key: string, valueType = 'text', options: string | null = null) {
  return {
    key,
    value_type: valueType,
    options,
    created_at: '2025-01-15T00:00:00Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PropertyDefinitionsList', () => {
  it('renders property definitions list', async () => {
    mockedInvoke.mockResolvedValueOnce([
      makePropDef('status', 'select', '["open","closed"]'),
      makePropDef('priority', 'number'),
      makePropDef('due', 'date'),
    ])

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Due')).toBeInTheDocument()
  })

  it('shows loading state initially', () => {
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = render(<PropertyDefinitionsList />)

    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(3)
  })

  it('shows empty state when no definitions', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('No property definitions yet')).toBeInTheDocument()
  })

  it('search filters definitions by key', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce([
      makePropDef('status', 'select'),
      makePropDef('priority', 'number'),
      makePropDef('due-date', 'date'),
    ])

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Due Date')).toBeInTheDocument()

    const searchInput = screen.getByPlaceholderText('Search properties...')
    await user.type(searchInput, 'pri')

    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.queryByText('Status')).not.toBeInTheDocument()
    expect(screen.queryByText('Due Date')).not.toBeInTheDocument()
  })

  it('create button creates a new definition', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce([])

    render(<PropertyDefinitionsList />)

    await waitFor(() => {
      expect(screen.getByText('No property definitions yet')).toBeInTheDocument()
    })

    mockedInvoke.mockResolvedValueOnce(makePropDef('my-prop', 'text'))

    const keyInput = screen.getByPlaceholderText('Property key')
    await user.type(keyInput, 'my-prop')

    const createBtn = screen.getByRole('button', { name: /Create/i })
    await user.click(createBtn)

    expect(await screen.findByText('My Prop')).toBeInTheDocument()

    expect(mockedInvoke).toHaveBeenCalledWith('create_property_def', {
      key: 'my-prop',
      valueType: 'text',
      options: null,
    })

    expect(keyInput).toHaveValue('')
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Property definition created')
  })

  it('delete button shows confirmation dialog', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce([makePropDef('to-delete', 'text')])

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('To Delete')).toBeInTheDocument()

    const deleteBtn = screen.getByRole('button', { name: /Delete property to-delete/i })
    await user.click(deleteBtn)

    expect(await screen.findByText('Delete this property definition?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Blocks using this property will keep their values, but the definition will be removed.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Delete/i })).toBeInTheDocument()
  })

  it('confirming delete removes the definition', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce([makePropDef('to-delete', 'text')])

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('To Delete')).toBeInTheDocument()

    mockedInvoke.mockResolvedValueOnce(undefined)

    const deleteBtn = screen.getByRole('button', { name: /Delete property to-delete/i })
    await user.click(deleteBtn)

    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(screen.queryByText('To Delete')).not.toBeInTheDocument()
    })

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Property definition deleted')
  })

  it('shows edit options button for select-type properties', async () => {
    mockedInvoke.mockResolvedValueOnce([
      makePropDef('status', 'select', '["open","closed"]'),
      makePropDef('priority', 'number'),
    ])

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Status')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Edit options/i })).toBeInTheDocument()
  })

  // ---------------------------------------------------------------------------
  // Error path tests
  // ---------------------------------------------------------------------------

  it('shows toast error when loading definitions fails', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('DB error'))

    render(<PropertyDefinitionsList />)

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load property definitions'),
      )
    })
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining('DB error'))
  })

  it('shows toast error when creating a definition fails', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce([]) // initial load

    render(<PropertyDefinitionsList />)

    await waitFor(() => {
      expect(screen.getByText('No property definitions yet')).toBeInTheDocument()
    })

    mockedInvoke.mockRejectedValueOnce(new Error('Duplicate key'))

    const keyInput = screen.getByPlaceholderText('Property key')
    await user.type(keyInput, 'my-prop')

    const createBtn = screen.getByRole('button', { name: /Create/i })
    await user.click(createBtn)

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create property definition'),
      )
    })
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining('Duplicate key'))
    // The definition should NOT appear in the list
    expect(screen.queryByText('My Prop')).not.toBeInTheDocument()
  })

  it('shows toast error when deleting a definition fails and keeps item', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce([makePropDef('to-delete', 'text')]) // initial load

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('To Delete')).toBeInTheDocument()

    mockedInvoke.mockRejectedValueOnce(new Error('Not found'))

    const deleteBtn = screen.getByRole('button', { name: /Delete property to-delete/i })
    await user.click(deleteBtn)

    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete property definition'),
      )
    })
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining('Not found'))
    // The definition should still be in the list
    expect(screen.getByText('To Delete')).toBeInTheDocument()
  })

  it('shows toast error when saving options fails', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce([makePropDef('status', 'select', '["open","closed"]')]) // initial load

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Status')).toBeInTheDocument()

    // Open the edit options popover
    const editBtn = screen.getByRole('button', { name: /Edit options/i })
    await user.click(editBtn)

    mockedInvoke.mockRejectedValueOnce(new Error('Invalid JSON'))

    const optionsInput = screen.getByLabelText('Options JSON')
    await user.clear(optionsInput)
    await user.type(optionsInput, 'not-valid-json')

    const saveBtn = screen.getByRole('button', { name: /Save/i })
    await user.click(saveBtn)

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update options'),
      )
    })
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining('Invalid JSON'))
  })

  it('has no a11y violations', async () => {
    mockedInvoke.mockResolvedValueOnce([
      makePropDef('status', 'select', '["open","closed"]'),
      makePropDef('priority', 'number'),
    ])

    const { container } = render(<PropertyDefinitionsList />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('includes ref type in the create-property type dropdown', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    render(<PropertyDefinitionsList />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_property_defs')
    })

    // The mock renders a native <select> for the type selector
    const typeSelects = screen.getAllByRole('combobox')
    const typeSelect = typeSelects.find((el) => el.getAttribute('aria-label') === 'Type') as
      | HTMLSelectElement
      | undefined
    expect(typeSelect).toBeDefined()
    const optionValues = Array.from(typeSelect?.options ?? []).map((o) => o.value)
    expect(optionValues).toContain('ref')
  })

  it('hides delete button on built-in properties and shows Built-in badge', async () => {
    mockedInvoke.mockResolvedValueOnce([
      makePropDef('repeat', 'text'),
      makePropDef('completed_at', 'date'),
      makePropDef('custom-field', 'text'),
    ])

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Repeat')).toBeInTheDocument()
    expect(screen.getByText('Completed At')).toBeInTheDocument()
    expect(screen.getByText('Custom Field')).toBeInTheDocument()

    // Built-in properties show "Built-in" badge, not delete button
    expect(
      screen.queryByRole('button', { name: /Delete property repeat/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Delete property completed_at/i }),
    ).not.toBeInTheDocument()

    const badges = screen.getAllByText('Built-in')
    expect(badges).toHaveLength(2)

    // Custom property still has delete button
    expect(
      screen.getByRole('button', { name: /Delete property custom-field/i }),
    ).toBeInTheDocument()
  })
})
