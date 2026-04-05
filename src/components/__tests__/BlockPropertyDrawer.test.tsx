/**
 * Tests for BlockPropertyDrawer component.
 *
 * Validates:
 *  - Renders "Block Properties" title when open
 *  - Shows loading state initially
 *  - Shows property list after loading
 *  - Delete button calls deleteProperty
 *  - Has no a11y violations (axe audit)
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { StoreApi } from 'zustand'
import type { PropertyDefinition, PropertyRow as PropertyRowData } from '../../lib/tauri'
import { useBlockStore } from '../../stores/blocks'
import {
  createPageBlockStore,
  PageBlockContext,
  type PageBlockState,
} from '../../stores/page-blocks'

const mockedInvoke = vi.mocked(invoke)

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

vi.mock('@/components/ui/select', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')
  const Ctx = React.createContext({})

  function Select({ value, onValueChange, children, disabled }: any) {
    const triggerPropsRef = React.useRef({})
    return React.createElement(
      Ctx.Provider,
      { value: { value, onValueChange, triggerPropsRef, disabled } },
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
        disabled: ctx.disabled,
        'aria-label': tp['aria-label'],
        className: tp.className,
        'data-size': tp.size,
      },
      children,
    )
  }

  function SelectItem({ value, children }: any) {
    return React.createElement('option', { value }, children)
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

import { BlockPropertyDrawer, PropertyRow } from '../BlockPropertyDrawer'

let pageStore: StoreApi<PageBlockState>

/** Render a component wrapped in the per-page store provider. */
function renderWithProvider(ui: React.ReactElement) {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(PageBlockContext.Provider, { value: pageStore }, children)
  return render(ui, { wrapper })
}

function makeProp(key: string, overrides?: Partial<PropertyRowData>): PropertyRowData {
  return {
    key,
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    ...overrides,
  }
}

function makeDef(key: string, valueType = 'text'): PropertyDefinition {
  return {
    key,
    value_type: valueType,
    options: null,
    created_at: '2026-01-01T00:00:00Z',
  }
}

function setupMock(props: PropertyRowData[] = [], defs: PropertyDefinition[] = []) {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_properties') return props
    if (cmd === 'list_property_defs') return defs
    if (cmd === 'set_property') return undefined
    if (cmd === 'delete_property') return undefined
    if (cmd === 'set_due_date') return { id: 'BLOCK_1', block_type: 'content' }
    if (cmd === 'set_scheduled_date') return { id: 'BLOCK_1', block_type: 'content' }
    return null
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  pageStore = createPageBlockStore('PAGE_1')
  useBlockStore.setState({
    focusedBlockId: null,
    selectedBlockIds: [],
  })
})

