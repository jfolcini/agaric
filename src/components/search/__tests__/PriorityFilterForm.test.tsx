/**
 * CR-MINOR — dedicated tests for `<PriorityFilterForm>`.
 *
 * Previously covered only transitively via `FilterHelperPopover.test.tsx`.
 * The form builds a `priority` / `not-priority` `FilterToken` from the
 * user-configurable `usePriorityLevels()` set plus the appended `none`
 * sentinel, driven by an include/exclude toggle.
 *
 * `@/components/ui/select` is globally mocked as a native `<select>` (see
 * `src/test-setup.ts`), so `userEvent.selectOptions` drives the value.
 *
 * Coverage:
 *  - renders the form, value control and Back/Add buttons
 *  - selecting a value + Add emits a `priority` token
 *  - selecting `none` + toggling exclude + Add emits a `notPriority` token
 *  - Back fires onBack
 *  - axe(container) clean
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'

import { PriorityFilterForm } from '../filter-forms/PriorityFilterForm'

function setup(): {
  onAddFilter: ReturnType<typeof vi.fn>
  onBack: ReturnType<typeof vi.fn>
  container: HTMLElement
} {
  const onAddFilter = vi.fn()
  const onBack = vi.fn()
  const { container } = render(<PriorityFilterForm onAddFilter={onAddFilter} onBack={onBack} />)
  return { onAddFilter, onBack, container }
}

const valueSelect = (): HTMLElement =>
  screen.getByLabelText(t('search.filterHelper.priorityValueLabel'))
const addButton = (): HTMLElement =>
  screen.getByRole('button', { name: t('search.filterHelper.add') })
const backButton = (): HTMLElement =>
  screen.getByRole('button', { name: t('search.filterHelper.back') })
const excludeRadio = (): HTMLElement =>
  screen.getByRole('radio', { name: t('search.filterHelper.exclude') })

describe('PriorityFilterForm — render', () => {
  it('renders the form scaffold and controls', () => {
    setup()
    expect(screen.getByTestId('priority-filter-form')).toBeInTheDocument()
    expect(screen.getByText(t('search.filterCategory.priority'))).toBeInTheDocument()
    expect(valueSelect()).toBeInTheDocument()
    expect(addButton()).toBeInTheDocument()
    expect(backButton()).toBeInTheDocument()
    expect(
      screen.getByRole('radiogroup', { name: t('search.filterHelper.matchMode') }),
    ).toBeInTheDocument()
  })

  it('includes the appended `none` sentinel as an option', () => {
    setup()
    expect(screen.getByRole('option', { name: 'none' })).toBeInTheDocument()
  })
})

describe('PriorityFilterForm — interaction', () => {
  it('emits a `priority` token for the selected value', async () => {
    const user = userEvent.setup()
    const { onAddFilter } = setup()
    await user.selectOptions(valueSelect(), '2')
    await user.click(addButton())
    expect(onAddFilter).toHaveBeenCalledWith({ kind: 'priority', value: '2', span: [0, 0] })
  })

  it('emits a `notPriority` token (with `none`) when exclude is toggled', async () => {
    const user = userEvent.setup()
    const { onAddFilter } = setup()
    await user.selectOptions(valueSelect(), 'none')
    await user.click(excludeRadio())
    await user.click(addButton())
    expect(onAddFilter).toHaveBeenCalledWith({ kind: 'notPriority', value: 'none', span: [0, 0] })
  })

  it('defaults to the first priority level when nothing is changed', async () => {
    const user = userEvent.setup()
    const { onAddFilter } = setup()
    await user.click(addButton())
    expect(onAddFilter).toHaveBeenCalledWith({ kind: 'priority', value: '1', span: [0, 0] })
  })

  it('calls onBack when Back is clicked', async () => {
    const user = userEvent.setup()
    const { onBack, onAddFilter } = setup()
    await user.click(backButton())
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onAddFilter).not.toHaveBeenCalled()
  })
})

describe('PriorityFilterForm — a11y', () => {
  it('has no axe violations', async () => {
    const { container } = setup()
    // oxlint-disable-next-line typescript/no-explicit-any -- vitest-axe loose typing.
    expect(await axe(container as any)).toHaveNoViolations()
  })
})
