/**
 * #5841 S2 — renaming a property key from Settings › Properties, against the
 * mock backend: the list is read again, the blocks' values follow, the toast's
 * Undo puts the key back, the dialog hints at keys that cannot be taken, and
 * a refusal shows the backend's reason.
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
import { properties, SEED_IDS, seedBlocks, spacePropertyDefs } from '@/lib/tauri-mock/seed'
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

async function openRename(key: string): Promise<HTMLElement> {
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: t('propertiesView.renameLabel', { key }) }),
  )
  return screen.findByRole('dialog')
}

async function typeKey(dialog: HTMLElement, key: string): Promise<void> {
  const user = userEvent.setup()
  const input = within(dialog).getByRole('textbox', { name: t('propertiesView.renameInputLabel') })
  await user.clear(input)
  await user.type(input, key)
}

function saveButton(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('button', { name: t('rename.save') })
}

describe('RenamePropertyDefinition', () => {
  it("renames the key on the space's definition and on every block holding it", async () => {
    const user = userEvent.setup()
    render(<PropertyDefinitionsList />)
    const dialog = await openRename('context')
    await typeKey(dialog, 'setting')
    await user.click(saveButton(dialog))

    expect(await screen.findByText('Setting')).toBeInTheDocument()
    expect(screen.queryByText('Context')).not.toBeInTheDocument()
    expect(properties.get(MTG_1)?.get('setting')?.['value_text']).toBe('@office')
    expect(properties.get(MTG_1)?.has('context')).toBe(false)
    expect(spacePropertyDefs(PERSONAL.id).has('context')).toBe(false)
  })

  it("the toast's Undo puts the old key back", async () => {
    const user = userEvent.setup()
    render(<PropertyDefinitionsList />)
    const dialog = await openRename('context')
    await typeKey(dialog, 'setting')
    await user.click(saveButton(dialog))
    expect(await screen.findByText('Setting')).toBeInTheDocument()

    const message = t('propertiesView.renamed', { from: 'context', to: 'setting' })
    const call = vi.mocked(toast.success).mock.calls.find(([shown]) => shown === message)
    const action = (call?.[1] as { action?: { label: string; onClick: () => void } } | undefined)
      ?.action
    expect(action?.label).toBe(t('action.undo'))
    action?.onClick()

    expect(await screen.findByText('Context')).toBeInTheDocument()
    expect(screen.queryByText('Setting')).not.toBeInTheDocument()
    expect(properties.get(MTG_1)?.get('context')?.['value_text']).toBe('@office')
  })

  it('hints at a key the space already defines or the app uses, and will not save it', async () => {
    render(<PropertyDefinitionsList />)
    const dialog = await openRename('context')

    await typeKey(dialog, 'reviewer')
    expect(within(dialog).getByRole('alert')).toHaveTextContent(t('propertiesView.duplicateKey'))
    expect(saveButton(dialog)).toBeDisabled()

    await typeKey(dialog, 'template')
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      t('propertiesView.reservedKey', { key: 'template' }),
    )
    expect(saveButton(dialog)).toBeDisabled()

    await typeKey(dialog, 'setting')
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(saveButton(dialog)).toBeEnabled()
  })

  it("shows the backend's reason when it refuses the new key", async () => {
    const user = userEvent.setup()
    // A key a block of the space holds, though no definition declares it.
    await dispatch('set_property', {
      blockId: MTG_1,
      key: 'venue',
      value: { value_text: 'hall' },
    })
    render(<PropertyDefinitionsList />)
    const dialog = await openRename('context')
    await typeKey(dialog, 'venue')
    await user.click(saveButton(dialog))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("'venue'"))
    })
    expect(screen.getByText('Context')).toBeInTheDocument()
    expect(properties.get(MTG_1)?.get('context')?.['value_text']).toBe('@office')
  })

  it('says the rename failed when the IPC fails for another reason', async () => {
    const user = userEvent.setup()
    const failure: AppError = { kind: 'database', message: 'disk I/O error' }
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) =>
      cmd === 'rename_property_key' ? Promise.reject(failure) : dispatch(cmd, args),
    )
    render(<PropertyDefinitionsList />)
    const dialog = await openRename('context')
    await typeKey(dialog, 'setting')
    await user.click(saveButton(dialog))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(t('propertiesView.renameFailed'))
    })
    expect(screen.getByText('Context')).toBeInTheDocument()
  })

  it('offers no rename on a built-in definition', async () => {
    render(<PropertyDefinitionsList />)
    expect(await screen.findByText('Context')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: t('propertiesView.renameLabel', { key: 'priority' }) }),
    ).not.toBeInTheDocument()
  })

  it('has no a11y violations with the dialog open', async () => {
    render(<PropertyDefinitionsList />)
    const dialog = await openRename('context')
    await waitFor(async () => {
      expect(await axe(dialog)).toHaveNoViolations()
    })
  })
})
