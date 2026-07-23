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

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { getTodayString } from '@/lib/date-utils'
import { reportIpcError } from '@/lib/report-ipc-error'
import type { PropertyDefinition, PropertyRow } from '@/lib/tauri'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { properties, propertyDefs, seedBlocks, SEED_IDS } from '@/lib/tauri-mock/seed'

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

vi.mock('lucide-react', () => ({
  ArrowDown: () => <svg data-testid="arrow-down-icon" />,
  ArrowUp: () => <svg data-testid="arrow-up-icon" />,
  CalendarCheck2: () => <svg data-testid="calendar-check2-icon" />,
  CalendarClock: () => <svg data-testid="calendar-clock-icon" />,
  CalendarPlus: () => <svg data-testid="calendar-plus-icon" />,
  Check: () => <svg data-testid="check-icon" />,
  CheckCircle2: () => <svg data-testid="check-circle2-icon" />,
  ChevronDown: () => <svg data-testid="chevron-down" />,
  ChevronRight: () => <svg data-testid="chevron-right" />,
  Clock: () => <svg data-testid="clock-icon" />,
  FileSearch: () => <svg data-testid="file-search-icon" />,
  Loader2: ({ className }: { className?: string }) => (
    <svg data-testid="loader2-icon" className={className} />
  ),
  Lock: () => <svg data-testid="lock-icon" />,
  MapPin: () => <svg data-testid="map-pin-icon" />,
  Pencil: () => <svg data-testid="pencil-icon" />,
  Plus: () => <svg data-testid="plus-icon" />,
  Repeat: () => <svg data-testid="repeat-icon" />,
  User: () => <svg data-testid="user-icon" />,
  X: () => <svg data-testid="x-icon" />,
}))

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

import { toast } from 'sonner'

import { PagePropertyTable } from '@/components/pages/PagePropertyTable'
import { t } from '@/lib/i18n'

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
    value_bool: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

/** Standard mock: returns given properties and definitions for relevant commands. */
function setupMock(props: PropertyRow[] = [], defs: PropertyDefinition[] = []) {
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
    const a = args as Record<string, unknown> | undefined
    if (cmd === 'get_properties') return props
    if (cmd === 'list_property_defs') return { items: defs, next_cursor: null, has_more: false }
    if (cmd === 'set_property') return undefined
    if (cmd === 'delete_property') return undefined
    if (cmd === 'create_property_def') {
      return makeDef((a?.['key'] as string) ?? 'new', (a?.['valueType'] as string) ?? 'text')
    }
    if (cmd === 'update_property_def_options') {
      const d = defs.find((def) => def.key === a?.['key'])
      return { ...d, key: a?.['key'] as string, options: a?.['options'] as string }
    }
    // PageHeader also calls these in integration
    if (cmd === 'list_blocks')
      return { items: [], next_cursor: null, has_more: false, total_count: null }
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
      expect(screen.queryByRole('button', { name: /Properties/ })).not.toBeInTheDocument()
      expect(container.querySelector('.page-property-table')).not.toBeInTheDocument()
    })
  })

  it('renders collapsed by default with toggle button when properties exist', async () => {
    setupMock([makeProp('status', { value_text: 'active' })], [makeDef('status', 'text')])
    render(<PagePropertyTable pageId="PAGE_1" />)

    await waitFor(() => {
      const toggle = screen.getByRole('button', { name: /Properties/ })
      expect(toggle).toBeInTheDocument()
      expect(toggle).toHaveTextContent(t('pageProperty.propertiesButton'))
    })
    // Should not show any property rows when collapsed
    expect(screen.queryByLabelText(/value$/i)).not.toBeInTheDocument()
  })

  it('expands to show property rows after clicking toggle', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('status', { value_text: 'active' })], [makeDef('status', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" />)

    const toggle = screen.getByRole('button', { name: /Properties/ })
    await user.click(toggle)

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.valueLabel', { key: 'status' })),
      ).toBeInTheDocument()
    })
  })

  it('shows loading skeletons while data loads', async () => {
    // Never-resolving promise to simulate loading
    mockedInvoke.mockImplementation(() => new Promise(() => {}))

    const { container } = render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByTestId('property-loading')).toBeInTheDocument()
      expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
    })
  })

  it('renders property count in toggle label', async () => {
    setupMock(
      [makeProp('status', { value_text: 'active' }), makeProp('priority', { value_num: 1 })],
      [makeDef('status', 'text'), makeDef('priority', 'number')],
    )

    render(<PagePropertyTable pageId="PAGE_1" />)

    await waitFor(() => {
      const toggle = screen.getByRole('button', { name: /Properties/ })
      expect(toggle).toHaveTextContent(`${t('pageProperty.propertiesButton')} (2)`)
    })
  })
})

