/**
 * Tests for the Sidebar component.
 *
 * Validates:
 *  - displayName is set on all exported components
 *  - ref forwarding for simple HTML sub-components
 */

import { fireEvent, render } from '@testing-library/react'
import * as React from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from '../sidebar'

// ---------------------------------------------------------------------------
// displayName
// ---------------------------------------------------------------------------

describe('Sidebar displayName', () => {
  it.each([
    ['SidebarProvider', SidebarProvider],
    ['Sidebar', Sidebar],
    ['SidebarTrigger', SidebarTrigger],
    ['SidebarRail', SidebarRail],
    ['SidebarInset', SidebarInset],
    ['SidebarInput', SidebarInput],
    ['SidebarHeader', SidebarHeader],
    ['SidebarFooter', SidebarFooter],
    ['SidebarSeparator', SidebarSeparator],
    ['SidebarContent', SidebarContent],
    ['SidebarGroup', SidebarGroup],
    ['SidebarGroupLabel', SidebarGroupLabel],
    ['SidebarGroupAction', SidebarGroupAction],
    ['SidebarGroupContent', SidebarGroupContent],
    ['SidebarMenu', SidebarMenu],
    ['SidebarMenuItem', SidebarMenuItem],
    ['SidebarMenuButton', SidebarMenuButton],
    ['SidebarMenuAction', SidebarMenuAction],
    ['SidebarMenuBadge', SidebarMenuBadge],
    ['SidebarMenuSkeleton', SidebarMenuSkeleton],
    ['SidebarMenuSub', SidebarMenuSub],
    ['SidebarMenuSubItem', SidebarMenuSubItem],
    ['SidebarMenuSubButton', SidebarMenuSubButton],
  ])('%s has displayName', (name, Component) => {
    expect(Component.displayName).toBe(name)
  })
})

// ---------------------------------------------------------------------------
// ref forwarding — simple HTML sub-components that don't need SidebarProvider
// ---------------------------------------------------------------------------

