/**
 * Tests for PaletteActionMenu — the per-row action sheet in the command
 * palette (hand-rolled menu, not Radix).
 *
 * Validates:
 *  - Renders one role="menuitem" per action with its label
 *  - Renders nothing when the action list is empty
 *  - Clicking an action fires onAction with that action's id
 *  - First action receives focus on mount (so Enter activates immediately)
 *  - Enter on the focused item activates it
 *  - ArrowDown / ArrowUp move focus between items (wrapping)
 *  - Escape closes the menu (onClose) and stops propagation
 *  - Pointerdown outside the menu closes it; inside does not
 *  - Optional hint chip renders and is aria-hidden
 *  - a11y: axe audit passes
 */

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import {
  type PaletteAction,
  PaletteActionMenu,
  type PaletteActionMenuProps,
} from '@/components/palette/PaletteActionMenu'

const ANCHOR = {
  bottom: 100,
  left: 50,
  top: 80,
  right: 250,
  width: 200,
  height: 20,
  x: 50,
  y: 80,
  toJSON: () => ({}),
} as DOMRect

const ACTIONS: ReadonlyArray<PaletteAction> = [
  { id: 'open', label: 'Open in new tab', hint: '⌘↵' },
  { id: 'pin', label: 'Pin to sidebar' },
  { id: 'delete', label: 'Delete page' },
]

