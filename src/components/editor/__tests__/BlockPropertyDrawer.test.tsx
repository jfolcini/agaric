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

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { StoreApi } from 'zustand'

import type { PropertyDefinition, PropertyRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { reportIpcError } from '@/lib/report-ipc-error'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { opLog, properties, spacePropertyDefs, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useBlockStore } from '@/stores/blocks'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

// Wrap `reportIpcError` in a spy that delegates to the real implementation.
// Lets FE-H-17 partial-failure assertions inspect call arguments while
// existing tests that rely on the real toast/logger side-effects keep passing.
vi.mock('@/lib/report-ipc-error', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/report-ipc-error')>('@/lib/report-ipc-error')
  return {
    ...actual,
    reportIpcError: vi.fn(actual.reportIpcError),
  }
})

const mockedInvoke = vi.mocked(invoke)
const mockedReportIpcError = vi.mocked(reportIpcError)

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

import { makeBlockRow, withOps } from '@/__tests__/fixtures'
import {
  type CommandReturns,
  deferred,
  stubInvoke,
  type TypedInvokeHandlers,
} from '@/__tests__/helpers/invoke'
import { BlockPropertyDrawer } from '@/components/editor/BlockPropertyDrawer'
import { PropertyField } from '@/components/properties/PropertyField'

let pageStore: StoreApi<PageBlockState>

/** Render a component wrapped in the per-page store provider. */
function renderWithProvider(ui: React.ReactElement) {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(PageBlockContext.Provider, { value: pageStore }, children)
  return render(ui, { wrapper })
}

function makeProp(key: string, overrides?: Partial<PropertyRow>): PropertyRow {
  return {
    key,
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
    ...overrides,
  }
}

function makeDef(key: string, valueType = 'text'): PropertyDefinition {
  return {
    key,
    value_type: valueType,
    options: null,
    created_at: '2026-01-01T00:00:00Z',
    builtin: false,
  }
}

/**
 * The commands the drawer fires, defaulted to success. `overrides` is how a
 * test fails exactly one of them: a positional `mockRejectedValueOnce` failed
 * whichever call happened to land first, whatever command it was (#3217).
 */