describe('PagePropertyTable property display', () => {
  it('text property renders as text input with correct value', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      const input = screen.getByLabelText(
        t('pageProperty.valueLabel', { key: 'author' }),
      ) as HTMLInputElement
      expect(input).toBeInTheDocument()
      expect(input.type).toBe('text')
      expect(input.value).toBe('Alice')
    })
  })

  it('number property renders as number input', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('priority', { value_num: 42 })], [makeDef('priority', 'number')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      const input = screen.getByLabelText(
        t('pageProperty.valueLabel', { key: 'priority' }),
      ) as HTMLInputElement
      expect(input.type).toBe('number')
      expect(input.value).toBe('42')
    })
  })

  it('date property renders as date input', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('due', { value_date: '2026-06-15' })], [makeDef('due', 'date')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      const input = screen.getByLabelText(
        t('pageProperty.valueLabel', { key: 'due' }),
      ) as HTMLInputElement
      expect(input.type).toBe('text')
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
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      const select = screen.getByLabelText(
        t('pageProperty.valueLabel', { key: 'stage' }),
      ) as HTMLSelectElement
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
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.valueLabel', { key: 'author' })),
      ).toBeInTheDocument()
    })

    const input = screen.getByLabelText(
      t('pageProperty.valueLabel', { key: 'author' }),
    ) as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'Bob')
    await user.tab()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'PAGE_1',
        key: 'author',
        value: {
          value_text: 'Bob',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      })
    })
  })

  it('number input saves on blur', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('priority', { value_num: 1 })], [makeDef('priority', 'number')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.valueLabel', { key: 'priority' })),
      ).toBeInTheDocument()
    })

    const input = screen.getByLabelText(
      t('pageProperty.valueLabel', { key: 'priority' }),
    ) as HTMLInputElement
    await user.clear(input)
    await user.type(input, '99')
    await user.tab()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'PAGE_1',
        key: 'priority',
        value: {
          value_num: 99,
          value_text: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
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
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.valueLabel', { key: 'stage' })),
      ).toBeInTheDocument()
    })

    const select = screen.getByLabelText(
      t('pageProperty.valueLabel', { key: 'stage' }),
    ) as HTMLSelectElement
    await user.selectOptions(select, 'DONE')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'PAGE_1',
        key: 'stage',
        value: {
          value_text: 'DONE',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      })
    })
  })

  it('delete button calls deleteProperty after confirmation', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.deletePropertyLabel', { key: 'author' })),
      ).toBeInTheDocument()
    })

    await user.click(
      screen.getByLabelText(t('pageProperty.deletePropertyLabel', { key: 'author' })),
    )

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

  it('hides delete button for non-deletable builtin properties', async () => {
    const user = userEvent.setup()
    setupMock(
      [
        makeProp('created_at', { value_text: '2026-01-01' }),
        makeProp('author', { value_text: 'Alice' }),
      ],
      [makeDef('author', 'text')],
    )

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.valueLabel', { key: 'author' })),
      ).toBeInTheDocument()
    })

    // Delete should be visible for custom property
    expect(
      screen.getByLabelText(t('pageProperty.deletePropertyLabel', { key: 'author' })),
    ).toBeInTheDocument()
    // Delete should NOT be visible for non-deletable builtin property
    expect(
      screen.queryByLabelText(t('pageProperty.deletePropertyLabel', { key: 'created_at' })),
    ).not.toBeInTheDocument()
  })
})

