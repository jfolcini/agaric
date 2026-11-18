/**
 * Tests for InfoPopover (#6895): an explanation behind a label that opens on
 * click, tap, Enter or Space, closes on Escape or a press outside, and is named
 * by its label.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { InfoPopover } from '@/components/ui/info-popover'

function renderInfo() {
  return render(
    <div>
      <InfoPopover content="Should stay at zero.">Missed writes</InfoPopover>
      <button type="button">Elsewhere</button>
    </div>,
  )
}

describe('InfoPopover', () => {
  it('renders the label as a button with the explanation closed', () => {
    renderInfo()

    const trigger = screen.getByRole('button', { name: 'Missed writes' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveClass('touch-hit-area')
    expect(screen.queryByText('Should stay at zero.')).not.toBeInTheDocument()
  })

  it('opens on click, named by its label', async () => {
    const user = userEvent.setup()
    renderInfo()

    await user.click(screen.getByRole('button', { name: 'Missed writes' }))

    expect(await screen.findByRole('dialog', { name: 'Missed writes' })).toHaveTextContent(
      'Should stay at zero.',
    )
  })

  it('opens with Space and closes with Escape, returning focus to the label', async () => {
    const user = userEvent.setup()
    renderInfo()
    const trigger = screen.getByRole('button', { name: 'Missed writes' })

    trigger.focus()
    await user.keyboard(' ')
    await screen.findByRole('dialog', { name: 'Missed writes' })

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('closes on a press outside', async () => {
    const user = userEvent.setup()
    renderInfo()

    await user.click(screen.getByRole('button', { name: 'Missed writes' }))
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('has no a11y violations closed or open', async () => {
    const user = userEvent.setup()
    const { container } = renderInfo()
    expect(await axe(container)).toHaveNoViolations()

    await user.click(screen.getByRole('button', { name: 'Missed writes' }))
    await screen.findByRole('dialog')
    expect(await axe(document.body)).toHaveNoViolations()
  })
})
