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
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { PropertyDefinition, PropertyRow } from '../../lib/tauri'
import { useBlockStore } from '../../stores/blocks'

const mockedInvoke = vi.mocked(invoke)

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

import { BlockPropertyDrawer } from '../BlockPropertyDrawer'

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

function makeDef(key: string, valueType = 'text'): PropertyDefinition {
  return {
    key,
    value_type: valueType,
    options: null,
    created_at: '2026-01-01T00:00:00Z',
  }
}

function setupMock(props: PropertyRow[] = [], defs: PropertyDefinition[] = []) {
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
  useBlockStore.setState({
    blocks: [],
    rootParentId: null,
    focusedBlockId: null,
    loading: false,
    selectedBlockIds: [],
  })
})

describe('BlockPropertyDrawer', () => {
  it('renders "Block Properties" title when open', async () => {
    setupMock()
    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByText('Block Properties')).toBeInTheDocument()
  })

  it('shows loading state initially', () => {
    // Return a never-resolving promise to keep loading state
    mockedInvoke.mockReturnValue(new Promise(() => {}))
    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('shows property list after loading', async () => {
    const props = [
      makeProp('status', { value_text: 'active' }),
      makeProp('priority', { value_num: 1 }),
    ]
    setupMock(props, [makeDef('status'), makeDef('priority', 'number')])

    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('status')).toBeInTheDocument()
    })
    expect(screen.getByText('priority')).toBeInTheDocument()
  })

  it('shows "No properties set" when block has no properties', async () => {
    setupMock([], [])

    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('No properties set')).toBeInTheDocument()
    })
  })

  it('delete button calls deleteProperty', async () => {
    const user = userEvent.setup()
    const props = [makeProp('status', { value_text: 'active' })]
    setupMock(props, [makeDef('status')])

    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

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
    render(<BlockPropertyDrawer blockId="BLOCK_1" open={false} onOpenChange={vi.fn()} />)

    expect(screen.queryByText('Block Properties')).not.toBeInTheDocument()
  })

  it('drawer body section has horizontal padding for consistent spacing', async () => {
    const props = [makeProp('status', { value_text: 'active' })]
    setupMock(props, [makeDef('status')])

    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

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

  it('has no a11y violations when open with properties', async () => {
    const props = [makeProp('status', { value_text: 'active' })]
    setupMock(props, [makeDef('status')])

    const { container } = render(
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
    useBlockStore.setState({
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

    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTitle('Due')).toBeInTheDocument()
    })
    const dateInput = screen.getByDisplayValue('2026-06-15')
    expect(dateInput).toBeInTheDocument()
  })

  it('shows scheduled_date from the block store', async () => {
    useBlockStore.setState({
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

    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTitle('Scheduled')).toBeInTheDocument()
    })
    const dateInput = screen.getByDisplayValue('2026-07-01')
    expect(dateInput).toBeInTheDocument()
  })

  it('does not show "No properties set" when block has built-in dates', async () => {
    useBlockStore.setState({
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

    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTitle('Due')).toBeInTheDocument()
    })
    expect(screen.queryByText('No properties set')).not.toBeInTheDocument()
  })

  it('clear due date button calls set_due_date with null', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({
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

    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

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
    useBlockStore.setState({
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

    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    // Initially no date shown
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
    })
    expect(screen.queryByTitle('Due')).not.toBeInTheDocument()

    // Simulate toolbar setting a due date
    useBlockStore.setState((s) => ({
      blocks: s.blocks.map((b) => (b.id === 'BLOCK_1' ? { ...b, due_date: '2026-08-20' } : b)),
    }))

    await waitFor(() => {
      expect(screen.getByTitle('Due')).toBeInTheDocument()
    })
    expect(screen.getByDisplayValue('2026-08-20')).toBeInTheDocument()
  })

  it('property value inputs have accessible labels', async () => {
    setupMock([makeProp('status', { value_text: 'active' })], [makeDef('status')])

    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    const input = await screen.findByLabelText('status value')
    expect(input).toBeInTheDocument()
  })

  it('does not show delete button for built-in properties', async () => {
    const props = [makeProp('created_at', { value_text: '2026-01-01' })]
    setupMock(props, [makeDef('created_at')])

    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('created_at')).toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: 'Delete property' })).not.toBeInTheDocument()
  })

  it('shows delete button for custom properties', async () => {
    const props = [makeProp('my_custom', { value_text: 'hello' })]
    setupMock(props, [makeDef('my_custom')])

    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('my_custom')).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: 'Delete property' })).toBeInTheDocument()
  })

  it('does not show delete button for repeat properties', async () => {
    const props = [makeProp('repeat', { value_text: '+1w' })]
    setupMock(props, [makeDef('repeat')])

    render(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('repeat')).toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: 'Delete property' })).not.toBeInTheDocument()
  })
})