describe('Sidebar ref forwarding', () => {
  it('SidebarHeader forwards ref to div', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(
      <SidebarProvider>
        <SidebarHeader ref={ref}>Header</SidebarHeader>
      </SidebarProvider>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('sidebar-header')
  })

  it('SidebarFooter forwards ref to div', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(
      <SidebarProvider>
        <SidebarFooter ref={ref}>Footer</SidebarFooter>
      </SidebarProvider>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('sidebar-footer')
  })

  it('SidebarContent forwards ref to div', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(
      <SidebarProvider>
        <SidebarContent ref={ref}>Content</SidebarContent>
      </SidebarProvider>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('sidebar-content')
  })

  // UX-208: SidebarContent uses ScrollArea primitive (no bare overflow-auto).
  it('SidebarContent renders through ScrollArea with a viewport (UX-208)', () => {
    const { container } = render(
      <SidebarProvider>
        <SidebarContent>
          <div data-testid="child-content">Hello</div>
        </SidebarContent>
      </SidebarProvider>,
    )

    // The content is rendered inside the ScrollArea viewport, not a bare div.
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]')
    expect(viewport).toBeInTheDocument()
    expect(viewport?.textContent).toContain('Hello')

    // Sanity: no bare overflow-auto class on the sidebar-content root.
    const root = container.querySelector('[data-slot="sidebar-content"]')
    expect(root).toBeInTheDocument()
    expect(root?.className ?? '').not.toContain('overflow-auto')
  })

  it('SidebarGroup forwards ref to div', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(
      <SidebarProvider>
        <SidebarGroup ref={ref}>Group</SidebarGroup>
      </SidebarProvider>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('sidebar-group')
  })

  it('SidebarGroupContent forwards ref to div', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(
      <SidebarProvider>
        <SidebarGroupContent ref={ref}>Content</SidebarGroupContent>
      </SidebarProvider>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('sidebar-group-content')
  })

  it('SidebarMenu forwards ref to ul', () => {
    const ref = React.createRef<HTMLUListElement>()
    render(
      <SidebarProvider>
        <SidebarMenu ref={ref}>
          <li>Item</li>
        </SidebarMenu>
      </SidebarProvider>,
    )
    expect(ref.current).toBeInstanceOf(HTMLUListElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('sidebar-menu')
  })

  it('SidebarMenuItem forwards ref to li', () => {
    const ref = React.createRef<HTMLLIElement>()
    render(
      <SidebarProvider>
        <ul>
          <SidebarMenuItem ref={ref}>Item</SidebarMenuItem>
        </ul>
      </SidebarProvider>,
    )
    expect(ref.current).toBeInstanceOf(HTMLLIElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('sidebar-menu-item')
  })

  it('SidebarMenuBadge forwards ref to div', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(
      <SidebarProvider>
        <SidebarMenuBadge ref={ref}>5</SidebarMenuBadge>
      </SidebarProvider>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('sidebar-menu-badge')
  })

  it('SidebarMenuSub forwards ref to ul', () => {
    const ref = React.createRef<HTMLUListElement>()
    render(
      <SidebarProvider>
        <SidebarMenuSub ref={ref}>
          <li>Sub item</li>
        </SidebarMenuSub>
      </SidebarProvider>,
    )
    expect(ref.current).toBeInstanceOf(HTMLUListElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('sidebar-menu-sub')
  })

  it('SidebarMenuSubItem forwards ref to li', () => {
    const ref = React.createRef<HTMLLIElement>()
    render(
      <SidebarProvider>
        <ul>
          <SidebarMenuSubItem ref={ref}>Sub item</SidebarMenuSubItem>
        </ul>
      </SidebarProvider>,
    )
    expect(ref.current).toBeInstanceOf(HTMLLIElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('sidebar-menu-sub-item')
  })

  it('SidebarInset forwards ref to main', () => {
    const ref = React.createRef<HTMLElement>()
    render(
      <SidebarProvider>
        <SidebarInset ref={ref}>Main content</SidebarInset>
      </SidebarProvider>,
    )
    expect(ref.current).toBeInstanceOf(HTMLElement)
    expect(ref.current?.tagName).toBe('MAIN')
    expect(ref.current?.getAttribute('data-slot')).toBe('sidebar-inset')
  })
})

// ---------------------------------------------------------------------------
// SidebarProvider interactions
// ---------------------------------------------------------------------------

describe('SidebarProvider interactions', () => {
  // Ensure desktop viewport so Sidebar renders the desktop branch with data-state
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      value: 1024,
      configurable: true,
      writable: true,
    })
  })

  it('Ctrl+B toggles sidebar open/closed', () => {
    render(
      <SidebarProvider defaultOpen>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    )

    const sidebar = document.querySelector('[data-slot="sidebar"]')
    expect(sidebar).toHaveAttribute('data-state', 'expanded')

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(sidebar).toHaveAttribute('data-state', 'collapsed')

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(sidebar).toHaveAttribute('data-state', 'expanded')
  })

  it('Ctrl+B is ignored when target is contentEditable', () => {
    render(
      <SidebarProvider defaultOpen>
        <Sidebar>
          <SidebarContent>
            <div contentEditable="true" data-testid="editor">
              Edit me
            </div>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    )

    const sidebar = document.querySelector('[data-slot="sidebar"]')
    expect(sidebar).toHaveAttribute('data-state', 'expanded')

    const editor = document.querySelector('[data-testid="editor"]') as HTMLElement
    editor.focus()
    fireEvent.keyDown(editor, { key: 'b', ctrlKey: true })

    expect(sidebar).toHaveAttribute('data-state', 'expanded')
  })

  it('sidebar width is persisted to localStorage', () => {
    localStorage.setItem('sidebar_width', '200')

    render(
      <SidebarProvider>
        <div>Child</div>
      </SidebarProvider>,
    )

    const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]') as HTMLElement
    expect(wrapper.style.getPropertyValue('--sidebar-width')).toBe('200px')

    localStorage.removeItem('sidebar_width')
  })

  it('sidebar width falls back to default when localStorage is empty', () => {
    localStorage.removeItem('sidebar_width')

    render(
      <SidebarProvider>
        <div>Child</div>
      </SidebarProvider>,
    )

    const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]') as HTMLElement
    expect(wrapper.style.getPropertyValue('--sidebar-width')).toBe('150px')
  })
})

// ---------------------------------------------------------------------------
// a11y
// ---------------------------------------------------------------------------

describe('Sidebar a11y', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      value: 1024,
      configurable: true,
      writable: true,
    })
  })

  it('has no accessibility violations', async () => {
    const { baseElement } = render(
      <SidebarProvider defaultOpen>
        <Sidebar>
          <SidebarHeader>Header</SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Group</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton>Item</SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>Footer</SidebarFooter>
        </Sidebar>
      </SidebarProvider>,
    )
    const results = await axe(baseElement, {
      rules: { region: { enabled: false } },
    })
    expect(results).toHaveNoViolations()
  })
})
