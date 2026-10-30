/**
 * #5841 S4 — Settings › Properties › Edit options, against the mock backend:
 * one row per option, a rename that reaches the blocks' values and that the
 * toast's Undo takes back, the refusals, and Save of an edited list.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { PropertyDefinitionsList } from '@/components/properties/PropertyDefinitionsList'
import type { AppError, PageResponse, PropertyDefinition, PropertyRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)
const PERSONAL = { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }
const MTG_1 = SEED_IDS.BLOCK_MTG_1

beforeEach(() => {
  vi.clearAllMocks()
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: PERSONAL.id, availableSpaces: [PERSONAL] })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

/** `key`'s options as `list_property_defs` answers them now. */
async function storedOptions(key: string): Promise<unknown> {
  const page = (await dispatch('list_property_defs', {
    spaceId: PERSONAL.id,
    cursor: null,
    limit: null,
  })) as PageResponse<PropertyDefinition>
  const options = page.items.find((d) => d.key === key)?.options
  return options == null ? null : JSON.parse(options)
}

/** `key`'s text on `blockId` as `get_properties` answers it now. */
async function storedValue(blockId: string, key: string): Promise<string | null | undefined> {
  const rows = (await dispatch('get_properties', { blockId })) as PropertyRow[]
  return rows.find((r) => r.key === key)?.value_text
}

function row(label: string): HTMLElement {
  return screen.getByText(label, { selector: 'span' }).closest('li') as HTMLElement
}

async function openOptions(label = 'Project'): Promise<HTMLElement> {
  const user = userEvent.setup()
  await screen.findByText(label)
  await user.click(
    within(row(label)).getByRole('button', { name: t('propertiesView.editOptionsTooltip') }),
  )
  return screen.findByRole('dialog', {
    name: t('pageProperty.editOptionsLabel', { key: label.toLowerCase() }),
  })
}

async function startRename(editor: HTMLElement, option: string): Promise<HTMLElement> {
  const user = userEvent.setup()
  await user.click(
    within(editor).getByRole('button', { name: t('properties.renameOption', { option }) }),
  )
  return within(editor).getByRole('textbox', {
    name: t('properties.renameOptionInput', { option }),
  })
}

async function typeName(input: HTMLElement, name: string): Promise<void> {
  const user = userEvent.setup()
  await user.clear(input)
  await user.type(input, name)
}

function submitButton(editor: HTMLElement): HTMLElement {
  return within(editor).getByRole('button', { name: t('properties.saveOptionName') })
}

function pressToastUndo(message: string): void {
  const call = vi.mocked(toast.success).mock.calls.find(([shown]) => shown === message)
  const action = (call?.[1] as { action?: { label: string; onClick: () => void } } | undefined)
    ?.action
  expect(action?.label).toBe(t('action.undo'))
  action?.onClick()
}

