/**
 * BlockDatePicker opened on a date a block already has (#6544): the date is
 * the selected day, its month is in view, the title names which date is
 * edited, and a "Clear date" button removes it. The real calendar renders
 * here; `BlockDatePicker.test.tsx` mocks it.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { BlockDatePicker } from '@/components/block-tree/BlockDatePicker'
import { t } from '@/lib/i18n'

const onSelect = vi.fn()
const onClose = vi.fn()
const onClear = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
})

function selectedDays(): HTMLElement[] {
  return screen.getAllByRole('gridcell').filter((cell) => cell.hasAttribute('data-selected'))
}

describe('BlockDatePicker on an existing date', () => {
  it('opened for a block due on the 12th selects the 12th, shows its month and says it edits the due date', () => {
    render(
      <BlockDatePicker
        mode="due"
        value="2027-02-12"
        onSelect={onSelect}
        onClose={onClose}
        onClear={onClear}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: t('datePicker.dueTitle') })
    expect(within(dialog).getByRole('heading', { name: t('datePicker.dueTitle') })).toBeVisible()
    expect(selectedDays().map((cell) => cell.getAttribute('data-day'))).toEqual(['2027-02-12'])
    expect(within(dialog).getByRole('grid', { name: 'February 2027' })).toBeInTheDocument()
  })

  it('says it edits the scheduled date', () => {
    render(
      <BlockDatePicker
        mode="schedule"
        value="2027-02-12"
        onSelect={onSelect}
        onClose={onClose}
        onClear={onClear}
      />,
    )

    expect(screen.getByRole('dialog', { name: t('datePicker.scheduledTitle') })).toBeVisible()
  })

  it('clears the date from the keyboard', async () => {
    const user = userEvent.setup()
    render(
      <BlockDatePicker
        mode="due"
        value="2027-02-12"
        onSelect={onSelect}
        onClose={onClose}
        onClear={onClear}
      />,
    )

    const clear = screen.getByRole('button', { name: t('datePicker.clearDate') })
    clear.focus()
    await user.keyboard('{Enter}')

    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('offers no clear and selects nothing when the block has no such date', () => {
    render(<BlockDatePicker mode="due" value={null} onSelect={onSelect} onClose={onClose} />)

    expect(screen.queryByRole('button', { name: t('datePicker.clearDate') })).toBeNull()
    expect(selectedDays()).toEqual([])
  })

  it('has no a11y violations with a date selected', async () => {
    render(
      <BlockDatePicker
        mode="due"
        value="2027-02-12"
        onSelect={onSelect}
        onClose={onClose}
        onClear={onClear}
      />,
    )

    expect(await axe(document.body)).toHaveNoViolations()
  })
})
