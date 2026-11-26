/**
 * Tests for `FormattingToolbar/MetadataGroup` — the custom cycle-priority
 * button renderer. Pins the same activation contract as `renderConfigButton`:
 * primary-pointerdown fires (and preventDefault()s), right/middle-click is
 * inert, keyboard Enter/Space (click with `detail === 0`) fires, and pointer
 * presses never double-fire.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type React from 'react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { renderCyclePriority, renderDateMenu } from '@/components/FormattingToolbar/MetadataGroup'
import { createDateButtons } from '@/components/FormattingToolbar/toolbar-config'
import { t } from '@/lib/i18n'
import { dispatchBlockCommand } from '@/stores/block-command-bus'

vi.mock('@/stores/block-command-bus', () => ({
  dispatchBlockCommand: vi.fn(),
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}))

const mockedDispatch = vi.mocked(dispatchBlockCommand)

function renderPriority(mode: 'inline' | 'overflow', onAfterOverflowAction = vi.fn()) {
  render(
    renderCyclePriority({
      mode,
      t,
      currentPriority: null,
      onAfterOverflowAction,
    }),
  )
  return {
    btn: screen.getByRole('button', { name: t('toolbar.cyclePriority') }),
    onAfterOverflowAction,
  }
}

describe('renderCyclePriority activation contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe.each(['inline', 'overflow'] as const)('%s mode', (mode) => {
    it('dispatches CYCLE_PRIORITY on primary-button pointerdown and prevents default', () => {
      const { btn } = renderPriority(mode)
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
      const prevented = !btn.dispatchEvent(event)
      expect(mockedDispatch).toHaveBeenCalledWith('CYCLE_PRIORITY')
      expect(mockedDispatch).toHaveBeenCalledTimes(1)
      expect(prevented).toBe(true)
    })

    it('ignores right-click and middle-click pointerdown', () => {
      const { btn } = renderPriority(mode)
      fireEvent.pointerDown(btn, { button: 2 })
      fireEvent.pointerDown(btn, { button: 1 })
      expect(mockedDispatch).not.toHaveBeenCalled()
    })

    it('dispatches CYCLE_PRIORITY on a keyboard-generated click (detail === 0)', () => {
      const { btn } = renderPriority(mode)
      fireEvent.click(btn, { detail: 0 })
      expect(mockedDispatch).toHaveBeenCalledWith('CYCLE_PRIORITY')
      expect(mockedDispatch).toHaveBeenCalledTimes(1)
    })

    it('does not double-fire on a pointer press (pointerdown + trailing click)', () => {
      const { btn } = renderPriority(mode)
      fireEvent.pointerDown(btn, { button: 0 })
      fireEvent.click(btn, { detail: 1 })
      expect(mockedDispatch).toHaveBeenCalledTimes(1)
    })
  })

  it('overflow mode runs onAfterOverflowAction on keyboard activation too', () => {
    const { btn, onAfterOverflowAction } = renderPriority('overflow')
    fireEvent.click(btn, { detail: 0 })
    expect(mockedDispatch).toHaveBeenCalledWith('CYCLE_PRIORITY')
    expect(onAfterOverflowAction).toHaveBeenCalledTimes(1)
  })

  it('has no a11y violations in either mode', async () => {
    const { container } = render(
      <div role="toolbar" aria-label={t('toolbar.formatting')}>
        {renderCyclePriority({
          mode: 'inline',
          t,
          currentPriority: '1',
          onAfterOverflowAction: vi.fn(),
        })}
        {renderCyclePriority({
          mode: 'overflow',
          t,
          currentPriority: null,
          onAfterOverflowAction: vi.fn(),
        })}
      </div>,
    )
    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})

// #6895 — an IconButton, so a touch press-and-hold shows its name. No key
// cycles the priority, so its tooltip carries no shortcut.
it('the inline button is an IconButton whose tooltip names it, with no shortcut', () => {
  const { btn } = renderPriority('inline')
  expect(btn).toHaveAttribute('data-slot', 'icon-button')
  const tip = screen.getByTestId('tooltip-content')
  expect(tip).toHaveTextContent(t('toolbar.cyclePriority'))
  expect(tip.querySelector('kbd')).toBeNull()
})

describe('renderDateMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const DATES = ['toolbar.insertDate', 'toolbar.setDueDate', 'toolbar.setScheduledDate']

  function InlineDateMenu() {
    const [open, setOpen] = useState(false)
    return (
      <div role="toolbar" aria-label={t('toolbar.formatting')}>
        {renderDateMenu({
          mode: 'inline',
          t,
          open,
          setOpen,
          dates: createDateButtons(),
          onOverflowClose: vi.fn(),
        })}
      </div>
    )
  }

  it('inline, one Date button opens the three dates, each with its name, and a row closes it', async () => {
    const { container } = render(<InlineDateMenu />)
    const date = screen.getByRole('button', { name: t('toolbar.date') })
    expect(date).toHaveAttribute('aria-expanded', 'false')
    for (const key of DATES) expect(screen.queryByRole('button', { name: t(key) })).toBeNull()

    fireEvent.pointerDown(date, { button: 0 })
    const menu = await screen.findByTestId('toolbar-date-menu')
    expect(date).toHaveAttribute('aria-expanded', 'true')
    for (const key of DATES) {
      expect(within(menu).getByRole('button', { name: t(key) })).toHaveTextContent(t(key))
    }
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations())

    fireEvent.pointerDown(within(menu).getByRole('button', { name: t('toolbar.setDueDate') }), {
      button: 0,
    })
    expect(mockedDispatch).toHaveBeenCalledWith('OPEN_DUE_DATE_PICKER')
    await waitFor(() => expect(screen.queryByTestId('toolbar-date-menu')).toBeNull())
    expect(date).toHaveAttribute('aria-expanded', 'false')
  })

  it('in More, the dates are its rows, and a row closes More', () => {
    const onOverflowClose = vi.fn()
    render(
      <div>
        {renderDateMenu({
          mode: 'overflow',
          t,
          open: false,
          setOpen: vi.fn(),
          dates: createDateButtons(),
          onOverflowClose,
        })}
      </div>,
    )
    expect(screen.queryByRole('button', { name: t('toolbar.date') })).toBeNull()
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(
      DATES.map((k) => t(k)),
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.setScheduledDate') }), {
      button: 0,
    })
    expect(mockedDispatch).toHaveBeenCalledWith('OPEN_SCHEDULED_DATE_PICKER')
    expect(onOverflowClose).toHaveBeenCalledTimes(1)
  })
})
