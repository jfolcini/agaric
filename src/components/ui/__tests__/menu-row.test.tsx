/**
 * One menu row for every menu (#7040 M4, M5): the page ⋮ menu, the popover
 * menus, the block menu and the right-click `ContextMenu` draw their rows
 * through `menuRowVariants`, which owns the pressed fill, the 44 px
 * coarse-pointer height and the icon size (16 px, 20 px on a coarse pointer,
 * as icon buttons draw theirs).
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { renderItem } from '@/components/editor/block-context-menu/menu-row'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { MenuRowChevron, menuRowVariants } from '@/components/ui/menu-row'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'

const PRESSED_FILL = 'active:bg-accent'
const COARSE_HEIGHT = '[@media(pointer:coarse)]:min-h-11'
const ICON = '[:where(&)_svg]:size-4'
const COARSE_ICON = '[@media(pointer:coarse)]:[:where(&)_svg]:size-5'

describe('menuRowVariants', () => {
  it('carries the pressed fill, the coarse-pointer height and the icon sizes', () => {
    const classes = menuRowVariants().split(' ')
    expect(classes).toEqual(
      expect.arrayContaining([PRESSED_FILL, COARSE_HEIGHT, ICON, COARSE_ICON]),
    )
  })

  it('indents a submenu row past the parent icon, more on a coarse pointer', () => {
    expect(menuRowVariants({ indent: 1 }).split(' ')).toEqual(
      expect.arrayContaining(['pl-8', '[@media(pointer:coarse)]:pl-9']),
    )
    expect(menuRowVariants({ indent: 2 }).split(' ')).toEqual(
      expect.arrayContaining(['pl-14', '[@media(pointer:coarse)]:pl-16']),
    )
  })
})

describe('every menu row draws through menuRowVariants', () => {
  const base = menuRowVariants().split(' ')

  it('the popover menu row', () => {
    render(<PopoverMenuItem>Popover row</PopoverMenuItem>)
    expect(screen.getByRole('button', { name: 'Popover row' })).toHaveClass(...base)
  })

  it('the block menu row', () => {
    render(
      <div role="menu" aria-label="Block actions">
        {renderItem(
          { id: 'indent', label: 'Indent', icon: <svg />, action: () => {} },
          { focusedIndex: 0, itemRefs: { current: [] }, nextIndex: () => 0, keyboardHints: false },
        )}
      </div>,
    )
    expect(screen.getByRole('menuitem', { name: 'Indent' })).toHaveClass(...base)
  })

  it('the right-click context menu row', async () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Open in new tab</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    fireEvent.contextMenu(screen.getByText('Target'))
    expect(await screen.findByRole('menuitem', { name: 'Open in new tab' })).toHaveClass(...base)
  })
})

describe('MenuRowChevron', () => {
  it('points right while its submenu is closed and down once it is open', () => {
    const { container, rerender } = render(<MenuRowChevron expanded={false} />)
    expect(container.querySelector('svg')).toHaveClass('lucide-chevron-right')
    rerender(<MenuRowChevron expanded />)
    expect(container.querySelector('svg')).toHaveClass('lucide-chevron-down')
  })

  it('is hidden from assistive tech: the row announces its own state', async () => {
    const { container } = render(
      <button type="button" className={menuRowVariants()} aria-expanded={false}>
        Export
        <MenuRowChevron expanded={false} />
      </button>,
    )
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(await axe(container)).toHaveNoViolations()
  })
})
