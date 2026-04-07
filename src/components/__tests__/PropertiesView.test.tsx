/**
 * Tests for PropertiesView component.
 *
 * Validates:
 *  - Renders title "Property Definitions"
 *  - Shows loading state initially
 *  - Shows property definitions after loading
 *  - Shows empty state when no definitions
 *  - Create button creates a new definition
 *  - Delete button shows confirmation dialog
 *  - Search filters definitions by key
 *  - Has no a11y violations (axe)
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { PropertiesView } from '../PropertiesView'

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
  localStorage.removeItem('task_cycle')
})

describe('PropertiesView', () => {
  it('renders title "Property Definitions"', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    render(<PropertiesView />)

    expect(screen.getByText('Property Definitions')).toBeInTheDocument()
  })

  it('shows loading state initially', () => {
    // Mock that never resolves — keeps loading state
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = render(<PropertiesView />)

    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(3)
  })

  it('shows property definitions after loading', async () => {
    mockedInvoke.mockResolvedValueOnce([
      makePropDef('status', 'select', '["open","closed"]'),
      makePropDef('priority', 'number'),
      makePropDef('due', 'date'),
    ])

    render(<PropertiesView />)

    // Property key names (formatted via formatPropertyName)
    expect(await screen.findByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Due')).toBeInTheDocument()

    // Type badges exist (values also appear in the dropdown, so use getAllByText)
    // Each type appears at least twice: once in the <option> and once in the badge
    for (const vt of ['select', 'number', 'date']) {
      const matches = screen.getAllByText(vt)
      expect(matches.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('shows empty state when no definitions', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    render(<PropertiesView />)

    expect(await screen.findByText('No property definitions yet')).toBeInTheDocument()
  })

  it('create button creates a new definition', async () => {
    const user = userEvent.setup()
    // Initial load — empty
    mockedInvoke.mockResolvedValueOnce([])

    render(<PropertiesView />)

    await waitFor(() => {
      expect(screen.getByText('No property definitions yet')).toBeInTheDocument()
    })

    // Mock createPropertyDef response
    mockedInvoke.mockResolvedValueOnce(makePropDef('my-prop', 'text'))

    // Type the key and submit
    const keyInput = screen.getByPlaceholderText('Property key')
    await user.type(keyInput, 'my-prop')

    const createBtn = screen.getByRole('button', { name: /Create/i })
    await user.click(createBtn)

    // New definition should appear (formatted as "My Prop")
    expect(await screen.findByText('My Prop')).toBeInTheDocument()

    // Verify invoke was called correctly
    expect(mockedInvoke).toHaveBeenCalledWith('create_property_def', {
      key: 'my-prop',
      valueType: 'text',
      options: null,
    })

    // Input should be cleared
    expect(keyInput).toHaveValue('')

    // Success toast
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Property definition created')
  })

  it('delete button shows confirmation dialog', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce([makePropDef('to-delete', 'text')])

    render(<PropertiesView />)

    expect(await screen.findByText('To Delete')).toBeInTheDocument()

    // Click the trash icon
    const deleteBtn = screen.getByRole('button', { name: /Delete property to-delete/i })
    await user.click(deleteBtn)

    // AlertDialog should appear
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

    render(<PropertiesView />)

    expect(await screen.findByText('To Delete')).toBeInTheDocument()

    // Mock deletePropertyDef
    mockedInvoke.mockResolvedValueOnce(undefined)

    // Click the trash icon
    const deleteBtn = screen.getByRole('button', { name: /Delete property to-delete/i })
    await user.click(deleteBtn)

    // Click Delete in the dialog
    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
    await user.click(confirmBtn)

    // Definition should be removed
    await waitFor(() => {
      expect(screen.queryByText('To Delete')).not.toBeInTheDocument()
    })

    // Success toast
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Property definition deleted')
  })

  it('search filters definitions by key', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce([
      makePropDef('status', 'select'),
      makePropDef('priority', 'number'),
      makePropDef('due-date', 'date'),
    ])

    render(<PropertiesView />)

    // Wait for all definitions to appear (formatted via formatPropertyName)
    expect(await screen.findByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Due Date')).toBeInTheDocument()

    // Type in the search
    const searchInput = screen.getByPlaceholderText('Search properties...')
    await user.type(searchInput, 'pri')

    // Only 'priority' should be visible (displayed as 'Priority')
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.queryByText('Status')).not.toBeInTheDocument()
    expect(screen.queryByText('Due Date')).not.toBeInTheDocument()
  })

  it('shows edit options button for select-type properties', async () => {
    mockedInvoke.mockResolvedValueOnce([
      makePropDef('status', 'select', '["open","closed"]'),
      makePropDef('priority', 'number'),
    ])

    render(<PropertiesView />)

    expect(await screen.findByText('Status')).toBeInTheDocument()

    // Edit options button should be visible for select type
    expect(screen.getByRole('button', { name: /Edit options/i })).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    mockedInvoke.mockResolvedValueOnce([
      makePropDef('status', 'select', '["open","closed"]'),
      makePropDef('priority', 'number'),
    ])

    const { container } = render(<PropertiesView />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('renders Task States section', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    render(<PropertiesView />)

    expect(screen.getByText('Task States')).toBeInTheDocument()
  })

  it('shows default task states', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    render(<PropertiesView />)

    expect(screen.getByText('TODO')).toBeInTheDocument()
    expect(screen.getByText('DOING')).toBeInTheDocument()
    expect(screen.getByText('DONE')).toBeInTheDocument()
    expect(screen.getByText('none')).toBeInTheDocument()
  })

  it('disables create button when key matches existing definition', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce([makePropDef('status', 'text')])

    render(<PropertiesView />)

    await waitFor(() => {
      expect(screen.getByText('Status')).toBeInTheDocument()
    })

    const keyInput = screen.getByPlaceholderText('Property key')
    await user.type(keyInput, 'status')

    const createBtn = screen.getByRole('button', { name: /Create/i })
    expect(createBtn).toBeDisabled()
  })

  it('shows duplicate key warning message', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce([makePropDef('status', 'text')])

    render(<PropertiesView />)

    await waitFor(() => {
      expect(screen.getByText('Status')).toBeInTheDocument()
    })

    const keyInput = screen.getByPlaceholderText('Property key')
    await user.type(keyInput, 'status')

    expect(screen.getByText('A property with this key already exists')).toBeInTheDocument()
  })

  it('enables create button when key is unique', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce([makePropDef('status', 'text')])

    render(<PropertiesView />)

    await waitFor(() => {
      expect(screen.getByText('Status')).toBeInTheDocument()
    })

    const keyInput = screen.getByPlaceholderText('Property key')
    await user.type(keyInput, 'new_key')

    const createBtn = screen.getByRole('button', { name: /Create/i })
    expect(createBtn).toBeEnabled()
  })

  it('displays formatted property names in the definitions list', async () => {
    mockedInvoke.mockResolvedValueOnce([
      makePropDef('created_at', 'date'),
      makePropDef('my_custom_prop', 'text'),
    ])

    render(<PropertiesView />)

    // Formatted names should appear
    expect(await screen.findByText('Created At')).toBeInTheDocument()
    expect(screen.getByText('My Custom Prop')).toBeInTheDocument()
    // Raw keys should NOT appear
    expect(screen.queryByText('created_at')).not.toBeInTheDocument()
    expect(screen.queryByText('my_custom_prop')).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // Error-path tests (mockRejectedValueOnce)
  // -----------------------------------------------------------------------

  it('shows error toast when loading definitions fails', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('DB read error'))

    render(<PropertiesView />)

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load property definitions'),
      )
    })

    // Loading should finish (no lingering skeletons)
    expect(screen.queryByTestId('properties-loading')).not.toBeInTheDocument()

    // Empty state shown because definitions stayed empty
    expect(screen.getByText('No property definitions yet')).toBeInTheDocument()
  })

  it('shows error toast when creating a definition fails', async () => {
    const user = userEvent.setup()
    // Initial load — empty
    mockedInvoke.mockResolvedValueOnce([])

    render(<PropertiesView />)

    await waitFor(() => {
      expect(screen.getByText('No property definitions yet')).toBeInTheDocument()
    })

    // Mock create to reject
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

    // Definition should NOT appear in the list
    expect(screen.queryByText('My Prop')).not.toBeInTheDocument()

    // Input should NOT be cleared (still contains the failed key)
    expect(keyInput).toHaveValue('my-prop')

    // No success toast
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
  })

  it('shows error toast when deleting a definition fails', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce([makePropDef('keep-me', 'text')])

    render(<PropertiesView />)

    expect(await screen.findByText('Keep Me')).toBeInTheDocument()

    // Mock delete to reject
    mockedInvoke.mockRejectedValueOnce(new Error('Backend error'))

    // Open delete dialog
    const deleteBtn = screen.getByRole('button', { name: /Delete property keep-me/i })
    await user.click(deleteBtn)

    // Confirm deletion
    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete property definition'),
      )
    })

    // Definition should still be visible (not removed)
    expect(screen.getByText('Keep Me')).toBeInTheDocument()

    // No success toast
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
  })

  it('shows error toast when updating select options fails', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce([makePropDef('status', 'select', '["open","closed"]')])

    render(<PropertiesView />)

    expect(await screen.findByText('Status')).toBeInTheDocument()

    // Open the edit options popover
    const editBtn = screen.getByRole('button', { name: /Edit options/i })
    await user.click(editBtn)

    // Modify the options input (avoid brackets — userEvent treats [ as key descriptor)
    const optionsInput = screen.getByLabelText('Options JSON')
    await user.clear(optionsInput)
    await user.type(optionsInput, 'open,closed,pending')

    // Mock update to reject
    mockedInvoke.mockRejectedValueOnce(new Error('Invalid JSON'))

    const saveBtn = screen.getByRole('button', { name: /Save/i })
    await user.click(saveBtn)

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update options'),
      )
    })

    // No success toast
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
  })
})
