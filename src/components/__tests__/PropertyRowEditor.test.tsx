/**
 * Tests for PropertyRowEditor component.
 *
 * Validates:
 *  - Renders property label (formatted) and value
 *  - Text input: renders with correct type, saves on blur
 *  - Number input: renders with type="number"
 *  - Date input: renders with type="date"
 *  - Select input: renders dropdown with options, saves on change
 *  - Select "none" option clears value
 *  - Edit options popover: add, remove, save
 *  - Delete button calls onDelete
 *  - No-op blur when value unchanged
 *  - Accessibility compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { __resetPriorityLevelsForTests, getPriorityLevels } from '../../lib/priority-levels'
import type { PropertyDefinition, PropertyRow } from '../../lib/tauri'

const mockedInvoke = vi.mocked(invoke)

vi.mock('lucide-react', () => ({
  CalendarCheck2: () => <svg data-testid="calendar-check2-icon" />,
  CalendarClock: () => <svg data-testid="calendar-clock-icon" />,
  CalendarPlus: () => <svg data-testid="calendar-plus-icon" />,
  CheckCircle2: () => <svg data-testid="check-circle2-icon" />,
  Clock: () => <svg data-testid="clock-icon" />,
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
import { t } from '@/lib/i18n'
import { PropertyRowEditor } from '../PropertyRowEditor'

const mockedToastError = vi.mocked(toast.error)

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

function makeDef(key: string, valueType: string, options?: string): PropertyDefinition {
  return {
    key,
    value_type: valueType,
    options: options ?? null,
    created_at: '2026-01-01T00:00:00Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetPriorityLevelsForTests()
})

afterEach(() => {
  __resetPriorityLevelsForTests()
})

describe('PropertyRowEditor rendering', () => {
  it('renders formatted property label in badge', () => {
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('my_field', { value_text: 'hello' })}
        def={makeDef('my_field', 'text')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(screen.getByText('My Field')).toBeInTheDocument()
  })

  it('renders text input with correct value', () => {
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('author', { value_text: 'Alice' })}
        def={makeDef('author', 'text')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    const input = screen.getByLabelText(
      t('pageProperty.valueLabel', { key: 'author' }),
    ) as HTMLInputElement
    expect(input.type).toBe('text')
    expect(input.value).toBe('Alice')
  })

  it('renders number input with type="number"', () => {
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('priority', { value_num: 42 })}
        def={makeDef('priority', 'number')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    const input = screen.getByLabelText(
      t('pageProperty.valueLabel', { key: 'priority' }),
    ) as HTMLInputElement
    expect(input.type).toBe('number')
    expect(input.value).toBe('42')
  })

  it('renders date input with type="text" for NL support', () => {
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('due', { value_date: '2026-06-15' })}
        def={makeDef('due', 'date')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    const input = screen.getByLabelText(
      t('pageProperty.valueLabel', { key: 'due' }),
    ) as HTMLInputElement
    expect(input.type).toBe('text')
    expect(input.value).toBe('2026-06-15')
  })

  it('renders select dropdown with options', () => {
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('stage', { value_text: 'DOING' })}
        def={makeDef('stage', 'select', '["TODO","DOING","DONE"]')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    const select = screen.getByLabelText(
      t('pageProperty.valueLabel', { key: 'stage' }),
    ) as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect(select.value).toBe('DOING')
    const opts = Array.from(select.options).map((o) => o.value)
    expect(opts).toContain('TODO')
    expect(opts).toContain('DOING')
    expect(opts).toContain('DONE')
  })

  it('defaults to text when no definition is provided', () => {
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('unknown', { value_text: 'val' })}
        def={undefined}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    const input = screen.getByLabelText(
      t('pageProperty.valueLabel', { key: 'unknown' }),
    ) as HTMLInputElement
    expect(input.type).toBe('text')
    expect(input.value).toBe('val')
  })

  it('renders empty string when prop has no value fields', () => {
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('empty')}
        def={makeDef('empty', 'text')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    const input = screen.getByLabelText(
      t('pageProperty.valueLabel', { key: 'empty' }),
    ) as HTMLInputElement
    expect(input.value).toBe('')
  })
})

describe('PropertyRowEditor editing', () => {
  it('calls onSave when text input is blurred with changed value', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('author', { value_text: '' })}
        def={makeDef('author', 'text')}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    )

    const input = screen.getByLabelText(t('pageProperty.valueLabel', { key: 'author' }))
    await user.click(input)
    await user.type(input, 'Bob')
    await user.tab()

    expect(onSave).toHaveBeenCalledWith('Bob')
  })

  it('does not call onSave on blur when value is unchanged', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('author', { value_text: 'Alice' })}
        def={makeDef('author', 'text')}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    )

    const input = screen.getByLabelText(t('pageProperty.valueLabel', { key: 'author' }))
    await user.click(input)
    await user.tab()

    expect(onSave).not.toHaveBeenCalled()
  })

  it('calls onSave when select value changes', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('stage', { value_text: 'TODO' })}
        def={makeDef('stage', 'select', '["TODO","DOING","DONE"]')}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    )

    const select = screen.getByLabelText(
      t('pageProperty.valueLabel', { key: 'stage' }),
    ) as HTMLSelectElement
    await user.selectOptions(select, 'DONE')

    expect(onSave).toHaveBeenCalledWith('DONE')
  })

  it('clears value when select __none__ option is chosen', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('stage', { value_text: 'TODO' })}
        def={makeDef('stage', 'select', '["TODO","DOING"]')}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    )

    const select = screen.getByLabelText(
      t('pageProperty.valueLabel', { key: 'stage' }),
    ) as HTMLSelectElement
    await user.selectOptions(select, '__none__')

    expect(onSave).toHaveBeenCalledWith('')
  })

  it('calls onDelete when delete button is clicked', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('author', { value_text: 'Alice' })}
        def={makeDef('author', 'text')}
        onSave={vi.fn()}
        onDelete={onDelete}
      />,
    )

    const deleteBtn = screen.getByLabelText(
      t('pageProperty.deletePropertyLabel', { key: 'author' }),
    )
    await user.click(deleteBtn)

    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})

describe('PropertyRowEditor NL date input', () => {
  it('parses NL date "tomorrow" on blur and calls onSave with YYYY-MM-DD', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('due', { value_date: '' })}
        def={makeDef('due', 'date')}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    )

    const input = screen.getByLabelText(t('pageProperty.valueLabel', { key: 'due' }))
    await user.click(input)
    await user.type(input, 'tomorrow')
    await user.tab()

    expect(onSave).toHaveBeenCalledTimes(1)
    const savedValue = onSave.mock.calls[0]?.[0]
    expect(savedValue).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('accepts ISO date as-is without NL parsing', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('due', { value_date: '' })}
        def={makeDef('due', 'date')}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    )

    const input = screen.getByLabelText(t('pageProperty.valueLabel', { key: 'due' }))
    await user.click(input)
    await user.type(input, '2025-04-15')
    await user.tab()

    expect(onSave).toHaveBeenCalledWith('2025-04-15')
  })

  it('shows preview text while typing NL date', async () => {
    const user = userEvent.setup()
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('due', { value_date: '' })}
        def={makeDef('due', 'date')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    const input = screen.getByLabelText(t('pageProperty.valueLabel', { key: 'due' }))
    await user.click(input)
    await user.type(input, 'today')

    const preview = input.parentElement?.querySelector('.text-muted-foreground')
    expect(preview).toBeInTheDocument()
    expect(preview?.textContent).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('does not call onSave for invalid NL date input', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('due', { value_date: '' })}
        def={makeDef('due', 'date')}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    )

    const input = screen.getByLabelText(t('pageProperty.valueLabel', { key: 'due' }))
    await user.click(input)
    await user.type(input, 'not a date')
    await user.tab()

    expect(onSave).not.toHaveBeenCalled()
  })

  it('shows placeholder for date input', () => {
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('due', { value_date: '' })}
        def={makeDef('due', 'date')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    const input = screen.getByLabelText(
      t('pageProperty.valueLabel', { key: 'due' }),
    ) as HTMLInputElement
    expect(input.placeholder).toBe(t('property.datePlaceholder'))
  })
})

describe('PropertyRowEditor select options editing', () => {
  it('shows edit options button for select properties', () => {
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('stage', { value_text: 'TODO' })}
        def={makeDef('stage', 'select', '["TODO","DOING"]')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(
      screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })),
    ).toBeInTheDocument()
  })

  it('does not show edit options button for non-select properties', () => {
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('author', { value_text: 'Alice' })}
        def={makeDef('author', 'text')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(screen.queryByLabelText(/Edit options for/)).not.toBeInTheDocument()
  })

  it('opens popover with current options listed', async () => {
    const user = userEvent.setup()
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('stage', { value_text: 'TODO' })}
        def={makeDef('stage', 'select', '["TODO","DOING","DONE"]')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    await user.click(screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })))

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.newOptionLabel'))).toBeInTheDocument()
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
    const onDefUpdated = vi.fn()
    mockedInvoke.mockResolvedValue({
      key: 'stage',
      value_type: 'select',
      options: '["TODO","DOING","DONE"]',
      created_at: '2026-01-01T00:00:00Z',
    })

    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('stage', { value_text: 'TODO' })}
        def={makeDef('stage', 'select', '["TODO","DOING"]')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onDefUpdated={onDefUpdated}
      />,
    )

    await user.click(screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })))

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.newOptionLabel'))).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText(t('pageProperty.newOptionLabel')), 'DONE')
    await user.click(screen.getByLabelText(t('pageProperty.addOptionLabel')))

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
    mockedInvoke.mockResolvedValue({
      key: 'stage',
      value_type: 'select',
      options: '["TODO","DONE"]',
      created_at: '2026-01-01T00:00:00Z',
    })

    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('stage', { value_text: 'TODO' })}
        def={makeDef('stage', 'select', '["TODO","DOING","DONE"]')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onDefUpdated={vi.fn()}
      />,
    )

    await user.click(screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })))

    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.removeOptionLabel', { option: 'DOING' })),
      ).toBeInTheDocument()
    })

    await user.click(
      screen.getByLabelText(t('pageProperty.removeOptionLabel', { option: 'DOING' })),
    )

    await user.click(screen.getByRole('button', { name: /save options/i }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('update_property_def_options', {
        key: 'stage',
        options: '["TODO","DONE"]',
      })
    })
  })

  it('shows error toast when saving options fails', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockRejectedValue(new Error('backend error'))

    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('stage', { value_text: 'TODO' })}
        def={makeDef('stage', 'select', '["TODO","DOING"]')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    await user.click(screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save options/i })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /save options/i }))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('pageProperty.updateOptionsFailed'))
    })
  })

  it('adds option via Enter key', async () => {
    const user = userEvent.setup()
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('stage', { value_text: 'TODO' })}
        def={makeDef('stage', 'select', '["TODO"]')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    await user.click(screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })))

    await waitFor(() => {
      expect(screen.getByLabelText(t('pageProperty.newOptionLabel'))).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText(t('pageProperty.newOptionLabel')), 'DOING')
    await user.keyboard('{Enter}')

    // The new option should appear in the list
    await waitFor(() => {
      expect(
        screen.getByLabelText(t('pageProperty.removeOptionLabel', { option: 'DOING' })),
      ).toBeInTheDocument()
    })
  })
})

describe('PropertyRowEditor accessibility', () => {
  it('text property has no a11y violations', async () => {
    const { container } = render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('author', { value_text: 'Alice' })}
        def={makeDef('author', 'text')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('select property has no a11y violations', async () => {
    const { container } = render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('stage', { value_text: 'TODO' })}
        def={makeDef('stage', 'select', '["TODO","DOING","DONE"]')}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

describe('PropertyRowEditor ref picker', () => {
  it('renders page picker button for ref-type properties', () => {
    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('linked_page', { value_ref: null })}
        def={makeDef('linked_page', 'ref')}
        onSave={vi.fn()}
      />,
    )

    // Should render a button (not an input) for ref properties
    const btn = screen.getByLabelText(t('pageProperty.valueLabel', { key: 'linked_page' }))
    expect(btn.tagName).toBe('BUTTON')
    // Should show placeholder text
    expect(btn).toHaveTextContent(t('block.searchPages'))
  })

  it('displays resolved page title when value_ref is set', async () => {
    const { useResolveStore } = await import('../../stores/resolve')
    useResolveStore.setState({
      cache: new Map([['TARGET_PAGE', { title: 'My Target', deleted: false }]]),
      version: 1,
    })

    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('linked_page', { value_ref: 'TARGET_PAGE' })}
        def={makeDef('linked_page', 'ref')}
        onSave={vi.fn()}
      />,
    )

    expect(screen.getByText('My Target')).toBeInTheDocument()
  })

  it('loads pages when picker is opened', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks')
        return {
          items: [
            { id: 'P1', content: 'Page One', block_type: 'page' },
            { id: 'P2', content: 'Page Two', block_type: 'page' },
          ],
          next_cursor: null,
          has_more: false,
        }
      return null
    })

    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('linked_page', { value_ref: null })}
        def={makeDef('linked_page', 'ref')}
        onSave={vi.fn()}
      />,
    )

    await user.click(screen.getByLabelText(t('pageProperty.valueLabel', { key: 'linked_page' })))

    await waitFor(() => {
      expect(screen.getByText('Page One')).toBeInTheDocument()
      expect(screen.getByText('Page Two')).toBeInTheDocument()
    })
  })

  it('filters pages by search text', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks')
        return {
          items: [
            { id: 'P1', content: 'Alpha Page', block_type: 'page' },
            { id: 'P2', content: 'Beta Page', block_type: 'page' },
          ],
          next_cursor: null,
          has_more: false,
        }
      return null
    })

    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('linked_page', { value_ref: null })}
        def={makeDef('linked_page', 'ref')}
        onSave={vi.fn()}
      />,
    )

    await user.click(screen.getByLabelText(t('pageProperty.valueLabel', { key: 'linked_page' })))

    await waitFor(() => {
      expect(screen.getByText('Alpha Page')).toBeInTheDocument()
    })

    const searchInput = screen.getByLabelText(t('block.searchPages'))
    await user.type(searchInput, 'Beta')

    await waitFor(() => {
      expect(screen.queryByText('Alpha Page')).not.toBeInTheDocument()
      expect(screen.getByText('Beta Page')).toBeInTheDocument()
    })
  })

  // UX-248 — Unicode-aware fold via `matchesSearchFolded`.
  it('ref picker matches Turkish İstanbul when query is lowercase istanbul', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks')
        return {
          items: [
            { id: 'P1', content: 'İstanbul trip', block_type: 'page' },
            { id: 'P2', content: 'Ankara plans', block_type: 'page' },
          ],
          next_cursor: null,
          has_more: false,
        }
      return null
    })

    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('linked_page', { value_ref: null })}
        def={makeDef('linked_page', 'ref')}
        onSave={vi.fn()}
      />,
    )

    await user.click(screen.getByLabelText(t('pageProperty.valueLabel', { key: 'linked_page' })))

    await waitFor(() => {
      expect(screen.getByText('İstanbul trip')).toBeInTheDocument()
    })

    const searchInput = screen.getByLabelText(t('block.searchPages'))
    await user.type(searchInput, 'istanbul')

    await waitFor(() => {
      expect(screen.getByText('İstanbul trip')).toBeInTheDocument()
      expect(screen.queryByText('Ankara plans')).not.toBeInTheDocument()
    })
  })

  it('saves selected page via setProperty', async () => {
    const user = userEvent.setup()
    const onRefSaved = vi.fn()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks')
        return {
          items: [{ id: 'P1', content: 'Target Page', block_type: 'page' }],
          next_cursor: null,
          has_more: false,
        }
      if (cmd === 'set_property') return undefined
      return null
    })

    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('linked_page', { value_ref: null })}
        def={makeDef('linked_page', 'ref')}
        onSave={vi.fn()}
        onRefSaved={onRefSaved}
      />,
    )

    await user.click(screen.getByLabelText(t('pageProperty.valueLabel', { key: 'linked_page' })))

    await waitFor(() => {
      expect(screen.getByText('Target Page')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Target Page'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'BLOCK_1',
        key: 'linked_page',
        valueRef: 'P1',
        valueText: null,
        valueNum: null,
        valueDate: null,
      })
    })
    expect(onRefSaved).toHaveBeenCalledTimes(1)
  })

  it('shows "No pages found" when search has no matches', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks')
        return {
          items: [{ id: 'P1', content: 'Only Page', block_type: 'page' }],
          next_cursor: null,
          has_more: false,
        }
      return null
    })

    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('linked_page', { value_ref: null })}
        def={makeDef('linked_page', 'ref')}
        onSave={vi.fn()}
      />,
    )

    await user.click(screen.getByLabelText(t('pageProperty.valueLabel', { key: 'linked_page' })))

    await waitFor(() => {
      expect(screen.getByText('Only Page')).toBeInTheDocument()
    })

    const searchInput = screen.getByLabelText(t('block.searchPages'))
    await user.type(searchInput, 'zzz_nonexistent')

    await waitFor(() => {
      expect(screen.getByText(t('block.noPagesFound'))).toBeInTheDocument()
    })
  })

  it('shows error toast when page list fails to load', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockRejectedValue(new Error('backend error'))

    render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('linked_page', { value_ref: null })}
        def={makeDef('linked_page', 'ref')}
        onSave={vi.fn()}
      />,
    )

    await user.click(screen.getByLabelText(t('pageProperty.valueLabel', { key: 'linked_page' })))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('pageProperty.loadPagesFailed'))
    })
  })

  it('ref property has no a11y violations', async () => {
    const { container } = render(
      <PropertyRowEditor
        blockId="BLOCK_1"
        prop={makeProp('linked_page', { value_ref: null })}
        def={makeDef('linked_page', 'ref')}
        onSave={vi.fn()}
      />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // UX-201a: todo_state's options are locked — the edit-options button must
  // not appear on the block-level property editor either. Keeps
  // `property_definitions.todo_state.options` in lockstep with TASK_CYCLE.
  describe('locked options for todo_state (UX-201a)', () => {
    it('does NOT render the edit options button for todo_state', () => {
      render(
        <PropertyRowEditor
          blockId="BLOCK_1"
          prop={makeProp('todo_state', { value_text: 'TODO' })}
          def={makeDef('todo_state', 'select', '["TODO","DOING","DONE","CANCELLED"]')}
          onSave={vi.fn()}
        />,
      )

      expect(
        screen.queryByLabelText(t('pageProperty.editOptionsLabel', { key: 'todo_state' })),
      ).not.toBeInTheDocument()
    })

    it('renders a locked indicator for todo_state with accessible tooltip copy', () => {
      render(
        <PropertyRowEditor
          blockId="BLOCK_1"
          prop={makeProp('todo_state', { value_text: 'TODO' })}
          def={makeDef('todo_state', 'select', '["TODO","DOING","DONE","CANCELLED"]')}
          onSave={vi.fn()}
        />,
      )

      const locked = screen.getByTestId('locked-options-todo_state')
      expect(locked).toHaveTextContent(t('propertiesView.optionsLocked'))
    })

    it('priority (not locked yet, UX-201b) still shows the edit options button', () => {
      render(
        <PropertyRowEditor
          blockId="BLOCK_1"
          prop={makeProp('priority', { value_text: '1' })}
          def={makeDef('priority', 'select', '["1","2","3"]')}
          onSave={vi.fn()}
        />,
      )

      expect(
        screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'priority' })),
      ).toBeInTheDocument()
    })

    it('renders without a11y violations when todo_state is locked', async () => {
      const { container } = render(
        <PropertyRowEditor
          blockId="BLOCK_1"
          prop={makeProp('todo_state', { value_text: 'TODO' })}
          def={makeDef('todo_state', 'select', '["TODO","DOING","DONE","CANCELLED"]')}
          onSave={vi.fn()}
        />,
      )

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // UX-201b: saving options on the `priority` definition must refresh the
  // shared priority-levels cache from the block-level editor too.
  describe('priority level refresh (UX-201b)', () => {
    it('updates getPriorityLevels() after saving new priority options', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(makeDef('priority', 'select', '["1","2","3","4"]'))

      render(
        <PropertyRowEditor
          blockId="BLOCK_1"
          prop={makeProp('priority', { value_text: '1' })}
          def={makeDef('priority', 'select', '["1","2","3"]')}
          onSave={vi.fn()}
        />,
      )

      await user.click(
        screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'priority' })),
      )

      const input = screen.getByLabelText(t('pageProperty.newOptionLabel'))
      await user.type(input, '4')
      await user.click(screen.getByLabelText(t('pageProperty.addOptionLabel')))
      await user.click(screen.getByRole('button', { name: t('pageProperty.saveOptionsButton') }))

      await waitFor(() => {
        expect(getPriorityLevels()).toEqual(['1', '2', '3', '4'])
      })
    })

    it('does not refresh priority levels when editing a non-priority key', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(makeDef('stage', 'select', '["x","y","z"]'))

      render(
        <PropertyRowEditor
          blockId="BLOCK_1"
          prop={makeProp('stage', { value_text: 'x' })}
          def={makeDef('stage', 'select', '["x","y"]')}
          onSave={vi.fn()}
        />,
      )

      await user.click(screen.getByLabelText(t('pageProperty.editOptionsLabel', { key: 'stage' })))

      const input = screen.getByLabelText(t('pageProperty.newOptionLabel'))
      await user.type(input, 'z')
      await user.click(screen.getByLabelText(t('pageProperty.addOptionLabel')))
      await user.click(screen.getByRole('button', { name: t('pageProperty.saveOptionsButton') }))

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('update_property_def_options', {
          key: 'stage',
          options: '["x","y","z"]',
        })
      })
      expect(getPriorityLevels()).toEqual(['1', '2', '3'])
    })
  })
})