function renderMenu(overrides: Partial<PaletteActionMenuProps> = {}) {
  const props: PaletteActionMenuProps = {
    anchor: ANCHOR,
    actions: ACTIONS,
    onAction: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  const result = render(<PaletteActionMenu {...props} />)
  return { ...result, props }
}

describe('PaletteActionMenu', () => {
  // ── Rendering ──────────────────────────────────────────────────────
  it('renders one menuitem per action with its label', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    expect(menu).toBeInTheDocument()

    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(ACTIONS.length)
    expect(screen.getByText('Open in new tab')).toBeInTheDocument()
    expect(screen.getByText('Pin to sidebar')).toBeInTheDocument()
    expect(screen.getByText('Delete page')).toBeInTheDocument()
  })

  it('exposes a stable testid per action id', () => {
    renderMenu()

    expect(screen.getByTestId('palette-action-open')).toBeInTheDocument()
    expect(screen.getByTestId('palette-action-pin')).toBeInTheDocument()
    expect(screen.getByTestId('palette-action-delete')).toBeInTheDocument()
  })

  it('renders nothing when the action list is empty', () => {
    renderMenu({ actions: [] })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  it('renders the optional hint chip as decorative (aria-hidden)', () => {
    renderMenu()

    const hint = screen.getByText('⌘↵')
    expect(hint).toBeInTheDocument()
    expect(hint).toHaveAttribute('aria-hidden', 'true')
  })

  // ── Activation ─────────────────────────────────────────────────────
  it('clicking an action fires onAction with that action id', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText('Pin to sidebar'))

    expect(props.onAction).toHaveBeenCalledTimes(1)
    expect(props.onAction).toHaveBeenCalledWith('pin')
  })

  it('clicking a different action fires onAction with its own id', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText('Delete page'))

    expect(props.onAction).toHaveBeenCalledWith('delete')
  })

  // ── Focus + keyboard navigation ────────────────────────────────────
  it('focuses the first action on mount', () => {
    renderMenu()

    const items = screen.getAllByRole('menuitem')
    expect(items[0]).toHaveFocus()
  })

  it('Enter on the focused (first) item activates it', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    // First item is focused on mount; Enter activates the native button.
    await user.keyboard('{Enter}')

    expect(props.onAction).toHaveBeenCalledWith('open')
  })

  it('ArrowDown moves focus to the next item', () => {
    renderMenu()

    const items = screen.getAllByRole('menuitem')
    expect(items[0]).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(items[1]).toHaveFocus()
  })

  it('ArrowDown wraps from the last item back to the first', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    const items = screen.getAllByRole('menuitem')

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(items[items.length - 1]).toHaveFocus()

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(items[0]).toHaveFocus()
  })

  it('ArrowUp from the first item wraps to the last', () => {
    renderMenu()

    const items = screen.getAllByRole('menuitem')
    expect(items[0]).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' })
    expect(items[items.length - 1]).toHaveFocus()
  })

  it('ArrowUp moves focus to the previous item', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    const items = screen.getAllByRole('menuitem')

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(items[1]).toHaveFocus()

    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(items[0]).toHaveFocus()
  })

  // ── Escape + dismissal ─────────────────────────────────────────────
  it('Escape closes the menu via onClose', () => {
    const { props } = renderMenu()

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onAction).not.toHaveBeenCalled()
  })

  it('Escape does not propagate to outer handlers (palette dialog stays put)', () => {
    const { props } = renderMenu()
    // A document-level Escape listener (mirrors Radix Dialog's portal handler):
    // it must NOT fire because the menu stops native propagation.
    const outerEscape = vi.fn()
    document.addEventListener('keydown', outerEscape)

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(outerEscape).not.toHaveBeenCalled()

    document.removeEventListener('keydown', outerEscape)
  })

  it('pointerdown outside the menu closes it', () => {
    const { props } = renderMenu()

    fireEvent.pointerDown(document.body)

    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('pointerdown inside the menu does not close it', () => {
    const { props } = renderMenu()

    fireEvent.pointerDown(screen.getByText('Open in new tab'))

    expect(props.onClose).not.toHaveBeenCalled()
  })

  // ── Positioning / viewport collision (#1751) ─────────────────────────
  // jsdom does not lay out, so `offsetHeight` is 0 by default — the height
  // collision logic never triggers without help. These tests stub the
  // rendered menu height (via the HTMLElement.offsetHeight prototype) and a
  // small viewport so the flip / clamp branches actually run.
  describe('positioning', () => {
    function stubMenuHeight(height: number) {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get() {
          return height
        },
      })
      return () => {
        if (original != null) {
          Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original)
        } else {
          delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
        }
      }
    }

    function setViewportHeight(height: number) {
      const original = window.innerHeight
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: height,
        writable: true,
      })
      return () => {
        Object.defineProperty(window, 'innerHeight', {
          configurable: true,
          value: original,
          writable: true,
        })
      }
    }

    it('places the menu below the anchor when it fits', () => {
      const restoreH = stubMenuHeight(120)
      const restoreV = setViewportHeight(800)
      try {
        // anchor.bottom = 100 → top should be 100 + GAP(4) = 104.
        renderMenu()
        const menu = screen.getByTestId('palette-action-menu')
        expect(menu.style.top).toBe('104px')
        expect(menu.style.maxHeight).toBe('')
      } finally {
        restoreV()
        restoreH()
      }
    })

    it('flips above the anchor when it would overflow the bottom', () => {
      // Viewport 200px tall, menu 120px: below the anchor (bottom 100) there
      // is only 200-100-4-16 = 80px, not enough. Above the anchor (top 80)
      // there is 80-4-16 = 60px... also tight; widen the gap above instead.
      const restoreH = stubMenuHeight(50)
      const restoreV = setViewportHeight(140)
      try {
        // spaceBelow = 140-100-4-16 = 20 (< 50). spaceAbove = 80-4-16 = 60
        // (>= 50) → flip above: top = anchor.top(80) - GAP(4) - height(50) = 26.
        renderMenu()
        const menu = screen.getByTestId('palette-action-menu')
        expect(menu.style.top).toBe('26px')
        expect(menu.style.maxHeight).toBe('')
      } finally {
        restoreV()
        restoreH()
      }
    })

    it('clamps height and scrolls when it fits neither side', () => {
      // Tall menu, short viewport: neither side has room → clamp + scroll.
      const restoreH = stubMenuHeight(2000)
      const restoreV = setViewportHeight(300)
      try {
        renderMenu()
        const menu = screen.getByTestId('palette-action-menu')
        // spaceBelow = 300-100-4-16 = 180; spaceAbove = 80-4-16 = 60.
        // below is larger → keep below, clamp to 180, enable scroll.
        expect(menu.style.top).toBe('104px')
        expect(menu.style.maxHeight).toBe('180px')
        expect(menu.style.overflowY).toBe('auto')
      } finally {
        restoreV()
        restoreH()
      }
    })
  })

  // ── a11y ───────────────────────────────────────────────────────────
  it('has no a11y violations', async () => {
    const { container } = renderMenu()

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