describe('BlockPropertyDrawer', () => {
  it('renders "Block Properties" title when open', async () => {
    setupMock()
    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByText('Block Properties')).toBeInTheDocument()
  })

  it('shows loading state initially', () => {
    // Return a never-resolving promise to keep loading state
    mockedInvoke.mockReturnValue(new Promise(() => {}))
    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('shows property list after loading', async () => {
    const props = [
      makeProp('status', { value_text: 'active' }),
      makeProp('priority', { value_num: 1 }),
    ]
    setupMock(props, [makeDef('status'), makeDef('priority', 'number')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('status')).toBeInTheDocument()
    })
    expect(screen.getByText('priority')).toBeInTheDocument()
  })

  it('shows "No properties set" when block has no properties', async () => {
    setupMock([], [])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('No properties set')).toBeInTheDocument()
    })
  })

  it('delete button calls deleteProperty', async () => {
    const user = userEvent.setup()
    const props = [makeProp('status', { value_text: 'active' })]
    setupMock(props, [makeDef('status')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('status')).toBeInTheDocument()
    })

    const deleteBtn = screen.getByRole('button', { name: 'Delete property' })
    await user.click(deleteBtn)

    expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
      blockId: 'BLOCK_1',
      key: 'status',
    })
  })

  it('does not render content when open=false', () => {
    setupMock()
    renderWithProvider(
      <BlockPropertyDrawer blockId="BLOCK_1" open={false} onOpenChange={vi.fn()} />,
    )

    expect(screen.queryByText('Block Properties')).not.toBeInTheDocument()
  })

  it('drawer body section has horizontal padding for consistent spacing', async () => {
    const props = [makeProp('status', { value_text: 'active' })]
    setupMock(props, [makeDef('status')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('status')).toBeInTheDocument()
    })

    // The body container wraps property rows; verify it carries px-4 for padding
    const statusEl = screen.getByText('status')
    // The body div is the grandparent: body > row > span
    const bodyDiv = statusEl.closest('.space-y-3')
    expect(bodyDiv).not.toBeNull()
    expect(bodyDiv).toHaveClass('px-4')
  })

  it('wraps content in a ScrollArea for overflow scrolling', async () => {
    const props = [makeProp('status', { value_text: 'active' })]
    setupMock(props, [makeDef('status')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('status')).toBeInTheDocument()
    })

    // ScrollArea renders with data-slot="scroll-area"
    const scrollArea = document.querySelector('[data-slot="scroll-area"]')
    expect(scrollArea).toBeInTheDocument()

    // The content div should be inside the scroll area
    const statusEl = screen.getByText('status')
    const bodyDiv = statusEl.closest('.space-y-3')
    expect(bodyDiv).not.toBeNull()
    expect(scrollArea?.contains(bodyDiv)).toBe(true)
  })

  it('has no a11y violations when open with properties', async () => {
    const props = [makeProp('status', { value_text: 'active' })]
    setupMock(props, [makeDef('status')])

    const { container } = renderWithProvider(
      <BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />,
    )

    await waitFor(() => {
      expect(screen.getByText('status')).toBeInTheDocument()
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // ── H-12: Built-in date fields from block store ───────────────────────

  it('shows due_date from the block store', async () => {
    pageStore.setState({
      blocks: [
        {
          id: 'BLOCK_1',
          block_type: 'content',
          content: 'test',
          parent_id: 'PAGE_1',
          position: 0,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: '2026-06-15',
          scheduled_date: null,
          depth: 0,
        },
      ],
    })
    setupMock()

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTitle('Due')).toBeInTheDocument()
    })
    const dateInput = screen.getByDisplayValue('2026-06-15')
    expect(dateInput).toBeInTheDocument()
  })

  it('shows scheduled_date from the block store', async () => {
    pageStore.setState({
      blocks: [
        {
          id: 'BLOCK_1',
          block_type: 'content',
          content: 'test',
          parent_id: 'PAGE_1',
          position: 0,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: '2026-07-01',
          depth: 0,
        },
      ],
    })
    setupMock()

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTitle('Scheduled')).toBeInTheDocument()
    })
    const dateInput = screen.getByDisplayValue('2026-07-01')
    expect(dateInput).toBeInTheDocument()
  })

  it('does not show "No properties set" when block has built-in dates', async () => {
    pageStore.setState({
      blocks: [
        {
          id: 'BLOCK_1',
          block_type: 'content',
          content: 'test',
          parent_id: 'PAGE_1',
          position: 0,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: '2026-06-15',
          scheduled_date: null,
          depth: 0,
        },
      ],
    })
    setupMock([], [])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTitle('Due')).toBeInTheDocument()
    })
    expect(screen.queryByText('No properties set')).not.toBeInTheDocument()
  })

  it('clear due date button calls set_due_date with null', async () => {
    const user = userEvent.setup()
    pageStore.setState({
      blocks: [
        {
          id: 'BLOCK_1',
          block_type: 'content',
          content: 'test',
          parent_id: 'PAGE_1',
          position: 0,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: '2026-06-15',
          scheduled_date: null,
          depth: 0,
        },
      ],
    })
    setupMock()

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTitle('Due')).toBeInTheDocument()
    })

    const clearBtn = screen.getByRole('button', { name: 'Clear due date' })
    await user.click(clearBtn)

    expect(mockedInvoke).toHaveBeenCalledWith('set_due_date', {
      blockId: 'BLOCK_1',
      date: null,
    })
  })

  it('updates reactively when block store due_date changes', async () => {
    pageStore.setState({
      blocks: [
        {
          id: 'BLOCK_1',
          block_type: 'content',
          content: 'test',
          parent_id: 'PAGE_1',
          position: 0,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          depth: 0,
        },
      ],
    })
    setupMock()

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    // Initially no date shown
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
    })
    expect(screen.queryByTitle('Due')).not.toBeInTheDocument()

    // Simulate toolbar setting a due date
    pageStore.setState((s) => ({
      blocks: s.blocks.map((b) => (b.id === 'BLOCK_1' ? { ...b, due_date: '2026-08-20' } : b)),
    }))

    await waitFor(() => {
      expect(screen.getByTitle('Due')).toBeInTheDocument()
    })
    expect(screen.getByDisplayValue('2026-08-20')).toBeInTheDocument()
  })

  it('property value inputs have accessible labels', async () => {
    setupMock([makeProp('status', { value_text: 'active' })], [makeDef('status')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    const input = await screen.findByLabelText('status value')
    expect(input).toBeInTheDocument()
  })

  it('does not show delete button for built-in properties', async () => {
    const props = [makeProp('created_at', { value_text: '2026-01-01' })]
    setupMock(props, [makeDef('created_at')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Created At')).toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: 'Delete property' })).not.toBeInTheDocument()
  })

  it('shows delete button for custom properties', async () => {
    const props = [makeProp('my_custom', { value_text: 'hello' })]
    setupMock(props, [makeDef('my_custom')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('my_custom')).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: 'Delete property' })).toBeInTheDocument()
  })

  it('does not show delete button for repeat properties', async () => {
    const props = [makeProp('repeat', { value_text: '+1w' })]
    setupMock(props, [makeDef('repeat')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Repeat')).toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: 'Delete property' })).not.toBeInTheDocument()
  })

  // ── UX-H1: Consistent built-in property rendering ────────────────────

  it('renders built-in property (created_at) with icon and formatted name', async () => {
    const props = [makeProp('created_at', { value_text: '2026-01-01' })]
    setupMock(props, [makeDef('created_at')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Created At')).toBeInTheDocument()
    })

    // Badge should have the formatted name as title
    const badge = screen.getByTitle('Created At')
    expect(badge).toBeInTheDocument()

    // Badge should have icon styling (flex items-center gap-1) and NOT font-mono
    expect(badge).toHaveClass('flex', 'items-center', 'gap-1')
    expect(badge).not.toHaveClass('font-mono')

    // Should contain an SVG icon
    const svg = badge.querySelector('svg')
    expect(svg).toBeInTheDocument()
  })

  it('renders built-in property (effort) with icon and formatted name', async () => {
    const props = [makeProp('effort', { value_num: 30 })]
    setupMock(props, [makeDef('effort', 'number')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Effort')).toBeInTheDocument()
    })

    const badge = screen.getByTitle('Effort')
    expect(badge).toHaveClass('flex', 'items-center', 'gap-1')
    expect(badge).not.toHaveClass('font-mono')

    const svg = badge.querySelector('svg')
    expect(svg).toBeInTheDocument()
  })

  it('renders custom properties with font-mono and raw key', async () => {
    const props = [makeProp('my_custom', { value_text: 'hello' })]
    setupMock(props, [makeDef('my_custom')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('my_custom')).toBeInTheDocument()
    })

    // Custom properties keep font-mono and raw key as title
    const badge = screen.getByTitle('my_custom')
    expect(badge).toHaveClass('font-mono')

    // No icon for custom properties
    const svg = badge.querySelector('svg')
    expect(svg).not.toBeInTheDocument()
  })
})

// ── PropertyRow unit tests ──────────────────────────────────────────────

describe('PropertyRow', () => {
  it('renders label and value', () => {
    render(<PropertyRow label="Status" value="active" ariaLabel="Status value" onSave={vi.fn()} />)

    expect(screen.getByTitle('Status')).toBeInTheDocument()
    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByDisplayValue('active')).toBeInTheDocument()
  })

  it('calls onSave when input is blurred', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<PropertyRow label="Name" value="" ariaLabel="Name value" onSave={onSave} />)

    const input = screen.getByLabelText('Name value')
    await user.click(input)
    await user.type(input, 'hello')
    await user.tab()

    expect(onSave).toHaveBeenCalledWith('hello')
  })

  it('calls onSave via Enter key', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<PropertyRow label="Name" value="" ariaLabel="Name value" onSave={onSave} />)

    const input = screen.getByLabelText('Name value')
    await user.click(input)
    await user.type(input, 'world')
    await user.keyboard('{Enter}')

    expect(onSave).toHaveBeenCalledWith('world')
  })

  it('calls onRemove when X button is clicked', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(
      <PropertyRow
        label="Tag"
        value="v1"
        ariaLabel="Tag value"
        onSave={vi.fn()}
        onRemove={onRemove}
        removeAriaLabel="Remove tag"
      />,
    )

    const removeBtn = screen.getByRole('button', { name: 'Remove tag' })
    await user.click(removeBtn)

    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('does not render X button when onRemove is not provided', () => {
    render(
      <PropertyRow label="ReadOnly" value="locked" ariaLabel="ReadOnly value" onSave={vi.fn()} />,
    )

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders a date input when inputType is "date"', () => {
    render(
      <PropertyRow
        label="Due"
        value="2026-06-15"
        inputType="date"
        ariaLabel="Due value"
        onSave={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Due value')
    expect(input).toHaveAttribute('type', 'date')
    expect(input).toHaveValue('2026-06-15')
  })

  it('renders a text input by default', () => {
    render(<PropertyRow label="Note" value="some text" ariaLabel="Note value" onSave={vi.fn()} />)

    const input = screen.getByLabelText('Note value')
    // When no type is specified, the input defaults to text
    expect(input).not.toHaveAttribute('type', 'date')
    expect(input).toHaveValue('some text')
  })

  it('shows icon styling when icon is provided', () => {
    // Use a simple SVG component as a stand-in for a LucideIcon
    const FakeIcon = ({ size }: { size: number }) => (
      <svg data-testid="fake-icon" width={size} height={size} />
    )
    render(
      <PropertyRow
        icon={FakeIcon as unknown as import('lucide-react').LucideIcon}
        label="Due Date"
        value="2026-01-01"
        ariaLabel="Due Date value"
        onSave={vi.fn()}
      />,
    )

    const badge = screen.getByTitle('Due Date')
    expect(badge).toHaveClass('flex', 'items-center', 'gap-1')
    expect(badge).not.toHaveClass('font-mono')
    expect(badge.querySelector('svg')).toBeInTheDocument()
  })

  it('shows font-mono styling when no icon is provided', () => {
    render(
      <PropertyRow label="custom_key" value="val" ariaLabel="custom_key value" onSave={vi.fn()} />,
    )

    const badge = screen.getByTitle('custom_key')
    expect(badge).toHaveClass('font-mono')
    expect(badge.querySelector('svg')).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <PropertyRow
        label="Status"
        value="active"
        ariaLabel="Status value"
        onSave={vi.fn()}
        onRemove={vi.fn()}
        removeAriaLabel="Remove status"
      />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