describe('PagePropertyTable add property flow', () => {
  it('"Add property" opens popover with definition list', async () => {
    setupMock([], [makeDef('status', 'text'), makeDef('weight', 'number')])

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.pickerLabel'))).toBeInTheDocument()
      expect(screen.getByText('Status')).toBeInTheDocument()
      expect(screen.getByText('Weight')).toBeInTheDocument()
    })
  })

  it('search filters definitions', async () => {
    const user = userEvent.setup()
    setupMock([], [makeDef('status', 'text'), makeDef('priority', 'number')])

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.searchLabel'))).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText(t('pageProperty.searchLabel')), 'stat')

    await waitFor(() => {
      expect(screen.getByText('Status')).toBeInTheDocument()
      expect(screen.queryByText('Priority')).not.toBeInTheDocument()
    })
  })

  // #2792 — text/select defs no longer persist an empty `value_text` on add;
  // see the "draft rows" describe block below for full coverage against the
  // real tauri-mock. This test only pins that a plain text def renders an
  // editable draft row locally instead of calling `set_property`.
  it('clicking a text definition adds a draft row WITHOUT calling set_property', async () => {
    const user = userEvent.setup()
    setupMock([], [makeDef('status', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByText('Status')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Status'))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.valueLabel', { key: 'status' })),
      ).toBeInTheDocument()
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
  })

  it('clicking a number definition initializes with valueNum: 0', async () => {
    const user = userEvent.setup()
    setupMock([], [makeDef('weight', 'number')])

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByText('Weight')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Weight'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'PAGE_1',
        key: 'weight',
        value: {
          value_num: 0,
          value_text: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      })
    })
  })

  it('clicking a date definition initializes with today as valueDate', async () => {
    const user = userEvent.setup()
    setupMock([], [makeDef('deadline', 'date')])

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByText('Deadline')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Deadline'))

    // Local calendar day — must match the component's `getTodayString()`
    // (buildInitParams uses it deliberately; `toISOString()` is UTC and goes
    // off-by-one for negative-offset timezones around midnight).
    const today = getTodayString()
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'PAGE_1',
        key: 'deadline',
        value: {
          value_date: today,
          value_text: null,
          value_num: null,
          value_ref: null,
          value_bool: null,
        },
      })
    })
  })

  // #2804 — a brand-new text def created via this flow has no valid empty
  // initializer (the backend rejects an empty `value_text`), so
  // `handleCreateDef` now routes text/select defs through the same draft-row
  // path as `handleAddFromDef` (#2792) instead of init-persisting. This test
  // only pins that the def is created and a draft row appears WITHOUT an
  // init `set_property` call; the full draft → non-empty-save round trip
  // (and the empty-draft-dropped case) is covered against the real
  // tauri-mock in the "create-def flow against the real tauri-mock (#2804)"
  // describe block below.
  it('"Create definition" flow: creates def then adds a draft row (no empty set_property)', async () => {
    const user = userEvent.setup()
    // Start with no definitions so "Create" button appears
    const props: PropertyRow[] = []
    const defs: PropertyDefinition[] = []

    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      const a = args as Record<string, unknown> | undefined
      if (cmd === 'get_properties') return [...props]
      if (cmd === 'list_property_defs')
        return { items: [...defs], next_cursor: null, has_more: false }
      if (cmd === 'create_property_def') {
        const newDef = makeDef(a?.['key'] as string, (a?.['valueType'] as string) ?? 'text')
        defs.push(newDef)
        return newDef
      }
      if (cmd === 'set_property') return undefined
      if (cmd === 'list_blocks')
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      if (cmd === 'list_tags_for_block') return []
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.searchLabel'))).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText(t('pageProperty.searchLabel')), 'newfield')

    // Click the "Create" prompt
    await waitFor(() => {
      expect(screen.getByText(/Create "newfield"/)).toBeInTheDocument()
    })
    await user.click(screen.getByText(/Create "newfield"/))

    // Should show type selector
    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.valueTypeLabel'))).toBeInTheDocument()
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

    // A draft row for the new definition renders locally…
    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.valueLabel', { key: 'newfield' })),
      ).toBeInTheDocument()
    })
    // …without ever init-persisting an empty `value_text`.
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
  })
  it('shows ref option in the property type dropdown', async () => {
    const user = userEvent.setup()
    const props: PropertyRow[] = []
    const defs: PropertyDefinition[] = []

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_properties') return [...props]
      if (cmd === 'list_property_defs')
        return { items: [...defs], next_cursor: null, has_more: false }
      if (cmd === 'list_blocks')
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      if (cmd === 'list_tags_for_block') return []
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.searchLabel'))).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText(t('pageProperty.searchLabel')), 'myref')

    await waitFor(() => {
      expect(screen.getByText(/Create "myref"/)).toBeInTheDocument()
    })
    await user.click(screen.getByText(/Create "myref"/))

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.valueTypeLabel'))).toBeInTheDocument()
    })

    const select = screen.getByLabelText(t('pageProperty.valueTypeLabel')) as HTMLSelectElement
    const opts = Array.from(select.options).map((o) => o.value)
    expect(opts).toContain('ref')
  })

  it('displays formatted property names in the add-property popover', async () => {
    setupMock([], [makeDef('reviewed_at', 'date'), makeDef('my_custom_prop', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByText('Reviewed At')).toBeInTheDocument()
      expect(screen.getByText('My Custom Prop')).toBeInTheDocument()
      // Raw keys should NOT appear
      expect(screen.queryByText('reviewed_at')).not.toBeInTheDocument()
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
      expect(mockedToastError).toHaveBeenCalledWith(t('pageProperty.loadFailed'))
    })
  })

  it('FE-H-17: partial failure (listPropertyDefs rejects) renders properties and reports failure', async () => {
    // get_properties succeeds, list_property_defs rejects — the table should
    // still render the property row from the successful side and surface the
    // defs failure via reportIpcError instead of failing the whole load.
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_properties') return [makeProp('author', { value_text: 'Alice' })]
      if (cmd === 'list_property_defs') throw new Error('defs IPC failed')
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" />)

    // (a) The successful side renders. Expand to see the property row.
    await user.click(await screen.findByRole('button', { name: /Properties/ }))
    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.valueLabel', { key: 'author' })),
      ).toBeInTheDocument()
    })

    // (b) reportIpcError was called for the listPropertyDefs failure with the
    // module/messageKey/context expected by FE-H-17.
    expect(mockedReportIpcError).toHaveBeenCalledWith(
      'PagePropertyTable',
      'pageProperty.loadFailed',
      expect.any(Error),
      expect.any(Function),
      expect.objectContaining({ pageId: 'PAGE_1', fetch: 'listPropertyDefs' }),
    )
    // The successful fetch must NOT trigger a report.
    expect(mockedReportIpcError).not.toHaveBeenCalledWith(
      'PagePropertyTable',
      'pageProperty.loadFailed',
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ fetch: 'getProperties' }),
    )
  })

  it('save error shows toast', async () => {
    const user = userEvent.setup()
    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_properties') return [makeProp('author', { value_text: 'Alice' })]
      if (cmd === 'list_property_defs')
        return { items: [makeDef('author', 'text')], next_cursor: null, has_more: false }
      if (cmd === 'set_property') {
        callCount++
        if (callCount >= 1) throw new Error('save failed')
      }
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.valueLabel', { key: 'author' })),
      ).toBeInTheDocument()
    })

    const input = screen.getByLabelText(
      t('pageProperty.valueLabel', { key: 'author' }),
    ) as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'Bob')
    await user.tab()

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('pageProperty.saveFailed'))
    })
  })
})

