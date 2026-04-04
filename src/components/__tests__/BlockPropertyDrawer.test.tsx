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
    return null
  })
}

beforeEach(() => {
  vi.clearAllMocks()
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
})
