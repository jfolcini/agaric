/**
 * Tests for PagePropertyTable component.
 *
 * Validates:
 *  - Rendering: collapsed default, expand toggle, loading skeletons, property count
 *  - Property display: text, number, date, select inputs
 *  - Property editing: blur save, select change, delete
 *  - Add property flow: popover, search, add from def, create def
 *  - Error handling: load error, save error
 *  - Accessibility compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { PropertyDefinition, PropertyRow } from '../../lib/tauri'

const mockedInvoke = vi.mocked(invoke)

vi.mock('lucide-react', () => ({
  CalendarCheck2: () => <svg data-testid="calendar-check2-icon" />,
  CalendarClock: () => <svg data-testid="calendar-clock-icon" />,
  CalendarPlus: () => <svg data-testid="calendar-plus-icon" />,
  CheckCircle2: () => <svg data-testid="check-circle2-icon" />,
  ChevronDown: () => <svg data-testid="chevron-down" />,
  ChevronRight: () => <svg data-testid="chevron-right" />,
  Clock: () => <svg data-testid="clock-icon" />,
  MapPin: () => <svg data-testid="map-pin-icon" />,
  Pencil: () => <svg data-testid="pencil-icon" />,
  Plus: () => <svg data-testid="plus-icon" />,
  Repeat: () => <svg data-testid="repeat-icon" />,
  User: () => <svg data-testid="user-icon" />,
  X: () => <svg data-testid="x-icon" />,
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

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

import { toast } from 'sonner'
import { PagePropertyTable } from '../PagePropertyTable'

const mockedToastError = vi.mocked(toast.error)

function makeDef(key: string, valueType: string, options?: string): PropertyDefinition {
  return {
    key,
    value_type: valueType,
    options: options ?? null,
    created_at: '2026-01-01T00:00:00Z',
  }
}

function makeProp(key: string, overrides?: Partial<PropertyRow>): PropertyRow {
  return {
    key,
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

/** Standard mock: returns given properties and definitions for relevant commands. */
function setupMock(props: PropertyRow[] = [], defs: PropertyDefinition[] = []) {
  mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
    if (cmd === 'get_properties') return props
    if (cmd === 'list_property_defs') return defs
    if (cmd === 'set_property') return undefined
    if (cmd === 'delete_property') return undefined
    if (cmd === 'create_property_def') {
      return makeDef(args?.key ?? 'new', args?.valueType ?? 'text')
    }
    if (cmd === 'update_property_def_options') {
      const d = defs.find((def) => def.key === args?.key)
      return { ...d, key: args?.key, options: args?.options }
    }
    // PageHeader also calls these in integration
    if (cmd === 'list_blocks') return { items: [], next_cursor: null, has_more: false }
    if (cmd === 'list_tags_for_block') return []
    return null
  })
}

describe('PagePropertyTable rendering', () => {
  it('does not render when no properties and not forced', async () => {
    setupMock()
    const { container } = render(<PagePropertyTable pageId="PAGE_1" />)

    // Flush pending async data loading so the component can settle
    await act(async () => {})

    // After loading completes with empty properties, component returns null
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Properties/ })).not.toBeInTheDocument()
      expect(container.querySelector('.page-property-table')).not.toBeInTheDocument()
    })
  })

  it('renders collapsed by default with toggle button when properties exist', async () => {
    setupMock([makeProp('status', { value_text: 'active' })], [makeDef('status', 'text')])
    render(<PagePropertyTable pageId="PAGE_1" />)

    await waitFor(() => {
      const toggle = screen.getByRole('button', { name: /^Properties/ })
      expect(toggle).toBeInTheDocument()
      expect(toggle).toHaveTextContent('Properties')
    })
    // Should not show any property rows when collapsed
    expect(screen.queryByLabelText(/value$/i)).not.toBeInTheDocument()
  })

  it('expands to show property rows after clicking toggle', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('status', { value_text: 'active' })], [makeDef('status', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" />)

    const toggle = screen.getByRole('button', { name: /^Properties/ })
    await user.click(toggle)

    await waitFor(() => {
      expect(screen.getByLabelText('status value')).toBeInTheDocument()
    })
  })

  it('shows loading skeletons while data loads', async () => {
    // Never-resolving promise to simulate loading
    mockedInvoke.mockImplementation(() => new Promise(() => {}))

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByTestId('property-loading')).toBeInTheDocument()
    })
  })

  it('renders property count in toggle label', async () => {
    setupMock(
      [makeProp('status', { value_text: 'active' }), makeProp('priority', { value_num: 1 })],
      [makeDef('status', 'text'), makeDef('priority', 'number')],
    )

    render(<PagePropertyTable pageId="PAGE_1" />)

    await waitFor(() => {
      const toggle = screen.getByRole('button', { name: /^Properties/ })
      expect(toggle).toHaveTextContent('Properties (2)')
    })
  })
})

