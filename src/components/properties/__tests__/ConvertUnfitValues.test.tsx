/**
 * #6206 — Convert, the step of the "don't fit" review that replaces each
 * distinct value by one the user types, against the mock backend: each value
 * once with its counts, an input that matches the key's type, only the
 * values given a replacement sent with the counts shown, the toast's Undo,
 * a stale acknowledgement read again with the replacements kept, and the
 * backend's refusals.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { PropertyDefinitionsList } from '@/components/properties/PropertyDefinitionsList'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { rowOf } from '@/lib/tauri-mock/property-keys'
import { properties, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)
const PERSONAL = { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }
const MTG_1 = SEED_IDS.BLOCK_MTG_1
const MTG_2 = SEED_IDS.BLOCK_MTG_2
const PROJ_1 = SEED_IDS.BLOCK_PROJ_1
const NO_SLOTS = {
  value_text: null,
  value_num: null,
  value_date: null,
  value_ref: null,
  value_bool: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: PERSONAL.id, availableSpaces: [PERSONAL] })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

async function declare(key: string, valueType: string, options: string | null = null) {
  await dispatch('create_property_def', { spaceId: PERSONAL.id, key, valueType, options })
}

/** `blockId` holds `fields` under `key` as a peer could write it, whatever the definition. */
function holds(blockId: string, key: string, fields: Record<string, unknown>): void {
  const held = properties.get(blockId) ?? new Map()
  held.set(key, rowOf(key, { ...NO_SLOTS, ...fields }))
  properties.set(blockId, held)
}

/** `when` is a date: `MTG_1` and `PROJ_1` hold "soon", `MTG_2` holds "later". */
async function whenHoldsWords(): Promise<void> {
  await declare('when', 'date')
  holds(MTG_1, 'when', { value_text: 'soon' })
  holds(PROJ_1, 'when', { value_text: 'soon' })
  holds(MTG_2, 'when', { value_text: 'later' })
}

function badge(key: string): HTMLElement | null {
  return screen.queryByTestId(`property-unfit-${key}`)
}

/** Open `key`'s review and go to its Convert step. */
async function openConvert(key: string): Promise<HTMLElement> {
  const user = userEvent.setup()
  await waitFor(() => {
    expect(badge(key)).toBeInTheDocument()
  })
  await user.click(badge(key) as HTMLElement)
  const dialog = await screen.findByRole('dialog')
  await user.click(within(dialog).getByRole('button', { name: t('propertiesView.convertOpen') }))
  return dialog
}

function replacement(dialog: HTMLElement, value: string): HTMLElement {
  return within(dialog).getByLabelText(t('propertiesView.convertReplacementLabel', { value }))
}

async function findRow(dialog: HTMLElement, value: string): Promise<HTMLElement> {
  return (await within(dialog).findByText(value)).closest('li') as HTMLElement
}

function convertButton(dialog: HTMLElement, count: number): HTMLElement {
  return within(dialog).getByRole('button', {
    name: t('propertiesView.convertConfirm', { count }),
  })
}

function undoOf(message: string): (() => void) | undefined {
  const call = vi.mocked(toast.success).mock.calls.find(([shown]) => shown === message)
  return (call?.[1] as { action?: { onClick: () => void } } | undefined)?.action?.onClick
}

function dateOf(blockId: string, key: string): unknown {
  return properties.get(blockId)?.get(key)?.['value_date']
}

function textOf(blockId: string, key: string): unknown {
  return properties.get(blockId)?.get(key)?.['value_text']
}

/** The `replacements` the first `convert_unfit_property_values` call sent. */
function sentReplacements(): unknown {
  const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'convert_unfit_property_values')
  return (call?.[1] as { replacements?: unknown } | undefined)?.replacements
}

