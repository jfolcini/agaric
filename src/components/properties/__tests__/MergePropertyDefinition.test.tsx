/**
 * #5841 S2 — merging one property key into another from Settings ›
 * Properties, against the mock backend: offered only toward a definition of
 * the same type, the dialog previews what moves and what is dropped, the merge
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
import { properties, SEED_IDS, seedBlocks, spacePropertyDefs } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)
const PERSONAL = { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }
const MTG_1 = SEED_IDS.BLOCK_MTG_1
const MTG_2 = SEED_IDS.BLOCK_MTG_2

beforeEach(() => {
  vi.clearAllMocks()
  // Personal declares `context` and `reviewer` as text; `context` is on both meeting blocks.
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: PERSONAL.id, availableSpaces: [PERSONAL] })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

async function setReviewer(blockId: string, text: string): Promise<void> {
  await dispatch('set_property', { blockId, key: 'reviewer', value: { value_text: text } })
}

function mergeButton(key: string): HTMLElement | null {
  return screen.queryByRole('button', { name: t('propertiesView.mergeLabel', { key }) })
}

/** Open `context`'s merge dialog and pick `reviewer`. */
async function pickReviewer(): Promise<HTMLElement> {
  const user = userEvent.setup()
  await waitFor(() => {
    expect(mergeButton('context')).toBeInTheDocument()
  })
  await user.click(mergeButton('context') as HTMLElement)
  const dialog = await screen.findByRole('dialog')
  await user.selectOptions(
    within(dialog).getByRole('combobox', { name: t('propertiesView.mergeTargetLabel') }),
    'reviewer',
  )
  return dialog
}

function confirmButton(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('button', { name: t('propertiesView.mergeConfirm') })
}

const moves = (count: number) =>
  t('propertiesView.mergeMoves', { count, into: 'reviewer', from: 'context' })
const drops = (count: number) =>
  t('propertiesView.mergeDrops', { count, into: 'reviewer', from: 'context' })

describe('MergePropertyDefinition', () => {
  it('is offered only toward another definition of the same type', async () => {
    await dispatch('create_property_def', {
      spaceId: PERSONAL.id,
      key: 'estimate',
      valueType: 'number',
      options: null,
    })
    render(<PropertyDefinitionsList />)
    await waitFor(() => {
      expect(mergeButton('context')).toBeInTheDocument()
    })
    expect(screen.getByText('Estimate')).toBeInTheDocument()
    expect(mergeButton('estimate')).not.toBeInTheDocument()
  })

  it('previews the counts and merges with them acknowledged', async () => {
    const user = userEvent.setup()
    await setReviewer(MTG_1, 'ann')
    render(<PropertyDefinitionsList />)
    const dialog = await pickReviewer()

    expect(await within(dialog).findByText(moves(1))).toBeInTheDocument()
    expect(within(dialog).getByText(drops(1))).toBeInTheDocument()
    expect(within(dialog).getByText(t('propertiesView.mergeTrashNote'))).toBeInTheDocument()
    await user.click(confirmButton(dialog))

    await waitFor(() => {
      expect(screen.queryByText('Context')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(spacePropertyDefs(PERSONAL.id).has('context')).toBe(false)
    expect(properties.get(MTG_1)?.get('reviewer')?.['value_text']).toBe('ann')
    expect(properties.get(MTG_2)?.get('reviewer')?.['value_text']).toBe('@remote')
    expect(properties.get(MTG_2)?.has('context')).toBe(false)
  })

  it('previews again and asks again when the counts changed since', async () => {
    const user = userEvent.setup()
    render(<PropertyDefinitionsList />)
    const dialog = await pickReviewer()
    expect(await within(dialog).findByText(moves(2))).toBeInTheDocument()
    expect(within(dialog).queryByText(drops(0))).not.toBeInTheDocument()

    // Another view gives a meeting block a reviewer after the preview.
    await setReviewer(MTG_2, 'bo')
    await user.click(confirmButton(dialog))

    expect(
      await within(dialog).findByText(t('propertiesView.mergeCountsChanged')),
    ).toBeInTheDocument()
    expect(within(dialog).getByText(moves(1))).toBeInTheDocument()
    expect(within(dialog).getByText(drops(1))).toBeInTheDocument()
    expect(spacePropertyDefs(PERSONAL.id).has('context')).toBe(true)

    await user.click(confirmButton(dialog))
    await waitFor(() => {
      expect(spacePropertyDefs(PERSONAL.id).has('context')).toBe(false)
    })
    expect(properties.get(MTG_2)?.get('reviewer')?.['value_text']).toBe('bo')
  })

  it("the toast's Undo brings the merged key and its values back", async () => {
    const user = userEvent.setup()
    render(<PropertyDefinitionsList />)
    const dialog = await pickReviewer()
    expect(await within(dialog).findByText(moves(2))).toBeInTheDocument()
    await user.click(confirmButton(dialog))
    await waitFor(() => {
      expect(screen.queryByText('Context')).not.toBeInTheDocument()
    })

    const message = t('propertiesView.merged', { from: 'context', into: 'reviewer' })
    const call = vi.mocked(toast.success).mock.calls.find(([shown]) => shown === message)
    const action = (call?.[1] as { action?: { label: string; onClick: () => void } } | undefined)
      ?.action
    expect(action?.label).toBe(t('action.undo'))
    action?.onClick()

    expect(await screen.findByText('Context')).toBeInTheDocument()
    expect(properties.get(MTG_1)?.get('context')?.['value_text']).toBe('@office')
    expect(properties.get(MTG_1)?.has('reviewer')).toBe(false)
  })

  it("shows the backend's reason when the preview is refused", async () => {
    const refusal: AppError = { kind: 'validation', message: 'the merge cannot be previewed' }
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'preview_property_merge') return Promise.reject(refusal)
      return dispatch(cmd, args)
    })
    render(<PropertyDefinitionsList />)
    const dialog = await pickReviewer()

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('the merge cannot be previewed')
    })
    expect(confirmButton(dialog)).toBeDisabled()
  })

  it("shows the backend's reason when the merge is refused, and merges nothing", async () => {
    const user = userEvent.setup()
    const refusal: AppError = { kind: 'validation', message: 'change one type first' }
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'merge_property_key') return Promise.reject(refusal)
      return dispatch(cmd, args)
    })
    render(<PropertyDefinitionsList />)
    const dialog = await pickReviewer()
    expect(await within(dialog).findByText(moves(2))).toBeInTheDocument()
    await user.click(confirmButton(dialog))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('change one type first')
    })
    expect(spacePropertyDefs(PERSONAL.id).has('context')).toBe(true)
  })

  it('has no a11y violations with the preview shown', async () => {
    render(<PropertyDefinitionsList />)
    const dialog = await pickReviewer()
    expect(await within(dialog).findByText(moves(2))).toBeInTheDocument()
    await waitFor(async () => {
      expect(await axe(dialog)).toHaveNoViolations()
    })
  })
})