describe('PagePropertyTable property display', () => {
  it('text property renders as text input with correct value', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      const input = screen.getByLabelText('author value') as HTMLInputElement
      expect(input).toBeInTheDocument()
      expect(input.type).toBe('text')
      expect(input.value).toBe('Alice')
    })
  })

  it('number property renders as number input', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('priority', { value_num: 42 })], [makeDef('priority', 'number')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      const input = screen.getByLabelText('priority value') as HTMLInputElement
      expect(input.type).toBe('number')
      expect(input.value).toBe('42')
    })
  })

  it('date property renders as date input', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('due', { value_date: '2026-06-15' })], [makeDef('due', 'date')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      const input = screen.getByLabelText('due value') as HTMLInputElement
      expect(input.type).toBe('date')
      expect(input.value).toBe('2026-06-15')
    })
  })

  it('select property renders as dropdown with options', async () => {
    const user = userEvent.setup()
    setupMock(
      [makeProp('stage', { value_text: 'DOING' })],
      [makeDef('stage', 'select', '["TODO","DOING","DONE"]')],
    )

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      const select = screen.getByLabelText('stage value') as HTMLSelectElement
      expect(select.tagName).toBe('SELECT')
      expect(select.value).toBe('DOING')
      // Check options
      const opts = Array.from(select.options).map((o) => o.value)
      expect(opts).toContain('TODO')
      expect(opts).toContain('DOING')
      expect(opts).toContain('DONE')
    })
  })
})

describe('PagePropertyTable property editing', () => {
  it('text input saves value on blur via setProperty', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('author value')).toBeInTheDocument()
    })

    const input = screen.getByLabelText('author value') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'Bob')
    await user.tab()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'PAGE_1',
        key: 'author',
        valueText: 'Bob',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('number input saves on blur', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('priority', { value_num: 1 })], [makeDef('priority', 'number')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('priority value')).toBeInTheDocument()
    })

    const input = screen.getByLabelText('priority value') as HTMLInputElement
    await user.clear(input)
    await user.type(input, '99')
    await user.tab()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'PAGE_1',
        key: 'priority',
        valueNum: 99,
        valueText: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('select dropdown saves on change', async () => {
    const user = userEvent.setup()
    setupMock(
      [makeProp('stage', { value_text: 'TODO' })],
      [makeDef('stage', 'select', '["TODO","DOING","DONE"]')],
    )

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('stage value')).toBeInTheDocument()
    })

    const select = screen.getByLabelText('stage value') as HTMLSelectElement
    await user.selectOptions(select, 'DONE')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'PAGE_1',
        key: 'stage',
        valueText: 'DONE',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('delete button calls deleteProperty after confirmation', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('Delete property author')).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText('Delete property author'))

    // Confirmation dialog should appear
    await waitFor(() => {
      expect(screen.getByText(/Delete this property\?/i)).toBeInTheDocument()
    })

    // Confirm deletion
    await user.click(screen.getByRole('button', { name: /^Delete$/i }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
        blockId: 'PAGE_1',
        key: 'author',
      })
    })
  })
})

