/**
 * #6206 — Move, the step of the "don't fit" review that moves a key's values
 * that don't fit to another key on the same blocks, against the mock backend:
 * the keys offered, the preview of what moves and what stays (already set
 * there, or not fitting there), the Trash counted, a preview answered after
 * another pick not shown, Move disabled when nothing moves, the toast's Undo,
 * a stale acknowledgement previewed again, and the backend's refusal.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { PropertyDefinitionsList } from '@/components/properties/PropertyDefinitionsList'
import { UnfitPropertyValues } from '@/components/properties/UnfitPropertyValues'
import type { AppError, PropertyDefinition } from '@/lib/bindings'
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
const PROJ_2 = SEED_IDS.BLOCK_PROJ_2
const NO_SLOTS = {
  value_text: null,
  value_num: null,
  value_date: null,
  value_ref: null,
  value_bool: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  // Personal declares the text keys `context` and `reviewer`, and the select `project`.
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: PERSONAL.id, availableSpaces: [PERSONAL] })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

async function declare(key: string, valueType: string): Promise<void> {
  await dispatch('create_property_def', { spaceId: PERSONAL.id, key, valueType, options: null })
}

/** `blockId` holds `fields` under `key` as a peer could write it, whatever the definition. */
function holds(blockId: string, key: string, fields: Record<string, unknown>): void {
  const held = properties.get(blockId) ?? new Map()
  held.set(key, rowOf(key, { ...NO_SLOTS, ...fields }))
  properties.set(blockId, held)
}

/**
 * `when` is a date: `MTG_1` holds "soon" beside its `reviewer` "ann", `MTG_2`
 * the number 5 and the trashed `PROJ_1` "later". `size` is a number.
 */
async function whenHoldsMisfits(): Promise<void> {
  await declare('when', 'date')
  await declare('size', 'number')
  holds(MTG_1, 'when', { value_text: 'soon' })
  holds(MTG_1, 'reviewer', { value_text: 'ann' })
  holds(MTG_2, 'when', { value_num: 5 })
  holds(PROJ_1, 'when', { value_text: 'later' })
  await dispatch('delete_block', { blockId: PROJ_1 })
}

function badge(key: string): HTMLElement | null {
  return screen.queryByTestId(`property-unfit-${key}`)
}

/** Open `key`'s review and go to its Move step. */
async function openMove(key: string): Promise<HTMLElement> {
  const user = userEvent.setup()
  await waitFor(() => {
    expect(badge(key)).toBeInTheDocument()
  })
  await user.click(badge(key) as HTMLElement)
  const dialog = await screen.findByRole('dialog')
  await user.click(within(dialog).getByRole('button', { name: t('propertiesView.moveOpen') }))
  return dialog
}

function target(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByLabelText(t('propertiesView.moveTargetLabel'))
}

async function pick(dialog: HTMLElement, into: string): Promise<void> {
  await userEvent.setup().selectOptions(target(dialog), into)
}

function moveButton(dialog: HTMLElement, count: number): HTMLElement {
  return within(dialog).getByRole('button', { name: t('propertiesView.moveConfirm', { count }) })
}

/** The three preview lines, once shown. */
async function previewed(dialog: HTMLElement): Promise<string[]> {
  const counts = await within(dialog).findByTestId('property-unfit-move-counts')
  return [...counts.querySelectorAll('p')].map((line) => line.textContent ?? '')
}

function lines(into: string, moved: number, occupied: number, unfitThere: number): string[] {
  return [
    t('propertiesView.moveMoves', { count: moved, into }),
    t('propertiesView.moveOccupied', { count: occupied, into }),
    t('propertiesView.moveUnfitThere', { count: unfitThere, into }),
    t('propertiesView.mergeTrashNote'),
  ]
}

function undoOf(message: string): (() => void) | undefined {
  const call = vi.mocked(toast.success).mock.calls.find(([shown]) => shown === message)
  return (call?.[1] as { action?: { onClick: () => void } } | undefined)?.action?.onClick
}

function rowOn(blockId: string, key: string): Record<string, unknown> | undefined {
  return properties.get(blockId)?.get(key)
}

