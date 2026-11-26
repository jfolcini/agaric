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

import { renderConfigButton, toolbarPressHandlers } from '@/components/FormattingToolbar/shared'
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

let touch = false
vi.mock('@/hooks/useIsTouch', () => ({ useIsTouch: () => touch }))
let hardwareKeyboard = false
vi.mock('@/hooks/useHasHardwareKeyboard', () => ({
  useHasHardwareKeyboard: () => hardwareKeyboard,
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

    // #6895 — a finger acts on its release, unless the press showed the button's
    // name (its tooltip open on the trigger), so learning a name never applies
    // it. Its press is still prevented, so the editor keeps its selection.
    it('a finger acts on release, its press prevented, and once only', () => {
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

      fireEvent.pointerUp(btn, { button: 0, pointerType: 'touch' })
      fireEvent.click(btn, { detail: 1 })
      expect(config.action).toHaveBeenCalledTimes(1)
    })

    it('a finger whose hold showed the name does nothing on release', () => {
      const config = makeConfig()
      render(renderConfigButton(config, {}, mode, t))
      const btn = screen.getByRole('button', { name: t('toolbar.divider') })

      fireEvent.pointerDown(btn, { button: 0, pointerType: 'touch' })
      // What Radix sets on the trigger once the long-press opened its tooltip.
      btn.dataset['state'] = 'delayed-open'
      fireEvent.pointerUp(btn, { button: 0, pointerType: 'touch' })
      fireEvent.click(btn, { detail: 1 })
      expect(config.action).not.toHaveBeenCalled()
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

  it('a finger on a control with no name to show acts on release, however long it held', () => {
    const action = vi.fn()
    render(
      <button type="button" {...toolbarPressHandlers(action)}>
        Save
      </button>,
    )
    const btn = screen.getByRole('button', { name: 'Save' })
    fireEvent.pointerDown(btn, { button: 0, pointerType: 'touch' })
    fireEvent.pointerUp(btn, { button: 0, pointerType: 'touch' })
    fireEvent.click(btn, { detail: 1 })
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('a finger acts on its release’s click, so that click cannot land on what the action opens (#7040)', () => {
    const action = vi.fn()
    render(
      <button type="button" {...toolbarPressHandlers(action)}>
        Block actions
      </button>,
    )
    const btn = screen.getByRole('button', { name: 'Block actions' })
    fireEvent.pointerDown(btn, { button: 0, pointerType: 'touch' })
    fireEvent.pointerUp(btn, { button: 0, pointerType: 'touch' })
    expect(action).not.toHaveBeenCalled()
    fireEvent.click(btn, { detail: 1 })
    expect(action).toHaveBeenCalledTimes(1)
    // A later stray click with no finger lift before it does nothing.
    fireEvent.click(btn, { detail: 1 })
    expect(action).toHaveBeenCalledTimes(1)
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
    expect(within(tip).getByText('Ctrl+B').tagName).toBe('KBD')
  })

  it('shows the name alone for a button with no shortcut', () => {
    render(renderConfigButton(makeConfig(), {}, 'inline', t))
    const tip = screen.getByTestId('tooltip-content')
    expect(tip).toHaveTextContent(t('toolbar.dividerTip'))
    expect(tip.querySelector('kbd')).toBeNull()
  })
})

// A row of More or of the Date menu shows its shortcut as its button's tooltip on the
// bar did, wherever there is a keyboard to press it on (`useKeyboardHints`).
describe('renderConfigButton overflow row shortcut', () => {
  beforeEach(() => {
    touch = false
    hardwareKeyboard = false
  })

  const newLine = () =>
    renderConfigButton(
      makeConfig({ label: 'toolbar.newLine', tip: 'toolbar.newLineTip' }),
      {},
      'overflow',
      t,
    )

  it('shows the name, then the shortcut, and keeps the name as the row’s', () => {
    render(newLine())
    const row = screen.getByRole('button', { name: t('toolbar.newLine') })
    expect(within(row).getByText('Shift+Enter').tagName).toBe('KBD')
  })

  it('on touch, shows the shortcut only once a keyboard has shown itself', () => {
    touch = true
    const { unmount } = render(newLine())
    expect(
      screen.getByRole('button', { name: t('toolbar.newLine') }).querySelector('kbd'),
    ).toBeNull()
    unmount()
    hardwareKeyboard = true
    render(newLine())
    expect(screen.getByText('Shift+Enter').tagName).toBe('KBD')
  })

  it('shows no shortcut for a button with none', () => {
    render(renderConfigButton(makeConfig(), {}, 'overflow', t))
    expect(
      screen.getByRole('button', { name: t('toolbar.divider') }).querySelector('kbd'),
    ).toBeNull()
  })
})