describe('PagePropertyTable add property flow', () => {
  it('"Add property" opens popover with definition list', async () => {
    setupMock([], [makeDef('status', 'text'), makeDef('priority', 'number')])

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByLabelText('Property picker')).toBeInTheDocument()
      expect(screen.getByText('Status')).toBeInTheDocument()
      expect(screen.getByText('Priority')).toBeInTheDocument()
    })
  })

  it('search filters definitions', async () => {
    const user = userEvent.setup()
    setupMock([], [makeDef('status', 'text'), makeDef('priority', 'number')])

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByLabelText('Search definitions')).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText('Search definitions'), 'stat')

    await waitFor(() => {
      expect(screen.getByText('Status')).toBeInTheDocument()
      expect(screen.queryByText('Priority')).not.toBeInTheDocument()
    })
  })

  it('clicking a definition adds the property', async () => {
    const user = userEvent.setup()
    setupMock([], [makeDef('status', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByText('Status')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Status'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'PAGE_1',
        key: 'status',
        valueText: '',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('"Create definition" flow: creates def then adds property', async () => {
    const user = userEvent.setup()
    // Start with no definitions so "Create" button appears
    const props: PropertyRow[] = []
    const defs: PropertyDefinition[] = []

    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_properties') return [...props]
      if (cmd === 'list_property_defs') return [...defs]
      if (cmd === 'create_property_def') {
        const newDef = makeDef(args?.key, args?.valueType)
        defs.push(newDef)
        return newDef
      }
      if (cmd === 'set_property') return undefined
      if (cmd === 'list_blocks') return { items: [], next_cursor: null, has_more: false }
      if (cmd === 'list_tags_for_block') return []
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByLabelText('Search definitions')).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText('Search definitions'), 'newfield')

    // Click the "Create" prompt
    await waitFor(() => {
      expect(screen.getByText(/Create "newfield"/)).toBeInTheDocument()
    })
    await user.click(screen.getByText(/Create "newfield"/))

    // Should show type selector
    await waitFor(() => {
      expect(screen.getByLabelText('Value type')).toBeInTheDocument()
    })

    // Click "Create definition" button
    await user.click(screen.getByRole('button', { name: /create definition/i }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_property_def', {
        key: 'newfield',
        valueType: 'text',
        options: null,
      })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'PAGE_1',
        key: 'newfield',
        valueText: '',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })
  it('shows ref option in the property type dropdown', async () => {
    const user = userEvent.setup()
    const props: PropertyRow[] = []
    const defs: PropertyDefinition[] = []

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_properties') return [...props]
      if (cmd === 'list_property_defs') return [...defs]
      if (cmd === 'list_blocks') return { items: [], next_cursor: null, has_more: false }
      if (cmd === 'list_tags_for_block') return []
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByLabelText('Search definitions')).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText('Search definitions'), 'myref')

    await waitFor(() => {
      expect(screen.getByText(/Create "myref"/)).toBeInTheDocument()
    })
    await user.click(screen.getByText(/Create "myref"/))

    await waitFor(() => {
      expect(screen.getByLabelText('Value type')).toBeInTheDocument()
    })

    const select = screen.getByLabelText('Value type') as HTMLSelectElement
    const opts = Array.from(select.options).map((o) => o.value)
    expect(opts).toContain('ref')
  })

  it('displays formatted property names in the add-property popover', async () => {
    setupMock([], [makeDef('created_at', 'date'), makeDef('my_custom_prop', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByText('Created At')).toBeInTheDocument()
      expect(screen.getByText('My Custom Prop')).toBeInTheDocument()
      // Raw keys should NOT appear
      expect(screen.queryByText('created_at')).not.toBeInTheDocument()
      expect(screen.queryByText('my_custom_prop')).not.toBeInTheDocument()
    })
  })
})

