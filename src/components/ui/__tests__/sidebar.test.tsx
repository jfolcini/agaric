/**
 * Tests for the Sidebar component.
 *
 * Validates:
 *  - displayName is set on all exported components
 *  - ref forwarding for simple HTML sub-components
 */

import { render } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
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
