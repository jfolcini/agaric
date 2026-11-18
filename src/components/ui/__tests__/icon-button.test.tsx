/**
 * Tests for IconButton's `shortcut` (#6895): the tooltip shows the name and the
 * shortcut on a device with a keyboard, and the name alone on a touch-only
 * device, whose press-and-hold is the only way to see it.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { IconButton } from '@/components/ui/icon-button'
import { TooltipProvider } from '@/components/ui/tooltip'

const device = vi.hoisted(() => ({ touch: false, mobile: false }))
vi.mock('@/hooks/useIsTouch', () => ({ useIsTouch: () => device.touch }))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => device.mobile }))

afterEach(() => {
  device.touch = false
  device.mobile = false
})

function renderBold() {
  return render(
    <TooltipProvider delayDuration={0}>
      <IconButton tooltip="Bold" ariaLabel="Bold" shortcut="Ctrl+B">
        <span aria-hidden="true">B</span>
      </IconButton>
    </TooltipProvider>,
  )
}

describe('IconButton shortcut', () => {
  it('shows the name and the shortcut on hover with a keyboard', async () => {
    const user = userEvent.setup()
    renderBold()

    await user.hover(screen.getByRole('button', { name: 'Bold' }))

    const tip = (await screen.findAllByRole('tooltip'))[0]
    expect(tip).toHaveTextContent('Bold')
    expect(tip).toHaveTextContent('Ctrl+B')
  })

  it('shows the name alone on a touch-only device’s press-and-hold', async () => {
    device.touch = true
    device.mobile = true
    vi.useFakeTimers()
    try {
      renderBold()
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Bold' }), {
        clientX: 5,
        clientY: 5,
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })

      const tip = screen.getAllByRole('tooltip')[0]
      expect(tip).toHaveTextContent('Bold')
      expect(tip).not.toHaveTextContent('Ctrl+B')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the shortcut on a touch laptop, which has a keyboard', async () => {
    device.touch = true
    device.mobile = false
    const user = userEvent.setup()
    renderBold()

    await user.hover(screen.getByRole('button', { name: 'Bold' }))

    expect((await screen.findAllByRole('tooltip'))[0]).toHaveTextContent('Ctrl+B')
  })

  it('has no a11y violations', async () => {
    const { container } = renderBold()
    expect(await axe(container)).toHaveNoViolations()
  })
})
