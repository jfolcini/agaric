/**
 * Tests for PropertiesPanel component.
 *
 * Validates:
 *  - Empty state when no blockId is provided
 *  - Fetches properties on mount
 *  - Loading state while fetching
 *  - Property display with key badges and rendered values
 *  - renderValue prioritisation (value_text > value_num > value_date > value_ref > empty)
 *  - Delete property interaction
 *  - Add property form toggle, submission, and cancellation
 *  - Error handling for get_properties failure
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { PropertyRow } from '../../lib/tauri'
import { PropertiesPanel } from '../PropertiesPanel'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

// Mock lucide-react icons with simple SVGs
vi.mock('lucide-react', () => ({
  Plus: (props: { className?: string }) => (
    <svg data-testid="plus-icon" className={props.className} />
  ),
  Settings2: (props: { className?: string }) => (
    <svg data-testid="settings-icon" className={props.className} />
  ),
  X: (props: { className?: string }) => <svg data-testid="x-icon" className={props.className} />,
}))

// Mock EmptyState to simplify assertions
vi.mock('../EmptyState', () => ({
  EmptyState: ({ message }: { message: string }) => <div data-testid="empty-state">{message}</div>,
}))

const mockedInvoke = vi.mocked(invoke)

/** Helper to build a PropertyRow with sensible defaults. */
function makeProp(overrides: Partial<PropertyRow> & { key: string }): PropertyRow {
  return {
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    ...overrides,
  }
}

const mockProperties: PropertyRow[] = [
  makeProp({ key: 'priority', value_text: 'A' }),
  makeProp({ key: 'due', value_date: '2025-06-15' }),
]