function setupMock(
  props: PropertyRow[] = [],
  defs: PropertyDefinition[] = [],
  overrides: TypedInvokeHandlers = {},
) {
  stubInvoke(mockedInvoke, {
    get_properties: () => props,
    list_property_defs: () => ({
      items: defs,
      next_cursor: null,
      has_more: false,
      total_count: null,
    }),
    set_property: () => withOps(makeBlockRow({ id: 'BLOCK_1' })),
    delete_property: () => withOps({ block_id: 'BLOCK_1', key: 'my_custom' }),
    set_due_date: () => makeBlockRow({ id: 'BLOCK_1' }),
    set_scheduled_date: () => makeBlockRow({ id: 'BLOCK_1' }),
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  pageStore = createPageBlockStore('PAGE_1')
  // The block is in the active space, whose definitions the drawer lists (#5841).
  useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
  useBlockStore.setState({
    focusedBlockId: null,
    selectedBlockIds: [],
  })
})

describe('BlockPropertyDrawer', () => {
  it('renders "Block Properties" title when open', async () => {
    setupMock()
    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    expect(screen.getByText('Block Properties')).toBeInTheDocument()
  })

  it('shows LoadingSkeleton initially (sub-fix 3)', () => {
    // Parked promise keeps the loading state up.
    const pending = deferred<CommandReturns['get_properties']>()
    setupMock([], [], { get_properties: () => pending.promise })
    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    // Sheet portals to document.body; query the document instead of container
    const loading = document.querySelector('[data-testid="block-property-drawer-loading"]')
    expect(loading).toBeInTheDocument()
    // 3 skeleton rows
    const skeletons = loading?.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons?.length).toBe(3)
  })

  it('disables the Add property button while loading with a tooltip (sub-fix 3)', async () => {
    const user = userEvent.setup()
    const pending = deferred<CommandReturns['get_properties']>()
    setupMock([], [], { get_properties: () => pending.promise })
    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    const addBtn = screen.getByRole('button', { name: 'Add property' })
    expect(addBtn).toBeDisabled()

    // Hover surfaces the loading tooltip
    const trigger = addBtn.parentElement as HTMLElement
    await user.hover(trigger)
    await waitFor(
      async () => {
        const matches = await screen.findAllByText('Properties loading\u2026')
        expect(matches.length).toBeGreaterThanOrEqual(1)
      },
      { timeout: 3000 },
    )
  })

  it('shows property list after loading', async () => {
    const props = [
      makeProp('status', { value_text: 'active' }),
      makeProp('priority', { value_num: 1 }),
    ]
    setupMock(props, [makeDef('status'), makeDef('priority', 'number')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('status')).toBeInTheDocument()
    })
    expect(screen.getByText('priority')).toBeInTheDocument()
  })

  it('shows "No properties set" when block has no properties', async () => {
    setupMock([], [])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('No properties set')).toBeInTheDocument()
    })
  })

  it('delete button calls deleteProperty', async () => {
    const user = userEvent.setup()
    const props = [makeProp('status', { value_text: 'active' })]
    setupMock(props, [makeDef('status')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

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

  // The SheetContent takes the default sheet width (75% of a phone, capped at
  // `sm:max-w-sm` on desktop) instead of a narrower per-drawer override.
  it('SheetContent uses the default sheet width, not a drawer-specific override', () => {
    setupMock()
    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    const sheetContent = document.querySelector('[data-slot="sheet-content"]') as HTMLElement
    expect(sheetContent).not.toBeNull()
    expect(sheetContent.className).toContain('w-3/4')
    expect(sheetContent.className).toContain('sm:max-w-sm')
    expect(sheetContent.className).not.toContain('sm:w-80')
  })

  // The body sits in SheetBody, which already indents it to the header's gutter;
  // an extra `px-4` here would push it 16px right of the header line again.
  it('drawer body sits in the SheetBody without its own horizontal padding', async () => {
    const props = [makeProp('status', { value_text: 'active' })]
    setupMock(props, [makeDef('status')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('status')).toBeInTheDocument()
    })

    const bodyDiv = screen.getByText('status').closest('.space-y-3')
    expect(bodyDiv).not.toBeNull()
    expect(bodyDiv).not.toHaveClass('px-4')
    expect(bodyDiv?.closest('[data-slot="sheet-body"]')).not.toBeNull()
  })

  it('wraps content in a ScrollArea for overflow scrolling', async () => {
    const props = [makeProp('status', { value_text: 'active' })]
    setupMock(props, [makeDef('status')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('status')).toBeInTheDocument()
    })

    // SheetBody is a ScrollArea and renders with data-slot="sheet-body"
    const scrollArea = document.querySelector('[data-slot="sheet-body"]')
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
      <BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />,
    )

    await waitFor(() => {
      expect(screen.getByText('status')).toBeInTheDocument()
    })

    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
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
          todo_state: null,
          priority: null,
          due_date: '2026-06-15',
          scheduled_date: null,
          page_id: null,
          depth: 0,
        },
      ],
    })
    setupMock()

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: '2026-07-01',
          page_id: null,
          depth: 0,
        },
      ],
    })
    setupMock()

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

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
          todo_state: null,
          priority: null,
          due_date: '2026-06-15',
          scheduled_date: null,
          page_id: null,
          depth: 0,
        },
      ],
    })
    setupMock([], [])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

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
          todo_state: null,
          priority: null,
          due_date: '2026-06-15',
          scheduled_date: null,
          page_id: null,
          depth: 0,
        },
      ],
    })
    setupMock()

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
          depth: 0,
        },
      ],
    })
    setupMock()

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    // Initially no date shown
    await waitFor(() => {
      expect(screen.queryByTestId('block-property-drawer-loading')).not.toBeInTheDocument()
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

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    const input = await screen.findByLabelText('status value')
    expect(input).toBeInTheDocument()
  })

  it('does not show delete button for built-in properties', async () => {
    const props = [makeProp('created_at', { value_text: '2026-01-01' })]
    setupMock(props, [makeDef('created_at')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Created At')).toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: 'Delete property' })).not.toBeInTheDocument()
  })

  it('shows delete button for custom properties', async () => {
    const props = [makeProp('my_custom', { value_text: 'hello' })]
    setupMock(props, [makeDef('my_custom')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('my_custom')).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: 'Delete property' })).toBeInTheDocument()
  })

  it('shows the delete button for the repeat rule, the user’s to remove', async () => {
    const props = [makeProp('repeat', { value_text: '+1w' })]
    setupMock(props, [makeDef('repeat')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Repeat')).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: 'Delete property' })).toBeInTheDocument()
  })

  // #5160 — the button follows what `delete_property` refuses, so a repeat
  // limit is removable while the occurrence count recurrence writes is not.
  it('removes a repeat limit against the real mock, but offers no delete for repeat-seq', async () => {
    const user = userEvent.setup()
    const blockId = SEED_IDS.BLOCK_GS_1
    seedBlocks()
    const row = (key: string, valueNum: number) => ({ ...makeProp(key), value_num: valueNum })
    properties.set(
      blockId,
      new Map([
        ['repeat-count', row('repeat-count', 3)],
        ['repeat-seq', row('repeat-seq', 2)],
      ]),
    )
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))

    renderWithProvider(<BlockPropertyDrawer blockId={blockId} open onOpenChange={vi.fn()} />)
    await screen.findByTestId('property-value-input-repeat-seq')
    const deletes = screen.getAllByRole('button', { name: 'Delete property' })
    expect(deletes).toHaveLength(1)
    // The Sheet portals out of the render container; its focus guards are Radix's.
    const sheet = document.querySelector('[data-slot="sheet-content"]') as HTMLElement
    expect(await axe(sheet)).toHaveNoViolations()

    await user.click(deletes[0] as HTMLElement)

    await waitFor(() => {
      expect([...(properties.get(blockId)?.keys() ?? [])]).toEqual(['repeat-seq'])
    })
  })

  // ── Repeat-syntax help popover ────────────────────────────────

  it('renders the repeat-syntax help popover trigger on the repeat property row', async () => {
    const props = [makeProp('repeat', { value_text: '++ 1d' })]
    setupMock(props, [makeDef('repeat')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Repeat')).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: 'Repeat syntax help' })).toBeInTheDocument()
    expect(screen.getByTestId('repeat-help-trigger')).toBeInTheDocument()
  })

  it('opens a popover explaining ++ and .+ when the help trigger is clicked', async () => {
    const user = userEvent.setup()
    const props = [makeProp('repeat', { value_text: '++ 1d' })]
    setupMock(props, [makeDef('repeat')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Repeat')).toBeInTheDocument()
    })

    await user.click(screen.getByTestId('repeat-help-trigger'))

    expect(await screen.findByText('Repeat syntax')).toBeInTheDocument()
    expect(
      screen.getByText('Reschedule from the original date plus the interval (catch-up).'),
    ).toBeInTheDocument()
    expect(screen.getByText('Reschedule from the moment of completion.')).toBeInTheDocument()
  })

  // PopoverContent must carry an aria-label so screen readers
  // announce the popover purpose, not a generic "dialog".
  it('labels the open repeat-help popover with property.repeatHelpPopoverLabel', async () => {
    const user = userEvent.setup()
    const props = [makeProp('repeat', { value_text: '++ 1d' })]
    setupMock(props, [makeDef('repeat')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Repeat')).toBeInTheDocument()
    })

    await user.click(screen.getByTestId('repeat-help-trigger'))

    expect(await screen.findByRole('dialog', { name: 'Repeat syntax help' })).toBeInTheDocument()
  })

  it('does not render the repeat-syntax help popover for non-repeat properties', async () => {
    const props = [makeProp('my_custom', { value_text: 'hello' })]
    setupMock(props, [makeDef('my_custom')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('my_custom')).toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: 'Repeat syntax help' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('repeat-help-trigger')).not.toBeInTheDocument()
  })

  // ── Consistent built-in property rendering ────────────────────

  it('renders built-in property (created_at) with icon and formatted name', async () => {
    const props = [makeProp('created_at', { value_text: '2026-01-01' })]
    setupMock(props, [makeDef('created_at')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

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

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

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

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

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

  // ── Ref-type property rendering ───────────────────────────────────────

  it('renders ref-type property with page picker button instead of text input', async () => {
    const props = [makeProp('linked_page', { value_ref: null })]
    setupMock(props, [makeDef('linked_page', 'ref')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    // PropertyRowEditor formats the key: linked_page → "Linked Page"
    await waitFor(() => {
      expect(screen.getByText('Linked Page')).toBeInTheDocument()
    })

    // Should render a page picker button (from PropertyRowEditor) instead of a plain input
    const pickerBtn = screen.getByLabelText('linked_page value')
    expect(pickerBtn.tagName).toBe('BUTTON')
    // Should not have a plain text input for this property
    expect(screen.queryByRole('textbox', { name: 'linked_page value' })).not.toBeInTheDocument()
  })

  it('offers delete for a ref row unless recurrence writes it', async () => {
    const props = [
      makeProp('linked_page', { value_ref: null }),
      makeProp('repeat-origin', { value_ref: null }),
    ]
    setupMock(props, [makeDef('linked_page', 'ref'), makeDef('repeat-origin', 'ref')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    expect(await screen.findByLabelText('Delete property linked_page')).toBeInTheDocument()
    expect(screen.queryByLabelText('Delete property repeat-origin')).not.toBeInTheDocument()
  })

  it('renders ref-type property with resolved page title', async () => {
    // Pre-populate resolve cache so the title is available.
    // Cache is keyed by composite `${spaceId}::${ulid}`, in the active space.
    const { useResolveStore, keyFor } = await import('@/stores/resolve')
    useResolveStore.setState({
      cache: new Map([
        [
          keyFor('SPACE_PERSONAL', 'TARGET_PAGE'),
          { title: 'My Target Page', deleted: false, resolved: true },
        ],
      ]),
      version: 1,
    })

    const props = [makeProp('linked_page', { value_ref: 'TARGET_PAGE' })]
    setupMock(props, [makeDef('linked_page', 'ref')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('My Target Page')).toBeInTheDocument()
    })
  })

  // ── Error path tests ────────────────────────────────────────────────

  it('shows error toast when loading properties fails', async () => {
    setupMock([], [], { get_properties: () => Promise.reject(new Error('network failure')) })

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load properties')
    })
  })

  it('exits loading state when loading properties fails', async () => {
    setupMock([], [], { get_properties: () => Promise.reject(new Error('network failure')) })

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.queryByTestId('block-property-drawer-loading')).not.toBeInTheDocument()
    })
  })

  it('FE-H-17: partial failure (listPropertyDefs rejects) renders properties and reports failure', async () => {
    // get_properties succeeds, list_property_defs rejects — the drawer should
    // still render the property row from the successful side and surface the
    // defs failure via reportIpcError instead of failing the whole load.
    const props = [makeProp('status', { value_text: 'active' })]
    setupMock(props, [], {
      list_property_defs: () => Promise.reject(new Error('defs IPC failed')),
    })

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    // (a) The successful side still renders.
    await waitFor(() => {
      expect(screen.getByText('status')).toBeInTheDocument()
    })

    // (b) reportIpcError was called for the listPropertyDefs failure with the
    // module/messageKey/context expected by FE-H-17.
    expect(mockedReportIpcError).toHaveBeenCalledWith(
      'BlockPropertyDrawer',
      'property.loadFailed',
      expect.any(Error),
      expect.any(Function),
      expect.objectContaining({ blockId: 'BLOCK_1', fetch: 'listPropertyDefs' }),
    )
    // The successful fetch must NOT trigger a report.
    expect(mockedReportIpcError).not.toHaveBeenCalledWith(
      'BlockPropertyDrawer',
      'property.loadFailed',
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ fetch: 'getProperties' }),
    )
  })

  it('shows error toast when saving a property fails', async () => {
    const user = userEvent.setup()
    const props = [makeProp('status', { value_text: 'active' })]
    setupMock(props, [makeDef('status')], {
      set_property: () => Promise.reject(new Error('save failure')),
    })

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('status')).toBeInTheDocument()
    })

    const input = screen.getByLabelText('status value')
    await user.clear(input)
    await user.type(input, 'new-value')
    await user.tab() // triggers onBlur → handleSave

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save property')
    })
  })

  it('shows error toast when deleting a property fails', async () => {
    const user = userEvent.setup()
    const props = [makeProp('my_custom', { value_text: 'hello' })]
    setupMock(props, [makeDef('my_custom')], {
      delete_property: () => Promise.reject(new Error('delete failure')),
    })

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('my_custom')).toBeInTheDocument()
    })

    const deleteBtn = screen.getByRole('button', { name: 'Delete property' })
    await user.click(deleteBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete property')
    })
  })

  it('preserves property list when delete fails', async () => {
    const user = userEvent.setup()
    const props = [makeProp('my_custom', { value_text: 'hello' })]
    setupMock(props, [makeDef('my_custom')], {
      delete_property: () => Promise.reject(new Error('delete failure')),
    })

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('my_custom')).toBeInTheDocument()
    })

    const deleteBtn = screen.getByRole('button', { name: 'Delete property' })
    await user.click(deleteBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete property')
    })

    // Property should still be visible since delete failed
    expect(screen.getByText('my_custom')).toBeInTheDocument()
  })

  it('shows error toast when clearing a builtin due date fails', async () => {
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
          todo_state: null,
          priority: null,
          due_date: '2026-06-15',
          scheduled_date: null,
          page_id: null,
          depth: 0,
        },
      ],
    })
    setupMock([], [], { set_due_date: () => Promise.reject(new Error('clear date failure')) })

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTitle('Due')).toBeInTheDocument()
    })

    const clearBtn = screen.getByRole('button', { name: 'Clear due date' })
    await user.click(clearBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save property')
    })
  })

  it('shows error toast when clearing a builtin scheduled date fails', async () => {
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: '2026-07-01',
          page_id: null,
          depth: 0,
        },
      ],
    })
    setupMock([], [], {
      set_scheduled_date: () => Promise.reject(new Error('clear scheduled failure')),
    })

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTitle('Scheduled')).toBeInTheDocument()
    })

    const clearBtn = screen.getByRole('button', { name: 'Clear scheduled date' })
    await user.click(clearBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save property')
    })
  })

  it('shows error toast when saving a builtin due date fails', async () => {
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
          todo_state: null,
          priority: null,
          due_date: '2026-06-15',
          scheduled_date: null,
          page_id: null,
          depth: 0,
        },
      ],
    })
    setupMock([], [], { set_due_date: () => Promise.reject(new Error('save date failure')) })

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTitle('Due')).toBeInTheDocument()
    })

    const dateInput = screen.getByDisplayValue('2026-06-15')
    await user.clear(dateInput)
    await user.type(dateInput, '2026-12-25')
    await user.tab() // triggers onBlur → handleSaveBuiltinDate

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save property')
    })
  })

  it('shows error toast when adding a property from definition fails', async () => {
    const user = userEvent.setup()
    // #2656 — a number def persists immediately on add (buildInitParams gives a
    // valid `value_num: 0`), so this exercises the add-time failure path.
    // (text/select defs no longer persist on add — see the draft-row tests.)
    const defs = [makeDef('new_prop', 'number')]
    // No existing properties, but one definition available
    setupMock([], defs, { set_property: () => Promise.reject(new Error('add property failure')) })

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.queryByTestId('block-property-drawer-loading')).not.toBeInTheDocument()
    })

    // Open the add-property popover
    const addBtn = screen.getByRole('button', { name: 'Add property' })
    await user.click(addBtn)

    // Click on the definition in the popover
    const defOption = await screen.findByText('New Prop')
    await user.click(defOption)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save property')
    })
  })

  // #2656 — text/select properties cannot be created with an empty value_text
  // (the real backend rejects it). Adding one from a definition creates a local
  // DRAFT row for value entry; it persists only on a non-empty save.
  it('adds a text property as an editable draft WITHOUT an empty set_property', async () => {
    const user = userEvent.setup()
    setupMock([], [makeDef('assignee', 'text')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.queryByTestId('block-property-drawer-loading')).not.toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Add property' }))
    await user.click(await screen.findByText('Assignee'))

    // An editable input for the draft appears…
    const input = await screen.findByTestId('property-value-input-assignee')
    expect(input).toBeInTheDocument()
    // …and NO empty-value set_property was fired (the old bug).
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
  })

  it('persists a text draft with a valid value_text on save', async () => {
    const user = userEvent.setup()
    setupMock([], [makeDef('assignee', 'text')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.queryByTestId('block-property-drawer-loading')).not.toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Add property' }))
    await user.click(await screen.findByText('Assignee'))

    const input = await screen.findByTestId('property-value-input-assignee')
    await user.type(input, 'Ada')
    await user.tab() // blur → onSave

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'set_property',
        expect.objectContaining({
          blockId: 'BLOCK_1',
          key: 'assignee',
          value: expect.objectContaining({ value_text: 'Ada' }),
        }),
      )
    })
  })

  it('drops an empty text draft on blur without any set_property', async () => {
    const user = userEvent.setup()
    setupMock([], [makeDef('assignee', 'text')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.queryByTestId('block-property-drawer-loading')).not.toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Add property' }))
    await user.click(await screen.findByText('Assignee'))

    const input = await screen.findByTestId('property-value-input-assignee')
    input.focus()
    await user.tab() // blur with no value → draft dropped

    await waitFor(() => {
      expect(screen.queryByTestId('property-value-input-assignee')).not.toBeInTheDocument()
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
  })

  // #5862 — the block never held the draft's key, and the undo of a DeleteProperty
  // for it fails, which aborts the page's undo group.
  it('removes a text draft without any delete_property', async () => {
    const user = userEvent.setup()
    setupMock([], [makeDef('assignee', 'text')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.queryByTestId('block-property-drawer-loading')).not.toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Add property' }))
    await user.click(await screen.findByText('Assignee'))
    expect(await screen.findByTestId('property-value-input-assignee')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete property' }))

    await waitFor(() => {
      expect(screen.queryByTestId('property-value-input-assignee')).not.toBeInTheDocument()
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_property', expect.anything())
  })

  it('drops unsaved draft rows when the drawer switches to a different block', async () => {
    const user = userEvent.setup()
    setupMock([], [makeDef('assignee', 'text')])

    const { rerender } = renderWithProvider(
      <BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />,
    )
    await waitFor(() => {
      expect(screen.queryByTestId('block-property-drawer-loading')).not.toBeInTheDocument()
    })

    // Start an unsaved draft on BLOCK_1.
    await user.click(screen.getByRole('button', { name: 'Add property' }))
    await user.click(await screen.findByText('Assignee'))
    expect(await screen.findByTestId('property-value-input-assignee')).toBeInTheDocument()

    // Switch the drawer to BLOCK_2: the stale draft must not leak across.
    rerender(<BlockPropertyDrawer blockId="BLOCK_2" open onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.queryByTestId('property-value-input-assignee')).not.toBeInTheDocument()
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
  })

  // #5736 — a boolean row is the page Properties table's checkbox, not a text box.
  describe('boolean property', () => {
    const blockId = SEED_IDS.BLOCK_GS_1
    const checkbox = () =>
      screen.findByRole('checkbox', { name: t('property.booleanToggle', { key: 'billable' }) })

    function seedBillable(valueBool: number) {
      seedBlocks()
      spacePropertyDefs('SPACE_PERSONAL').set('billable', {
        key: 'billable',
        value_type: 'boolean',
        options: null,
        created_at: '2026-01-01T00:00:00.000Z',
        builtin: false,
      })
      properties.set(
        blockId,
        new Map([['billable', makeProp('billable', { value_bool: valueBool })]]),
      )
      mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
    }

    it('toggles to true against the real mock and is checked when the drawer opens again', async () => {
      const user = userEvent.setup()
      seedBillable(0)
      const { unmount } = renderWithProvider(
        <BlockPropertyDrawer blockId={blockId} open onOpenChange={vi.fn()} />,
      )
      expect(await checkbox()).not.toBeChecked()
      const sheet = document.querySelector('[data-slot="sheet-content"]') as HTMLElement
      expect(await axe(sheet)).toHaveNoViolations()

      await user.click(await checkbox())

      await waitFor(() => {
        expect(properties.get(blockId)?.get('billable')?.['value_bool']).toBe(1)
      })
      unmount()
      renderWithProvider(<BlockPropertyDrawer blockId={blockId} open onOpenChange={vi.fn()} />)
      expect(await checkbox()).toBeChecked()
    })

    it('stays unchecked and says so when the write is refused', async () => {
      const user = userEvent.setup()
      setupMock([makeProp('billable', { value_bool: 0 })], [makeDef('billable', 'boolean')], {
        set_property: () => Promise.reject(new Error('refused')),
      })
      renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

      await user.click(await checkbox())

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(t('property.saveFailed'))
      })
      expect(await checkbox()).not.toBeChecked()
    })
  })

  // #5736 — a ref with no target is a row with no value, which the backend
  // refuses (`validate_set_property`), so adding one writes nothing until a page is picked.
  describe('ref draft', () => {
    const blockId = SEED_IDS.BLOCK_GS_1
    const removeOwner = () =>
      screen.getByRole('button', { name: t('pageProperty.deletePropertyLabel', { key: 'owner' }) })

    beforeEach(() => {
      seedBlocks()
      spacePropertyDefs('SPACE_PERSONAL').set('owner', {
        key: 'owner',
        value_type: 'ref',
        options: null,
        created_at: '2026-01-01T00:00:00.000Z',
        builtin: false,
      })
      useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
      mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
    })

    /** Open the drawer, add an `owner` ref draft and return its page picker. */
    async function addOwnerDraft(user: ReturnType<typeof userEvent.setup>) {
      renderWithProvider(<BlockPropertyDrawer blockId={blockId} open onOpenChange={vi.fn()} />)
      await waitFor(() => {
        expect(screen.queryByTestId('block-property-drawer-loading')).not.toBeInTheDocument()
      })
      await user.click(screen.getByRole('button', { name: 'Add property' }))
      await user.click(await screen.findByText('Owner'))
      return screen.findByRole('button', { name: t('pageProperty.valueLabel', { key: 'owner' }) })
    }

    it('writes it only once a page is picked', async () => {
      const user = userEvent.setup()
      const picker = await addOwnerDraft(user)
      expect(properties.get(blockId)?.has('owner') ?? false).toBe(false)

      await user.click(picker)
      await user.click(await screen.findByRole('button', { name: 'Quick Notes' }))

      await waitFor(() => {
        expect(properties.get(blockId)?.get('owner')?.['value_ref']).toBe(SEED_IDS.PAGE_QUICK_NOTES)
      })
    })

    // #5862 — the block never held the key, and the undo of a DeleteProperty
    // for it fails, which aborts the page's undo group.
    it('removed before a page is picked, writes no delete', async () => {
      const user = userEvent.setup()
      await addOwnerDraft(user)

      await user.click(removeOwner())

      await waitFor(() => {
        expect(
          screen.queryByRole('button', { name: t('pageProperty.valueLabel', { key: 'owner' }) }),
        ).not.toBeInTheDocument()
      })
      expect(opLog.filter((op) => op.op_type === 'delete_property')).toEqual([])
      expect(mockedInvoke).not.toHaveBeenCalledWith('delete_property', expect.anything())
    })

    it('removed after a page is picked, deletes the stored value', async () => {
      const user = userEvent.setup()
      await user.click(await addOwnerDraft(user))
      await user.click(await screen.findByRole('button', { name: 'Quick Notes' }))
      await waitFor(() => {
        expect(properties.get(blockId)?.has('owner')).toBe(true)
      })

      await user.click(removeOwner())

      await waitFor(() => {
        expect(properties.get(blockId)?.has('owner')).toBe(false)
      })
    })
  })

  it('does not crash when reloading properties after ref save fails', async () => {
    const props = [makeProp('linked_page', { value_ref: null })]
    const defs = [makeDef('linked_page', 'ref')]
    // The initial load succeeds; the reload `onRefSaved` triggers rejects.
    let loaded = false
    setupMock(props, defs, {
      get_properties: () => {
        if (loaded) return Promise.reject(new Error('reload failure'))
        loaded = true
        return props
      },
    })

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Linked Page')).toBeInTheDocument()
    })

    // The reloadProperties function is passed as onRefSaved to PropertyRowEditor.
    // It catches errors silently (logger.warn only, no toast).
    // Verify the component is still rendered and didn't crash.
    expect(screen.getByText('Linked Page')).toBeInTheDocument()
  })
})

// #6206 — a value that doesn't fit its key is marked in its field, shows even
// when it sits in the boolean slot, and an untouched blur leaves it as it is.
describe("BlockPropertyDrawer values that don't fit", () => {
  const mark = (key: string, value: string) =>
    screen.queryByRole('button', { name: t('property.unfitReview', { key, value }) })

  it("marks a value outside a select's options, and not one that fits", async () => {
    setupMock(
      [makeProp('project', { value_text: 'beta' }), makeProp('context', { value_text: 'work' })],
      [{ ...makeDef('project', 'select'), options: '["alpha"]' }, makeDef('context')],
    )
    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    expect(await screen.findByLabelText(t('property.valueLabel', { key: 'project' }))).toHaveValue(
      'beta',
    )
    expect(mark('Project', 'beta')).toBeInTheDocument()
    expect(mark('Context', 'work')).not.toBeInTheDocument()
  })

  it("shows a text key's boolean as true", async () => {
    setupMock([makeProp('note', { value_bool: 1 })], [makeDef('note')])
    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    expect(await screen.findByLabelText(t('property.valueLabel', { key: 'note' }))).toHaveValue(
      'true',
    )
    expect(mark('Note', 'true')).toBeInTheDocument()
  })

  describe('against the real mock', () => {
    const blockId = SEED_IDS.BLOCK_GS_1

    beforeEach(() => {
      seedBlocks()
      spacePropertyDefs('SPACE_PERSONAL').set('weight', {
        key: 'weight',
        value_type: 'number',
        options: null,
        created_at: '2026-01-01T00:00:00.000Z',
        builtin: false,
      })
      properties.set(blockId, new Map([['weight', makeProp('weight', { value_text: 'abc' })]]))
      mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
    })

    it('writes nothing and raises no toast on an untouched blur, and saves an edit', async () => {
      const user = userEvent.setup()
      renderWithProvider(<BlockPropertyDrawer blockId={blockId} open onOpenChange={vi.fn()} />)
      const input = await screen.findByLabelText(t('property.valueLabel', { key: 'weight' }))
      expect(mark('Weight', 'abc')).toBeInTheDocument()

      await user.click(input)
      await user.tab()

      expect(toast.error).not.toHaveBeenCalled()
      expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
      expect(properties.get(blockId)?.get('weight')?.['value_text']).toBe('abc')

      // Positive control: an edit of the same field is written.
      await user.clear(input)
      await user.type(input, '42')
      await user.tab()
      await waitFor(() => {
        expect(properties.get(blockId)?.get('weight')?.['value_num']).toBe(42)
      })
    })

    it('has no a11y violations with a marked field', async () => {
      renderWithProvider(<BlockPropertyDrawer blockId={blockId} open onOpenChange={vi.fn()} />)
      await screen.findByLabelText(t('property.valueLabel', { key: 'weight' }))
      const sheet = document.querySelector('[data-slot="sheet-content"]') as HTMLElement
      await waitFor(async () => {
        expect(await axe(sheet)).toHaveNoViolations()
      })
    })
  })
})

// ── PropertyField unit tests ──────────────────────────────────────────────

describe('PropertyField', () => {
  it('renders label and value', () => {
    render(
      <PropertyField label="Status" value="active" ariaLabel="Status value" onSave={vi.fn()} />,
    )

    expect(screen.getByTitle('Status')).toBeInTheDocument()
    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByDisplayValue('active')).toBeInTheDocument()
  })

  it('calls onSave when input is blurred', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<PropertyField label="Name" value="" ariaLabel="Name value" onSave={onSave} />)

    const input = screen.getByLabelText('Name value')
    await user.click(input)
    await user.type(input, 'hello')
    await user.tab()

    expect(onSave).toHaveBeenCalledWith('hello')
  })

  it('calls onSave via Enter key', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<PropertyField label="Name" value="" ariaLabel="Name value" onSave={onSave} />)

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
      <PropertyField
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
      <PropertyField label="ReadOnly" value="locked" ariaLabel="ReadOnly value" onSave={vi.fn()} />,
    )

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders a text input for NL date support when inputType is "date"', () => {
    render(
      <PropertyField
        label="Due"
        value="2026-06-15"
        inputType="date"
        ariaLabel="Due value"
        onSave={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Due value')
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveValue('2026-06-15')
  })

  it('shows "Parsing…" indicator while NL date is being debounced', async () => {
    const user = userEvent.setup()
    render(
      <PropertyField
        label="Due"
        value=""
        inputType="date"
        ariaLabel="Due value"
        onSave={vi.fn()}
      />,
    )

    // Hidden by default — no parse in flight on initial render.
    expect(screen.queryByText('Parsing…')).not.toBeInTheDocument()

    // Typing a non-ISO value triggers the 300ms NL parse debounce; the
    // hook flips isParsing=true while the timer is pending.
    const input = screen.getByLabelText('Due value')
    await user.click(input)
    await user.type(input, 'tomorrow')

    // Indicator visible during the debounce window.
    expect(screen.getByText('Parsing…')).toBeInTheDocument()

    // After the debounce fires, isParsing flips back to false and the
    // indicator is removed.
    await waitFor(
      () => {
        expect(screen.queryByText('Parsing…')).not.toBeInTheDocument()
      },
      { timeout: 2000 },
    )
  })

  it('renders a text input by default', () => {
    render(<PropertyField label="Note" value="some text" ariaLabel="Note value" onSave={vi.fn()} />)

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
      <PropertyField
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
      <PropertyField
        label="custom_key"
        value="val"
        ariaLabel="custom_key value"
        onSave={vi.fn()}
      />,
    )

    const badge = screen.getByTitle('custom_key')
    expect(badge).toHaveClass('font-mono')
    expect(badge.querySelector('svg')).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <PropertyField
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