function definition(key: string, valueType: string, builtin = false): PropertyDefinition {
  return { key, value_type: valueType, options: null, created_at: '2026-01-01', builtin }
}

describe('MoveUnfitValues', () => {
  it("offers as targets the space's own keys but this one, the app's, and the refs", async () => {
    const user = userEvent.setup()
    await whenHoldsMisfits()
    const definitions = [
      definition('when', 'date'),
      definition('reviewer', 'text'),
      definition('size', 'number'),
      definition('owner', 'ref'),
      definition('template', 'text'),
      definition('priority', 'select', true),
    ]
    render(
      <UnfitPropertyValues
        definition={definition('when', 'date')}
        spaceId={PERSONAL.id}
        counts={{ unfit: 2, unfit_in_trash: 1 }}
        definitions={definitions}
        onChanged={vi.fn()}
      />,
    )
    await user.click(badge('when') as HTMLElement)
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: t('propertiesView.moveOpen') }))
    const names = within(target(dialog))
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(names).toEqual(['reviewer', 'size'])
  })

  it('offers no Move when no other key can take the values', async () => {
    const user = userEvent.setup()
    await whenHoldsMisfits()
    render(
      <UnfitPropertyValues
        definition={definition('when', 'date')}
        spaceId={PERSONAL.id}
        counts={{ unfit: 2, unfit_in_trash: 1 }}
        definitions={[
          definition('when', 'date'),
          definition('owner', 'ref'),
          definition('priority', 'select', true),
        ]}
        onChanged={vi.fn()}
      />,
    )
    await user.click(badge('when') as HTMLElement)
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByRole('button', { name: t('propertiesView.unfitRemove') }),
    ).toBeInTheDocument()
    expect(
      within(dialog).queryByRole('button', { name: t('propertiesView.moveOpen') }),
    ).not.toBeInTheDocument()
  })

  it('previews what moves, what is set there already and what does not fit there', async () => {
    await whenHoldsMisfits()
    render(<PropertyDefinitionsList />)
    const dialog = await openMove('when')
    expect(moveButton(dialog, 0)).toBeDisabled()

    await pick(dialog, 'reviewer')
    // The 5 and the trashed "later" read as text; MTG_1 holds reviewer already.
    expect(await previewed(dialog)).toEqual(lines('reviewer', 2, 1, 0))
    expect(moveButton(dialog, 2)).toBeEnabled()

    await pick(dialog, 'size')
    await waitFor(async () => {
      expect(await previewed(dialog)).toEqual(lines('size', 1, 0, 2))
    })
  })

  it('disables Move when nothing would move', async () => {
    await whenHoldsMisfits()
    await declare('flag', 'boolean')
    render(<PropertyDefinitionsList />)
    const dialog = await openMove('when')
    await pick(dialog, 'flag')
    expect(await previewed(dialog)).toEqual(lines('flag', 0, 0, 3))
    expect(moveButton(dialog, 0)).toBeDisabled()
  })

  it('shows the preview of the last pick, not one answered after it', async () => {
    await whenHoldsMisfits()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      const into = (args as { intoKey?: string } | undefined)?.intoKey
      if (cmd === 'preview_unfit_property_move' && into === 'reviewer') await gate
      return dispatch(cmd, args)
    })
    render(<PropertyDefinitionsList />)
    const dialog = await openMove('when')
    await pick(dialog, 'reviewer')
    await pick(dialog, 'size')
    expect(await previewed(dialog)).toEqual(lines('size', 1, 0, 2))

    // The first pick's preview answers now, after the second's.
    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(await previewed(dialog)).toEqual(lines('size', 1, 0, 2))
  })

  it("moves them, closes, and the toast's Undo puts them back", async () => {
    const user = userEvent.setup()
    await whenHoldsMisfits()
    render(<PropertyDefinitionsList />)
    const dialog = await openMove('when')
    await pick(dialog, 'reviewer')
    await previewed(dialog)
    await user.click(moveButton(dialog, 2))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(rowOn(MTG_2, 'reviewer')?.['value_text']).toBe('5')
    expect(rowOn(MTG_2, 'when')).toBeUndefined()
    expect(rowOn(PROJ_1, 'reviewer')?.['value_text']).toBe('later')
    expect(rowOn(MTG_1, 'when')?.['value_text']).toBe('soon')
    expect(rowOn(MTG_1, 'reviewer')?.['value_text']).toBe('ann')
    await waitFor(() => {
      expect(badge('when')).toHaveTextContent(t('propertiesView.unfitBadge', { count: 1 }))
    })

    const undo = undoOf(t('propertiesView.moveDone', { count: 2, key: 'when', into: 'reviewer' }))
    expect(undo).toBeDefined()
    undo?.()
    await waitFor(() => {
      expect(badge('when')).toHaveTextContent(t('propertiesView.unfitBadge', { count: 2 }))
    })
    expect(rowOn(MTG_2, 'when')?.['value_num']).toBe(5)
    expect(rowOn(MTG_2, 'reviewer')).toBeUndefined()
    expect(rowOn(PROJ_1, 'when')?.['value_text']).toBe('later')
  })

  it('previews again when the values changed since, and asks again', async () => {
    const user = userEvent.setup()
    await whenHoldsMisfits()
    render(<PropertyDefinitionsList />)
    const dialog = await openMove('when')
    await pick(dialog, 'reviewer')
    expect(await previewed(dialog)).toEqual(lines('reviewer', 2, 1, 0))

    // Another device writes a third value that doesn't fit.
    holds(PROJ_2, 'when', { value_text: 'someday' })
    await user.click(moveButton(dialog, 2))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      t('propertiesView.typeChangeCountsChanged'),
    )
    await waitFor(async () => {
      expect(await previewed(dialog)).toEqual(lines('reviewer', 3, 1, 0))
    })
    expect(rowOn(MTG_2, 'when')?.['value_num']).toBe(5)

    await user.click(moveButton(dialog, 3))
    await waitFor(() => {
      expect(rowOn(PROJ_2, 'reviewer')?.['value_text']).toBe('someday')
    })
    expect(rowOn(MTG_2, 'reviewer')?.['value_text']).toBe('5')
  })

  it("shows the backend's reason when the move is refused, and moves nothing", async () => {
    const user = userEvent.setup()
    const refusal: AppError = { kind: 'validation', message: 'the values cannot be moved' }
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'move_unfit_property_values') return Promise.reject(refusal)
      return dispatch(cmd, args)
    })
    await whenHoldsMisfits()
    render(<PropertyDefinitionsList />)
    const dialog = await openMove('when')
    await pick(dialog, 'reviewer')
    await previewed(dialog)
    await user.click(moveButton(dialog, 2))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('the values cannot be moved')
    })
    expect(rowOn(MTG_2, 'when')?.['value_num']).toBe(5)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it("shows the backend's reason when the preview is refused", async () => {
    const refusal: AppError = { kind: 'validation', message: 'the values cannot be counted' }
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'preview_unfit_property_move') return Promise.reject(refusal)
      return dispatch(cmd, args)
    })
    await whenHoldsMisfits()
    render(<PropertyDefinitionsList />)
    const dialog = await openMove('when')
    await pick(dialog, 'reviewer')

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('the values cannot be counted')
    })
    expect(within(dialog).queryByTestId('property-unfit-move-counts')).not.toBeInTheDocument()
    expect(moveButton(dialog, 0)).toBeDisabled()
  })

  it('goes back from Move to the review', async () => {
    const user = userEvent.setup()
    await whenHoldsMisfits()
    render(<PropertyDefinitionsList />)
    const dialog = await openMove('when')
    await user.click(within(dialog).getByRole('button', { name: t('nav.back') }))
    expect(
      within(dialog).getByRole('button', { name: t('propertiesView.unfitRemove') }),
    ).toBeInTheDocument()
    expect(within(dialog).queryByLabelText(t('propertiesView.moveTargetLabel'))).toBeNull()
  })

  it('has no a11y violations, with a preview shown', async () => {
    await whenHoldsMisfits()
    render(<PropertyDefinitionsList />)
    const dialog = await openMove('when')
    await pick(dialog, 'reviewer')
    await previewed(dialog)
    await waitFor(async () => {
      expect(await axe(dialog)).toHaveNoViolations()
    })
  })
})