/** Default mock: route invoke calls by command name. */
function mockInvokeWith(properties: PropertyRow[]) {
  // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
  mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
    if (cmd === 'get_properties') return properties
    if (cmd === 'set_property') return null
    if (cmd === 'delete_property') return null
    return null
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PropertiesPanel', () => {
  // -- Empty / no block -------------------------------------------------------

  it('renders empty state when blockId is null', () => {
    render(<PropertiesPanel blockId={null} />)

    const emptyState = screen.getByTestId('empty-state')
    expect(emptyState).toBeInTheDocument()
    expect(emptyState).toHaveTextContent('Select a block to see properties')
  })

  it('calls get_properties on mount when blockId provided', async () => {
    mockInvokeWith([])

    render(<PropertiesPanel blockId="BLOCK001" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_properties', { blockId: 'BLOCK001' })
    })
  })

  // -- Loading ----------------------------------------------------------------

  it('shows Skeleton elements while fetching', async () => {
    // Create a deferred promise so we can control when get_properties resolves
    let resolveGetProperties!: (value: PropertyRow[]) => void
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'get_properties') {
        return new Promise<PropertyRow[]>((resolve) => {
          resolveGetProperties = resolve
        })
      }
      return null
    })

    const { container } = render(<PropertiesPanel blockId="BLOCK001" />)

    // While the promise is pending, Skeleton elements should be visible
    const loadingDiv = container.querySelector('.properties-panel-loading')
    expect(loadingDiv).toBeInTheDocument()
    const skeletons = loadingDiv?.querySelectorAll('[data-slot="skeleton"]') ?? []
    expect(skeletons.length).toBe(2)

    // Resolve the promise and loading should disappear
    resolveGetProperties([])

    await waitFor(() => {
      expect(container.querySelector('.properties-panel-loading')).not.toBeInTheDocument()
    })
  })

  // -- Property display -------------------------------------------------------

  it('renders property key-value pairs', async () => {
    mockInvokeWith(mockProperties)

    render(<PropertiesPanel blockId="BLOCK001" />)

    // Key badges
    expect(await screen.findByText('priority')).toBeInTheDocument()
    expect(screen.getByText('due')).toBeInTheDocument()

    // Values
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('2025-06-15')).toBeInTheDocument()
  })

  it('shows "No properties set" when block has no properties', async () => {
    mockInvokeWith([])

    render(<PropertiesPanel blockId="BLOCK001" />)

    expect(await screen.findByText('No properties set')).toBeInTheDocument()
  })

  it('renderValue: shows value_text', async () => {
    mockInvokeWith([makeProp({ key: 'status', value_text: 'active' })])

    render(<PropertiesPanel blockId="BLOCK001" />)

    expect(await screen.findByText('active')).toBeInTheDocument()
  })

  it('renderValue: shows value_num as string', async () => {
    mockInvokeWith([makeProp({ key: 'count', value_num: 42 })])

    render(<PropertiesPanel blockId="BLOCK001" />)

    expect(await screen.findByText('42')).toBeInTheDocument()
  })

  it('renderValue: shows value_date', async () => {
    mockInvokeWith([makeProp({ key: 'created', value_date: '2025-01-01' })])

    render(<PropertiesPanel blockId="BLOCK001" />)

    expect(await screen.findByText('2025-01-01')).toBeInTheDocument()
  })

  it('renderValue: shows truncated value_ref', async () => {
    const refUlid = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    mockInvokeWith([makeProp({ key: 'ref', value_ref: refUlid })])

    render(<PropertiesPanel blockId="BLOCK001" />)

    // Should show → followed by first 8 chars + ...
    expect(await screen.findByText(`→ ${refUlid.slice(0, 8)}...`)).toBeInTheDocument()
  })

  it('renderValue: shows (empty) when all values null', async () => {
    mockInvokeWith([makeProp({ key: 'blank' })])

    render(<PropertiesPanel blockId="BLOCK001" />)

    expect(await screen.findByText('(empty)')).toBeInTheDocument()
  })

  // -- Delete -----------------------------------------------------------------

  it('delete button calls delete_property and removes from list', async () => {
    const user = userEvent.setup()
    mockInvokeWith([
      makeProp({ key: 'priority', value_text: 'A' }),
      makeProp({ key: 'due', value_date: '2025-06-15' }),
    ])

    render(<PropertiesPanel blockId="BLOCK001" />)

    // Wait for properties to render
    expect(await screen.findByText('priority')).toBeInTheDocument()

    // Click the delete button for "priority"
    const deleteBtn = screen.getByRole('button', { name: 'Delete property priority' })
    await user.click(deleteBtn)

    // Verify invoke was called with delete_property
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
        blockId: 'BLOCK001',
        key: 'priority',
      })
    })

    // "priority" should be removed from the list
    await waitFor(() => {
      expect(screen.queryByText('priority')).not.toBeInTheDocument()
    })

    // "due" should still be present
    expect(screen.getByText('due')).toBeInTheDocument()
  })

  it('shows toast on failed delete property', async () => {
    const user = userEvent.setup()

    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'get_properties') return [makeProp({ key: 'priority', value_text: 'A' })]
      if (cmd === 'delete_property') throw new Error('fail')
      return null
    })

    render(<PropertiesPanel blockId="BLOCK001" />)

    expect(await screen.findByText('priority')).toBeInTheDocument()

    const deleteBtn = screen.getByRole('button', { name: 'Delete property priority' })
    await user.click(deleteBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete property')
    })

    // Property should NOT be removed from the list on failure
    expect(screen.getByText('priority')).toBeInTheDocument()
  })

  // -- Add property -----------------------------------------------------------

  it('"Add property" button shows the add form', async () => {
    const user = userEvent.setup()
    mockInvokeWith([])

    const { container } = render(<PropertiesPanel blockId="BLOCK001" />)

    // Wait for loading to finish
    await waitFor(() => {
      expect(container.querySelector('.properties-panel-loading')).not.toBeInTheDocument()
    })

    // Click "Add property" button
    const addPropertyBtn = screen.getByRole('button', { name: /Add property/i })
    await user.click(addPropertyBtn)

    // Form inputs should appear
    expect(screen.getByPlaceholderText('Key')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Value')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('add form calls set_property with key and value', async () => {
    const user = userEvent.setup()

    const updatedProperties = [
      makeProp({ key: 'priority', value_text: 'A' }),
      makeProp({ key: 'status', value_text: 'active' }),
    ]

    let getPropertiesCallCount = 0
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'get_properties') {
        getPropertiesCallCount++
        // First call returns initial list, subsequent calls return updated list
        return getPropertiesCallCount === 1
          ? [makeProp({ key: 'priority', value_text: 'A' })]
          : updatedProperties
      }
      if (cmd === 'set_property') return null
      if (cmd === 'delete_property') return null
      return null
    })

    render(<PropertiesPanel blockId="BLOCK001" />)

    // Wait for initial properties to load
    expect(await screen.findByText('priority')).toBeInTheDocument()

    // Open add form
    const addPropertyBtn = screen.getByRole('button', { name: /Add property/i })
    await user.click(addPropertyBtn)

    // Fill in key and value
    const keyInput = screen.getByPlaceholderText('Key')
    const valueInput = screen.getByPlaceholderText('Value')
    await user.type(keyInput, 'status')
    await user.type(valueInput, 'active')

    // Click Add
    const addBtn = screen.getByRole('button', { name: 'Add' })
    await user.click(addBtn)

    // Verify set_property was called
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'BLOCK001',
        key: 'status',
        valueText: 'active',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })

    // After adding, the form should be hidden and updated list fetched
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Key')).not.toBeInTheDocument()
    })

    // The new property should appear in the list
    expect(await screen.findByText('status')).toBeInTheDocument()
  })

  it('add form Cancel hides the form', async () => {
    const user = userEvent.setup()
    mockInvokeWith([])

    const { container } = render(<PropertiesPanel blockId="BLOCK001" />)

    // Wait for loading to finish
    await waitFor(() => {
      expect(container.querySelector('.properties-panel-loading')).not.toBeInTheDocument()
    })

    // Open add form
    const addPropertyBtn = screen.getByRole('button', { name: /Add property/i })
    await user.click(addPropertyBtn)

    // Verify form is visible
    expect(screen.getByPlaceholderText('Key')).toBeInTheDocument()

    // Click Cancel
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
    await user.click(cancelBtn)

    // Form should be gone
    expect(screen.queryByPlaceholderText('Key')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Value')).not.toBeInTheDocument()

    // "Add property" button should reappear
    expect(screen.getByRole('button', { name: /Add property/i })).toBeInTheDocument()
  })

  // -- Error handling ---------------------------------------------------------

  it('handles get_properties error gracefully', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'get_properties') throw new Error('backend error')
      return null
    })

    const { container } = render(<PropertiesPanel blockId="BLOCK001" />)

    // Should not crash and loading should clear
    await waitFor(() => {
      expect(container.querySelector('.properties-panel-loading')).not.toBeInTheDocument()
    })

    // Should show error toast
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load properties')
    })

    // Should show empty state since error results in no properties
    expect(screen.getByText('No properties set')).toBeInTheDocument()
  })

  it('shows toast on failed add property', async () => {
    const user = userEvent.setup()

    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'get_properties') return []
      if (cmd === 'set_property') throw new Error('fail')
      return null
    })

    const { container } = render(<PropertiesPanel blockId="BLOCK001" />)

    // Wait for loading to finish
    await waitFor(() => {
      expect(container.querySelector('.properties-panel-loading')).not.toBeInTheDocument()
    })

    // Open add form
    const addPropertyBtn = screen.getByRole('button', { name: /Add property/i })
    await user.click(addPropertyBtn)

    // Fill in key and value
    const keyInput = screen.getByPlaceholderText('Key')
    const valueInput = screen.getByPlaceholderText('Value')
    await user.type(keyInput, 'status')
    await user.type(valueInput, 'active')

    // Click Add
    const addBtn = screen.getByRole('button', { name: 'Add' })
    await user.click(addBtn)

    // Should show error toast
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to add property')
    })
  })

  // -- a11y -------------------------------------------------------------------

  // -- Keyboard hints & handlers -----------------------------------------------

  it('shows keyboard hint text when add form is visible', async () => {
    const user = userEvent.setup()
    mockInvokeWith([])

    const { container } = render(<PropertiesPanel blockId="BLOCK001" />)

    await waitFor(() => {
      expect(container.querySelector('.properties-panel-loading')).not.toBeInTheDocument()
    })

    const addPropertyBtn = screen.getByRole('button', { name: /Add property/i })
    await user.click(addPropertyBtn)

    expect(screen.getByText('Press Enter to add, Escape to cancel')).toBeInTheDocument()
  })

  it('Enter key in add form submits the form', async () => {
    const user = userEvent.setup()

    const updatedProperties = [makeProp({ key: 'status', value_text: 'active' })]

    let getPropertiesCallCount = 0
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'get_properties') {
        getPropertiesCallCount++
        return getPropertiesCallCount === 1 ? [] : updatedProperties
      }
      if (cmd === 'set_property') return null
      return null
    })

    const { container } = render(<PropertiesPanel blockId="BLOCK001" />)

    await waitFor(() => {
      expect(container.querySelector('.properties-panel-loading')).not.toBeInTheDocument()
    })

    const addPropertyBtn = screen.getByRole('button', { name: /Add property/i })
    await user.click(addPropertyBtn)

    const keyInput = screen.getByPlaceholderText('Key')
    const valueInput = screen.getByPlaceholderText('Value')
    await user.type(keyInput, 'status')
    await user.type(valueInput, 'active')

    fireEvent.keyDown(keyInput, { key: 'Enter' })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'set_property',
        expect.objectContaining({
          blockId: 'BLOCK001',
          key: 'status',
          valueText: 'active',
        }),
      )
    })
  })

  it('Escape key in add form cancels the form', async () => {
    const user = userEvent.setup()
    mockInvokeWith([])

    const { container } = render(<PropertiesPanel blockId="BLOCK001" />)

    await waitFor(() => {
      expect(container.querySelector('.properties-panel-loading')).not.toBeInTheDocument()
    })

    const addPropertyBtn = screen.getByRole('button', { name: /Add property/i })
    await user.click(addPropertyBtn)

    expect(screen.getByPlaceholderText('Key')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByPlaceholderText('Key'), { key: 'Escape' })

    expect(screen.queryByPlaceholderText('Key')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add property/i })).toBeInTheDocument()
  })

  it('has no a11y violations with properties', async () => {
    mockInvokeWith(mockProperties)

    const { container } = render(<PropertiesPanel blockId="BLOCK001" />)

    // Wait for properties to render
    await screen.findByText('priority')

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with null blockId', async () => {
    const { container } = render(<PropertiesPanel blockId={null} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