describe('PagePropertyTable error paths (mockRejectedValue)', () => {
  it('delete_property rejection shows deleteFailed toast', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_properties') return [makeProp('author', { value_text: 'Alice' })]
      if (cmd === 'list_property_defs')
        return { items: [makeDef('author', 'text')], next_cursor: null, has_more: false }
      if (cmd === 'delete_property') throw new Error('backend delete error')
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.deletePropertyLabel', { key: 'author' })),
      ).toBeInTheDocument()
    })

    await user.click(
      screen.getByLabelText(t('pageProperty.deletePropertyLabel', { key: 'author' })),
    )

    // Confirm in the dialog
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Delete$/i })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /^Delete$/i }))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('pageProperty.deleteFailed'))
    })
  })

  it('set_property rejection during handleAddFromDef shows addFailed toast', async () => {
    const user = userEvent.setup()
    // #2792 — a number def persists immediately on add (buildInitParams gives
    // a valid `value_num: 0`), so this exercises the add-time failure path.
    // (text/select defs no longer persist on add — see the draft-row tests.)
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs')
        return { items: [makeDef('weight', 'number')], next_cursor: null, has_more: false }
      if (cmd === 'set_property') throw new Error('backend set error')
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByText('Weight')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Weight'))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('pageProperty.addFailed'))
    })
  })

  it('get_properties rejection during handleAddFromDef shows addFailed toast', async () => {
    const user = userEvent.setup()
    let addPhase = false
    // #2792 — number def (see note above): still init-persists on add.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_properties') {
        if (addPhase) throw new Error('backend reload error')
        return []
      }
      if (cmd === 'list_property_defs')
        return { items: [makeDef('weight', 'number')], next_cursor: null, has_more: false }
      if (cmd === 'set_property') {
        addPhase = true
        return undefined
      }
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByText('Weight')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Weight'))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('pageProperty.addFailed'))
    })
  })

  it('create_property_def rejection shows error message from backend', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs')
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      if (cmd === 'create_property_def') throw new Error('Duplicate key "status"')
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.searchLabel'))).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText(t('pageProperty.searchLabel')), 'status')

    await waitFor(() => {
      expect(screen.getByText(/Create "status"/)).toBeInTheDocument()
    })
    await user.click(screen.getByText(/Create "status"/))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create definition/i })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /create definition/i }))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Duplicate key "status"')
    })
  })

  it('create_property_def rejection without message shows fallback toast', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs')
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      if (cmd === 'create_property_def') {
        const err: Record<string, unknown> = new Error() as unknown as Record<string, unknown>
        err['message'] = undefined
        throw err
      }
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.searchLabel'))).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText(t('pageProperty.searchLabel')), 'newprop')

    await waitFor(() => {
      expect(screen.getByText(/Create "newprop"/)).toBeInTheDocument()
    })
    await user.click(screen.getByText(/Create "newprop"/))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create definition/i })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /create definition/i }))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('property.createDefFailed'))
    })
  })

  it('set_property rejection during handleCreateDef shows error toast', async () => {
    const user = userEvent.setup()
    // #2804 — text/select defs no longer init-persist on create (see the
    // "creates a draft row" tests), so this exercises the init-persist
    // failure path with a number def instead, which still calls
    // `set_property` immediately after creation.
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      const a = args as Record<string, unknown> | undefined
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs')
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      if (cmd === 'create_property_def')
        return makeDef((a?.['key'] as string) ?? 'myprop', (a?.['valueType'] as string) ?? 'number')
      if (cmd === 'set_property') throw new Error('set failed after create')
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.searchLabel'))).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText(t('pageProperty.searchLabel')), 'myprop')

    await waitFor(() => {
      expect(screen.getByText(/Create "myprop"/)).toBeInTheDocument()
    })
    await user.click(screen.getByText(/Create "myprop"/))

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.valueTypeLabel'))).toBeInTheDocument()
    })
    const select = screen.getByLabelText(t('pageProperty.valueTypeLabel')) as HTMLSelectElement
    await user.selectOptions(select, 'number')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create definition/i })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /create definition/i }))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('set failed after create')
    })
  })

  it('component does not crash when all invoke calls reject on mount', async () => {
    mockedInvoke.mockRejectedValue(new Error('total failure'))

    const { container } = render(<PagePropertyTable pageId="PAGE_1" />)

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('pageProperty.loadFailed'))
    })

    // Component should not crash — should either render nothing or a degraded state
    expect(container).toBeTruthy()
  })
})

