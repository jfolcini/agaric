/**
 * Tests for the Sidebar compound component.
 *
 * Validates:
 *  - axe accessibility audit in expanded (default) and collapsed states
 *  - Sidebar trigger button renders and toggles open/closed
 *  - Keyboard shortcut (Ctrl+B) toggles the sidebar
 *  - Appropriate ARIA attributes on trigger and rail elements
 *  - Semantic list structure for navigation menu
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '../ui/sidebar'

/**
 * Render a Sidebar with typical navigation content, mirroring how App.tsx
 * composes the sidebar with header, nav menu, footer, rail, and trigger.
 */
function renderSidebar({ defaultOpen = true }: { defaultOpen?: boolean } = {}) {
  return render(
    <SidebarProvider defaultOpen={defaultOpen}>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <span>App Name</span>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip="Home">
                    <span>Home</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip="Settings">
                    <span>Settings</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <span>Footer</span>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header>
          <SidebarTrigger />
        </header>
        <div>
          <p>Main content</p>
        </div>
      </SidebarInset>
    </SidebarProvider>,
  )
}

/** Return the sidebar trigger button (data-sidebar="trigger"). */
function getTriggerButton(): HTMLElement {
  const el = document.querySelector('[data-sidebar="trigger"]')
  if (!el) throw new Error('SidebarTrigger not found')
  return el as HTMLElement
}

/** Return the outer sidebar element that carries data-state. */
function getSidebarSlot(): HTMLElement {
  const el = document.querySelector('[data-slot="sidebar"]')
  if (!el) throw new Error('Sidebar [data-slot="sidebar"] not found')
  return el as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Sidebar', () => {
  it('has no a11y violations in default state', async () => {
    const { container } = renderSidebar()

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations when collapsed', async () => {
    const { container } = renderSidebar({ defaultOpen: false })

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('renders sidebar trigger button', () => {
    renderSidebar()

    const trigger = getTriggerButton()
    expect(trigger).toBeInTheDocument()
    // The trigger should be a button element (accessible role)
    expect(trigger.tagName).toBe('BUTTON')
  })

  it('toggles sidebar open/closed', async () => {
    const user = userEvent.setup()
    renderSidebar()

    const sidebar = getSidebarSlot()
    expect(sidebar).toHaveAttribute('data-state', 'expanded')

    // Click the trigger to collapse
    await user.click(getTriggerButton())
    expect(sidebar).toHaveAttribute('data-state', 'collapsed')

    // Click again to expand
    await user.click(getTriggerButton())
    expect(sidebar).toHaveAttribute('data-state', 'expanded')
  })

  it('toggles sidebar with Ctrl+B keyboard shortcut', async () => {
    renderSidebar()

    const sidebar = getSidebarSlot()
    expect(sidebar).toHaveAttribute('data-state', 'expanded')

    // Ctrl+B should collapse
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(sidebar).toHaveAttribute('data-state', 'collapsed')

    // Ctrl+B again should expand
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(sidebar).toHaveAttribute('data-state', 'expanded')
  })

  it('sidebar has appropriate ARIA attributes', () => {
    renderSidebar()

    // SidebarRail has aria-label for accessibility
    const rail = document.querySelector('[data-sidebar="rail"]')
    expect(rail).toHaveAttribute('aria-label', 'Toggle Sidebar')

    // SidebarTrigger has accessible name via sr-only text
    const triggers = screen.getAllByRole('button', { name: /toggle sidebar/i })
    expect(triggers.length).toBeGreaterThanOrEqual(1)

    // Sidebar wrapper carries the data-slot for layout identification
    const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]')
    expect(wrapper).toBeInTheDocument()
  })

  it('renders navigation items in semantic list structure', () => {
    renderSidebar()

    // SidebarMenu renders as <ul>, SidebarMenuItem as <li>
    const lists = document.querySelectorAll('[data-sidebar="menu"]')
    expect(lists.length).toBeGreaterThanOrEqual(1)

    // Menu items should be <li> elements
    const items = document.querySelectorAll('[data-sidebar="menu-item"]')
    expect(items.length).toBe(2) // Home + Settings

    // Verify the buttons within are accessible
    const menuButtons = document.querySelectorAll('[data-sidebar="menu-button"]')
    expect(menuButtons.length).toBe(2)
    expect(menuButtons[0]).toHaveTextContent('Home')
    expect(menuButtons[1]).toHaveTextContent('Settings')
  })
})

describe('swipe-to-open gesture', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true, writable: true })
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList)
  })

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true })
    vi.restoreAllMocks()
  })

  it('swipe from left edge opens mobile sidebar', async () => {
    renderSidebar()

    // On mobile the sidebar renders as a Sheet; when closed, the dialog is not in the DOM
    expect(document.querySelector('[data-mobile="true"]')).not.toBeInTheDocument()

    fireEvent.touchStart(document, {
      touches: [{ clientX: 10, clientY: 200 }],
    })
    fireEvent.touchMove(document, {
      touches: [{ clientX: 70, clientY: 200 }],
    })
    fireEvent.touchEnd(document)

    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).toBeInTheDocument()
    })
  })

  it('swipe not from edge does not open', async () => {
    renderSidebar()

    fireEvent.touchStart(document, {
      touches: [{ clientX: 100, clientY: 200 }],
    })
    fireEvent.touchMove(document, {
      touches: [{ clientX: 200, clientY: 200 }],
    })
    fireEvent.touchEnd(document)

    // Give React a tick to flush any state updates
    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).not.toBeInTheDocument()
    })
  })

  it('vertical swipe from edge does not open', async () => {
    renderSidebar()

    fireEvent.touchStart(document, {
      touches: [{ clientX: 10, clientY: 200 }],
    })
    fireEvent.touchMove(document, {
      touches: [{ clientX: 30, clientY: 300 }],
    })
    fireEvent.touchEnd(document)

    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).not.toBeInTheDocument()
    })
  })

  it('short swipe from edge does not open', async () => {
    renderSidebar()

    fireEvent.touchStart(document, {
      touches: [{ clientX: 10, clientY: 200 }],
    })
    fireEvent.touchMove(document, {
      touches: [{ clientX: 40, clientY: 200 }],
    })
    fireEvent.touchEnd(document)

    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).not.toBeInTheDocument()
    })
  })

  it('swipe left from edge does not open', async () => {
    renderSidebar()

    fireEvent.touchStart(document, {
      touches: [{ clientX: 10, clientY: 200 }],
    })
    fireEvent.touchMove(document, {
      touches: [{ clientX: 2, clientY: 200 }],
    })
    fireEvent.touchEnd(document)

    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).not.toBeInTheDocument()
    })
  })

  it('multi-touch is ignored', async () => {
    renderSidebar()

    fireEvent.touchStart(document, {
      touches: [
        { clientX: 10, clientY: 200 },
        { clientX: 300, clientY: 400 },
      ],
    })
    fireEvent.touchMove(document, {
      touches: [
        { clientX: 70, clientY: 200 },
        { clientX: 350, clientY: 400 },
      ],
    })
    fireEvent.touchEnd(document)

    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).not.toBeInTheDocument()
    })
  })

  it('no swipe listener on desktop', async () => {
    // Restore desktop viewport
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true })
    vi.restoreAllMocks()

    renderSidebar()

    fireEvent.touchStart(document, {
      touches: [{ clientX: 10, clientY: 200 }],
    })
    fireEvent.touchMove(document, {
      touches: [{ clientX: 70, clientY: 200 }],
    })
    fireEvent.touchEnd(document)

    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).not.toBeInTheDocument()
    })
  })
})
