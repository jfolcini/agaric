/**
 * #5841 S3 — changing a property's type from Settings › Properties, against
 * the mock backend: offered on user definitions only, the dialog previews what
 * converts and what doesn't fit and lists the blocks of each, the change
 * acknowledges those counts, a stale acknowledgement previews again, the
 * toast's Undo restores, and a refusal shows the backend's reason.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { PropertyDefinitionsList } from '@/components/properties/PropertyDefinitionsList'
import type {
  AppError,
  PageResponse,
  PropertyTypeChangeCounts,
  PropertyTypeChangeValue,
} from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blocks,
  makeBlock,
  properties,
  SEED_IDS,
  seedBlocks,
  spacePropertyDefs,
} from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)
const PERSONAL = { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }
const MTG_1 = SEED_IDS.BLOCK_MTG_1
const MTG_2 = SEED_IDS.BLOCK_MTG_2
const WELCOME = SEED_IDS.BLOCK_GS_1

beforeEach(() => {
  vi.clearAllMocks()
  // Personal declares `context` as text; it is on both meeting blocks.
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: PERSONAL.id, availableSpaces: [PERSONAL] })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

async function setContext(blockId: string, text: string): Promise<void> {
  await dispatch('set_property', { blockId, key: 'context', value: { value_text: text } })
}

function changeButton(key: string): HTMLElement | null {
  return screen.queryByRole('button', { name: t('propertiesView.typeChangeLabel', { key }) })
}

/** Open `context`'s type dialog and pick `type`. */
async function pickType(type: string): Promise<HTMLElement> {
  const user = userEvent.setup()
  await waitFor(() => {
    expect(changeButton('context')).toBeInTheDocument()
  })
  await user.click(changeButton('context') as HTMLElement)
  const dialog = await screen.findByRole('dialog')
  await user.selectOptions(
    within(dialog).getByRole('combobox', { name: t('propertiesView.typeChangeTypeLabel') }),
    type,
  )
  return dialog
}

function confirmButton(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('button', { name: t('propertiesView.typeChangeConfirm') })
}

function counts(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByTestId('property-type-change-counts')
}

/** `context`'s type dialog, opened. */
async function openDialog(): Promise<HTMLElement> {
  const user = userEvent.setup()
  await waitFor(() => {
    expect(changeButton('context')).toBeInTheDocument()
  })
  await user.click(changeButton('context') as HTMLElement)
  return screen.findByRole('dialog')
}

function severalBox(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('checkbox', { name: t('properties.holdsSeveralValues') })
}

const converts = (count: number) => t('propertiesView.typeChangeConverts', { count })
const unfit = (count: number, type: string) => t('propertiesView.typeChangeUnfit', { count, type })

/** The badge of `context`'s row: its type. */
function contextType(): string | null | undefined {
  return screen.getByText('Context').closest('li')?.querySelector('[data-slot="badge"]')
    ?.textContent
}

