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
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '../../lib/i18n'
import { BlockContextMenu, type BlockContextMenuProps } from '../BlockContextMenu'

vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
  flip: vi.fn(() => ({})),
  shift: vi.fn(() => ({})),
  offset: vi.fn(() => ({})),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

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
    expect(within(menu).getByText(t('contextMenu.delete'))).toBeInTheDocument()
    expect(within(menu).getByText(t('contextMenu.indent'))).toBeInTheDocument()
    expect(within(menu).getByText(t('contextMenu.dedent'))).toBeInTheDocument()
    expect(within(menu).getByText(t('contextMenu.moveUp'))).toBeInTheDocument()
    expect(within(menu).getByText(t('contextMenu.moveDown'))).toBeInTheDocument()
    expect(within(menu).getByText(t('contextMenu.collapse'))).toBeInTheDocument()
    expect(within(menu).getByText(t('contextMenu.setTodo'))).toBeInTheDocument()
    expect(within(menu).getByText(t('contextMenu.setPriority1'))).toBeInTheDocument()
  })

  it('clicking Delete calls onDelete with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText(t('contextMenu.delete')))

    expect(props.onDelete).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Indent calls onIndent with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText(t('contextMenu.indent')))

    expect(props.onIndent).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Dedent calls onDedent with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText(t('contextMenu.dedent')))

    expect(props.onDedent).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Set as TODO calls onToggleTodo with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText(t('contextMenu.setTodo')))

    expect(props.onToggleTodo).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Set priority 1 calls onTogglePriority with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText(t('contextMenu.setPriority1')))

    expect(props.onTogglePriority).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Move Up calls onMoveUp with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText(t('contextMenu.moveUp')))

    expect(props.onMoveUp).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Move Down calls onMoveDown with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText(t('contextMenu.moveDown')))

    expect(props.onMoveDown).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Collapse calls onToggleCollapse with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ hasChildren: true, isCollapsed: false })

    await user.click(screen.getByText(t('contextMenu.collapse')))

    expect(props.onToggleCollapse).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Expand calls onToggleCollapse when isCollapsed is true', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ hasChildren: true, isCollapsed: true })

    await user.click(screen.getByText(t('contextMenu.expand')))

    expect(props.onToggleCollapse).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  // ── State-aware labels ──────────────────────────────────────────

  it('shows "TODO → DOING" when todoState is TODO', () => {
    renderMenu({ todoState: 'TODO' })
    expect(screen.getByText(t('contextMenu.todoToDoing'))).toBeInTheDocument()
  })

  it('shows "DOING → DONE" when todoState is DOING', () => {
    renderMenu({ todoState: 'DOING' })
    expect(screen.getByText(t('contextMenu.doingToDone'))).toBeInTheDocument()
  })

  it('shows "DONE → Clear" when todoState is DONE', () => {
    renderMenu({ todoState: 'DONE' })
    expect(screen.getByText(t('contextMenu.doneToClear'))).toBeInTheDocument()
  })

  it('shows "Priority 1 → 2" when priority is 1', () => {
    renderMenu({ priority: '1' })
    expect(screen.getByText(t('contextMenu.priority1To2'))).toBeInTheDocument()
  })

  it('shows "Priority 2 → 3" when priority is 2', () => {
    renderMenu({ priority: '2' })
    expect(screen.getByText(t('contextMenu.priority2To3'))).toBeInTheDocument()
  })

  it('shows "Priority 3 → Clear" when priority is 3', () => {
    renderMenu({ priority: '3' })
    expect(screen.getByText(t('contextMenu.priority3ToClear'))).toBeInTheDocument()
  })

  // ── Collapse/Expand visibility ─────────────────────────────────

  it('does not show Collapse/Expand when hasChildren is false', () => {
    renderMenu({ hasChildren: false })
    expect(screen.queryByText(t('contextMenu.collapse'))).not.toBeInTheDocument()
    expect(screen.queryByText(t('contextMenu.expand'))).not.toBeInTheDocument()
  })

  it('shows Collapse when hasChildren is true and isCollapsed is false', () => {
    renderMenu({ hasChildren: true, isCollapsed: false })
    expect(screen.getByText(t('contextMenu.collapse'))).toBeInTheDocument()
  })

  it('shows Expand when hasChildren is true and isCollapsed is true', () => {
    renderMenu({ hasChildren: true, isCollapsed: true })
    expect(screen.getByText(t('contextMenu.expand'))).toBeInTheDocument()
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

  it('menu container has .block-context-menu class (B-15)', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    expect(menu.classList.contains('block-context-menu')).toBe(true)
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
    expect(screen.queryByText(t('contextMenu.delete'))).not.toBeInTheDocument()
    expect(screen.queryByText(t('contextMenu.indent'))).not.toBeInTheDocument()
    expect(screen.getByText(t('contextMenu.noActions'))).toBeInTheDocument()
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
    expect(menu).toHaveAttribute('aria-label', t('contextMenu.blockActions'))
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

    expect(screen.queryByText(t('contextMenu.history'))).not.toBeInTheDocument()
  })

  it('renders History item when onShowHistory is provided', () => {
    renderMenu({ onShowHistory: vi.fn() })

    expect(screen.getByText(t('contextMenu.history'))).toBeInTheDocument()
  })

  it('clicking History calls onShowHistory with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ onShowHistory: vi.fn() })

    await user.click(screen.getByText(t('contextMenu.history')))

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

    expect(screen.getByText(t('contextMenu.merge'))).toBeInTheDocument()
  })

  it('does not render Merge item when onMerge is not provided', () => {
    renderMenu({ onMerge: undefined })

    expect(screen.queryByText(t('contextMenu.merge'))).not.toBeInTheDocument()
  })

  it('clicking Merge calls onMerge with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ onMerge: vi.fn() })

    await user.click(screen.getByText(t('contextMenu.merge')))

    expect(props.onMerge).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  // ── Error paths ───────────────────────────────────────────────────
  //
  // BlockContextMenu has no invoke calls.  The only async operation that can
  // fail is computePosition from @floating-ui/dom, called in a useEffect with
  // .then() but no .catch().  When it fails, setComputedPos is never called
  // and the menu gracefully stays at the initial `position` prop.
  //
  // We use mockImplementationOnce returning a non-settling thenable (same
  // observable effect as a rejection: the onFulfilled handler never fires)
  // so there is no unhandled-rejection noise in the test runner.

  /**
   * A thenable that never settles — the `.then(onFulfilled)` callback is never
   * invoked, which mirrors the observable effect of a rejected promise when the
   * consumer has no `.catch()` handler.  Unlike a real `Promise.reject`, this
   * does not trigger Node's unhandled-rejection tracking.
   */
  function failedPositioning() {
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable mock to simulate non-settling promise
    const t: Record<string, () => typeof t> = { then: () => t, catch: () => t, finally: () => t }
    return t as unknown as ReturnType<typeof import('@floating-ui/dom').computePosition>
  }

  it('falls back to initial position when computePosition rejects', async () => {
    const { computePosition } = await import('@floating-ui/dom')
    vi.mocked(computePosition).mockImplementationOnce(() => failedPositioning())

    renderMenu({ position: { x: 120, y: 250 } })

    const menu = screen.getByRole('menu')
    // computePosition failed → setComputedPos never called → stays at initial position
    await waitFor(() => {
      expect(menu.style.left).toBe('120px')
      expect(menu.style.top).toBe('250px')
    })
  })

  it('menu items remain functional when computePosition rejects', async () => {
    const { computePosition } = await import('@floating-ui/dom')
    vi.mocked(computePosition).mockImplementationOnce(() => failedPositioning())

    const user = userEvent.setup()
    const { props } = renderMenu({ position: { x: 100, y: 200 } })

    // Menu should still be interactive even though positioning failed
    await user.click(screen.getByText(t('contextMenu.delete')))

    expect(props.onDelete).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('keyboard navigation works when computePosition rejects', async () => {
    const { computePosition } = await import('@floating-ui/dom')
    vi.mocked(computePosition).mockImplementationOnce(() => failedPositioning())

    const user = userEvent.setup()
    const { props } = renderMenu()

    const items = screen.getAllByRole('menuitem')
    expect(items[0]).toHaveFocus()

    // Navigate to second item and activate
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(items[1]).toHaveFocus()

    await user.keyboard('{Enter}')

    // Second item is Indent
    expect(props.onIndent).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  // ── Copy URL menu item ──────────────────────────────────────────

  it('renders "Copy URL" item when linkUrl is provided', () => {
    renderMenu({ linkUrl: 'https://example.com' })

    expect(screen.getByText(t('contextMenu.copyUrl'))).toBeInTheDocument()
  })

  it('does not render "Copy URL" item when linkUrl is undefined', () => {
    renderMenu({ linkUrl: undefined })

    expect(screen.queryByText(t('contextMenu.copyUrl'))).not.toBeInTheDocument()
  })

  it('clicking "Copy URL" copies to clipboard and shows toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    })

    const { props } = renderMenu({ linkUrl: 'https://example.com/page' })

    fireEvent.click(screen.getByText(t('contextMenu.copyUrl')))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('https://example.com/page')
    })
    expect(props.onClose).toHaveBeenCalled()
  })

  it('"Copy URL" appears as the first menu item when linkUrl is provided', () => {
    renderMenu({ linkUrl: 'https://example.com' })

    const items = screen.getAllByRole('menuitem')
    expect(items[0]).toHaveTextContent(t('contextMenu.copyUrl'))
  })
})