describe('PagePropertyTable accessibility', () => {
  it('collapsed state has no a11y violations', async () => {
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])

    const { container } = render(<PagePropertyTable pageId="PAGE_1" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Properties/ })).toBeInTheDocument()
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('expanded state has no a11y violations', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])

    const { container } = render(<PagePropertyTable pageId="PAGE_1" />)

    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.valueLabel', { key: 'author' })),
      ).toBeInTheDocument()
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
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.valueLabel', { key: 'priority' })),
      ).toBeInTheDocument()
    })

    const input = screen.getByLabelText(
      t('pageProperty.valueLabel', { key: 'priority' }),
    ) as HTMLInputElement
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
      expect(mockedToastError).toHaveBeenCalledWith(t('property.invalidNumber'))
    })
  })

  it('shows confirmation dialog before deleting property', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.deletePropertyLabel', { key: 'author' })),
      ).toBeInTheDocument()
    })

    await user.click(
      screen.getByLabelText(t('pageProperty.deletePropertyLabel', { key: 'author' })),
    )

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
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.deletePropertyLabel', { key: 'author' })),
      ).toBeInTheDocument()
    })

    await user.click(
      screen.getByLabelText(t('pageProperty.deletePropertyLabel', { key: 'author' })),
    )

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
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })),
      ).toBeInTheDocument()
    })
  })

  it('does not show edit options button for non-select properties', async () => {
    const user = userEvent.setup()
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.valueLabel', { key: 'author' })),
      ).toBeInTheDocument()
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
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })),
      ).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })))

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.newOptionLabel'))).toBeInTheDocument()
      // All three options should be listed in the popover
      expect(
        screen.getByLabelText(t('pageProperty.removeOptionLabel', { option: 'TODO' })),
      ).toBeInTheDocument()
      expect(
        screen.getByLabelText(t('pageProperty.removeOptionLabel', { option: 'DOING' })),
      ).toBeInTheDocument()
      expect(
        screen.getByLabelText(t('pageProperty.removeOptionLabel', { option: 'DONE' })),
      ).toBeInTheDocument()
    })
  })

  it('can add a new option and save', async () => {
    const user = userEvent.setup()
    setupMock(
      [makeProp('stage', { value_text: 'TODO' })],
      [makeDef('stage', 'select', '["TODO","DOING"]')],
    )

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })),
      ).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })))

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.newOptionLabel'))).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText(t('pageProperty.newOptionLabel')), 'DONE')
    await user.click(screen.getByLabelText(t('pageProperty.addOptionLabel')))

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
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })),
      ).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.removeOptionLabel', { option: 'DOING' })),
      ).toBeInTheDocument()
    })

    // Remove "DOING"
    await user.click(
      screen.getByLabelText(t('pageProperty.removeOptionLabel', { option: 'DOING' })),
    )

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
      if (cmd === 'list_property_defs')
        return {
          items: [makeDef('stage', 'select', '["TODO","DOING"]')],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      if (cmd === 'update_property_def_options') throw new Error('backend error')
      if (cmd === 'list_blocks')
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      if (cmd === 'list_tags_for_block') return []
      return null
    })

    render(<PagePropertyTable pageId="PAGE_1" />)
    await user.click(screen.getByRole('button', { name: /Properties/ }))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })),
      ).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save options/i })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /save options/i }))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('pageProperty.updateOptionsFailed'))
    })
  })
})

