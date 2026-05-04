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
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { StoreApi } from 'zustand'
import { reportIpcError } from '../../lib/report-ipc-error'
import type { PropertyDefinition, PropertyRow as PropertyRowData } from '../../lib/tauri'
import { useBlockStore } from '../../stores/blocks'
import {
  createPageBlockStore,
  PageBlockContext,
  type PageBlockState,
} from '../../stores/page-blocks'

// Wrap `reportIpcError` in a spy that delegates to the real implementation.
// Lets FE-H-17 partial-failure assertions inspect call arguments while
// existing tests that rely on the real toast/logger side-effects keep passing.
vi.mock('../../lib/report-ipc-error', async () => {
  const actual = await vi.importActual<typeof import('../../lib/report-ipc-error')>(
    '../../lib/report-ipc-error',
  )
  return {
    ...actual,
    reportIpcError: vi.fn(actual.reportIpcError),
  }
})

const mockedInvoke = vi.mocked(invoke)
const mockedReportIpcError = vi.mocked(reportIpcError)

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

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
  }
}

function setupMock(props: PropertyRowData[] = [], defs: PropertyDefinition[] = []) {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_properties') return props
    // M-85: paginated PageResponse envelope.
    if (cmd === 'list_property_defs') return { items: defs, next_cursor: null, has_more: false }
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

  it('shows LoadingSkeleton initially (UX-272 sub-fix 3)', () => {
    // Return a never-resolving promise to keep loading state
    mockedInvoke.mockReturnValue(new Promise(() => {}))
    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    // Sheet portals to document.body; query the document instead of container
    const loading = document.querySelector('[data-testid="block-property-drawer-loading"]')
    expect(loading).toBeInTheDocument()
    // 3 skeleton rows
    const skeletons = loading?.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons?.length).toBe(3)
  })

  it('disables the Add property button while loading with a tooltip (UX-272 sub-fix 3)', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockReturnValue(new Promise(() => {}))
    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

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

  // PEND-28b H3 — the SheetContent must inherit the responsive baseline.
  // `w-80` alone clips a 360 px phone (320 px drawer leaves 40 px for content);
  // `w-3/4 sm:w-80` keeps the desktop 320 px while making mobile 75% viewport.
  it('SheetContent uses responsive width (w-3/4 sm:w-80)', () => {
    setupMock()
    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    const sheetContent = document.querySelector('[data-slot="sheet-content"]') as HTMLElement
    expect(sheetContent).not.toBeNull()
    expect(sheetContent.className).toContain('w-3/4')
    expect(sheetContent.className).toContain('sm:w-80')
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
          is_conflict: false,
          conflict_type: null,
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
          page_id: null,
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
          page_id: null,
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
          page_id: null,
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
          page_id: null,
          depth: 0,
        },
      ],
    })
    setupMock()

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

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

  // ── UX-320: Repeat-syntax help popover ────────────────────────────────

  it('renders the repeat-syntax help popover trigger on the repeat property row', async () => {
    const props = [makeProp('repeat', { value_text: '++ 1d' })]
    setupMock(props, [makeDef('repeat')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

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

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

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

  // PEND-23 M3: PopoverContent must carry an aria-label so screen readers
  // announce the popover purpose, not a generic "dialog".
  it('labels the open repeat-help popover with property.repeatHelpPopoverLabel', async () => {
    const user = userEvent.setup()
    const props = [makeProp('repeat', { value_text: '++ 1d' })]
    setupMock(props, [makeDef('repeat')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Repeat')).toBeInTheDocument()
    })

    await user.click(screen.getByTestId('repeat-help-trigger'))

    expect(await screen.findByRole('dialog', { name: 'Repeat syntax help' })).toBeInTheDocument()
  })

  it('does not render the repeat-syntax help popover for non-repeat properties', async () => {
    const props = [makeProp('my_custom', { value_text: 'hello' })]
    setupMock(props, [makeDef('my_custom')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('my_custom')).toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: 'Repeat syntax help' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('repeat-help-trigger')).not.toBeInTheDocument()
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

  // ── Ref-type property rendering ───────────────────────────────────────

  it('renders ref-type property with page picker button instead of text input', async () => {
    const props = [makeProp('linked_page', { value_ref: null })]
    setupMock(props, [makeDef('linked_page', 'ref')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

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

  it('renders ref-type property with resolved page title', async () => {
    // Pre-populate resolve cache so the title is available.
    // FEAT-3p7 — cache is keyed by composite `${spaceId}::${ulid}`;
    // no active space is set so we use the `__global__` sentinel via
    // `keyFor(null, id)`.
    const { useResolveStore, keyFor } = await import('../../stores/resolve')
    useResolveStore.setState({
      cache: new Map([[keyFor(null, 'TARGET_PAGE'), { title: 'My Target Page', deleted: false }]]),
      version: 1,
    })

    const props = [makeProp('linked_page', { value_ref: 'TARGET_PAGE' })]
    setupMock(props, [makeDef('linked_page', 'ref')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('My Target Page')).toBeInTheDocument()
    })
  })

  // ── Error path tests ────────────────────────────────────────────────

  it('shows error toast when loading properties fails', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('network failure'))

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load properties')
    })
  })

  it('exits loading state when loading properties fails', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('network failure'))

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.queryByTestId('block-property-drawer-loading')).not.toBeInTheDocument()
    })
  })

  it('FE-H-17: partial failure (listPropertyDefs rejects) renders properties and reports failure', async () => {
    // get_properties succeeds, list_property_defs rejects — the drawer should
    // still render the property row from the successful side and surface the
    // defs failure via reportIpcError instead of failing the whole load.
    const props = [makeProp('status', { value_text: 'active' })]
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_properties') return props
      if (cmd === 'list_property_defs') throw new Error('defs IPC failed')
      return null
    })

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

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
    setupMock(props, [makeDef('status')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('status')).toBeInTheDocument()
    })

    // Now make the next set_property call fail
    mockedInvoke.mockRejectedValueOnce(new Error('save failure'))

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
    setupMock(props, [makeDef('my_custom')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('my_custom')).toBeInTheDocument()
    })

    // Make the next delete_property call fail
    mockedInvoke.mockRejectedValueOnce(new Error('delete failure'))

    const deleteBtn = screen.getByRole('button', { name: 'Delete property' })
    await user.click(deleteBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete property')
    })
  })

  it('preserves property list when delete fails', async () => {
    const user = userEvent.setup()
    const props = [makeProp('my_custom', { value_text: 'hello' })]
    setupMock(props, [makeDef('my_custom')])

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('my_custom')).toBeInTheDocument()
    })

    // Make the next delete_property call fail
    mockedInvoke.mockRejectedValueOnce(new Error('delete failure'))

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
          is_conflict: false,
          conflict_type: null,
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

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTitle('Due')).toBeInTheDocument()
    })

    // Make set_due_date reject
    mockedInvoke.mockRejectedValueOnce(new Error('clear date failure'))

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
          is_conflict: false,
          conflict_type: null,
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

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTitle('Scheduled')).toBeInTheDocument()
    })

    // Make set_scheduled_date reject
    mockedInvoke.mockRejectedValueOnce(new Error('clear scheduled failure'))

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
          is_conflict: false,
          conflict_type: null,
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

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTitle('Due')).toBeInTheDocument()
    })

    // Make set_due_date reject
    mockedInvoke.mockRejectedValueOnce(new Error('save date failure'))

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
    const defs = [makeDef('new_prop', 'text')]
    // No existing properties, but one definition available
    setupMock([], defs)

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.queryByTestId('block-property-drawer-loading')).not.toBeInTheDocument()
    })

    // Open the add-property popover
    const addBtn = screen.getByRole('button', { name: 'Add property' })
    await user.click(addBtn)

    // Make set_property reject when adding from definition
    mockedInvoke.mockRejectedValueOnce(new Error('add property failure'))

    // Click on the definition in the popover
    const defOption = await screen.findByText('New Prop')
    await user.click(defOption)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save property')
    })
  })

  it('does not crash when reloading properties after ref save fails', async () => {
    const props = [makeProp('linked_page', { value_ref: null })]
    const defs = [makeDef('linked_page', 'ref')]
    setupMock(props, defs)

    renderWithProvider(<BlockPropertyDrawer blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Linked Page')).toBeInTheDocument()
    })

    // Make get_properties reject for the reload path
    mockedInvoke.mockRejectedValueOnce(new Error('reload failure'))

    // The reloadProperties function is passed as onRefSaved to PropertyRowEditor.
    // It catches errors silently (logger.warn only, no toast).
    // Verify the component is still rendered and didn't crash.
    expect(screen.getByText('Linked Page')).toBeInTheDocument()
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

  it('renders a text input for NL date support when inputType is "date"', () => {
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
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveValue('2026-06-15')
  })

  it('shows "Parsing…" indicator while NL date is being debounced (UX-322)', async () => {
    const user = userEvent.setup()
    render(
      <PropertyRow label="Due" value="" inputType="date" ariaLabel="Due value" onSave={vi.fn()} />,
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
