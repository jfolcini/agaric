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
import { t } from '../../lib/i18n'
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

    // axe's first call per worker loads rules and can exceed the default 1s
    // waitFor timeout under full-suite worker contention. 5000ms matches the
    // precedent in TemplatePicker.test.tsx.
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  it('has no a11y violations when collapsed', async () => {
    const { container } = renderSidebar({ defaultOpen: false })

    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
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
    expect(rail).toHaveAttribute('aria-label', t('sidebar.toggleSidebar'))

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

// ---------------------------------------------------------------------------
// UX-231: Persistent icon rail on mobile when collapsible="icon"
// ---------------------------------------------------------------------------

/**
 * Force `useIsMobile()` to report `true` by pinning both the viewport width
 * below the 768 px breakpoint and `matchMedia` to `matches: true`.
 */
function mockMobileViewport() {
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
}

function restoreDesktopViewport() {
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true })
  vi.restoreAllMocks()
}

describe('UX-231 — persistent mobile icon rail (collapsible="icon")', () => {
  beforeEach(() => {
    mockMobileViewport()
  })

  afterEach(() => {
    restoreDesktopViewport()
  })

  it('renders a persistent 48-px icon rail below the mobile breakpoint', () => {
    renderSidebar()

    const rail = document.querySelector('[data-mobile-rail="true"]') as HTMLElement | null
    expect(rail).not.toBeNull()
    // Rail is rendered in the collapsed/icon state so descendant CSS
    // (`group-data-[collapsible=icon]`) reduces menu buttons to icon-only.
    expect(rail).toHaveAttribute('data-collapsible', 'icon')
    expect(rail).toHaveAttribute('data-state', 'collapsed')
    expect(rail).toHaveAttribute('data-slot', 'sidebar')

    // UX-231 a11y: the rail is a navigation landmark so assistive tech
    // announces it. A `<nav>` element (implicit role=navigation) + a
    // non-empty `aria-label` are both required for the landmark to be
    // meaningful. We use `tagName` instead of `toHaveAttribute('role', …)`
    // because `<nav>`'s role is implicit — there is no `role` attribute
    // on the DOM node.
    expect(rail?.tagName.toLowerCase()).toBe('nav')
    expect(rail).toHaveAttribute('aria-label', t('sidebar.label'))
    expect(rail?.getAttribute('aria-label') ?? '').not.toBe('')

    // The rail has a fixed-position container pinned to the viewport's left
    // edge, with width driven by the --sidebar-width-icon token (3rem/48px).
    const container = rail?.querySelector('[data-slot="sidebar-container"]') as HTMLElement
    expect(container).not.toBeNull()
    expect(container.className).toContain('w-(--sidebar-width-icon)')
    expect(container.className).toContain('fixed')
    expect(container.className).toContain('left-0')

    // The spacer reserves layout space beside the rail so SidebarInset's
    // flex-1 content area starts after the 48-px edge, not underneath it.
    const gap = rail?.querySelector('[data-slot="sidebar-gap"]') as HTMLElement
    expect(gap).not.toBeNull()
    expect(gap.className).toContain('w-(--sidebar-width-icon)')
  })

  it('Sheet is closed by default — only the rail is visible', () => {
    renderSidebar()

    // Rail always in DOM.
    expect(document.querySelector('[data-mobile-rail="true"]')).toBeInTheDocument()
    // Sheet content (data-mobile="true") only mounts when the Sheet opens.
    expect(document.querySelector('[data-mobile="true"]')).not.toBeInTheDocument()
  })

  it('tapping the SidebarTrigger opens the Sheet while the rail persists', async () => {
    const user = userEvent.setup()
    renderSidebar()

    expect(document.querySelector('[data-mobile-rail="true"]')).toBeInTheDocument()
    expect(document.querySelector('[data-mobile="true"]')).not.toBeInTheDocument()

    await user.click(getTriggerButton())

    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).toBeInTheDocument()
    })

    // Rail stays mounted while the Sheet overlays it.
    expect(document.querySelector('[data-mobile-rail="true"]')).toBeInTheDocument()
  })

  it('rail nav items render in icon-collapsed mode (data-collapsible=icon inherited)', () => {
    renderSidebar()

    const rail = document.querySelector('[data-mobile-rail="true"]') as HTMLElement
    const buttons = rail.querySelectorAll('[data-sidebar="menu-button"]')
    expect(buttons.length).toBe(2)
    // Every button must be a descendant of the rail's [data-collapsible=icon]
    // group so the CSS cascade collapses labels. We prove the ancestry rather
    // than computing layout (jsdom doesn't lay out CSS).
    for (const btn of buttons) {
      const group = btn.closest('[data-collapsible="icon"]')
      expect(group).toBe(rail)
    }
  })

  it('SidebarGroup inside the rail strips horizontal padding so 44-px buttons fit the 48-px rail', () => {
    renderSidebar()

    const rail = document.querySelector('[data-mobile-rail="true"]') as HTMLElement
    const group = rail.querySelector('[data-slot="sidebar-group"]') as HTMLElement
    expect(group).not.toBeNull()
    // The Tailwind selector `group-data-[mobile-rail=true]:px-0` is what
    // reclaims the 16 px of horizontal padding the default `p-2` applied,
    // giving the 44-px coarse-pointer button the full 48-px rail width.
    // jsdom doesn't compute CSS, so we assert the class is present on the
    // element (not that `getBoundingClientRect` is 48 px).
    expect(group.className).toContain('group-data-[mobile-rail=true]:px-0')
    // Sanity: vertical padding is preserved — we only strip horizontal.
    expect(group.className).toContain('p-2')
  })

  it('has no a11y violations on the persistent rail + trigger layout', async () => {
    const { container } = renderSidebar()

    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})