describe('PagePropertyTable task-only property filtering', () => {
  it('filters out task-only and non-deletable properties from add-property options', async () => {
    setupMock(
      [],
      [
        makeDef('effort', 'number'),
        makeDef('assignee', 'text'),
        makeDef('location', 'text'),
        makeDef('due_date', 'date'),
        makeDef('created_at', 'date'),
        makeDef('custom_prop', 'text'),
      ],
    )

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.pickerLabel'))).toBeInTheDocument()
    })

    // Task-only properties should be filtered
    expect(screen.queryByText('Effort')).not.toBeInTheDocument()
    expect(screen.queryByText('Assignee')).not.toBeInTheDocument()
    expect(screen.queryByText('Location')).not.toBeInTheDocument()
    // Non-deletable builtin properties should be filtered
    expect(screen.queryByText('Due Date')).not.toBeInTheDocument()
    expect(screen.queryByText('Created At')).not.toBeInTheDocument()
    // Custom properties should remain
    expect(screen.getByText('Custom Prop')).toBeInTheDocument()
  })

  it('shows ref-type properties in add-property options', async () => {
    setupMock([], [makeDef('linked_page', 'ref'), makeDef('notes', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.pickerLabel'))).toBeInTheDocument()
    })

    expect(screen.getByText('Linked Page')).toBeInTheDocument()
    expect(screen.getByText('Notes')).toBeInTheDocument()
  })

  it('clicking a ref definition initializes with valueRef: null', async () => {
    const user = userEvent.setup()
    setupMock([], [makeDef('linked_page', 'ref')])

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    await waitFor(() => {
      expect(screen.getByText('Linked Page')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Linked Page'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'PAGE_1',
        key: 'linked_page',
        value: {
          value_ref: null,
          value_text: null,
          value_num: null,
          value_date: null,
          value_bool: null,
        },
      })
    })
  })
})

describe('PagePropertyTable forceExpanded', () => {
  it('renders and auto-expands when forceExpanded is true', async () => {
    setupMock([], [makeDef('status', 'text')])

    render(<PagePropertyTable pageId="PAGE_1" forceExpanded />)

    // Should render even with no properties
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Properties/ })).toBeInTheDocument()
    })

    // Should auto-expand and open add-property popover
    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.pickerLabel'))).toBeInTheDocument()
    })
  })

  it('does not render when no properties and forceExpanded is false', async () => {
    setupMock()
    render(<PagePropertyTable pageId="PAGE_1" />)

    // Wait for loading to finish before asserting absence
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Properties/ })).not.toBeInTheDocument()
    })
  })

  it('renders when properties exist without forceExpanded', async () => {
    setupMock([makeProp('author', { value_text: 'Alice' })], [makeDef('author', 'text')])
    render(<PagePropertyTable pageId="PAGE_1" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Properties/ })).toBeInTheDocument()
    })
  })
})

