/**
 * Tests for BlockContextMenu component.
 *
 * Validates:
 *  - Renders all menu items when callbacks are wired
 *  - Clicking Delete calls onDelete
 *  - Clicking Indent calls onIndent
 *  - Clicking Dedent calls onDedent
 *  - Clicking Set as TODO calls onToggleTodo
 *  - Clicking Set priority 1 calls onTogglePriority
 *  - Clicking Move Up calls onMoveUp
 *  - Clicking Move Down calls onMoveDown
 *  - Clicking Collapse/Expand calls onToggleCollapse
 *  - State-aware labels for TODO and Priority
 *  - Keyboard navigation (ArrowDown/Up, Home, End, Enter)
 *  - Shortcut hints rendered
 *  - Separators between groups
 *  - Collapse/Expand only shown when hasChildren
 *  - Clicking outside closes the menu
 *  - Pressing Escape closes the menu
 *  - Menu is rendered via portal (into document.body)
 *  - Position is correctly applied
 *  - a11y: axe audit passes
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { BlockContextMenu, type BlockContextMenuProps } from '../BlockContextMenu'

vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
  flip: vi.fn(() => ({})),
  shift: vi.fn(() => ({})),
  offset: vi.fn(() => ({})),
}))

type MenuOverrides = { [K in keyof BlockContextMenuProps]?: BlockContextMenuProps[K] | undefined }

function renderMenu(overrides: MenuOverrides = {}) {
  const defaults: BlockContextMenuProps = {
    blockId: 'BLOCK_01',
    position: { x: 100, y: 200 },
    onClose: vi.fn(),
    onDelete: vi.fn(),
    onIndent: vi.fn(),
    onDedent: vi.fn(),
    onToggleTodo: vi.fn(),
    onTogglePriority: vi.fn(),
    onToggleCollapse: vi.fn(),
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    hasChildren: true,
    isCollapsed: false,
    todoState: null,
    priority: null,
  }
  const merged = { ...defaults, ...overrides }
  // Remove keys explicitly set to undefined so they are truly absent
  // (satisfies exactOptionalPropertyTypes)
  for (const key of Object.keys(merged) as (keyof typeof merged)[]) {
    if (merged[key] === undefined) {
      delete merged[key]
    }
  }
  const result = render(<BlockContextMenu {...(merged as BlockContextMenuProps)} />)
  return { ...result, props: merged }
}

describe('BlockContextMenu', () => {
  it('renders all menu items when all callbacks are wired', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('Delete')).toBeInTheDocument()
    expect(within(menu).getByText('Indent')).toBeInTheDocument()
    expect(within(menu).getByText('Dedent')).toBeInTheDocument()
    expect(within(menu).getByText('Move Up')).toBeInTheDocument()
    expect(within(menu).getByText('Move Down')).toBeInTheDocument()
    expect(within(menu).getByText('Collapse')).toBeInTheDocument()
    expect(within(menu).getByText('Set as TODO')).toBeInTheDocument()
    expect(within(menu).getByText('Set priority 1')).toBeInTheDocument()
  })

  it('clicking Delete calls onDelete with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText('Delete'))

    expect(props.onDelete).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Indent calls onIndent with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText('Indent'))

    expect(props.onIndent).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Dedent calls onDedent with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText('Dedent'))

    expect(props.onDedent).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Set as TODO calls onToggleTodo with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText('Set as TODO'))

    expect(props.onToggleTodo).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Set priority 1 calls onTogglePriority with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText('Set priority 1'))

    expect(props.onTogglePriority).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Move Up calls onMoveUp with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText('Move Up'))

    expect(props.onMoveUp).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Move Down calls onMoveDown with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText('Move Down'))

    expect(props.onMoveDown).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Collapse calls onToggleCollapse with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ hasChildren: true, isCollapsed: false })

    await user.click(screen.getByText('Collapse'))

    expect(props.onToggleCollapse).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Expand calls onToggleCollapse when isCollapsed is true', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ hasChildren: true, isCollapsed: true })

    await user.click(screen.getByText('Expand'))

    expect(props.onToggleCollapse).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  // ── State-aware labels ──────────────────────────────────────────

  it('shows "TODO → DOING" when todoState is TODO', () => {
    renderMenu({ todoState: 'TODO' })
    expect(screen.getByText('TODO → DOING')).toBeInTheDocument()
  })

  it('shows "DOING → DONE" when todoState is DOING', () => {
    renderMenu({ todoState: 'DOING' })
    expect(screen.getByText('DOING → DONE')).toBeInTheDocument()
  })

  it('shows "DONE → Clear" when todoState is DONE', () => {
    renderMenu({ todoState: 'DONE' })
    expect(screen.getByText('DONE → Clear')).toBeInTheDocument()
  })

  it('shows "Priority 1 → 2" when priority is 1', () => {
    renderMenu({ priority: '1' })
    expect(screen.getByText('Priority 1 → 2')).toBeInTheDocument()
  })

  it('shows "Priority 2 → 3" when priority is 2', () => {
    renderMenu({ priority: '2' })
    expect(screen.getByText('Priority 2 → 3')).toBeInTheDocument()
  })

  it('shows "Priority 3 → Clear" when priority is 3', () => {
    renderMenu({ priority: '3' })
    expect(screen.getByText('Priority 3 → Clear')).toBeInTheDocument()
  })

  // ── Collapse/Expand visibility ─────────────────────────────────

  it('does not show Collapse/Expand when hasChildren is false', () => {
    renderMenu({ hasChildren: false })
    expect(screen.queryByText('Collapse')).not.toBeInTheDocument()
    expect(screen.queryByText('Expand')).not.toBeInTheDocument()
  })

  it('shows Collapse when hasChildren is true and isCollapsed is false', () => {
    renderMenu({ hasChildren: true, isCollapsed: false })
    expect(screen.getByText('Collapse')).toBeInTheDocument()
  })

  it('shows Expand when hasChildren is true and isCollapsed is true', () => {
    renderMenu({ hasChildren: true, isCollapsed: true })
    expect(screen.getByText('Expand')).toBeInTheDocument()
  })

  // ── Keyboard navigation ─────────────────────────────────────────

  it('ArrowDown moves focus to next item', () => {
    renderMenu()

    const items = screen.getAllByRole('menuitem')
    // First item should be focused initially
    expect(items[0]).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(items[1]).toHaveFocus()
  })

  it('ArrowUp moves focus to previous item (wraps)', () => {
    renderMenu()

    const items = screen.getAllByRole('menuitem')
    // First item focused, ArrowUp wraps to last
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' })
    expect(items[items.length - 1]).toHaveFocus()
  })

  it('Home moves focus to first item', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    // Move down a couple times first
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })

    fireEvent.keyDown(menu, { key: 'Home' })
    const items = screen.getAllByRole('menuitem')
    expect(items[0]).toHaveFocus()
  })

  it('End moves focus to last item', () => {
    renderMenu()

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' })
    const items = screen.getAllByRole('menuitem')
    expect(items[items.length - 1]).toHaveFocus()
  })

  it('ArrowDown wraps from last item to first', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    const items = screen.getAllByRole('menuitem')
    // Move to last item
    fireEvent.keyDown(menu, { key: 'End' })
    expect(items[items.length - 1]).toHaveFocus()

    // ArrowDown should wrap to first
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(items[0]).toHaveFocus()
  })

  it('Enter activates the focused menu item', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    // First item (Delete) should be focused after mount
    await user.keyboard('{Enter}')

    expect(props.onDelete).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  // ── Shortcut hints ──────────────────────────────────────────────

  it('renders shortcut hints for items', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('Ctrl+Shift+→')).toBeInTheDocument()
    expect(within(menu).getByText('Ctrl+Shift+←')).toBeInTheDocument()
    expect(within(menu).getByText('Ctrl+Shift+↑')).toBeInTheDocument()
    expect(within(menu).getByText('Ctrl+Shift+↓')).toBeInTheDocument()
    expect(within(menu).getByText('Ctrl+.')).toBeInTheDocument()
    expect(within(menu).getByText('Ctrl+Enter')).toBeInTheDocument()
    expect(within(menu).getByText('Ctrl+Shift+1-3')).toBeInTheDocument()
  })

  // ── Separators ──────────────────────────────────────────────────

  it('renders separators between groups', () => {
    renderMenu()

    const separators = screen.getAllByRole('separator')
    // With all callbacks wired and hasChildren=true, we have 4 groups → 3 separators
    expect(separators.length).toBe(3)
  })

  // ── Existing tests (updated) ────────────────────────────────────

  it('clicking outside the menu closes it', () => {
    const { props } = renderMenu()

    // Fire pointerdown on document body (outside menu)
    fireEvent.pointerDown(document.body)

    expect(props.onClose).toHaveBeenCalled()
  })

  it('pressing Escape closes the menu', () => {
    const { props } = renderMenu()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(props.onClose).toHaveBeenCalled()
  })

  it('restores focus to triggerRef element on Escape', () => {
    const triggerEl = document.createElement('div')
    triggerEl.tabIndex = -1
    document.body.appendChild(triggerEl)
    const triggerRef = { current: triggerEl }
    const focusSpy = vi.spyOn(triggerEl, 'focus')

    renderMenu({ triggerRef })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(focusSpy).toHaveBeenCalled()
    document.body.removeChild(triggerEl)
  })

  it('menu is rendered via portal into document.body', () => {
    renderMenu()

    // The menu should be a direct child of document.body (portal)
    const menu = screen.getByRole('menu')
    expect(menu.parentElement).toBe(document.body)
  })

  it('position is correctly applied as CSS style', async () => {
    const { computePosition } = await import('@floating-ui/dom')
    const mockedComputePosition = vi.mocked(computePosition)
    mockedComputePosition.mockResolvedValueOnce({
      x: 150,
      y: 300,
      placement: 'bottom-start',
      strategy: 'absolute',
      middlewareData: {},
    })

    renderMenu({ position: { x: 150, y: 300 } })

    const menu = screen.getByRole('menu')
    await waitFor(() => {
      expect(menu.style.left).toBe('150px')
      expect(menu.style.top).toBe('300px')
    })
  })

  it('hides items when their callbacks are not provided', () => {
    renderMenu({
      onDelete: undefined,
      onIndent: undefined,
      onDedent: undefined,
      onToggleTodo: undefined,
      onTogglePriority: undefined,
      onToggleCollapse: undefined,
      onMoveUp: undefined,
      onMoveDown: undefined,
      hasChildren: false,
    })

    // No action items should be shown; "No actions available" fallback
    expect(screen.queryByText('Delete')).not.toBeInTheDocument()
    expect(screen.queryByText('Indent')).not.toBeInTheDocument()
    expect(screen.getByText('No actions available')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = renderMenu()

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('menu items have role="menuitem"', () => {
    renderMenu()

    const items = screen.getAllByRole('menuitem')
    // 8 items: Delete, Indent, Dedent, Move Up, Move Down, Collapse, Set as TODO, Set priority 1
    expect(items.length).toBe(8)
  })

  it('menu has aria-label', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    expect(menu).toHaveAttribute('aria-label', 'Block actions')
  })

  it('focused menu item has focus-visible highlight classes', () => {
    renderMenu()

    const items = screen.getAllByRole('menuitem')
    // All items should have focus-visible:bg-accent for keyboard highlight
    for (const item of items) {
      expect(item.className).toContain('focus-visible:bg-accent')
      expect(item.className).toContain('focus-visible:text-accent-foreground')
      expect(item.className).toContain('focus-visible:outline-none')
    }
  })

  // ── History menu item ─────────────────────────────────────────────

  it('does not render History item when onShowHistory is not provided', () => {
    renderMenu({ onShowHistory: undefined })

    expect(screen.queryByText('History')).not.toBeInTheDocument()
  })

  it('renders History item when onShowHistory is provided', () => {
    renderMenu({ onShowHistory: vi.fn() })

    expect(screen.getByText('History')).toBeInTheDocument()
  })

  it('clicking History calls onShowHistory with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ onShowHistory: vi.fn() })

    await user.click(screen.getByText('History'))

    expect(props.onShowHistory).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('renders 4 separators when History group is present', () => {
    renderMenu({ onShowHistory: vi.fn() })

    const separators = screen.getAllByRole('separator')
    // With all callbacks wired, hasChildren=true, and onShowHistory: 5 groups → 4 separators
    expect(separators.length).toBe(4)
  })

  // ── Merge menu item ──────────────────────────────────────────────

  it('renders Merge item when onMerge is provided', () => {
    renderMenu({ onMerge: vi.fn() })

    expect(screen.getByText('Merge with previous')).toBeInTheDocument()
  })

  it('does not render Merge item when onMerge is not provided', () => {
    renderMenu({ onMerge: undefined })

    expect(screen.queryByText('Merge with previous')).not.toBeInTheDocument()
  })

  it('clicking Merge calls onMerge with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ onMerge: vi.fn() })

    await user.click(screen.getByText('Merge with previous'))

    expect(props.onMerge).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })
})
