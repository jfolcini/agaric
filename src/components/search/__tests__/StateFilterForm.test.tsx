/**
 * CR-MINOR — dedicated tests for `<StateFilterForm>`.
 *
 * Previously covered only transitively via `FilterHelperPopover.test.tsx`.
 * The form builds a `state` / `not-state` `FilterToken` from the SEARCH
 * vocabulary (`STATE_VALUES`) and an include/exclude toggle.
 *
 * `@/components/ui/select` is globally mocked as a native `<select>` (see
 * `src/test-setup.ts`), so `userEvent.selectOptions` drives the value.
 *
 * Coverage:
 *  - renders the form, value control and Back/Add buttons
 *  - selecting a value + Add emits a `state` token
 *  - toggling exclude + Add emits a `notState` token
 *  - Back fires onBack
 *  - axe(container) clean
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'

import { StateFilterForm } from '../filter-forms/StateFilterForm'

function setup(): {
  onAddFilter: ReturnType<typeof vi.fn>
  onBack: ReturnType<typeof vi.fn>
  container: HTMLElement
} {
  const onAddFilter = vi.fn()
  const onBack = vi.fn()
  const { container } = render(<StateFilterForm onAddFilter={onAddFilter} onBack={onBack} />)
  return { onAddFilter, onBack, container }
}

const valueSelect = (): HTMLElement =>
  screen.getByLabelText(t('search.filterHelper.stateValueLabel'))
const addButton = (): HTMLElement =>
  screen.getByRole('button', { name: t('search.filterHelper.add') })
const backButton = (): HTMLElement =>
  screen.getByRole('button', { name: t('search.filterHelper.back') })
const excludeRadio = (): HTMLElement =>
  screen.getByRole('radio', { name: t('search.filterHelper.exclude') })

describe('StateFilterForm — render', () => {
  it('renders the form scaffold and controls', () => {
    setup()
    expect(screen.getByTestId('state-filter-form')).toBeInTheDocument()
    expect(screen.getByText(t('search.filterCategory.state'))).toBeInTheDocument()
    expect(valueSelect()).toBeInTheDocument()
    expect(addButton()).toBeInTheDocument()
    expect(backButton()).toBeInTheDocument()
    expect(
      screen.getByRole('radiogroup', { name: t('search.filterHelper.matchMode') }),
    ).toBeInTheDocument()
  })
})

describe('StateFilterForm — interaction', () => {
  it('emits a `state` token for the selected value', async () => {
    const user = userEvent.setup()
    const { onAddFilter } = setup()
    await user.selectOptions(valueSelect(), 'DONE')
    await user.click(addButton())
    expect(onAddFilter).toHaveBeenCalledWith({ kind: 'state', value: 'DONE', span: [0, 0] })
  })

  it('emits a `notState` token when exclude is toggled', async () => {
    const user = userEvent.setup()
    const { onAddFilter } = setup()
    await user.selectOptions(valueSelect(), 'TODO')
    await user.click(excludeRadio())
    await user.click(addButton())
    expect(onAddFilter).toHaveBeenCalledWith({ kind: 'notState', value: 'TODO', span: [0, 0] })
  })

  it('defaults to the first STATE_VALUES entry when nothing is changed', async () => {
    const user = userEvent.setup()
    const { onAddFilter } = setup()
    await user.click(addButton())
    expect(onAddFilter).toHaveBeenCalledWith({ kind: 'state', value: 'TODO', span: [0, 0] })
  })

  it('calls onBack when Back is clicked', async () => {
    const user = userEvent.setup()
    const { onBack, onAddFilter } = setup()
    await user.click(backButton())
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onAddFilter).not.toHaveBeenCalled()
  })
})

describe('StateFilterForm — a11y', () => {
  it('has no axe violations', async () => {
    const { container } = setup()
    expect(await axe(container as any)).toHaveNoViolations()
  })
})
