/**
 * Tests for PropertyDefinitionsList component.
 *
 * Validates:
 *  - Renders the selected space's definitions, the active one by default,
 *    without the internal `is_space` (#5629, #5841)
 *  - Search/filter functionality
 *  - Delete with confirmation
 *  - A built-in shows a lock and offers no edit or delete (#5841)
 *  - Has no a11y violations (axe)
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { mockInvokeCommands, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { PropertyDefinitionsList } from '@/components/properties/PropertyDefinitionsList'
import type { AppError, PageResponse, PropertyDefinition } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks, spacePropertyDefs } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

const mockedInvoke = vi.mocked(invoke)

function stubInvoke(handlers: Readonly<TypedInvokeHandlers>): void {
  // #5841 S0 — the list also loads its usage counts; a test that stubs none shows none.
  mockedInvoke.mockImplementation(
    mockInvokeCommands({ count_property_usage: () => [], ...handlers }),
  )
}

/** Stub the `list_property_defs` load with one page of definitions. */
function stubDefs(page: PageResponse<PropertyDefinition>): void {
  stubInvoke({ list_property_defs: () => page })
}

function makePropDef(
  key: string,
  valueType = 'text',
  options: string | null = null,
): PropertyDefinition {
  return {
    key,
    value_type: valueType,
    options,
    created_at: '2025-01-15T00:00:00Z',
    builtin: false,
  }
}

/** A built-in definition as `list_property_defs` returns it (#5841). */
function makeBuiltinDef(key: string, valueType: string, options: string | null = null) {
  return { ...makePropDef(key, valueType, options), builtin: true }
}

/**
 * `list_property_defs` is cursor-paginated and returns a
 * `PageResponse<PropertyDefinition>` envelope, not a flat array.
 *
 * #4668 — this used to omit `total_count`, a key `PageResponse` always
 * serialises (`bindings.ts`), so every stub here returned a shape the backend
 * cannot send. Annotating the return type is what makes that a `tsc` failure.
 */
function pageOf(items: PropertyDefinition[]): PageResponse<PropertyDefinition> {
  return { items, next_cursor: null, has_more: false, total_count: null }
}

const PERSONAL = { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }
const WORK = { id: 'SPACE_WORK', name: 'Work', accent_color: null }

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({ currentSpaceId: PERSONAL.id, availableSpaces: [PERSONAL] })
})

