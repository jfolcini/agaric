/**
 * Tests for `FormattingToolbar/MetadataGroup` — the custom cycle-priority
 * button renderer. Pins the same activation contract as `renderConfigButton`:
 * primary-pointerdown fires (and preventDefault()s), right/middle-click is
 * inert, keyboard Enter/Space (click with `detail === 0`) fires, and pointer
 * presses never double-fire.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { dispatchBlockEvent } from '@/lib/block-events'
import { t } from '@/lib/i18n'

import { renderCyclePriority } from '../MetadataGroup'

vi.mock('@/lib/block-events', () => ({
  dispatchBlockEvent: vi.fn(),
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

const mockedDispatch = vi.mocked(dispatchBlockEvent)

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