describe('UX-231 — collapsible="none" on mobile (regression guard)', () => {
  beforeEach(() => {
    mockMobileViewport()
  })

  afterEach(() => {
    restoreDesktopViewport()
  })

  it('mobile + collapsible="none" — neither rail nor Sheet renders, just the static sidebar', () => {
    render(
      <SidebarProvider>
        <Sidebar collapsible="none">
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton>
                  <span>Home</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger />
        </SidebarInset>
      </SidebarProvider>,
    )

    // No persistent mobile rail (that path is specific to collapsible="icon").
    expect(document.querySelector('[data-mobile-rail="true"]')).not.toBeInTheDocument()
    // No Radix Sheet dialog (collapsible="none" short-circuits before the
    // mobile/Sheet branches in Sidebar).
    expect(document.querySelector('[data-mobile="true"]')).not.toBeInTheDocument()
    expect(document.querySelector('[role="dialog"]')).not.toBeInTheDocument()

    // The static sidebar div is rendered — the `collapsible="none"` branch
    // emits a plain `<div>` with `data-slot="sidebar"` and the
    // `w-(--sidebar-width)` layout class. Use the combined selector so we
    // do not collide with any ancestor data-slot="sidebar" we might add
    // later.
    const staticSidebar = document.querySelector(
      'div[data-slot="sidebar"]:not([data-mobile-rail])',
    ) as HTMLElement | null
    expect(staticSidebar).not.toBeNull()
    expect(staticSidebar?.className).toContain('w-(--sidebar-width)')
    // Menu content rendered inside.
    expect(staticSidebar?.querySelector('[data-sidebar="menu-button"]')).toBeInTheDocument()
  })
})

describe('UX-231 — collapsible="offcanvas" regression guard (Sheet-only)', () => {
  beforeEach(() => {
    mockMobileViewport()
  })

  afterEach(() => {
    restoreDesktopViewport()
  })

  it('renders no persistent rail when collapsible="offcanvas"', () => {
    render(
      <SidebarProvider>
        <Sidebar collapsible="offcanvas">
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton>
                  <span>Home</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger />
        </SidebarInset>
      </SidebarProvider>,
    )

    // Offcanvas mode on mobile: only the Sheet exists, and it is closed by
    // default. The persistent rail is specific to collapsible="icon".
    expect(document.querySelector('[data-mobile-rail="true"]')).not.toBeInTheDocument()
    expect(document.querySelector('[data-mobile="true"]')).not.toBeInTheDocument()
  })
})

describe('UX-231 — desktop branch preservation (collapsible="icon")', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true })
  })

  it('does not render the mobile persistent rail on desktop', () => {
    renderSidebar()
    expect(document.querySelector('[data-mobile-rail="true"]')).not.toBeInTheDocument()
  })

  it('renders the desktop sidebar container + gap + inner layout', () => {
    renderSidebar()

    const sidebar = getSidebarSlot()
    expect(sidebar).toHaveAttribute('data-state', 'expanded')
    // Desktop uses the `hidden md:block` wrapper — not the mobile-rail marker.
    expect(sidebar.hasAttribute('data-mobile-rail')).toBe(false)

    expect(sidebar.querySelector('[data-slot="sidebar-gap"]')).toBeInTheDocument()
    expect(sidebar.querySelector('[data-slot="sidebar-container"]')).toBeInTheDocument()
    expect(sidebar.querySelector('[data-slot="sidebar-inner"]')).toBeInTheDocument()
  })
})

describe('UX-231 — SidebarInset overflow-x-hidden (belt-and-braces)', () => {
  it('SidebarInset carries overflow-x-hidden to contain lateral overflow', () => {
    render(
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarContent />
        </Sidebar>
        <SidebarInset>
          <div>Main</div>
        </SidebarInset>
      </SidebarProvider>,
    )

    const inset = document.querySelector('[data-slot="sidebar-inset"]') as HTMLElement
    expect(inset).not.toBeNull()
    expect(inset.className).toContain('overflow-x-hidden')
  })
})
