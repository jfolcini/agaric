/**
 * #6206 — the values that don't fit a property, from Settings › Properties,
 * against the mock backend: the badge counts the live ones, the dialog lists
 * each with its block and why it doesn't fit, Remove acknowledges the counts
 * and its toast's Undo puts the values back, a stale acknowledgement counts
 * again, Add to options is offered on a user select only, and refusals show
 * the backend's reason.
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
import { rowOf } from '@/lib/tauri-mock/property-keys'
import { properties, SEED_IDS, seedBlocks, spacePropertyDefs } from '@/lib/tauri-mock/seed'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)
const PERSONAL = { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }
const MTG_1 = SEED_IDS.BLOCK_MTG_1
const MTG_2 = SEED_IDS.BLOCK_MTG_2

beforeEach(() => {
  vi.clearAllMocks()
  // Personal's `project` is a select of alpha, beta and gamma, on both meeting
  // blocks (alpha, beta); `context` is text (@office, @remote).
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: PERSONAL.id, availableSpaces: [PERSONAL] })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

/** `project` loses the option `beta`, which the second meeting block holds. */
async function projectLosesBeta(): Promise<void> {
  await dispatch('update_property_def_options', {
    spaceId: PERSONAL.id,
    key: 'project',
    options: '["alpha","gamma"]',
  })
}

/** `context` becomes a number: neither of its texts is one. */
async function contextBecomesNumber(): Promise<void> {
  await dispatch('change_property_type', {
    spaceId: PERSONAL.id,
    key: 'context',
    valueType: 'number',
    options: null,
    acknowledged: { converted: 0, unfit: 2 },
  })
}

function badge(key: string): HTMLElement | null {
  return screen.queryByTestId(`property-unfit-${key}`)
}

async function openDialog(key: string): Promise<HTMLElement> {
  const user = userEvent.setup()
  await waitFor(() => {
    expect(badge(key)).toBeInTheDocument()
  })
  await user.click(badge(key) as HTMLElement)
  return screen.findByRole('dialog')
}

function button(dialog: HTMLElement, key: string): HTMLElement | null {
  return within(dialog).queryByRole('button', { name: t(key) })
}

function undoOf(message: string): (() => void) | undefined {
  const call = vi.mocked(toast.success).mock.calls.find(([shown]) => shown === message)
  return (call?.[1] as { action?: { onClick: () => void } } | undefined)?.action?.onClick
}

