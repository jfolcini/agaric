/**
 * Tests for `FormattingToolbar/shared` — the config-driven button renderer.
 *
 * Pins the activation contract for every toolbar/menu button that rides
 * `renderConfigButton`:
 *  - primary-button pointerdown runs the action and preventDefault()s (so the
 *    editor keeps focus through the press);
 *  - right/middle-click pointerdown is inert;
 *  - keyboard Enter/Space (a click with `detail === 0`) runs the action —
 *    the toolbar is keyboard-focusable via roving tabindex, so activation
 *    must not be pointer-only;
 *  - pointer presses never double-fire through the click fallback.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { renderConfigButton } from '@/components/FormattingToolbar/shared'
import type { ToolbarButtonConfig } from '@/components/FormattingToolbar/toolbar-config'
import { t } from '@/lib/i18n'

// Radix tooltips need a TooltipProvider + portal plumbing that is irrelevant
// here — render trigger and label inline (same shim as FormattingToolbar.test).
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

const IconStub = (): React.ReactElement => <span data-testid="icon" />

function makeConfig(overrides?: Partial<ToolbarButtonConfig>): ToolbarButtonConfig {
  return {
    icon: IconStub as unknown as ToolbarButtonConfig['icon'],
    label: 'toolbar.divider',
    tip: 'toolbar.dividerTip',
    action: vi.fn(),
    ...overrides,
  }
}

describe('renderConfigButton activation contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe.each(['inline', 'overflow'] as const)('%s mode', (mode) => {
    it('runs the action on primary-button pointerdown and prevents default', () => {
      const config = makeConfig()
      render(renderConfigButton(config, {}, mode, t))
      const btn = screen.getByRole('button', { name: t('toolbar.divider') })
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
      const prevented = !btn.dispatchEvent(event)
      expect(config.action).toHaveBeenCalledTimes(1)
      expect(prevented).toBe(true)
    })

    it('ignores right-click and middle-click pointerdown', () => {
      const config = makeConfig()
      render(renderConfigButton(config, {}, mode, t))
      const btn = screen.getByRole('button', { name: t('toolbar.divider') })
      fireEvent.pointerDown(btn, { button: 2 })
      fireEvent.pointerDown(btn, { button: 1 })
      expect(config.action).not.toHaveBeenCalled()
    })

    it('runs the action on a keyboard-generated click (detail === 0)', () => {
      const config = makeConfig()
      render(renderConfigButton(config, {}, mode, t))
      const btn = screen.getByRole('button', { name: t('toolbar.divider') })
      // Enter/Space on a focused native button dispatches a click with
      // detail 0 — no pointerdown ever fires on the keyboard path.
      fireEvent.click(btn, { detail: 0 })
      expect(config.action).toHaveBeenCalledTimes(1)
    })

    // #6895 — a finger acts on the release of a short tap, and a press held long
    // enough to show the button's name does nothing when it lifts. Its press is
    // still prevented, so the editor keeps its selection either way.
    it('a short finger tap acts on release, its press prevented, and once only', () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
      const config = makeConfig()
      render(renderConfigButton(config, {}, mode, t))
      const btn = screen.getByRole('button', { name: t('toolbar.divider') })

      const down = new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerType: 'touch',
      })
      expect(btn.dispatchEvent(down)).toBe(false)
      expect(config.action).not.toHaveBeenCalled()

      now.mockReturnValue(1150)
      fireEvent.pointerUp(btn, { button: 0, pointerType: 'touch' })
      fireEvent.click(btn, { detail: 1 })
      expect(config.action).toHaveBeenCalledTimes(1)
      now.mockRestore()
    })

    it('a finger held past the long-press delay does nothing on release', () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
      const config = makeConfig()
      render(renderConfigButton(config, {}, mode, t))
      const btn = screen.getByRole('button', { name: t('toolbar.divider') })

      fireEvent.pointerDown(btn, { button: 0, pointerType: 'touch' })
      now.mockReturnValue(1600)
      fireEvent.pointerUp(btn, { button: 0, pointerType: 'touch' })
      fireEvent.click(btn, { detail: 1 })
      expect(config.action).not.toHaveBeenCalled()
      now.mockRestore()
    })

    it('does not double-fire on a pointer press (pointerdown + trailing click)', () => {
      const config = makeConfig()
      render(renderConfigButton(config, {}, mode, t))
      const btn = screen.getByRole('button', { name: t('toolbar.divider') })
      fireEvent.pointerDown(btn, { button: 0 })
      fireEvent.click(btn, { detail: 1 })
      expect(config.action).toHaveBeenCalledTimes(1)
    })
  })

  it('overflow mode runs onAfterAction on keyboard activation too', () => {
    const config = makeConfig()
    const onAfterAction = vi.fn()
    render(renderConfigButton(config, {}, 'overflow', t, onAfterAction))
    fireEvent.click(screen.getByRole('button', { name: t('toolbar.divider') }), { detail: 0 })
    expect(config.action).toHaveBeenCalledTimes(1)
    expect(onAfterAction).toHaveBeenCalledTimes(1)
  })

  it('has no a11y violations in either mode', async () => {
    const { container } = render(
      <div role="toolbar" aria-label={t('toolbar.formatting')}>
        {renderConfigButton(makeConfig(), {}, 'inline', t)}
        {renderConfigButton(
          makeConfig({ label: 'toolbar.undo', tip: 'toolbar.undoTip' }),
          {},
          'overflow',
          t,
        )}
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

// #6895 — an inline button is an `IconButton`, so a touch press-and-hold shows
// its name (`IconButton`'s own tests cover the gesture); its tooltip names it
// and, after the name, shows its shortcut from the keyboard catalog.
describe('renderConfigButton inline tooltip', () => {
  it('is an IconButton whose tooltip shows the name, then the shortcut', () => {
    render(
      renderConfigButton(
        makeConfig({ label: 'toolbar.bold', tip: 'toolbar.boldTip' }),
        {},
        'inline',
        t,
      ),
    )
    const btn = screen.getByRole('button', { name: t('toolbar.bold') })
    expect(btn).toHaveAttribute('data-slot', 'icon-button')
    const tip = screen.getByTestId('tooltip-content')
    expect(tip.firstChild?.textContent).toBe(t('toolbar.boldTip'))
    expect(within(tip).getByText('Ctrl + B').tagName).toBe('KBD')
  })

  it('shows the name alone for a button with no shortcut', () => {
    render(renderConfigButton(makeConfig(), {}, 'inline', t))
    const tip = screen.getByTestId('tooltip-content')
    expect(tip).toHaveTextContent(t('toolbar.dividerTip'))
    expect(tip.querySelector('kbd')).toBeNull()
  })
})