describe('PropertyDefinitionsList', () => {
  it('renders property definitions list', async () => {
    stubDefs(
      pageOf([
        makePropDef('status', 'select', '["open","closed"]'),
        makePropDef('priority', 'number'),
        makePropDef('due', 'date'),
      ]),
    )

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Due')).toBeInTheDocument()
  })

  // #5629 — every space block carries `is_space`, the app's bookkeeping.
  it('hides the internal is_space definition', async () => {
    stubDefs(pageOf([makeBuiltinDef('is_space', 'select', '["true"]'), makePropDef('status')]))

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Status')).toBeInTheDocument()
    expect(screen.queryByText('Is Space')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: t('properties.deleteDefinition', { key: 'is_space' }) }),
    ).not.toBeInTheDocument()
  })

  it('typing is_space keeps Create disabled and says the key exists', async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([makeBuiltinDef('is_space', 'select', '["true"]'), makePropDef('status')]))

    render(<PropertyDefinitionsList />)
    await screen.findByText('Status')

    await user.type(screen.getByLabelText(t('propertiesView.createKey')), 'is_space')

    expect(screen.getByRole('button', { name: t('propertiesView.create') })).toBeDisabled()
    expect(screen.getByText(t('propertiesView.duplicateKey'))).toBeInTheDocument()
  })

  it('shows loading state initially', () => {
    stubInvoke({ list_property_defs: () => new Promise<never>(() => {}) })

    const { container } = render(<PropertyDefinitionsList />)

    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(3)
  })

  it('shows empty state when no definitions', async () => {
    stubDefs(pageOf([]))

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('No property definitions yet')).toBeInTheDocument()
  })

  it('search filters definitions by key', async () => {
    const user = userEvent.setup()
    stubDefs(
      pageOf([
        makePropDef('status', 'select'),
        makePropDef('priority', 'number'),
        makePropDef('due-date', 'date'),
      ]),
    )

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Due Date')).toBeInTheDocument()

    const searchInput = screen.getByPlaceholderText('Search properties...')
    await user.type(searchInput, 'pri')

    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.queryByText('Status')).not.toBeInTheDocument()
    expect(screen.queryByText('Due Date')).not.toBeInTheDocument()
  })

  // Unicode-aware fold via `matchesSearchFolded`.
  it('search matches accented property key via diacritic fold', async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([makePropDef('café-visits', 'number'), makePropDef('priority', 'number')]))

    render(<PropertyDefinitionsList />)

    // `formatPropertyName` renders `café-visits` as `Café Visits`.
    await screen.findByText('Café Visits')
    const searchInput = screen.getByPlaceholderText('Search properties...')
    await user.type(searchInput, 'cafe')

    expect(screen.getByText('Café Visits')).toBeInTheDocument()
    expect(screen.queryByText('Priority')).not.toBeInTheDocument()
  })

  it('create button creates a new definition', async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([]))

    render(<PropertyDefinitionsList />)

    await waitFor(() => {
      expect(screen.getByText('No property definitions yet')).toBeInTheDocument()
    })

    stubInvoke({ create_property_def: () => makePropDef('my-prop', 'text') })

    const keyInput = screen.getByPlaceholderText('Property key')
    await user.type(keyInput, 'my-prop')

    const createBtn = screen.getByRole('button', { name: /Create/i })
    await user.click(createBtn)

    expect(await screen.findByText('My Prop')).toBeInTheDocument()

    expect(mockedInvoke).toHaveBeenCalledWith('create_property_def', {
      spaceId: PERSONAL.id,
      key: 'my-prop',
      valueType: 'text',
      options: null,
    })

    expect(keyInput).toHaveValue('')
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Property definition created')
  })

  // #5449 — the backend refuses a select definition without options.
  it('a select definition is created only with its options', async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([]))

    render(<PropertyDefinitionsList />)

    await waitFor(() => {
      expect(screen.getByText('No property definitions yet')).toBeInTheDocument()
    })

    stubInvoke({ create_property_def: () => makePropDef('size', 'select', '["small","large"]') })

    await user.type(screen.getByPlaceholderText('Property key'), 'size')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'select')
    const createBtn = screen.getByRole('button', { name: /Create/i })
    expect(createBtn).toBeDisabled()

    await user.type(
      screen.getByRole('textbox', { name: 'Options, comma-separated' }),
      'small, ,large',
    )
    await user.click(createBtn)

    expect(await screen.findByText('Size')).toBeInTheDocument()
    expect(mockedInvoke).toHaveBeenCalledWith('create_property_def', {
      spaceId: PERSONAL.id,
      key: 'size',
      valueType: 'select',
      options: '["small","large"]',
    })
  })

  // #5736 — a boolean key is declarable here too, not only from a page's Properties table.
  it('creates a boolean definition', async () => {
    const user = userEvent.setup()
    seedBlocks()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
    render(<PropertyDefinitionsList />)
    await user.type(await screen.findByPlaceholderText('Property key'), 'billable')

    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'boolean')
    await user.click(screen.getByRole('button', { name: /Create/i }))

    await waitFor(() => {
      expect(spacePropertyDefs(PERSONAL.id).get('billable')?.['value_type']).toBe('boolean')
    })
  })

  it('delete button shows confirmation dialog', async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([makePropDef('to-delete', 'text')]))

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('To Delete')).toBeInTheDocument()

    const deleteBtn = screen.getByRole('button', { name: /Delete property to-delete/i })
    await user.click(deleteBtn)

    expect(await screen.findByText('Delete this property definition?')).toBeInTheDocument()
    expect(screen.getByText(t('propertiesView.deleteDesc'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Delete/i })).toBeInTheDocument()
  })

  it('styles the delete confirm as destructive and focuses Cancel first', async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([makePropDef('to-delete', 'text')]))

    render(<PropertyDefinitionsList />)

    await user.click(await screen.findByRole('button', { name: /Delete property to-delete/i }))

    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
    expect(confirmBtn).toHaveClass('bg-destructive')
    expect(screen.getByRole('button', { name: /Cancel/i })).toHaveFocus()
  })

  it('confirming delete removes the definition', async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([makePropDef('to-delete', 'text')]))

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('To Delete')).toBeInTheDocument()

    stubInvoke({ delete_property_def: () => null })

    const deleteBtn = screen.getByRole('button', { name: /Delete property to-delete/i })
    await user.click(deleteBtn)

    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(screen.queryByText('To Delete')).not.toBeInTheDocument()
    })

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Property definition deleted')
  })

  it('shows edit options button for select-type properties', async () => {
    stubDefs(
      pageOf([
        makePropDef('status', 'select', '["open","closed"]'),
        makePropDef('priority', 'number'),
      ]),
    )

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Status')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Edit options/i })).toBeInTheDocument()
  })

  it('Edit options comes before Delete in the tab order, as drawn on desktop', async () => {
    stubDefs(pageOf([makePropDef('status', 'select', '["open","closed"]')]))

    render(<PropertyDefinitionsList />)

    const edit = await screen.findByRole('button', { name: /Edit options/i })
    const del = screen.getByRole('button', { name: /Delete property/i })
    expect(edit.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // ---------------------------------------------------------------------------
  // Error path tests
  // ---------------------------------------------------------------------------

  it('shows toast error when loading definitions fails', async () => {
    stubInvoke({ list_property_defs: () => Promise.reject(new Error('DB error')) })

    render(<PropertyDefinitionsList />)

    // Error reporting now goes through reportIpcError —
    // toast carries only the localized message; the Error detail
    // is logged separately, not surfaced in the toast string.
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load property definitions'),
      )
    })
  })

  it('shows toast error when creating a definition fails', async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([])) // initial load

    render(<PropertyDefinitionsList />)

    await waitFor(() => {
      expect(screen.getByText('No property definitions yet')).toBeInTheDocument()
    })

    stubInvoke({ create_property_def: () => Promise.reject(new Error('Duplicate key')) })

    const keyInput = screen.getByPlaceholderText('Property key')
    await user.type(keyInput, 'my-prop')

    const createBtn = screen.getByRole('button', { name: /Create/i })
    await user.click(createBtn)

    // See loading test above.
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create property definition'),
      )
    })
    // The definition should NOT appear in the list
    expect(screen.queryByText('My Prop')).not.toBeInTheDocument()
  })

  // #4399 — Settings -> Properties is the entry point the issue calls "the
  // direct one": type `year`, pick `number`, done. The backend now refuses
  // when the space already holds `year` values that `number` would reject,
  // and the reason has to reach the user — the offending blocks are anywhere
  // in the space, so "Failed to create property definition" leaves nothing to
  // act on. Note the rejection is the AppError OBJECT (what `unwrap` throws),
  // not an `Error`; the test above pins that a transport `Error` still gets
  // the generic toast, so this cannot pass by showing every thrown message.
  it("shows the backend's reason when a definition would trap existing values", async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([])) // initial load

    render(<PropertyDefinitionsList />)

    await waitFor(() => {
      expect(screen.getByText('No property definitions yet')).toBeInTheDocument()
    })

    const trapped: AppError = {
      kind: 'validation',
      code: null,
      message:
        "cannot declare property 'year' as 'number': 1 value(s) already stored under this key " +
        'would be rejected by that type (1 stored as text).',
    }
    stubInvoke({ create_property_def: () => Promise.reject(trapped) })

    await user.type(screen.getByPlaceholderText('Property key'), 'year')
    await user.click(screen.getByRole('button', { name: /Create/i }))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining("cannot declare property 'year' as 'number'"),
      )
    })
    expect(vi.mocked(toast.error)).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to create property definition'),
    )
    expect(screen.queryByText('Year')).not.toBeInTheDocument()
  })

  it('shows toast error when deleting a definition fails and keeps item', async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([makePropDef('to-delete', 'text')])) // initial load

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('To Delete')).toBeInTheDocument()

    stubInvoke({ delete_property_def: () => Promise.reject(new Error('Not found')) })

    const deleteBtn = screen.getByRole('button', { name: /Delete property to-delete/i })
    await user.click(deleteBtn)

    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
    await user.click(confirmBtn)

    // See loading test above.
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete property definition'),
      )
    })
    // The definition should still be in the list
    expect(screen.getByText('To Delete')).toBeInTheDocument()
  })

  // #5449 — a definition a block still uses is refused; the user is told why.
  it("shows the backend's reason when a definition in use is not deleted", async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([makePropDef('project', 'text')]))

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Project')).toBeInTheDocument()

    const inUse: AppError = {
      kind: 'validation',
      code: null,
      message:
        "Can't delete 'project': 2 block(s) still use it. Remove the property from them first.",
    }
    stubInvoke({ delete_property_def: () => Promise.reject(inUse) })

    await user.click(screen.getByRole('button', { name: 'Delete property project' }))
    await user.click(await screen.findByRole('button', { name: /^Delete$/i }))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(inUse.message)
    })
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Project')).toBeInTheDocument()
  })

  it('shows toast error when saving options fails', async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([makePropDef('status', 'select', '["open","closed"]')])) // initial load

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Status')).toBeInTheDocument()

    // Open the edit options popover
    const editBtn = screen.getByRole('button', { name: /Edit options/i })
    await user.click(editBtn)

    stubInvoke({
      update_property_def_options: () => Promise.reject(new Error('Invalid JSON')),
    })

    const optionsInput = screen.getByLabelText('Options JSON')
    // Client-side parse validation now disables Save on invalid
    // input, so the toast-on-server-error path requires a payload that
    // parses locally but is rejected by the backend mock.
    fireEvent.change(optionsInput, { target: { value: '["a"]' } })

    const saveBtn = screen.getByRole('button', { name: /Save/i })
    await user.click(saveBtn)

    // See loading test above.
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update options'),
      )
    })
  })

  it('has no a11y violations', async () => {
    stubDefs(
      pageOf([
        makePropDef('status', 'select', '["open","closed"]'),
        makePropDef('priority', 'number'),
      ]),
    )

    const { container } = render(<PropertyDefinitionsList />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('includes ref type in the create-property type dropdown', async () => {
    stubDefs(pageOf([]))

    render(<PropertyDefinitionsList />)

    await waitFor(() => {
      // Paginated wrapper threads `cursor` + `limit` (both null
      // when omitted) through the IPC layer.
      expect(mockedInvoke).toHaveBeenCalledWith('list_property_defs', {
        spaceId: PERSONAL.id,
        cursor: null,
        limit: null,
      })
    })

    // The mock renders a native <select> for the type selector
    const typeSelects = screen.getAllByRole('combobox')
    const typeSelect = typeSelects.find((el) => el.getAttribute('aria-label') === 'Type') as
      | HTMLSelectElement
      | undefined
    expect(typeSelect).toBeDefined()
    const optionValues = Array.from(typeSelect?.options ?? []).map((o) => o.value)
    expect(optionValues).toContain('ref')
    // #4710 — a `url` definition is declarable from Settings too, not only
    // from the page property table's Add-property popover.
    expect(optionValues).toContain('url')
  })

  it('shows a lock on a built-in and offers no edit or delete for it', async () => {
    stubDefs(
      pageOf([
        makeBuiltinDef('priority', 'select', '["1","2","3"]'),
        makeBuiltinDef('repeat', 'text'),
        makePropDef('custom-field', 'select', '["a","b"]'),
      ]),
    )

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Priority')).toBeInTheDocument()
    for (const key of ['priority', 'repeat']) {
      const lock = screen.getByTestId(`builtin-lock-${key}`)
      expect(lock).toHaveTextContent(t('propertiesView.builtIn'))
      expect(
        screen.queryByRole('button', { name: t('properties.deleteDefinition', { key }) }),
      ).not.toBeInTheDocument()
    }
    expect(screen.queryByTestId('builtin-lock-custom-field')).not.toBeInTheDocument()
    // The one Edit options button is the user's select, not priority's.
    expect(
      screen.getAllByRole('button', { name: t('propertiesView.editOptionsTooltip') }),
    ).toHaveLength(1)
    expect(
      screen.getByRole('button', {
        name: t('properties.deleteDefinition', { key: 'custom-field' }),
      }),
    ).toBeInTheDocument()
  })

  it('has no a11y violations with built-ins locked', async () => {
    stubDefs(
      pageOf([
        makeBuiltinDef('todo_state', 'select', '["TODO","DOING","DONE","CANCELLED"]'),
        makeBuiltinDef('priority', 'select', '["1","2","3"]'),
        makePropDef('status', 'select', '["open","closed"]'),
      ]),
    )

    const { container } = render(<PropertyDefinitionsList />)

    await screen.findByTestId('builtin-lock-priority')
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('search clear button clears the filter', async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([makePropDef('status', 'select'), makePropDef('priority', 'number')]))

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Status')).toBeInTheDocument()

    const searchInput = screen.getByPlaceholderText('Search properties...')
    await user.type(searchInput, 'pri')

    expect(screen.queryByText('Status')).not.toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()

    const clearBtn = screen.getByRole('button', { name: /Clear search/i })
    await user.click(clearBtn)

    expect(searchInput).toHaveValue('')
    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()
  })

  it('shows empty state when filter matches nothing', async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([makePropDef('status', 'select'), makePropDef('priority', 'number')]))

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Status')).toBeInTheDocument()

    const searchInput = screen.getByPlaceholderText('Search properties...')
    await user.type(searchInput, 'zzzznonexistent')

    expect(screen.queryByText('Status')).not.toBeInTheDocument()
    expect(screen.queryByText('Priority')).not.toBeInTheDocument()
    expect(screen.getByText('No properties match your search')).toBeInTheDocument()
  })

  it('delete button has aria-label for tooltip accessibility', async () => {
    stubDefs(pageOf([makePropDef('my-prop', 'text')]))

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('My Prop')).toBeInTheDocument()

    const deleteBtn = screen.getByRole('button', { name: /Delete property my-prop/i })
    expect(deleteBtn).toBeInTheDocument()
    expect(deleteBtn).toHaveAttribute('aria-label', 'Delete property my-prop')
  })

  // Delete button must be reachable on desktop without hovering
  // the row. Pin the visibility so a future "hide-until-hover" regression
  // is caught at test time.
  it('delete button is always visible (no opacity-0 / group-hover gating)', async () => {
    stubDefs(pageOf([makePropDef('my-prop', 'text')]))

    render(<PropertyDefinitionsList />)

    const deleteBtn = await screen.findByRole('button', {
      name: t('properties.deleteDefinition', { key: 'my-prop' }),
    })
    expect(deleteBtn).toBeInTheDocument()

    const className = deleteBtn.className
    expect(className).not.toMatch(/(^|\s)opacity-0(\s|$)/)
    expect(className).not.toMatch(/group-hover:opacity-100/)
  })

  // Options JSON placeholder resolves via t()
  it('options JSON input placeholder resolves via t()', async () => {
    const user = userEvent.setup()
    stubDefs(pageOf([makePropDef('status', 'select', '["open","closed"]')]))

    render(<PropertyDefinitionsList />)

    expect(await screen.findByText('Status')).toBeInTheDocument()

    const editBtn = screen.getByRole('button', { name: /Edit options/i })
    await user.click(editBtn)

    expect(
      await screen.findByPlaceholderText(t('propertiesView.optionsJsonPlaceholder')),
    ).toBeInTheDocument()
  })

  // Explain WHY the todo_state cycle is fixed via a HelpCircle
  // tooltip on the todo_state row only.
  describe('todo_state cycle help', () => {
    it('renders the HelpCircle on the todo_state row', async () => {
      stubDefs(
        pageOf([makeBuiltinDef('todo_state', 'select', '["TODO","DOING","DONE","CANCELLED"]')]),
      )

      render(<PropertyDefinitionsList />)

      await screen.findByText('Todo State')
      const help = screen.getByTestId('todo-state-cycle-help')
      expect(help).toBeInTheDocument()
      expect(help).toHaveAttribute('aria-label', t('propertiesView.taskCycleHelpLabel'))
    })

    it('does NOT render the HelpCircle on non-todo_state rows', async () => {
      stubDefs(
        pageOf([
          makeBuiltinDef('priority', 'select', '["1","2","3"]'),
          makePropDef('effort', 'select', '["15m","30m","1h"]'),
          makePropDef('custom-field', 'text'),
        ]),
      )

      render(<PropertyDefinitionsList />)

      await screen.findByText('Priority')
      expect(screen.queryByTestId('todo-state-cycle-help')).not.toBeInTheDocument()
    })
  })

  // Inline JSON validation in the options editor. The Save button
  // is disabled and an inline error is rendered when the input does not
  // parse as JSON. Empty input is treated as valid (clears options).
  describe('inline options JSON validation', () => {
    it('empty input shows no error and Save is enabled', async () => {
      const user = userEvent.setup()
      stubDefs(pageOf([makePropDef('status', 'select', '["open","closed"]')]))

      render(<PropertyDefinitionsList />)

      expect(await screen.findByText('Status')).toBeInTheDocument()

      const editBtn = screen.getByRole('button', { name: /Edit options/i })
      await user.click(editBtn)

      const optionsInput = screen.getByLabelText(t('propertiesView.optionsJsonLabel'))
      fireEvent.change(optionsInput, { target: { value: '' } })

      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(optionsInput).not.toHaveAttribute('aria-invalid', 'true')

      const saveBtn = screen.getByRole('button', { name: /^Save$/i })
      expect(saveBtn).toBeEnabled()
    })

    it('valid JSON shows no error and Save is enabled', async () => {
      const user = userEvent.setup()
      stubDefs(pageOf([makePropDef('status', 'select', '["open","closed"]')]))

      render(<PropertyDefinitionsList />)

      expect(await screen.findByText('Status')).toBeInTheDocument()

      const editBtn = screen.getByRole('button', { name: /Edit options/i })
      await user.click(editBtn)

      const optionsInput = screen.getByLabelText(t('propertiesView.optionsJsonLabel'))
      fireEvent.change(optionsInput, { target: { value: '["a"]' } })

      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(optionsInput).not.toHaveAttribute('aria-invalid', 'true')

      const saveBtn = screen.getByRole('button', { name: /^Save$/i })
      expect(saveBtn).toBeEnabled()
    })

    it('invalid JSON shows inline error and disables Save', async () => {
      const user = userEvent.setup()
      stubDefs(pageOf([makePropDef('status', 'select', '["open","closed"]')]))

      render(<PropertyDefinitionsList />)

      expect(await screen.findByText('Status')).toBeInTheDocument()

      const editBtn = screen.getByRole('button', { name: /Edit options/i })
      await user.click(editBtn)

      const optionsInput = screen.getByLabelText(t('propertiesView.optionsJsonLabel'))
      fireEvent.change(optionsInput, { target: { value: '[unclosed' } })

      const error = await screen.findByRole('alert')
      expect(error).toHaveTextContent(/Invalid JSON:/)
      expect(error).toHaveAttribute('id', 'property-options-json-error')
      expect(optionsInput).toHaveAttribute('aria-invalid', 'true')
      expect(optionsInput).toHaveAttribute('aria-describedby', 'property-options-json-error')

      const saveBtn = screen.getByRole('button', { name: /^Save$/i })
      expect(saveBtn).toBeDisabled()
    })
  })

  // ── PopoverContent labelled for screen-reader users ─────
  describe('Edit options popover aria-label', () => {
    it('labels the open popover with propertiesView.editOptionsPopoverLabel', async () => {
      const user = userEvent.setup()
      stubDefs(pageOf([makePropDef('status', 'select', '["open","closed"]')]))

      render(<PropertyDefinitionsList />)

      expect(await screen.findByText('Status')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /Edit options/i }))

      expect(
        screen.getByRole('dialog', { name: t('propertiesView.editOptionsPopoverLabel') }),
      ).toBeInTheDocument()
    })

    it('axe is clean with the Edit options popover open', async () => {
      const user = userEvent.setup()
      stubDefs(pageOf([makePropDef('status', 'select', '["open","closed"]')]))

      const { container } = render(<PropertyDefinitionsList />)

      expect(await screen.findByText('Status')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /Edit options/i }))
      // Wait for the portalled PopoverContent so axe runs against a settled DOM.
      await screen.findByRole('dialog', { name: t('propertiesView.editOptionsPopoverLabel') })

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // ── #5841: definitions are per space ─────
  describe('per-space definitions', () => {
    const spacePicker = () =>
      screen.getByRole('combobox', { name: t('propertiesView.definitionsIn') })
    const copyButton = (key: string) =>
      screen.getByRole('button', { name: t('propertiesView.copyToSpaceLabel', { key }) })

    /** The mock backend, with a Work space declaring `budget` as a number. */
    function seedTwoSpaces(): void {
      seedBlocks()
      spacePropertyDefs(WORK.id).set('budget', {
        key: 'budget',
        value_type: 'number',
        options: null,
        created_at: '2026-01-01T00:00:00.000Z',
      })
      useSpaceStore.setState({ currentSpaceId: PERSONAL.id, availableSpaces: [PERSONAL, WORK] })
      mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
    }

    it("lists the active space's definitions, and another space's once picked", async () => {
      const user = userEvent.setup()
      seedTwoSpaces()

      render(<PropertyDefinitionsList />)

      expect(await screen.findByText('Context')).toBeInTheDocument()
      expect(spacePicker()).toHaveValue(PERSONAL.id)
      expect(screen.queryByText('Budget')).not.toBeInTheDocument()

      await user.selectOptions(spacePicker(), WORK.id)

      expect(await screen.findByText('Budget')).toBeInTheDocument()
      expect(screen.queryByText('Context')).not.toBeInTheDocument()
      expect(mockedInvoke).toHaveBeenCalledWith('list_property_defs', {
        spaceId: WORK.id,
        cursor: null,
        limit: null,
      })
    })

    it('creates a definition in the picked space only', async () => {
      const user = userEvent.setup()
      seedTwoSpaces()
      render(<PropertyDefinitionsList />)
      await screen.findByText('Context')
      await user.selectOptions(spacePicker(), WORK.id)
      await screen.findByText('Budget')

      await user.type(screen.getByPlaceholderText('Property key'), 'estimate')
      await user.click(screen.getByRole('button', { name: /Create/i }))

      await waitFor(() => {
        expect(spacePropertyDefs(WORK.id).get('estimate')?.['value_type']).toBe('text')
      })
      expect(spacePropertyDefs(PERSONAL.id).has('estimate')).toBe(false)
    })

    it('copies a user definition to another space, where it then lists', async () => {
      const user = userEvent.setup()
      seedTwoSpaces()
      render(<PropertyDefinitionsList />)
      await screen.findByText('Project')

      await user.click(copyButton('project'))
      await user.click(await screen.findByRole('button', { name: WORK.name }))

      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
          t('propertiesView.copiedToSpace', { key: 'project', space: WORK.name }),
        )
      })
      expect(mockedInvoke).toHaveBeenCalledWith('create_property_def', {
        spaceId: WORK.id,
        key: 'project',
        valueType: 'select',
        options: '["alpha","beta","gamma"]',
      })
      await user.selectOptions(spacePicker(), WORK.id)
      expect(await screen.findByText('Project')).toBeInTheDocument()
    })

    it("keeps the other space's differing definition and says so", async () => {
      const user = userEvent.setup()
      seedTwoSpaces()
      spacePropertyDefs(WORK.id).set('project', {
        key: 'project',
        value_type: 'text',
        options: null,
        created_at: '2026-01-01T00:00:00.000Z',
      })
      render(<PropertyDefinitionsList />)
      await screen.findByText('Project')

      await user.click(copyButton('project'))
      await user.click(await screen.findByRole('button', { name: WORK.name }))

      await waitFor(() => {
        expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
          t('propertiesView.copyKeptExisting', { key: 'project', space: WORK.name, type: 'text' }),
        )
      })
      expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
      expect(spacePropertyDefs(WORK.id).get('project')?.['value_type']).toBe('text')
    })

    it("shows the backend's reason when the copy is refused", async () => {
      const user = userEvent.setup()
      useSpaceStore.setState({ currentSpaceId: PERSONAL.id, availableSpaces: [PERSONAL, WORK] })
      const refusal: AppError = {
        kind: 'validation',
        message: "cannot declare property 'year' as 'number': 1 value(s) already stored",
      }
      stubInvoke({
        list_property_defs: () => pageOf([makePropDef('year', 'number')]),
        create_property_def: () => Promise.reject(refusal),
      })
      render(<PropertyDefinitionsList />)
      await screen.findByText('Year')

      await user.click(copyButton('year'))
      await user.click(await screen.findByRole('button', { name: WORK.name }))

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(refusal.message)
      })
    })

    it('offers no copy when there is no other space, nor on a built-in', async () => {
      stubDefs(pageOf([makePropDef('project'), makeBuiltinDef('priority', 'select', '["1"]')]))
      render(<PropertyDefinitionsList />)
      await screen.findByText('Project')

      expect(
        screen.queryByRole('button', {
          name: t('propertiesView.copyToSpaceLabel', { key: 'project' }),
        }),
      ).not.toBeInTheDocument()
    })

    it('has no a11y violations with the copy menu open', async () => {
      const user = userEvent.setup()
      seedTwoSpaces()
      const { container } = render(<PropertyDefinitionsList />)
      await screen.findByText('Project')
      expect(
        screen.queryByRole('button', {
          name: t('propertiesView.copyToSpaceLabel', { key: 'priority' }),
        }),
      ).not.toBeInTheDocument()

      await user.click(copyButton('project'))
      await screen.findByRole('button', { name: WORK.name })

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // ── #5841 S0: per-space usage count ─────
  describe('usage count', () => {
    const usageBadge = (key: string) => screen.queryByTestId(`property-usage-${key}`)
    const MTG_1 = '0000000000000000000BLOCK17'

    /** The mock backend: Personal's `context` and `project` are each on two blocks. */
    function seedMock(): void {
      seedBlocks()
      mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
    }

    it("shows each definition's live usage count", async () => {
      seedMock()
      const { container } = render(<PropertyDefinitionsList />)

      await waitFor(() => {
        expect(usageBadge('context')).toHaveTextContent('2 uses')
      })
      expect(usageBadge('reviewer')).toHaveTextContent('0 uses')
      await waitFor(async () => {
        expect(await axe(container)).toHaveNoViolations()
      })
    })

    it('counts a trashed block out once the list is opened again', async () => {
      seedMock()
      await dispatch('delete_block', { blockId: MTG_1 })

      render(<PropertyDefinitionsList />)

      await waitFor(() => {
        expect(usageBadge('context')).toHaveTextContent('1 use')
      })
    })

    it('shows no count, not 0, while the counts load', async () => {
      seedMock()
      mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) =>
        cmd === 'count_property_usage' ? new Promise<never>(() => {}) : dispatch(cmd, args),
      )

      render(<PropertyDefinitionsList />)

      expect(await screen.findByText('Reviewer')).toBeInTheDocument()
      expect(usageBadge('reviewer')).not.toBeInTheDocument()
      expect(screen.queryByText('0 uses')).not.toBeInTheDocument()
    })

    it('a failed count load shows no count and only warns', async () => {
      const warn = vi.spyOn(logger, 'warn')
      stubInvoke({
        list_property_defs: () => pageOf([makePropDef('stage')]),
        count_property_usage: () => Promise.reject(new Error('DB error')),
      })

      render(<PropertyDefinitionsList />)

      expect(await screen.findByText('Stage')).toBeInTheDocument()
      await waitFor(() => {
        expect(warn).toHaveBeenCalledWith(
          'PropertyDefinitionsList',
          'count_property_usage failed',
          { spaceId: PERSONAL.id },
          expect.any(Error),
        )
      })
      expect(usageBadge('stage')).not.toBeInTheDocument()
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    })

    // Answer 6: delete counts trashed blocks, the badge does not.
    it('a refused delete beside a count of 0 says trashed blocks still use the key', async () => {
      const user = userEvent.setup()
      seedMock()
      await dispatch('create_property_def', {
        spaceId: PERSONAL.id,
        key: 'stage',
        valueType: 'text',
        options: null,
      })
      await dispatch('set_property', {
        blockId: MTG_1,
        key: 'stage',
        value: { value_text: 'draft' },
      })
      await dispatch('delete_block', { blockId: MTG_1 })
      render(<PropertyDefinitionsList />)
      await waitFor(() => {
        expect(usageBadge('stage')).toHaveTextContent('0 uses')
      })

      await user.click(screen.getByRole('button', { name: 'Delete property stage' }))
      await user.click(await screen.findByRole('button', { name: /^Delete$/i }))

      // The backend's own count stays, followed by why it differs from the badge.
      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
          "Can't delete 'stage': 1 block(s) still use it. Remove the property from them first. " +
            'Blocks in the Trash count too, until you permanently delete them.',
        )
      })
      expect(screen.getByText('Stage')).toBeInTheDocument()
    })

    it('counts a created definition, and a deleted one is gone with its count', async () => {
      const user = userEvent.setup()
      seedMock()
      render(<PropertyDefinitionsList />)
      await waitFor(() => {
        expect(usageBadge('reviewer')).toHaveTextContent('0 uses')
      })

      await user.type(screen.getByPlaceholderText('Property key'), 'estimate')
      await user.click(screen.getByRole('button', { name: /Create/i }))
      await waitFor(() => {
        expect(usageBadge('estimate')).toHaveTextContent('0 uses')
      })

      await user.click(screen.getByRole('button', { name: 'Delete property reviewer' }))
      await user.click(await screen.findByRole('button', { name: /^Delete$/i }))
      await waitFor(() => {
        expect(usageBadge('reviewer')).not.toBeInTheDocument()
      })
      expect(usageBadge('context')).toHaveTextContent('2 uses')
    })

    it("shows the picked space's counts", async () => {
      const user = userEvent.setup()
      seedMock()
      const workId = (await dispatch('create_space', { name: 'Work', accentColor: null })) as string
      // Work's `status` is on one page; Personal's, a default too, is on none.
      const workPage = (await dispatch('create_page_in_space', {
        parentId: null,
        content: 'Plan',
        spaceId: workId,
      })) as string
      await dispatch('set_property', {
        blockId: workPage,
        key: 'status',
        value: { value_text: 'active' },
      })
      useSpaceStore.setState({
        currentSpaceId: PERSONAL.id,
        availableSpaces: [PERSONAL, { id: workId, name: 'Work', accent_color: null }],
      })
      render(<PropertyDefinitionsList />)
      await waitFor(() => {
        expect(usageBadge('context')).toHaveTextContent('2 uses')
      })
      expect(usageBadge('status')).toHaveTextContent('0 uses')

      await user.selectOptions(
        screen.getByRole('combobox', { name: t('propertiesView.definitionsIn') }),
        workId,
      )

      await waitFor(() => {
        expect(usageBadge('status')).toHaveTextContent('1 use')
      })
      expect(usageBadge('context')).not.toBeInTheDocument()
    })
  })
})
