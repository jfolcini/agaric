/**
 * Tests for BlockContextMenu component.
 *
 * Validates:
 *  - Renders all menu items when callbacks are wired
 *  - Clicking Delete calls onDelete
 *  - Clicking Indent calls onIndent
 *  - Clicking Dedent calls onDedent
 *  - Clicking Set TODO calls onToggleTodo
 *  - Clicking Set Priority calls onTogglePriority
 *  - Clicking outside closes the menu
 *  - Pressing Escape closes the menu
 *  - Menu is rendered via portal (into document.body)
 *  - Position is correctly applied
 *  - a11y: axe audit passes
 */

import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { BlockContextMenu, type BlockContextMenuProps } from '../BlockContextMenu'

function renderMenu(overrides: Partial<BlockContextMenuProps> = {}) {
  const defaults: BlockContextMenuProps = {
    blockId: 'BLOCK_01',
    position: { x: 100, y: 200 },
    onClose: vi.fn(),
    onDelete: vi.fn(),
    onIndent: vi.fn(),
    onDedent: vi.fn(),
    onToggleTodo: vi.fn(),
    onTogglePriority: vi.fn(),
  }
  const props = { ...defaults, ...overrides }
  const result = render(<BlockContextMenu {...props} />)
  return { ...result, props }
}

describe('BlockContextMenu', () => {
  it('renders all menu items when all callbacks are wired', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('Delete')).toBeInTheDocument()
    expect(within(menu).getByText('Indent')).toBeInTheDocument()
    expect(within(menu).getByText('Dedent')).toBeInTheDocument()
    expect(within(menu).getByText('Set TODO')).toBeInTheDocument()
    expect(within(menu).getByText('Set Priority')).toBeInTheDocument()
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

  it('clicking Set TODO calls onToggleTodo with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText('Set TODO'))

    expect(props.onToggleTodo).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Set Priority calls onTogglePriority with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText('Set Priority'))

    expect(props.onTogglePriority).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

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

  it('menu is rendered via portal into document.body', () => {
    renderMenu()

    // The menu should be a direct child of document.body (portal)
    const menu = screen.getByRole('menu')
    expect(menu.parentElement).toBe(document.body)
  })

  it('position is correctly applied as CSS style', () => {
    renderMenu({ position: { x: 150, y: 300 } })

    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('150px')
    expect(menu.style.top).toBe('300px')
  })

  it('hides items when their callbacks are not provided', () => {
    renderMenu({
      onDelete: undefined,
      onIndent: undefined,
      onDedent: undefined,
      onToggleTodo: undefined,
      onTogglePriority: undefined,
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
    expect(items.length).toBe(5)
  })

  it('menu has aria-label', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    expect(menu).toHaveAttribute('aria-label', 'Block actions')
  })
})