describe('PagePropertyTable error handling', () => {
  it('load error shows toast', async () => {
    mockedInvoke.mockImplementation(async () => {
      throw new Error('backend error')
    })

    render(<PagePropertyTable pageId="PAGE_1" />)

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to load properties')
    })
  })

  it('save error shows toast', async () => {
    const user = userEvent.setup()
    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_properties') return [makeProp('author', { value_text: 'Alice' })]
      if (cmd === 'list_property_defs') return [makeDef('author', 'text')]
      if (cmd === 'set_property') {
        callCount++
        if (callCount >= 1) throw new Error('save failed')
      }
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('author value')).toBeInTheDocument()
    })

    const input = screen.getByLabelText('author value') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'Bob')
    await user.tab()

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to save property')
    })
  })
})

describe('PagePropertyTable accessibility', () => {
  it('collapsed state has no a11y violations', async () => {
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])

    const { container } = render(<PagePropertyTable pageId="PAGE_1" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Properties/ })).toBeInTheDocument()
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('expanded state has no a11y violations', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])

    const { container } = render(<PagePropertyTable pageId="PAGE_1" />)

    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('author value')).toBeInTheDocument()
    })

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

describe('PagePropertyTable validation and confirmation', () => {
  it('shows error toast when invalid number is entered', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('priority', { value_num: 1 })], [makeDef('priority', 'number')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('priority value')).toBeInTheDocument()
    })

    const input = screen.getByLabelText('priority value') as HTMLInputElement
    // Override the value property to bypass jsdom's number-input sanitization
    // (jsdom rejects non-numeric characters on type="number" inputs)
    Object.defineProperty(input, 'value', {
      value: 'abc',
      writable: true,
      configurable: true,
    })
    fireEvent.change(input)
    fireEvent.blur(input)

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Invalid number value')
    })
  })

  it('shows confirmation dialog before deleting property', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('Delete property author')).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText('Delete property author'))

    await waitFor(() => {
      expect(screen.getByText(/Delete this property\?/i)).toBeInTheDocument()
      expect(
        screen.getByText(/This will remove the property from the block\./i),
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Delete$/i })).toBeInTheDocument()
    })
  })

  it('does not delete until confirmation', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('Delete property author')).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText('Delete property author'))

    // Dialog should be open
    await waitFor(() => {
      expect(screen.getByText(/Delete this property\?/i)).toBeInTheDocument()
    })

    // deleteProperty should NOT have been called yet
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_property', expect.anything())

    // Cancel the dialog
    await user.click(screen.getByRole('button', { name: /Cancel/i }))

    // Dialog should be closed and deleteProperty still not called
    await waitFor(() => {
      expect(screen.queryByText(/Delete this property\?/i)).not.toBeInTheDocument()
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_property', expect.anything())
  })
})