describe('ConvertUnfitValues', () => {
  it('lists each value once, with its live and trashed blocks', async () => {
    await whenHoldsWords()
    await dispatch('delete_block', { blockId: MTG_2 })
    render(<PropertyDefinitionsList />)
    const dialog = await openConvert('when')

    const soon = await findRow(dialog, 'soon')
    expect(soon).toHaveTextContent(t('propertiesView.convertBlocks', { count: 2 }))
    expect(soon).not.toHaveTextContent(t('propertiesView.convertInTrash', { count: 1 }))
    const later = await findRow(dialog, 'later')
    expect(later).toHaveTextContent(t('propertiesView.convertInTrash', { count: 1 }))
    expect(later).not.toHaveTextContent(t('propertiesView.convertBlocks', { count: 1 }))
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2)
  })

  it.each([
    ['text', null, { value_num: 42 }, '42'],
    ['url', null, { value_num: 7 }, '7'],
    ['number', null, { value_text: 'many' }, 'many'],
    ['date', null, { value_text: 'soon' }, 'soon'],
  ])('gives a %s key a text input', async (valueType, options, fields, value) => {
    await declare('probe', valueType, options)
    holds(MTG_1, 'probe', fields)
    render(<PropertyDefinitionsList />)
    const dialog = await openConvert('probe')
    await findRow(dialog, value)
    const input = replacement(dialog, value) as HTMLInputElement
    expect(input.tagName).toBe('INPUT')
    // Text takes the value itself; the other types take none of it, by construction.
    const prefilled = valueType === 'text' || valueType === 'url'
    expect(input.value).toBe(prefilled ? value : '')
    expect(input.type).toBe(valueType === 'date' ? 'date' : 'text')
    expect(input.getAttribute('inputmode')).toBe(valueType === 'number' ? 'decimal' : null)
  })

  it.each([
    ['boolean', null, [t('property.booleanTrue'), t('property.booleanFalse')]],
    ['select', '["alpha","gamma"]', ['alpha', 'gamma']],
  ])('gives a %s key a choice, with Leave as it is', async (valueType, options, choices) => {
    await declare('probe', valueType, options)
    holds(MTG_1, 'probe', { value_text: 'maybe' })
    render(<PropertyDefinitionsList />)
    const dialog = await openConvert('probe')
    await findRow(dialog, 'maybe')
    const picker = replacement(dialog, 'maybe')
    expect(picker.tagName).toBe('SELECT')
    const names = within(picker)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(names).toEqual([t('propertiesView.convertLeave'), ...choices])
    expect(picker).toHaveDisplayValue(t('propertiesView.convertLeave'))
  })

  it('sends only the values given a replacement, each with the counts it showed', async () => {
    const user = userEvent.setup()
    await whenHoldsWords()
    await dispatch('delete_block', { blockId: PROJ_1 })
    render(<PropertyDefinitionsList />)
    const dialog = await openConvert('when')
    await findRow(dialog, 'later')
    expect(convertButton(dialog, 0)).toBeDisabled()

    await user.type(replacement(dialog, 'soon'), '2026-03-01')
    expect(within(dialog).getByText(t('propertiesView.convertSummary', { count: 2 }))).toBeVisible()
    await user.click(convertButton(dialog, 2))

    await waitFor(() => {
      expect(dateOf(MTG_1, 'when')).toBe('2026-03-01')
    })
    expect(dateOf(PROJ_1, 'when')).toBe('2026-03-01')
    expect(textOf(MTG_2, 'when')).toBe('later')
    const sent = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'convert_unfit_property_values')
    expect(sent).toEqual([
      [
        'convert_unfit_property_values',
        {
          spaceId: PERSONAL.id,
          key: 'when',
          replacements: [
            {
              value: 'soon',
              replacement: '2026-03-01',
              acknowledged: { unfit: 1, unfit_in_trash: 1 },
            },
          ],
        },
      ],
    ])
  })

  it('closes, counts again, and lists only the values left', async () => {
    const user = userEvent.setup()
    await whenHoldsWords()
    render(<PropertyDefinitionsList />)
    let dialog = await openConvert('when')
    await findRow(dialog, 'soon')
    await user.type(replacement(dialog, 'soon'), '2026-03-01')
    await user.click(convertButton(dialog, 2))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(badge('when')).toHaveTextContent(t('propertiesView.unfitBadge', { count: 1 }))
    })
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      t('propertiesView.convertDone', { count: 2, key: 'when' }),
      expect.anything(),
    )
    dialog = await openConvert('when')
    await findRow(dialog, 'later')
    expect(within(dialog).queryByText('soon')).not.toBeInTheDocument()
  })

  it("puts the values back on the toast's Undo", async () => {
    const user = userEvent.setup()
    await whenHoldsWords()
    render(<PropertyDefinitionsList />)
    const dialog = await openConvert('when')
    await findRow(dialog, 'soon')
    await user.type(replacement(dialog, 'soon'), '2026-03-01')
    await user.click(convertButton(dialog, 2))
    await waitFor(() => {
      expect(badge('when')).toHaveTextContent(t('propertiesView.unfitBadge', { count: 1 }))
    })

    const undo = undoOf(t('propertiesView.convertDone', { count: 2, key: 'when' }))
    expect(undo).toBeDefined()
    undo?.()
    await waitFor(() => {
      expect(badge('when')).toHaveTextContent(t('propertiesView.unfitBadge', { count: 3 }))
    })
    expect(textOf(MTG_1, 'when')).toBe('soon')
    expect(textOf(PROJ_1, 'when')).toBe('soon')
    expect(dateOf(MTG_1, 'when')).toBeNull()
  })

  it('reads the values again when they changed, and keeps the replacements', async () => {
    const user = userEvent.setup()
    await whenHoldsWords()
    render(<PropertyDefinitionsList />)
    const dialog = await openConvert('when')
    expect(await findRow(dialog, 'soon')).toHaveTextContent(
      t('propertiesView.convertBlocks', { count: 2 }),
    )
    await user.type(replacement(dialog, 'soon'), '2026-03-01')

    // Another device writes "soon" on a third block.
    holds(MTG_2, 'when', { value_text: 'soon' })
    await user.click(convertButton(dialog, 2))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      t('propertiesView.typeChangeCountsChanged'),
    )
    await waitFor(async () => {
      expect(await findRow(dialog, 'soon')).toHaveTextContent(
        t('propertiesView.convertBlocks', { count: 3 }),
      )
    })
    expect(replacement(dialog, 'soon')).toHaveValue('2026-03-01')
    expect(textOf(MTG_1, 'when')).toBe('soon')

    await user.click(convertButton(dialog, 3))
    await waitFor(() => {
      expect(dateOf(MTG_2, 'when')).toBe('2026-03-01')
    })
    expect(dateOf(MTG_1, 'when')).toBe('2026-03-01')
  })

  it("shows the backend's reason when a replacement doesn't fit, and converts nothing", async () => {
    const user = userEvent.setup()
    await declare('size', 'number')
    holds(MTG_1, 'size', { value_text: 'many' })
    render(<PropertyDefinitionsList />)
    const dialog = await openConvert('size')
    await findRow(dialog, 'many')
    await user.type(replacement(dialog, 'many'), 'lots')
    await user.click(convertButton(dialog, 1))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("'lots' doesn't fit 'size' (number)")
    })
    expect(textOf(MTG_1, 'size')).toBe('many')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('converts a typed number to a number', async () => {
    const user = userEvent.setup()
    await declare('size', 'number')
    holds(MTG_1, 'size', { value_text: 'many' })
    render(<PropertyDefinitionsList />)
    const dialog = await openConvert('size')
    await findRow(dialog, 'many')
    await user.type(replacement(dialog, 'many'), ' 3.5 ')
    await user.click(convertButton(dialog, 1))

    await waitFor(() => {
      expect(properties.get(MTG_1)?.get('size')?.['value_num']).toBe(3.5)
    })
    expect(textOf(MTG_1, 'size')).toBeNull()
  })

  it("sends a boolean's Yes as true and converts the value to a boolean", async () => {
    const user = userEvent.setup()
    await declare('flag', 'boolean')
    holds(MTG_1, 'flag', { value_text: 'maybe' })
    render(<PropertyDefinitionsList />)
    const dialog = await openConvert('flag')
    await findRow(dialog, 'maybe')
    await user.selectOptions(replacement(dialog, 'maybe'), t('property.booleanTrue'))
    await user.click(convertButton(dialog, 1))

    await waitFor(() => {
      expect(properties.get(MTG_1)?.get('flag')?.['value_bool']).toBe(1)
    })
    expect(sentReplacements()).toEqual([
      { value: 'maybe', replacement: 'true', acknowledged: { unfit: 1, unfit_in_trash: 0 } },
    ])
  })

  it('loads the next page on request, keeping what was typed on the one before', async () => {
    const user = userEvent.setup()
    await whenHoldsWords()
    // The mock's two values, one to a page: `later` on the first, `soon` after its cursor.
    const page = (value: string, unfit: number, next: string | null) => ({
      items: [{ value, unfit, unfit_in_trash: 0 }],
      next_cursor: next,
      has_more: next !== null,
      total_count: null,
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd !== 'list_distinct_unfit_property_values') return dispatch(cmd, args)
      const { cursor } = args as { cursor: string | null }
      return cursor === null ? page('later', 1, 'after-later') : page('soon', 2, null)
    })
    render(<PropertyDefinitionsList />)
    const dialog = await openConvert('when')
    await findRow(dialog, 'later')
    expect(within(dialog).queryByText('soon')).not.toBeInTheDocument()
    await user.type(replacement(dialog, 'later'), '2026-04-01')

    await user.click(within(dialog).getByRole('button', { name: t('action.loadMore') }))
    await findRow(dialog, 'soon')
    expect(replacement(dialog, 'later')).toHaveValue('2026-04-01')
    expect(within(dialog).queryByRole('button', { name: t('action.loadMore') })).toBeNull()
    await user.type(replacement(dialog, 'soon'), '2026-03-01')
    await user.click(convertButton(dialog, 3))

    await waitFor(() => {
      expect(dateOf(MTG_2, 'when')).toBe('2026-04-01')
    })
    expect(dateOf(MTG_1, 'when')).toBe('2026-03-01')
    expect(dateOf(PROJ_1, 'when')).toBe('2026-03-01')
    expect(sentReplacements()).toEqual([
      {
        value: 'later',
        replacement: '2026-04-01',
        acknowledged: { unfit: 1, unfit_in_trash: 0 },
      },
      {
        value: 'soon',
        replacement: '2026-03-01',
        acknowledged: { unfit: 2, unfit_in_trash: 0 },
      },
    ])
  })

  it('says so when the values cannot be loaded', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'list_distinct_unfit_property_values') {
        return Promise.reject({ kind: 'database', message: 'disk I/O error' })
      }
      return dispatch(cmd, args)
    })
    await whenHoldsWords()
    render(<PropertyDefinitionsList />)
    const dialog = await openConvert('when')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(t('spaceMove.valuesFailed'))
  })

  it('has no a11y violations', async () => {
    await whenHoldsWords()
    await declare('flag', 'boolean')
    holds(MTG_1, 'flag', { value_text: 'maybe' })
    render(<PropertyDefinitionsList />)
    let dialog = await openConvert('when')
    await findRow(dialog, 'soon')
    await waitFor(async () => {
      expect(await axe(dialog)).toHaveNoViolations()
    })
    await userEvent.setup().keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    dialog = await openConvert('flag')
    await findRow(dialog, 'maybe')
    await waitFor(async () => {
      expect(await axe(dialog)).toHaveNoViolations()
    })
  })
})