// ── #2792 — add-from-definition against the REAL tauri-mock ────────────────
//
// Every test above stubs `invoke` directly with hand-written command
// responses, which is exactly why the empty-`value_text` bug (#2792, the
// PagePropertyTable sibling of #2656) was latent: the stubs never modeled
// the backend's `set_property` value validation, so an invalid empty write
// would have "succeeded" silently. This block instead routes the mocked
// `invoke` through the real `dispatch()` from `@/lib/tauri-mock/handlers`,
// whose `assertValidSetPropertyValue` mirrors `op.rs::validate_property_value`
// and rejects an empty `value_text` (and an out-of-options select value).
// Follows the draft-row test pattern from `BlockPropertyDrawer.test.tsx` (#2656).
describe('PagePropertyTable add-from-definition against the real tauri-mock (#2792)', () => {
  const PAGE_ID = SEED_IDS.PAGE_QUICK_NOTES

  beforeEach(() => {
    seedBlocks()
    // The seed loop stamps every seeded page with a `space` ref property;
    // clear it so this page starts from a clean, deterministic property list.
    properties.set(PAGE_ID, new Map())
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  })

  it('text add-from-def creates an editable draft WITHOUT an empty set_property', async () => {
    const user = userEvent.setup()
    // `context` is a seeded text-typed property definition (see tauri-mock/seed.ts).
    render(<PagePropertyTable pageId={PAGE_ID} forceExpanded />)

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument()
    })
    await user.click(screen.getByText('Context'))

    // An editable draft input appears…
    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.valueLabel', { key: 'context' })),
      ).toBeInTheDocument()
    })
    // …and NO empty-value set_property was fired. Without the #2792 fix this
    // calls `set_property` with `value_text: ''`, which the real mock's
    // `assertValidSetPropertyValue` rejects (mirroring the backend) — that
    // rejection would otherwise surface as an addFailed toast.
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
    expect(mockedToastError).not.toHaveBeenCalled()
  })

  it('persists a non-empty text draft save via the real mock', async () => {
    const user = userEvent.setup()
    render(<PagePropertyTable pageId={PAGE_ID} forceExpanded />)

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument()
    })
    await user.click(screen.getByText('Context'))

    const input = await screen.findByLabelText(t('pageProperty.valueLabel', { key: 'context' }))
    await user.type(input, 'work')
    await user.tab()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'set_property',
        expect.objectContaining({
          blockId: PAGE_ID,
          key: 'context',
          value: expect.objectContaining({ value_text: 'work' }),
        }),
      )
    })
    // Actually persisted in the mock store, not just called.
    expect(properties.get(PAGE_ID)?.get('context')?.['value_text']).toBe('work')
    expect(mockedToastError).not.toHaveBeenCalled()
  })

  it('drops an empty text draft on blur without any set_property call', async () => {
    const user = userEvent.setup()
    render(<PagePropertyTable pageId={PAGE_ID} forceExpanded />)

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument()
    })
    await user.click(screen.getByText('Context'))

    const input = await screen.findByLabelText(t('pageProperty.valueLabel', { key: 'context' }))
    input.focus()
    await user.tab() // blur with no value entered → draft dropped

    await waitFor(() => {
      expect(
        screen.queryByLabelText(t('pageProperty.valueLabel', { key: 'context' })),
      ).not.toBeInTheDocument()
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
    expect(properties.get(PAGE_ID)?.get('context')).toBeUndefined()
  })

  it('select add-from-def creates a draft; picking a valid option persists via the real mock', async () => {
    const user = userEvent.setup()
    // `project` is a seeded select-typed def with options alpha/beta/gamma.
    render(<PagePropertyTable pageId={PAGE_ID} forceExpanded />)

    await waitFor(() => {
      expect(screen.getByText('Project')).toBeInTheDocument()
    })
    await user.click(screen.getByText('Project'))

    // Draft select renders with the definition's seeded options and no
    // premature set_property call (the empty-value bug — and, for select,
    // an invalid-option write — are both guarded by the real mock).
    const select = await screen.findByLabelText(t('pageProperty.valueLabel', { key: 'project' }))
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())

    await user.selectOptions(select, 'alpha')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'set_property',
        expect.objectContaining({
          blockId: PAGE_ID,
          key: 'project',
          value: expect.objectContaining({ value_text: 'alpha' }),
        }),
      )
    })
    expect(properties.get(PAGE_ID)?.get('project')?.['value_text']).toBe('alpha')
    expect(mockedToastError).not.toHaveBeenCalled()
  })

  it('number and boolean defs still init-persist immediately via the real mock', async () => {
    const user = userEvent.setup()
    propertyDefs.set('weight', {
      key: 'weight',
      value_type: 'number',
      options: null,
      created_at: new Date().toISOString(),
    })
    propertyDefs.set('is_featured', {
      key: 'is_featured',
      value_type: 'boolean',
      options: null,
      created_at: new Date().toISOString(),
    })

    render(<PagePropertyTable pageId={PAGE_ID} forceExpanded />)

    await waitFor(() => {
      expect(screen.getByText('Weight')).toBeInTheDocument()
      expect(screen.getByText('Is Featured')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Weight'))
    await waitFor(() => {
      expect(properties.get(PAGE_ID)?.get('weight')?.['value_num']).toBe(0)
    })

    // Picking a definition closes the popover — reopen it for the second pick.
    await user.click(screen.getByRole('button', { name: 'Add property' }))
    await waitFor(() => {
      expect(screen.getByText('Is Featured')).toBeInTheDocument()
    })
    await user.click(screen.getByText('Is Featured'))
    await waitFor(() => {
      expect(properties.get(PAGE_ID)?.get('is_featured')?.['value_bool']).toBe(0)
    })
    expect(mockedToastError).not.toHaveBeenCalled()
  })
})

// ── #2804 — create-definition flow against the REAL tauri-mock ─────────────
//
// #2792 fixed the empty-`value_text` bug for `handleAddFromDef` (adding an
// EXISTING def); `handleCreateDef` (defining a brand-new def via the
// "Create definition" flow, which defaults to type `text`) had the same
// root cause and is fixed here. Mirrors the "add-from-definition against the
// real tauri-mock (#2792)" block above: the mocked `invoke` routes through
// the real `dispatch()` so `assertValidSetPropertyValue` enforces the
// empty-value rule the hand-rolled stubs above never modeled.
describe('PagePropertyTable create-def flow against the real tauri-mock (#2804)', () => {
  const PAGE_ID = SEED_IDS.PAGE_QUICK_NOTES

  beforeEach(() => {
    seedBlocks()
    // Clear the seeded `space` ref property so this page starts from a
    // clean, deterministic property list (mirrors the #2792 block above).
    properties.set(PAGE_ID, new Map())
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  })

  /** Drives the popover through "Create '<key>'" up to clicking "Create definition" (type stays the default: text). */
  async function createTextDef(user: ReturnType<typeof userEvent.setup>, key: string) {
    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.searchLabel'))).toBeInTheDocument()
    })
    await user.type(screen.getByLabelText(t('pageProperty.searchLabel')), key)

    await waitFor(() => {
      expect(screen.getByText(new RegExp(`Create "${key}"`))).toBeInTheDocument()
    })
    await user.click(screen.getByText(new RegExp(`Create "${key}"`)))

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.valueTypeLabel'))).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /create definition/i }))
  }

  it('creates a text def and adds a draft row WITHOUT an empty set_property', async () => {
    const user = userEvent.setup()
    render(<PagePropertyTable pageId={PAGE_ID} forceExpanded />)

    await createTextDef(user, 'newfield')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_property_def', {
        key: 'newfield',
        valueType: 'text',
        options: null,
      })
    })
    expect(propertyDefs.get('newfield')).toBeTruthy()

    // A draft row renders for value entry…
    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.valueLabel', { key: 'newfield' })),
      ).toBeInTheDocument()
    })
    // …and NO empty-value set_property was fired. Without the #2804 fix this
    // calls `set_property` with `value_text: ''`, which the real mock's
    // `assertValidSetPropertyValue` rejects (mirroring the backend).
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
    expect(mockedToastError).not.toHaveBeenCalled()
  })

  it('persists a non-empty draft save after create-def, persisting both the def and the value', async () => {
    const user = userEvent.setup()
    render(<PagePropertyTable pageId={PAGE_ID} forceExpanded />)

    await createTextDef(user, 'newfield')

    const input = await screen.findByLabelText(t('pageProperty.valueLabel', { key: 'newfield' }))
    await user.type(input, 'work')
    await user.tab()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'set_property',
        expect.objectContaining({
          blockId: PAGE_ID,
          key: 'newfield',
          value: expect.objectContaining({ value_text: 'work' }),
        }),
      )
    })
    // Both the definition and the value actually landed in the mock store,
    // not just the invoke call.
    expect(propertyDefs.get('newfield')).toMatchObject({ key: 'newfield', value_type: 'text' })
    expect(properties.get(PAGE_ID)?.get('newfield')?.['value_text']).toBe('work')
    expect(mockedToastError).not.toHaveBeenCalled()
  })

  it('drops an empty draft on blur after create-def without any set_property call', async () => {
    const user = userEvent.setup()
    render(<PagePropertyTable pageId={PAGE_ID} forceExpanded />)

    await createTextDef(user, 'newfield')

    const input = await screen.findByLabelText(t('pageProperty.valueLabel', { key: 'newfield' }))
    input.focus()
    await user.tab() // blur with no value entered → draft dropped

    await waitFor(() => {
      expect(
        screen.queryByLabelText(t('pageProperty.valueLabel', { key: 'newfield' })),
      ).not.toBeInTheDocument()
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
    // The def itself was still created — only the value write was skipped.
    expect(propertyDefs.get('newfield')).toBeTruthy()
    expect(properties.get(PAGE_ID)?.get('newfield')).toBeUndefined()
  })
})