describe('EditSelectOptions', () => {
  it('shows one row per option', async () => {
    render(<PropertyDefinitionsList />)
    const editor = await openOptions()
    for (const option of ['alpha', 'beta', 'gamma']) {
      expect(
        within(editor).getByRole('button', { name: t('properties.renameOption', { option }) }),
      ).toBeInTheDocument()
    }
    expect(within(editor).getByTestId('options-count-badge')).toHaveTextContent(
      t('properties.optionsCount', { count: 3 }),
    )
  })

  it('renames an option in the definition and in the values blocks hold', async () => {
    const user = userEvent.setup()
    render(<PropertyDefinitionsList />)
    const editor = await openOptions()
    await typeName(await startRename(editor, 'alpha'), 'apollo')
    await user.click(submitButton(editor))

    expect(
      await within(editor).findByRole('button', {
        name: t('properties.renameOption', { option: 'apollo' }),
      }),
    ).toBeInTheDocument()
    expect(await storedOptions('project')).toEqual(['apollo', 'beta', 'gamma'])
    expect(await storedValue(MTG_1, 'project')).toBe('apollo')
  })

  it("the toast's Undo takes the rename back", async () => {
    const user = userEvent.setup()
    render(<PropertyDefinitionsList />)
    const editor = await openOptions()
    await typeName(await startRename(editor, 'alpha'), 'apollo')
    await user.click(submitButton(editor))
    await waitFor(async () => {
      expect(await storedValue(MTG_1, 'project')).toBe('apollo')
    })

    pressToastUndo(
      t('propertiesView.optionRenamed', { key: 'project', from: 'alpha', to: 'apollo' }),
    )

    await waitFor(async () => {
      expect(await storedOptions('project')).toEqual(['alpha', 'beta', 'gamma'])
    })
    expect(await storedValue(MTG_1, 'project')).toBe('alpha')
  })

  it('a name the definition already lists disables the rename and says why', async () => {
    render(<PropertyDefinitionsList />)
    const editor = await openOptions()
    const input = await startRename(editor, 'alpha')
    expect(submitButton(editor)).toBeDisabled()

    await typeName(input, 'beta')
    expect(within(editor).getByText(t('properties.optionTaken'))).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(submitButton(editor)).toBeDisabled()

    await typeName(input, 'apollo')
    expect(within(editor).queryByText(t('properties.optionTaken'))).not.toBeInTheDocument()
    expect(submitButton(editor)).toBeEnabled()
  })

  it('a taken name padded with spaces is still taken', async () => {
    render(<PropertyDefinitionsList />)
    const editor = await openOptions()
    await typeName(await startRename(editor, 'alpha'), ' beta ')
    expect(within(editor).getByText(t('properties.optionTaken'))).toBeInTheDocument()
    expect(submitButton(editor)).toBeDisabled()
  })

  it('renames to the name without its surrounding spaces', async () => {
    const user = userEvent.setup()
    render(<PropertyDefinitionsList />)
    const editor = await openOptions()
    await typeName(await startRename(editor, 'alpha'), ' apollo ')
    await user.click(submitButton(editor))

    await waitFor(async () => {
      expect(await storedOptions('project')).toEqual(['apollo', 'beta', 'gamma'])
    })
    expect(await storedValue(MTG_1, 'project')).toBe('apollo')
  })

  it("shows the backend's reason when it refuses the rename, and keeps the row open", async () => {
    const user = userEvent.setup()
    const refusal: AppError = {
      kind: 'validation',
      message: "'apollo' is already held by 1 block(s) of this space, the Trash included",
    }
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) =>
      cmd === 'rename_property_option' ? Promise.reject(refusal) : dispatch(cmd, args),
    )
    render(<PropertyDefinitionsList />)
    const editor = await openOptions()
    const input = await startRename(editor, 'alpha')
    await typeName(input, 'apollo')
    await user.click(submitButton(editor))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(refusal.message)
    })
    expect(input).toBeInTheDocument()
    expect(await storedOptions('project')).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('cancel closes the rename row without writing', async () => {
    const user = userEvent.setup()
    render(<PropertyDefinitionsList />)
    const editor = await openOptions()
    await typeName(await startRename(editor, 'alpha'), 'apollo')
    await user.click(
      within(editor).getByRole('button', { name: t('properties.cancelOptionRename') }),
    )
    expect(
      within(editor).getByRole('button', {
        name: t('properties.renameOption', { option: 'alpha' }),
      }),
    ).toBeInTheDocument()
    expect(await storedOptions('project')).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('remove, add and reorder persist on Save', async () => {
    const user = userEvent.setup()
    render(<PropertyDefinitionsList />)
    const editor = await openOptions()
    await user.click(
      within(editor).getByRole('button', {
        name: t('pageProperty.removeOptionLabel', { option: 'gamma' }),
      }),
    )
    await user.type(
      within(editor).getByRole('textbox', { name: t('pageProperty.newOptionLabel') }),
      'delta{Enter}',
    )
    await user.click(
      within(editor).getByRole('button', {
        name: t('properties.moveOptionUp', { option: 'beta' }),
      }),
    )
    // A pending add is not stored yet, so it cannot be renamed.
    expect(
      within(editor).queryByRole('button', {
        name: t('properties.renameOption', { option: 'delta' }),
      }),
    ).not.toBeInTheDocument()
    await user.click(
      within(editor).getByRole('button', { name: t('pageProperty.saveOptionsButton') }),
    )

    await waitFor(async () => {
      expect(await storedOptions('project')).toEqual(['beta', 'alpha', 'delta'])
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('a built-in select offers no options editor', async () => {
    render(<PropertyDefinitionsList />)
    await screen.findByText('Todo State')
    expect(
      within(row('Todo State')).queryByRole('button', {
        name: t('propertiesView.editOptionsTooltip'),
      }),
    ).not.toBeInTheDocument()
  })

  it('has no a11y violations with the editor open, and with a rename row open', async () => {
    const { container } = render(<PropertyDefinitionsList />)
    const editor = await openOptions()
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
    await startRename(editor, 'alpha')
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
