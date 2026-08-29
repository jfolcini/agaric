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

import type { PropertyDefinition } from '@/lib/tauri'

const mockUseIsTouch = vi.hoisted(() => vi.fn(() => false))

vi.mock('@/hooks/useIsTouch', () => ({
  useIsTouch: mockUseIsTouch,
}))

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
  XIcon: () => <svg data-testid="x-icon" />,
}))

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

import { AddPropertyPopover } from '@/components/properties/AddPropertyPopover'

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
  mockUseIsTouch.mockReturnValue(false)
})

describe('AddPropertyPopover', () => {
  it('inherits the shared viewport cap in the coarse-pointer sheet', () => {
    mockUseIsTouch.mockReturnValue(true)
    render(<AddPropertyPopover definitions={[]} onAdd={vi.fn()} open onOpenChange={vi.fn()} />)

    expect(screen.getByTestId('add-property-sheet')).toHaveClass('max-h-[calc(100dvh-2rem)]')
    expect(screen.getByTestId('add-property-sheet')).not.toHaveClass('max-h-[80vh]')
  })

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

  // Unicode-aware fold via `matchesSearchFolded`.
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

  // Both the filter AND the "exists-exact-match" check must
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

  // #4514 — the sigma-collapse fix in `foldForSearch` broadens this
  // exact-match dedupe, not just substring search: a definition key
  // stored with a word-final sigma (U+03C2, 'ς') now folds equal to a
  // search typed with the regular sigma (U+03C3, 'σ'). Pin the
  // user-visible consequence (the "Create new" affordance stays
  // suppressed), not just fold equality.
  //
  // Both sigmas are written as escapes rather than pasted: the two glyphs
  // are indistinguishable at a glance, and if the stored key and the
  // typed search ended in the *same* sigma the assertions below would
  // hold with or without the fold — a tautology, not a test.
  it('does NOT show "Create new" suggestion when the only difference is Greek final-sigma form (#4514)', async () => {
    const STORED_KEY = 'οδο\u03C2' // word-final sigma
    const TYPED_QUERY = 'οδο\u03C3' // regular sigma
    // Tamper-detector: normalising either escape to the other sigma makes
    // the two words identical and the assertions below vacuous.
    expect(TYPED_QUERY).not.toBe(STORED_KEY)
    const user = userEvent.setup()
    const defs = [makeDef(STORED_KEY)]
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

    // Regular sigma (U+03C3) where the stored key ends in the
    // word-final form (U+03C2) — same word, different sigma glyph.
    await user.type(screen.getByLabelText('Search definitions'), TYPED_QUERY)

    await waitFor(() => {
      expect(screen.getByText(STORED_KEY)).toBeInTheDocument()
    })
    expect(
      screen.queryByRole('button', { name: new RegExp(`create "${TYPED_QUERY}"`, 'i') }),
    ).not.toBeInTheDocument()
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

  // Sub-fix 7 — surface the default value type next to the
  // "Create new" label so users know what they get when clicking.
  it(' sub-fix 7 — surfaces the default "(text)" hint on the Create new button', async () => {
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

  // The boolean value-type option must appear alongside text/number/
  // date/select/ref so users can create native boolean property defs.
  it('surfaces a "boolean" option in the value-type selector', async () => {
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
    await user.type(screen.getByLabelText('Search definitions'), 'myflag')
    await user.click(screen.getByText(/Create "myflag"/))

    const select = (await screen.findByLabelText('Value type')) as HTMLSelectElement
    const optionValues = Array.from(select.options).map((o) => o.value)
    expect(optionValues).toEqual(
      expect.arrayContaining(['text', 'number', 'date', 'select', 'ref', 'boolean']),
    )
  })

  // Extra a11y audit covering the create-definition surface (which
  // includes the boolean option). The default "browse mode" axe pass at the
  // top of this file does not render the create-definition select, so the
  // boolean SelectItem stays uncovered without this second pass.
  it('has no a11y violations with the create-definition select visible', async () => {
    const user = userEvent.setup()
    const { container } = render(
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
    await user.type(screen.getByLabelText('Search definitions'), 'myflag')
    await user.click(screen.getByText(/Create "myflag"/))
    await waitFor(() => {
      expect(screen.getByLabelText('Value type')).toBeInTheDocument()
    })

    expect(await axe(container)).toHaveNoViolations()
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

  // Definition rows render via the Button primitive so they inherit
  // the focus-visible ring tokens from buttonVariants.
  it('definition rows render as Button primitives with focus-visible ring tokens', async () => {
    const defs = [makeDef('status', 'text')]
    render(<AddPropertyPopover definitions={defs} onAdd={vi.fn()} open onOpenChange={vi.fn()} />)

    const row = await screen.findByRole('button', { name: /Status/ })
    expect(row.className).toContain('focus-ring-visible')
  })

  // The type-hint contrast fix. The hint must not use the old
  // text-xs opacity-70 combo (both font-size and contrast were below
  // WCAG AA); it should now use text-xs + text-muted-foreground.
  it('create-new-type-hint uses text-xs + text-muted-foreground (no opacity-70)', async () => {
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

    expect(hint.className).toContain('text-xs')
    expect(hint.className).toContain('text-muted-foreground')
    expect(hint.className).not.toContain('text-[10px]')
    expect(hint.className).not.toContain('opacity-70')
  })
})
