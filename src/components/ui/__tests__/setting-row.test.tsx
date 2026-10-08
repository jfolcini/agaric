/**
 * Tests SettingRow (#5345): the label names the control, the description
 * describes it, and the row still lays out without a control id.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { Input } from '@/components/ui/input'
import { SettingRow, settingDescriptionId } from '@/components/ui/setting-row'

function NamedRow(): React.ReactElement {
  return (
    <SettingRow label="Reminder time" description="When to remind you." controlId="reminder">
      <Input id="reminder" type="time" aria-describedby={settingDescriptionId('reminder')} />
    </SettingRow>
  )
}

describe('SettingRow', () => {
  it('names the control by its label', async () => {
    const user = userEvent.setup()
    render(<NamedRow />)

    const input = screen.getByLabelText('Reminder time')
    expect(input).toHaveAttribute('id', 'reminder')

    await user.click(screen.getByText('Reminder time'))
    expect(input).toHaveFocus()
  })

  it('resolves aria-describedby to the description', () => {
    render(<NamedRow />)

    expect(screen.getByLabelText('Reminder time')).toHaveAccessibleDescription(
      'When to remind you.',
    )
  })

  it('renders a plain title and no description id without a controlId', () => {
    const { container } = render(
      <SettingRow label="Reset onboarding" description="Show the tips again.">
        <button type="button">Reset</button>
      </SettingRow>,
    )

    expect(container.querySelector('label')).toBeNull()
    expect(screen.getByText('Reset onboarding').tagName).toBe('P')
    expect(screen.getByText('Show the tips again.')).not.toHaveAttribute('id')
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument()
  })

  it('omits the description paragraph when none is given', () => {
    const { container } = render(
      <SettingRow label="Theme" controlId="theme">
        <Input id="theme" />
      </SettingRow>,
    )

    expect(container.querySelector(`#${settingDescriptionId('theme')}`)).toBeNull()
    expect(container.querySelectorAll('[data-slot="setting-row"] p')).toHaveLength(0)
  })

  it('has no a11y violations with and without a controlId', async () => {
    const { container } = render(
      <>
        <NamedRow />
        <SettingRow label="Reset onboarding" description="Show the tips again.">
          <button type="button">Reset</button>
        </SettingRow>
      </>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