describe('UnfitPropertyValues', () => {
  it('shows no badge while every value fits', async () => {
    render(<PropertyDefinitionsList />)
    expect(await screen.findByTestId('property-usage-project')).toBeInTheDocument()
    expect(badge('project')).not.toBeInTheDocument()
    expect(badge('context')).not.toBeInTheDocument()
  })

  it('counts the live values that do not fit, and lists each with its block and why', async () => {
    await contextBecomesNumber()
    await dispatch('delete_block', { blockId: MTG_2 })
    render(<PropertyDefinitionsList />)
    await waitFor(() => {
      expect(badge('context')).toHaveTextContent(t('propertiesView.unfitBadge', { count: 1 }))
    })
    expect(badge('context')).toHaveAccessibleName(
      t('propertiesView.unfitLabel', { count: 1, key: 'context' }),
    )

    const dialog = await openDialog('context')
    expect(within(dialog).getByText(t('propertiesView.unfitCount', { count: 1 }))).toBeVisible()
    expect(within(dialog).getByText(t('propertiesView.unfitInTrash', { count: 1 }))).toBeVisible()
    const office = await within(dialog).findByText('@office')
    expect(office.closest('li')).toHaveTextContent('Meetings › Weekly standup notes')
    expect(office.closest('li')).toHaveTextContent(
      t('propertiesView.unfitForm', { form: 'text', type: 'number' }),
    )
    expect(office.closest('li')).not.toHaveTextContent(t('spaceMove.inTrash'))
    const remote = within(dialog).getByText('@remote')
    expect(remote.closest('li')).toHaveTextContent(t('spaceMove.inTrash'))
  })

  it("says a select's text is not one of its options, and offers Add to options", async () => {
    await projectLosesBeta()
    render(<PropertyDefinitionsList />)
    const dialog = await openDialog('project')
    const beta = await within(dialog).findByText('beta')
    expect(beta.closest('li')).toHaveTextContent(t('propertiesView.unfitNotAnOption'))
    expect(button(dialog, 'propertiesView.unfitAddToOptions')).toBeInTheDocument()
  })

  it('offers no Add to options on a property that is not a select', async () => {
    await contextBecomesNumber()
    render(<PropertyDefinitionsList />)
    const dialog = await openDialog('context')
    expect(await within(dialog).findByText('@office')).toBeInTheDocument()
    expect(button(dialog, 'propertiesView.unfitRemove')).toBeInTheDocument()
    expect(button(dialog, 'propertiesView.unfitAddToOptions')).not.toBeInTheDocument()
  })

  it('holds a built-in select to its options, and offers Remove but no Add to options', async () => {
    const slots = { value_num: null, value_date: null, value_ref: null, value_bool: null }
    properties.get(MTG_1)?.set('listStyle', rowOf('listStyle', { value_text: 'zigzag', ...slots }))
    properties.get(MTG_2)?.set('listStyle', rowOf('listStyle', { value_text: 'ordered', ...slots }))
    render(<PropertyDefinitionsList />)
    await waitFor(() => {
      expect(badge('listStyle')).toHaveTextContent(t('propertiesView.unfitBadge', { count: 1 }))
    })
    const dialog = await openDialog('listStyle')
    expect(await within(dialog).findByText('zigzag')).toBeInTheDocument()
    expect(within(dialog).queryByText('ordered')).not.toBeInTheDocument()
    expect(button(dialog, 'propertiesView.unfitRemove')).toBeInTheDocument()
    expect(button(dialog, 'propertiesView.unfitAddToOptions')).not.toBeInTheDocument()
  })

  it("removes them, and the toast's Undo puts them back", async () => {
    const user = userEvent.setup()
    await projectLosesBeta()
    render(<PropertyDefinitionsList />)
    const dialog = await openDialog('project')
    await user.click(button(dialog, 'propertiesView.unfitRemove') as HTMLElement)

    await waitFor(() => {
      expect(badge('project')).not.toBeInTheDocument()
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(properties.get(MTG_2)?.has('project')).toBe(false)
    expect(properties.get(MTG_1)?.get('project')?.['value_text']).toBe('alpha')

    const undo = undoOf(t('propertiesView.unfitRemoved', { count: 1, key: 'project' }))
    expect(undo).toBeDefined()
    undo?.()
    await waitFor(() => {
      expect(badge('project')).toHaveTextContent(t('propertiesView.unfitBadge', { count: 1 }))
    })
    expect(properties.get(MTG_2)?.get('project')?.['value_text']).toBe('beta')
  })

  it('adds them to the options, and the badge goes', async () => {
    const user = userEvent.setup()
    await projectLosesBeta()
    render(<PropertyDefinitionsList />)
    const dialog = await openDialog('project')
    await user.click(button(dialog, 'propertiesView.unfitAddToOptions') as HTMLElement)

    await waitFor(() => {
      expect(badge('project')).not.toBeInTheDocument()
    })
    expect(spacePropertyDefs(PERSONAL.id).get('project')?.['options']).toBe(
      '["alpha","gamma","beta"]',
    )
    expect(properties.get(MTG_2)?.get('project')?.['value_text']).toBe('beta')
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      t('propertiesView.unfitAddedToOptions', { key: 'project' }),
      expect.anything(),
    )
  })

  it('counts again and asks again when the values changed since', async () => {
    const user = userEvent.setup()
    await projectLosesBeta()
    render(<PropertyDefinitionsList />)
    const dialog = await openDialog('project')
    expect(within(dialog).getByText(t('propertiesView.unfitCount', { count: 1 }))).toBeVisible()

    // Another view narrows the options again: alpha no longer fits either.
    await dispatch('update_property_def_options', {
      spaceId: PERSONAL.id,
      key: 'project',
      options: '["gamma"]',
    })
    await user.click(button(dialog, 'propertiesView.unfitRemove') as HTMLElement)

    expect(
      await within(dialog).findByText(t('propertiesView.typeChangeCountsChanged')),
    ).toBeInTheDocument()
    expect(
      await within(dialog).findByText(t('propertiesView.unfitCount', { count: 2 })),
    ).toBeVisible()
    expect(await within(dialog).findByText('alpha')).toBeInTheDocument()
    expect(properties.get(MTG_2)?.get('project')?.['value_text']).toBe('beta')

    await user.click(button(dialog, 'propertiesView.unfitRemove') as HTMLElement)
    await waitFor(() => {
      expect(properties.get(MTG_1)?.has('project')).toBe(false)
    })
    expect(properties.get(MTG_2)?.has('project')).toBe(false)
  })

  it("shows the backend's reason when the removal is refused, and removes nothing", async () => {
    const user = userEvent.setup()
    const refusal: AppError = { kind: 'validation', message: 'the values cannot be removed' }
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'remove_unfit_property_values') return Promise.reject(refusal)
      return dispatch(cmd, args)
    })
    await projectLosesBeta()
    render(<PropertyDefinitionsList />)
    const dialog = await openDialog('project')
    await user.click(button(dialog, 'propertiesView.unfitRemove') as HTMLElement)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('the values cannot be removed')
    })
    expect(properties.get(MTG_2)?.get('project')?.['value_text']).toBe('beta')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('says nothing was added, and keeps the dialog, when no value is a text', async () => {
    const user = userEvent.setup()
    // `size` was a number held by a meeting block; as a select, its 5 is no option.
    await dispatch('create_property_def', {
      spaceId: PERSONAL.id,
      key: 'size',
      valueType: 'number',
      options: null,
    })
    await dispatch('set_property', { blockId: MTG_1, key: 'size', value: { value_num: 5 } })
    await dispatch('change_property_type', {
      spaceId: PERSONAL.id,
      key: 'size',
      valueType: 'select',
      options: '["s","m"]',
      acknowledged: { converted: 0, unfit: 1 },
    })
    render(<PropertyDefinitionsList />)
    const dialog = await openDialog('size')
    const five = await within(dialog).findByText('5')
    expect(five.closest('li')).toHaveTextContent(
      t('propertiesView.unfitForm', { form: 'number', type: 'select' }),
    )
    await user.click(button(dialog, 'propertiesView.unfitAddToOptions') as HTMLElement)

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(t('propertiesView.unfitNothingToAdd'))
    })
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(spacePropertyDefs(PERSONAL.id).get('size')?.['options']).toBe('["s","m"]')
  })

  it("shows the backend's reason when adding to the options is refused", async () => {
    const user = userEvent.setup()
    const refusal: AppError = { kind: 'validation', message: 'the options cannot change' }
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'add_unfit_values_to_options') return Promise.reject(refusal)
      return dispatch(cmd, args)
    })
    await projectLosesBeta()
    render(<PropertyDefinitionsList />)
    const dialog = await openDialog('project')
    await user.click(button(dialog, 'propertiesView.unfitAddToOptions') as HTMLElement)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('the options cannot change')
    })
    expect(spacePropertyDefs(PERSONAL.id).get('project')?.['options']).toBe('["alpha","gamma"]')
  })

  it('says so when the values cannot be loaded', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'list_unfit_property_values') {
        return Promise.reject({ kind: 'database', message: 'disk I/O error' })
      }
      return dispatch(cmd, args)
    })
    await projectLosesBeta()
    render(<PropertyDefinitionsList />)
    const dialog = await openDialog('project')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(t('spaceMove.valuesFailed'))
  })

  it('says so when none are left to list', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'list_unfit_property_values') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      return dispatch(cmd, args)
    })
    await projectLosesBeta()
    render(<PropertyDefinitionsList />)
    const dialog = await openDialog('project')
    expect(await within(dialog).findByText(t('propertiesView.unfitNone'))).toBeInTheDocument()
  })

  it('offers Convert… on a select and not on a ref, whose values are blocks', async () => {
    const user = userEvent.setup()
    await projectLosesBeta()
    await dispatch('create_property_def', {
      spaceId: PERSONAL.id,
      key: 'owner',
      valueType: 'ref',
      options: null,
    })
    const slots = { value_num: null, value_date: null, value_ref: null, value_bool: null }
    properties.get(MTG_1)?.set('owner', rowOf('owner', { value_text: 'Bob', ...slots }))
    render(<PropertyDefinitionsList />)

    let dialog = await openDialog('project')
    expect(await within(dialog).findByText('beta')).toBeInTheDocument()
    expect(button(dialog, 'propertiesView.convertOpen')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: t('action.cancel') }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    dialog = await openDialog('owner')
    expect(await within(dialog).findByText('Bob')).toBeInTheDocument()
    expect(button(dialog, 'propertiesView.unfitRemove')).toBeInTheDocument()
    expect(button(dialog, 'propertiesView.convertOpen')).not.toBeInTheDocument()
  })

  it('goes back from Convert to the review', async () => {
    const user = userEvent.setup()
    await projectLosesBeta()
    render(<PropertyDefinitionsList />)
    const dialog = await openDialog('project')
    await user.click(button(dialog, 'propertiesView.convertOpen') as HTMLElement)
    expect(
      await within(dialog).findByLabelText(
        t('propertiesView.convertReplacementLabel', { value: 'beta' }),
      ),
    ).toBeInTheDocument()
    expect(button(dialog, 'propertiesView.unfitRemove')).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: t('nav.back') }))
    expect(button(dialog, 'propertiesView.unfitRemove')).toBeInTheDocument()
    expect(
      within(dialog).queryByLabelText(
        t('propertiesView.convertReplacementLabel', { value: 'beta' }),
      ),
    ).not.toBeInTheDocument()
    expect(await within(dialog).findByText('beta')).toBeInTheDocument()
  })

  it('opens again on the review, not on Convert', async () => {
    const user = userEvent.setup()
    await projectLosesBeta()
    render(<PropertyDefinitionsList />)
    let dialog = await openDialog('project')
    await user.click(button(dialog, 'propertiesView.convertOpen') as HTMLElement)
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    dialog = await openDialog('project')
    expect(button(dialog, 'propertiesView.unfitRemove')).toBeInTheDocument()
  })

  it('returns focus to the badge on Cancel', async () => {
    const user = userEvent.setup()
    await projectLosesBeta()
    render(<PropertyDefinitionsList />)
    const dialog = await openDialog('project')
    await user.click(within(dialog).getByRole('button', { name: t('action.cancel') }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(badge('project')).toHaveFocus()
  })

  it('has no a11y violations with the badge, and with the dialog open', async () => {
    await contextBecomesNumber()
    const { container } = render(<PropertyDefinitionsList />)
    await waitFor(() => {
      expect(badge('context')).toBeInTheDocument()
    })
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
    const dialog = await openDialog('context')
    expect(await within(dialog).findByText('@office')).toBeInTheDocument()
    await waitFor(async () => {
      expect(await axe(dialog)).toHaveNoViolations()
    })
  })
})

