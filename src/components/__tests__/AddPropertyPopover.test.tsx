/**
 * Tests for AddPropertyPopover component.
 *
 * Validates:
 *  - Renders trigger button with correct label
 *  - Shows definition list in popover
 *  - Filters definitions by search
 *  - Calls onAdd when a definition is clicked
 *  - Shows "Create" button when search doesn't match (supportCreateDef)
 *  - Hides "Create" button when supportCreateDef is false
 *  - Shows type selector in create flow
 *  - Calls onCreateDef with key and type
 *  - Displays formatted property names
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { PropertyDefinition } from '../../lib/tauri'

vi.mock('lucide-react', () => ({
  CalendarCheck2: () => <svg data-testid="calendar-check2-icon" />,
  CalendarClock: () => <svg data-testid="calendar-clock-icon" />,
  CalendarPlus: () => <svg data-testid="calendar-plus-icon" />,
  CheckCircle2: () => <svg data-testid="check-circle2-icon" />,
  Clock: () => <svg data-testid="clock-icon" />,
  MapPin: () => <svg data-testid="map-pin-icon" />,
  Plus: () => <svg data-testid="plus-icon" />,
  Repeat: () => <svg data-testid="repeat-icon" />,
  User: () => <svg data-testid="user-icon" />,
}))

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

import { AddPropertyPopover } from '../AddPropertyPopover'

function makeDef(key: string, valueType = 'text'): PropertyDefinition {
  return {
    key,
    value_type: valueType,
    options: null,
    created_at: '2026-01-01T00:00:00Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AddPropertyPopover', () => {
  it('renders trigger button', () => {
    render(<AddPropertyPopover definitions={[]} onAdd={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Add property' })).toBeInTheDocument()
  })

  it('shows definition list when opened', async () => {
    const defs = [makeDef('status', 'text'), makeDef('priority', 'number')]
    render(<AddPropertyPopover definitions={defs} onAdd={vi.fn()} open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByLabelText('Property picker')).toBeInTheDocument()
      expect(screen.getByText('Status')).toBeInTheDocument()
      expect(screen.getByText('Priority')).toBeInTheDocument()
    })
  })

  it('filters definitions by search', async () => {
    const user = userEvent.setup()
    const defs = [makeDef('status', 'text'), makeDef('priority', 'number')]
    render(<AddPropertyPopover definitions={defs} onAdd={vi.fn()} open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByLabelText('Search definitions')).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText('Search definitions'), 'stat')

    await waitFor(() => {
      expect(screen.getByText('Status')).toBeInTheDocument()
      expect(screen.queryByText('Priority')).not.toBeInTheDocument()
    })
  })

  // UX-248 — Unicode-aware fold via `matchesSearchFolded`.
  it('search matches accented property key via diacritic fold', async () => {
    const user = userEvent.setup()
    const defs = [makeDef('café-visits', 'number'), makeDef('priority', 'number')]
    render(<AddPropertyPopover definitions={defs} onAdd={vi.fn()} open onOpenChange={vi.fn()} />)

    // `formatPropertyName('café-visits')` renders as `Café Visits`.
    await waitFor(() => {
      expect(screen.getByText('Café Visits')).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText('Search definitions'), 'cafe')

    await waitFor(() => {
      expect(screen.getByText('Café Visits')).toBeInTheDocument()
      expect(screen.queryByText('Priority')).not.toBeInTheDocument()
    })
  })

  // UX-248 — both the filter AND the "exists-exact-match" check must
  // agree on Unicode equivalence, otherwise the picker shows the match
  // and the "Create new" suggestion simultaneously when the user types
  // a diacritic-folded form of an existing key.
  it('does NOT show "Create new" suggestion when Unicode fold matches existing definition', async () => {
    const user = userEvent.setup()
    const defs = [makeDef('café-visits', 'number')]
    render(
      <AddPropertyPopover
        definitions={defs}
        onAdd={vi.fn()}
        supportCreateDef
        onCreateDef={vi.fn()}
        open
        onOpenChange={vi.fn()}
      />,
    )

    await user.type(screen.getByLabelText('Search definitions'), 'cafe-visits')

    await waitFor(() => {
      expect(screen.getByText('Café Visits')).toBeInTheDocument()
    })
    // The "Create new" prompt only appears when no existing def
    // matches.  Fold makes `cafe-visits` match `café-visits`, so the
    // create flow must stay hidden.
    expect(screen.queryByRole('button', { name: /create "cafe-visits"/i })).not.toBeInTheDocument()
  })

  it('calls onAdd when a definition is clicked', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn()
    const defs = [makeDef('status', 'text')]
    render(<AddPropertyPopover definitions={defs} onAdd={onAdd} open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Status')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Status'))

    expect(onAdd).toHaveBeenCalledWith(defs[0])
  })

  it('shows "Create" button when search does not match and supportCreateDef is true', async () => {
    const user = userEvent.setup()
    render(
      <AddPropertyPopover
        definitions={[]}
        onAdd={vi.fn()}
        supportCreateDef
        onCreateDef={vi.fn()}
        open
        onOpenChange={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByLabelText('Search definitions')).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText('Search definitions'), 'newfield')

    await waitFor(() => {
      expect(screen.getByText(/Create "newfield"/)).toBeInTheDocument()
    })
  })

  // UX-272 sub-fix 7 — surface the default value type next to the
  // "Create new" label so users know what they get when clicking.
  it('UX-272 sub-fix 7 — surfaces the default "(text)" hint on the Create new button', async () => {
    const user = userEvent.setup()
    render(
      <AddPropertyPopover
        definitions={[]}
        onAdd={vi.fn()}
        supportCreateDef
        onCreateDef={vi.fn()}
        open
        onOpenChange={vi.fn()}
      />,
    )

    await user.type(screen.getByLabelText('Search definitions'), 'myfield')

    const hint = await screen.findByTestId('create-new-type-hint')
    expect(hint).toHaveTextContent('(text)')

    // The hint sits on the Create new button as a sibling of the label
    const createBtn = screen.getByText(/Create "myfield"/).closest('button')
    expect(createBtn).not.toBeNull()
    expect(createBtn).toContainElement(hint)
  })

  it('does NOT show "Create" button when supportCreateDef is false', async () => {
    const user = userEvent.setup()
    render(<AddPropertyPopover definitions={[]} onAdd={vi.fn()} open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByLabelText('Search definitions')).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText('Search definitions'), 'newfield')

    // Wait a tick to ensure the UI has updated
    await waitFor(() => {
      expect(screen.queryByText(/Create "newfield"/)).not.toBeInTheDocument()
    })
  })

  it('shows type selector after clicking Create', async () => {
    const user = userEvent.setup()
    render(
      <AddPropertyPopover
        definitions={[]}
        onAdd={vi.fn()}
        supportCreateDef
        onCreateDef={vi.fn()}
        open
        onOpenChange={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByLabelText('Search definitions')).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText('Search definitions'), 'myfield')

    await waitFor(() => {
      expect(screen.getByText(/Create "myfield"/)).toBeInTheDocument()
    })

    await user.click(screen.getByText(/Create "myfield"/))

    await waitFor(() => {
      expect(screen.getByLabelText('Value type')).toBeInTheDocument()
    })
  })

  it('calls onCreateDef with key and type when definition is created', async () => {
    const user = userEvent.setup()
    const onCreateDef = vi.fn()
    render(
      <AddPropertyPopover
        definitions={[]}
        onAdd={vi.fn()}
        supportCreateDef
        onCreateDef={onCreateDef}
        open
        onOpenChange={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByLabelText('Search definitions')).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText('Search definitions'), 'newfield')

    await waitFor(() => {
      expect(screen.getByText(/Create "newfield"/)).toBeInTheDocument()
    })
    await user.click(screen.getByText(/Create "newfield"/))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create definition/i })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /create definition/i }))

    expect(onCreateDef).toHaveBeenCalledWith('newfield', 'text')
  })

  it('displays formatted property names', async () => {
    const defs = [makeDef('created_at', 'date'), makeDef('my_custom_prop', 'text')]
    render(<AddPropertyPopover definitions={defs} onAdd={vi.fn()} open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Created At')).toBeInTheDocument()
      expect(screen.getByText('My Custom Prop')).toBeInTheDocument()
    })
  })

  it('shows type badges alongside definition names', async () => {
    const defs = [makeDef('status', 'text'), makeDef('count', 'number')]
    render(<AddPropertyPopover definitions={defs} onAdd={vi.fn()} open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('text')).toBeInTheDocument()
      expect(screen.getByText('number')).toBeInTheDocument()
    })
  })

  it('has no a11y violations', async () => {
    const defs = [makeDef('status', 'text')]
    const { container } = render(
      <AddPropertyPopover definitions={defs} onAdd={vi.fn()} open onOpenChange={vi.fn()} />,
    )
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