describe('ChangePropertyType', () => {
  it('is offered on user definitions only, never a built-in or app-internal one', async () => {
    await dispatch('create_property_def', {
      spaceId: PERSONAL.id,
      key: 'template',
      valueType: 'text',
      options: null,
    })
    render(<PropertyDefinitionsList />)
    await waitFor(() => {
      expect(changeButton('context')).toBeInTheDocument()
    })
    expect(screen.getByText('Template')).toBeInTheDocument()
    expect(changeButton('template')).not.toBeInTheDocument()
    expect(screen.getByTestId('builtin-lock-due_date')).toBeInTheDocument()
    expect(changeButton('due_date')).not.toBeInTheDocument()
  })

  it('previews the counts and lists the blocks of each tab', async () => {
    const user = userEvent.setup()
    await setContext(WELCOME, '042')
    render(<PropertyDefinitionsList />)
    const dialog = await pickType('number')

    expect(await within(dialog).findByText(converts(1))).toBeInTheDocument()
    expect(counts(dialog)).toHaveTextContent(unfit(2, 'number'))
    expect(counts(dialog)).toHaveTextContent(t('propertiesView.typeChangeTrashNote'))
    expect(
      within(dialog).getByText(t('propertiesView.typeChangeDescription', { key: 'context' })),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('tab', {
        name: t('propertiesView.typeChangeUnfitTab', { count: 2 }),
        selected: true,
      }),
    ).toBeInTheDocument()

    const doesNotFit = await within(dialog).findByText('Meetings › Weekly standup notes')
    expect(doesNotFit.closest('li')).toHaveTextContent('@office')
    await user.click(
      within(dialog).getByRole('tab', {
        name: t('propertiesView.typeChangeConvertedTab', { count: 1 }),
      }),
    )
    const converted = await within(dialog).findByText('042 → 42')
    expect(converted.closest('li')).toHaveTextContent('Welcome to Agaric!')
  })

  it("shows a ref's target by its title", async () => {
    const user = userEvent.setup()
    await setContext(WELCOME, SEED_IDS.PAGE_MEETINGS)
    render(<PropertyDefinitionsList />)
    const dialog = await pickType('ref')
    expect(await within(dialog).findByText(converts(1))).toBeInTheDocument()

    await user.click(
      within(dialog).getByRole('tab', {
        name: t('propertiesView.typeChangeConvertedTab', { count: 1 }),
      }),
    )
    expect(
      await within(dialog).findByText(`${SEED_IDS.PAGE_MEETINGS} → Meetings`),
    ).toBeInTheDocument()
  })

  it("lists the values that don't fit a page at a time, and Load more brings the rest", async () => {
    const user = userEvent.setup()
    // 49 more blocks of the meetings page hold `context`: 51 in all, past one page.
    for (let i = 0; i < 49; i++) {
      const id = `${'0'.repeat(19)}H${String(i).padStart(6, '0')}`
      blocks.set(id, makeBlock(id, 'content', `holder ${i}`, SEED_IDS.PAGE_MEETINGS, 3 + i))
      await setContext(id, `place ${i}`)
    }
    render(<PropertyDefinitionsList />)
    const dialog = await pickType('number')
    const panel = await within(dialog).findByRole('tabpanel')

    await waitFor(() => {
      expect(within(panel).getAllByRole('listitem')).toHaveLength(50)
    })
    await user.click(within(panel).getByRole('button', { name: t('action.loadMore') }))
    await waitFor(() => {
      expect(within(panel).getAllByRole('listitem')).toHaveLength(51)
    })
    expect(
      within(panel).queryByRole('button', { name: t('action.loadMore') }),
    ).not.toBeInTheDocument()
  })

  it('previews a change to select once the options are typed', async () => {
    const user = userEvent.setup()
    render(<PropertyDefinitionsList />)
    const dialog = await pickType('select')
    expect(confirmButton(dialog)).toBeDisabled()

    await user.type(
      within(dialog).getByRole('textbox', { name: t('properties.newSelectOptions') }),
      '@office, @home',
    )
    expect(await within(dialog).findByText(converts(1))).toBeInTheDocument()
    expect(counts(dialog)).toHaveTextContent(unfit(1, 'select'))
    await user.click(confirmButton(dialog))

    await waitFor(() => {
      expect(spacePropertyDefs(PERSONAL.id).get('context')?.['value_type']).toBe('select')
    })
    expect(spacePropertyDefs(PERSONAL.id).get('context')?.['options']).toBe('["@office","@home"]')
    expect(properties.get(MTG_2)?.get('context')?.['value_text']).toBe('@remote')
  })

  it("changes the type, and the toast's Undo brings the type and the values back", async () => {
    const user = userEvent.setup()
    render(<PropertyDefinitionsList />)
    const dialog = await pickType('number')
    expect(await within(dialog).findByText(unfit(2, 'number'))).toBeInTheDocument()
    await user.click(confirmButton(dialog))

    await waitFor(() => {
      expect(contextType()).toBe('number')
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(properties.get(MTG_1)?.get('context')).toMatchObject({
      value_text: '@office',
      value_num: null,
    })

    const message = t('propertiesView.typeChanged', { key: 'context', type: 'number' })
    const call = vi.mocked(toast.success).mock.calls.find(([shown]) => shown === message)
    const action = (call?.[1] as { action?: { label: string; onClick: () => void } } | undefined)
      ?.action
    expect(action?.label).toBe(t('action.undo'))
    action?.onClick()

    await waitFor(() => {
      expect(contextType()).toBe('text')
    })
    expect(properties.get(MTG_1)?.get('context')?.['value_text']).toBe('@office')
  })

  it('previews again and asks again when the values changed since', async () => {
    const user = userEvent.setup()
    render(<PropertyDefinitionsList />)
    const dialog = await pickType('number')
    expect(await within(dialog).findByText(unfit(2, 'number'))).toBeInTheDocument()

    // Another view gives a third block a context after the preview.
    await setContext(WELCOME, '5')
    await user.click(confirmButton(dialog))

    expect(
      await within(dialog).findByText(t('propertiesView.typeChangeCountsChanged')),
    ).toBeInTheDocument()
    expect(within(dialog).getByText(converts(1))).toBeInTheDocument()
    expect(spacePropertyDefs(PERSONAL.id).get('context')?.['value_type']).toBe('text')

    await user.click(confirmButton(dialog))
    await waitFor(() => {
      expect(spacePropertyDefs(PERSONAL.id).get('context')?.['value_type']).toBe('number')
    })
    expect(properties.get(WELCOME)?.get('context')?.['value_num']).toBe(5)
  })

  it("shows the backend's reason when the preview is refused", async () => {
    const refusal: AppError = { kind: 'validation', message: 'the change cannot be previewed' }
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'preview_property_type_change') return Promise.reject(refusal)
      return dispatch(cmd, args)
    })
    render(<PropertyDefinitionsList />)
    const dialog = await pickType('number')

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('the change cannot be previewed')
    })
    expect(confirmButton(dialog)).toBeDisabled()
  })

  it("shows the backend's reason when the change is refused, and changes nothing", async () => {
    const user = userEvent.setup()
    const refusal: AppError = { kind: 'validation', message: "'context' is already a number" }
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'change_property_type') return Promise.reject(refusal)
      return dispatch(cmd, args)
    })
    render(<PropertyDefinitionsList />)
    const dialog = await pickType('number')
    expect(await within(dialog).findByText(unfit(2, 'number'))).toBeInTheDocument()
    await user.click(confirmButton(dialog))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("'context' is already a number")
    })
    expect(spacePropertyDefs(PERSONAL.id).get('context')?.['value_type']).toBe('text')
  })

  it('has no a11y violations with the preview and its values shown', async () => {
    render(<PropertyDefinitionsList />)
    const dialog = await pickType('number')
    expect(await within(dialog).findByText('Meetings › Weekly standup notes')).toBeInTheDocument()
    await waitFor(async () => {
      expect(await axe(dialog)).toHaveNoViolations()
    })
  })

  // #6741 D2/D5 — to and from a list. The mock's type change is Lane R's; these
  // pin what the dialog sends, and the backend's answer is canned.
  describe('to and from a list (#6741)', () => {
    const COUNTS: PropertyTypeChangeCounts = { converted: 2, unfit: 0 }
    const VALUE: PropertyTypeChangeValue = {
      block_id: MTG_1,
      page_id: SEED_IDS.PAGE_MEETINGS,
      page_title: 'Meetings',
      content: 'Weekly standup notes',
      deleted: false,
      value: '@office, @home',
      converted: '@office, @home',
    }
    let sent: Array<{ cmd: string; args: Record<string, unknown> }>

    /** Answer the type change with canned counts; the change writes the definition it was sent. */
    function stubTypeChange(): void {
      sent = []
      mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
        const a = (args ?? {}) as Record<string, unknown>
        if (cmd === 'preview_property_type_change') {
          sent.push({ cmd, args: a })
          return COUNTS
        }
        if (cmd === 'list_property_type_change_values') {
          sent.push({ cmd, args: a })
          const page: PageResponse<PropertyTypeChangeValue> = {
            items: [VALUE],
            next_cursor: null,
            has_more: false,
            total_count: null,
          }
          return page
        }
        if (cmd === 'change_property_type') {
          sent.push({ cmd, args: a })
          const defs = spacePropertyDefs(PERSONAL.id)
          const def: Record<string, unknown> = {
            ...defs.get('context'),
            value_type: a['valueType'],
          }
          if (a['multiple'] === true) def['multiple'] = true
          else delete def['multiple']
          defs.set('context', def)
          return { ...def, op_refs: [{ device_id: 'D', seq: 1 }] }
        }
        return dispatch(cmd, args)
      })
    }

    const previews = () => sent.filter(({ cmd }) => cmd === 'preview_property_type_change')

    function declareList(): void {
      const defs = spacePropertyDefs(PERSONAL.id)
      defs.set('context', { ...defs.get('context'), multiple: true })
    }

    it('splits each value at commas into a list, and lists the key as holding several', async () => {
      const user = userEvent.setup()
      stubTypeChange()
      render(<PropertyDefinitionsList />)
      const dialog = await openDialog()
      expect(severalBox(dialog)).not.toBeChecked()

      await user.click(severalBox(dialog))
      const split = within(dialog).getByRole('radiogroup', {
        name: t('propertiesView.typeChangeSplitLabel'),
      })
      // Where to split is the user's to say: nothing is previewed before.
      expect(previews()).toEqual([])
      expect(confirmButton(dialog)).toBeDisabled()
      await user.click(
        within(split).getByRole('radio', { name: t('propertiesView.typeChangeSplitComma') }),
      )

      expect(await within(dialog).findByText(converts(2))).toBeInTheDocument()
      expect(previews().at(-1)?.args).toEqual({
        spaceId: PERSONAL.id,
        key: 'context',
        valueType: 'text',
        options: null,
        multiple: true,
        separator: 'comma',
      })
      await user.click(
        within(dialog).getByRole('tab', {
          name: t('propertiesView.typeChangeConvertedTab', { count: 2 }),
        }),
      )
      expect(await within(dialog).findByText('@office, @home → @office, @home')).toBeVisible()
      expect(
        sent.find(({ cmd }) => cmd === 'list_property_type_change_values')?.args,
      ).toMatchObject({ valueType: 'text', options: null, multiple: true, separator: 'comma' })
      await user.click(confirmButton(dialog))

      await waitFor(() => {
        expect(contextType()).toBe(t('properties.severalValuesType', { type: 'text' }))
      })
      expect(sent.find(({ cmd }) => cmd === 'change_property_type')?.args).toEqual({
        spaceId: PERSONAL.id,
        key: 'context',
        valueType: 'text',
        options: null,
        multiple: true,
        separator: 'comma',
        acknowledged: COUNTS,
      })
      expect(toast.success).toHaveBeenCalledWith(
        t('propertiesView.typeChanged', {
          key: 'context',
          type: t('properties.severalValuesType', { type: 'text' }),
        }),
        expect.anything(),
      )
    })

    it('opens again on the flag the key holds, after a cancel and after a change', async () => {
      const user = userEvent.setup()
      stubTypeChange()
      render(<PropertyDefinitionsList />)
      let dialog = await openDialog()
      await user.click(severalBox(dialog))
      await user.click(within(dialog).getByRole('button', { name: t('action.cancel') }))
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      })
      dialog = await openDialog()
      expect(severalBox(dialog)).not.toBeChecked()

      await user.click(severalBox(dialog))
      await user.click(
        within(dialog).getByRole('radio', { name: t('propertiesView.typeChangeSplitComma') }),
      )
      expect(await within(dialog).findByText(converts(2))).toBeInTheDocument()
      await user.click(confirmButton(dialog))
      await waitFor(() => {
        expect(contextType()).toBe(t('properties.severalValuesType', { type: 'text' }))
      })

      dialog = await openDialog()
      expect(severalBox(dialog)).toBeChecked()
    })

    it('makes each value a one-item list when told not to split, and splits at semicolons', async () => {
      const user = userEvent.setup()
      stubTypeChange()
      render(<PropertyDefinitionsList />)
      const dialog = await openDialog()
      await user.click(severalBox(dialog))

      await user.click(
        within(dialog).getByRole('radio', { name: t('propertiesView.typeChangeSplitNone') }),
      )
      await waitFor(() => {
        expect(previews().at(-1)?.args).toMatchObject({ multiple: true, separator: null })
      })
      await user.click(
        within(dialog).getByRole('radio', { name: t('propertiesView.typeChangeSplitSemicolon') }),
      )
      await waitFor(() => {
        expect(previews().at(-1)?.args).toMatchObject({ multiple: true, separator: 'semicolon' })
      })
    })

    it('joins each list into one text at the separator picked', async () => {
      const user = userEvent.setup()
      declareList()
      stubTypeChange()
      render(<PropertyDefinitionsList />)
      const dialog = await openDialog()
      expect(severalBox(dialog)).toBeChecked()

      await user.click(severalBox(dialog))
      expect(previews()).toEqual([])
      const join = within(dialog).getByRole('radiogroup', {
        name: t('propertiesView.typeChangeJoinLabel'),
      })
      await user.click(
        within(join).getByRole('radio', { name: t('propertiesView.typeChangeJoinSemicolon') }),
      )

      expect(await within(dialog).findByText(converts(2))).toBeInTheDocument()
      expect(previews().at(-1)?.args).toEqual({
        spaceId: PERSONAL.id,
        key: 'context',
        valueType: 'text',
        options: null,
        multiple: false,
        separator: 'semicolon',
      })
      await user.click(confirmButton(dialog))
      await waitFor(() => {
        expect(contextType()).toBe('text')
      })
    })

    it('asks no separator for a list changed to numbers, nor one to a list of numbers', async () => {
      const user = userEvent.setup()
      declareList()
      stubTypeChange()
      render(<PropertyDefinitionsList />)
      const dialog = await pickType('number')

      // A list of numbers: each item converts, nothing to split or join.
      await waitFor(() => {
        expect(previews().at(-1)?.args).toMatchObject({
          valueType: 'number',
          multiple: true,
          separator: null,
        })
      })
      await user.click(severalBox(dialog))
      await waitFor(() => {
        expect(previews().at(-1)?.args).toMatchObject({
          valueType: 'number',
          multiple: false,
          separator: null,
        })
      })
      expect(within(dialog).queryByRole('radiogroup')).not.toBeInTheDocument()
    })

    it('offers no several values for a boolean, which holds one', async () => {
      declareList()
      stubTypeChange()
      render(<PropertyDefinitionsList />)
      const dialog = await pickType('boolean')

      expect(
        within(dialog).queryByRole('checkbox', { name: t('properties.holdsSeveralValues') }),
      ).not.toBeInTheDocument()
      await waitFor(() => {
        expect(previews().at(-1)?.args).toMatchObject({
          valueType: 'boolean',
          multiple: false,
          separator: null,
        })
      })
    })

    it('previews nothing while the type and the flag are as they are', async () => {
      const user = userEvent.setup()
      stubTypeChange()
      render(<PropertyDefinitionsList />)
      const dialog = await openDialog()

      await user.click(severalBox(dialog))
      await user.click(severalBox(dialog))

      expect(within(dialog).queryByRole('radiogroup')).not.toBeInTheDocument()
      expect(previews()).toEqual([])
      expect(confirmButton(dialog)).toBeDisabled()
    })

    it('has no a11y violations with the split choice shown', async () => {
      const user = userEvent.setup()
      stubTypeChange()
      render(<PropertyDefinitionsList />)
      const dialog = await openDialog()
      await user.click(severalBox(dialog))
      expect(within(dialog).getByRole('radiogroup')).toBeInTheDocument()
      await waitFor(async () => {
        expect(await axe(dialog)).toHaveNoViolations()
      })
    })
  })
})