describe('PagePropertyTable edit select options', () => {
  it('shows edit options (pencil) button for select properties', async () => {
    const user = userEvent.setup()
    setupMock(
      [makeProp('stage', { value_text: 'TODO' })],
      [makeDef('stage', 'select', '["TODO","DOING","DONE"]')],
    )

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('Edit options for stage')).toBeInTheDocument()
    })
  })

  it('does not show edit options button for non-select properties', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('author value')).toBeInTheDocument()
    })
    expect(screen.queryByLabelText(/Edit options for/)).not.toBeInTheDocument()
  })

  it('opens popover with current options listed', async () => {
    const user = userEvent.setup()
    setupMock(
      [makeProp('stage', { value_text: 'TODO' })],
      [makeDef('stage', 'select', '["TODO","DOING","DONE"]')],
    )

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('Edit options for stage')).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText('Edit options for stage'))

    await waitFor(() => {
      expect(screen.getByLabelText('New option value')).toBeInTheDocument()
      // All three options should be listed in the popover
      expect(screen.getByLabelText('Remove option TODO')).toBeInTheDocument()
      expect(screen.getByLabelText('Remove option DOING')).toBeInTheDocument()
      expect(screen.getByLabelText('Remove option DONE')).toBeInTheDocument()
    })
  })

  it('can add a new option and save', async () => {
    const user = userEvent.setup()
    setupMock(
      [makeProp('stage', { value_text: 'TODO' })],
      [makeDef('stage', 'select', '["TODO","DOING"]')],
    )

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('Edit options for stage')).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText('Edit options for stage'))

    await waitFor(() => {
      expect(screen.getByLabelText('New option value')).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText('New option value'), 'DONE')
    await user.click(screen.getByLabelText('Add option'))

    // Click Save
    await user.click(screen.getByRole('button', { name: /save options/i }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('update_property_def_options', {
        key: 'stage',
        options: '["TODO","DOING","DONE"]',
      })
    })
  })

  it('can remove an option and save', async () => {
    const user = userEvent.setup()
    setupMock(
      [makeProp('stage', { value_text: 'TODO' })],
      [makeDef('stage', 'select', '["TODO","DOING","DONE"]')],
    )

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('Edit options for stage')).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText('Edit options for stage'))

    await waitFor(() => {
      expect(screen.getByLabelText('Remove option DOING')).toBeInTheDocument()
    })

    // Remove "DOING"
    await user.click(screen.getByLabelText('Remove option DOING'))

    // Click Save
    await user.click(screen.getByRole('button', { name: /save options/i }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('update_property_def_options', {
        key: 'stage',
        options: '["TODO","DONE"]',
      })
    })
  })

  it('shows error toast when save fails', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_properties') return [makeProp('stage', { value_text: 'TODO' })]
      if (cmd === 'list_property_defs') return [makeDef('stage', 'select', '["TODO","DOING"]')]
      if (cmd === 'update_property_def_options') throw new Error('backend error')
      if (cmd === 'list_blocks') return { items: [], next_cursor: null, has_more: false }
      if (cmd === 'list_tags_for_block') return []
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /^Properties/ }))

    await waitFor(() => {
      expect(screen.getByLabelText('Edit options for stage')).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText('Edit options for stage'))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save options/i })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /save options/i }))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to update options')
    })
  })
})

describe('PagePropertyTable task-only property filtering', () => {
  it('filters out task-only properties from add-property options', async () => {
    setupMock(
      [],
      [
        makeDef('effort', 'number'),
        makeDef('assignee', 'text'),
        makeDef('location', 'text'),
        makeDef('due_date', 'date'),
        makeDef('custom_prop', 'text'),
      ],
    )

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByLabelText('Property picker')).toBeInTheDocument()
    })

    expect(screen.queryByText('Effort')).not.toBeInTheDocument()
    expect(screen.queryByText('Assignee')).not.toBeInTheDocument()
    expect(screen.queryByText('Location')).not.toBeInTheDocument()
    expect(screen.getByText('Due Date')).toBeInTheDocument()
    expect(screen.getByText('Custom Prop')).toBeInTheDocument()
  })
})

describe('PagePropertyTable forceExpanded', () => {
  it('renders and auto-expands when forceExpanded is true', async () => {
    setupMock([], [makeDef('status', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    // Should render even with no properties
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Properties/ })).toBeInTheDocument()
    })

    // Should auto-expand and open add-property popover
    await waitFor(() => {
      expect(screen.getByLabelText('Property picker')).toBeInTheDocument()
    })
  })

  it('does not render when no properties and forceExpanded is false', async () => {
    setupMock()
    render(<PagePropertyTable pageId="PAGE_1" />)

    // Wait for loading to finish before asserting absence
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Properties/ })).not.toBeInTheDocument()
    })
  })

  it('renders when properties exist without forceExpanded', async () => {
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])
    render(<PagePropertyTable pageId="PAGE_1" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Properties/ })).toBeInTheDocument()
    })
  })
})
