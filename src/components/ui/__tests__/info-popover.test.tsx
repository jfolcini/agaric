/**
 * Tests for InfoPopover (#6895): an explanation behind a label that opens on
 * click, tap, Enter or Space, closes on Escape or a press outside, and is named
 * by its label.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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

  // A trigger stops its click, which Radix does not count as a press outside (#7155 R4).
  it('closes the open one when another opens', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <InfoPopover content="Should stay at zero.">Missed writes</InfoPopover>
        <InfoPopover content="Since the app started.">Ops processed</InfoPopover>
      </div>,
    )

    await user.click(screen.getByRole('button', { name: 'Missed writes' }))
    await screen.findByRole('dialog', { name: 'Missed writes' })
    await user.click(screen.getByRole('button', { name: 'Ops processed' }))

    await screen.findByRole('dialog', { name: 'Ops processed' })
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1))
    expect(screen.queryByRole('dialog', { name: 'Missed writes' })).not.toBeInTheDocument()
  })

  it('keeps presses on the trigger and inside the popover out of a clickable row', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    render(
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- stands in for a selectable History row
      <div onClick={onRowClick}>
        <InfoPopover content="Should stay at zero.">Missed writes</InfoPopover>
      </div>,
    )

    await user.click(screen.getByRole('button', { name: 'Missed writes' }))
    await user.click(await screen.findByText('Should stay at zero.'))
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('opens with Enter or Space without the key reaching a row around it', async () => {
    const user = userEvent.setup()
    const onRowKeyDown = vi.fn()
    render(
      // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- stands in for an agenda row that opens its task on Enter or Space
      <div onKeyDown={onRowKeyDown}>
        <InfoPopover content="Should stay at zero.">Missed writes</InfoPopover>
      </div>,
    )
    const trigger = screen.getByRole('button', { name: 'Missed writes' })

    for (const key of ['{Enter}', ' ']) {
      trigger.focus()
      await user.keyboard(key)
      expect(await screen.findByRole('dialog', { name: 'Missed writes' })).toHaveTextContent(
        'Should stay at zero.',
      )
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    }
    expect(onRowKeyDown).not.toHaveBeenCalled()
  })

  it('closes on Escape without the Escape reaching a list around it', async () => {
    const user = userEvent.setup()
    const onListKeyDown = vi.fn()
    render(
      // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- stands in for a list that collapses its expanded row on Escape
      <div onKeyDown={onListKeyDown}>
        <InfoPopover content="Should stay at zero.">Missed writes</InfoPopover>
      </div>,
    )

    await user.click(screen.getByRole('button', { name: 'Missed writes' }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onListKeyDown).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }))
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

describe('InfoPopover icon variant', () => {
  function renderIcon() {
    return render(
      <div>
        <button type="button" disabled>
          Delete
        </button>
        <InfoPopover variant="icon" ariaLabel="Why delete is off" content="A space holds pages." />
      </div>,
    )
  }

  it('renders an ⓘ button named by its aria-label, enabled beside a disabled control', () => {
    renderIcon()

    const trigger = screen.getByRole('button', { name: 'Why delete is off' })
    expect(trigger).toBeEnabled()
    expect(trigger).toHaveClass('touch-hit-area')
    expect(trigger.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('opens on click, named by its aria-label, and closes with Escape', async () => {
    const user = userEvent.setup()
    renderIcon()

    await user.click(screen.getByRole('button', { name: 'Why delete is off' }))
    expect(await screen.findByRole('dialog', { name: 'Why delete is off' })).toHaveTextContent(
      'A space holds pages.',
    )

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('has no a11y violations closed or open', async () => {
    const user = userEvent.setup()
    const { container } = renderIcon()
    expect(await axe(container)).toHaveNoViolations()

    await user.click(screen.getByRole('button', { name: 'Why delete is off' }))
    expect(await axe(await screen.findByRole('dialog'))).toHaveNoViolations()
  })
})