// A mark on a value that doesn't fit leaves its key in the navigation store's slot.
describe('UnfitPropertyValues opened from a mark', () => {
  beforeEach(() => {
    useNavigationStore.setState({ pendingPropertyReview: null })
  })

  it("opens the slot's key's dialog with no click and clears the slot", async () => {
    await projectLosesBeta()
    await contextBecomesNumber()
    useNavigationStore.setState({ pendingPropertyReview: 'project' })
    render(<PropertyDefinitionsList />)

    expect(
      await screen.findByText(t('propertiesView.unfitTitle', { key: 'project' })),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(t('propertiesView.unfitTitle', { key: 'context' })),
    ).not.toBeInTheDocument()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAccessibleName(t('propertiesView.unfitTitle', { key: 'project' }))
    expect(await within(dialog).findByText('beta')).toBeInTheDocument()
    expect(badge('context')).toBeInTheDocument()
    expect(useNavigationStore.getState().pendingPropertyReview).toBeNull()
  })

  it('has no a11y violations with the dialog it opened', async () => {
    await projectLosesBeta()
    useNavigationStore.setState({ pendingPropertyReview: 'project' })
    render(<PropertyDefinitionsList />)

    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('beta')).toBeInTheDocument()
    await waitFor(async () => {
      expect(await axe(dialog)).toHaveNoViolations()
    })
  })
})
