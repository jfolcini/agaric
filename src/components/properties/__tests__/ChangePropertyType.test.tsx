/**
 * #5841 S3 — changing a property's type from Settings › Properties, against
 * the mock backend: offered on user definitions only, the dialog previews what
 * converts and what is removed and lists the blocks of each, the change
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
import type { AppError } from '@/lib/bindings'
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

const converts = (count: number) => t('propertiesView.typeChangeConverts', { count })
const removes = (count: number, type: string) =>
  t('propertiesView.typeChangeRemoves', { count, type })

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
    expect(counts(dialog)).toHaveTextContent(removes(2, 'number'))
    expect(counts(dialog)).toHaveTextContent(t('propertiesView.typeChangeTrashNote'))

    const removed = await within(dialog).findByText('Meetings › Weekly standup notes')
    expect(removed.closest('li')).toHaveTextContent('@office')
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

  it('lists the removed values a page at a time, and Load more brings the rest', async () => {
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
    expect(counts(dialog)).toHaveTextContent(removes(1, 'select'))
    await user.click(confirmButton(dialog))

    await waitFor(() => {
      expect(spacePropertyDefs(PERSONAL.id).get('context')?.['value_type']).toBe('select')
    })
    expect(spacePropertyDefs(PERSONAL.id).get('context')?.['options']).toBe('["@office","@home"]')
    expect(properties.get(MTG_2)?.has('context')).toBe(false)
  })

  it("changes the type, and the toast's Undo brings the type and the values back", async () => {
    const user = userEvent.setup()
    render(<PropertyDefinitionsList />)
    const dialog = await pickType('number')
    expect(await within(dialog).findByText(removes(2, 'number'))).toBeInTheDocument()
    await user.click(confirmButton(dialog))

    await waitFor(() => {
      expect(contextType()).toBe('number')
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(properties.get(MTG_1)?.has('context')).toBe(false)

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
    expect(await within(dialog).findByText(removes(2, 'number'))).toBeInTheDocument()

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
    expect(await within(dialog).findByText(removes(2, 'number'))).toBeInTheDocument()
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
})
