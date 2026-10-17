import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { NewTabTarget } from '@/components/common/NewTabTarget'
import { useNavigationStore } from '@/stores/navigation'
import { useTabsStore } from '@/stores/tabs'

const onClick = vi.fn()

function renderTarget() {
  return render(
    <NewTabTarget pageId="TARGET" title="Target page">
      <button type="button" onClick={onClick}>
        Target page
      </button>
    </NewTabTarget>,
  )
}

function tabLabels(): string[] {
  return useTabsStore.getState().tabs.map((tab) => tab.label)
}

const desktopWidth = window.innerWidth

beforeEach(() => {
  vi.clearAllMocks()
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [{ pageId: 'CUR', title: 'Current' }], label: 'Current' }],
    activeTabIndex: 0,
    tabsBySpace: {},
    activeTabIndexBySpace: {},
  })
  useNavigationStore.setState({ currentView: 'pages', selectedBlockId: null })
})

afterEach(() => {
  window.innerWidth = desktopWidth
})

describe('NewTabTarget', () => {
  it('opens the page in a background tab on a middle click, without the click', async () => {
    const user = userEvent.setup()
    renderTarget()

    await user.pointer({ keys: '[MouseMiddle]', target: screen.getByRole('button') })

    expect(tabLabels()).toEqual(['Current', 'Target page'])
    expect(useTabsStore.getState().tabs[1]?.pageStack).toEqual([
      { pageId: 'TARGET', title: 'Target page' },
    ])
    expect(useTabsStore.getState().activeTabIndex).toBe(0)
    expect(useNavigationStore.getState().currentView).toBe('pages')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('cancels the browser’s own middle-button actions, and only those', () => {
    renderTarget()
    const button = screen.getByRole('button')

    expect(fireEvent.mouseDown(button, { button: 1 })).toBe(false)
    expect(fireEvent.mouseUp(button, { button: 1 })).toBe(false)
    expect(fireEvent.mouseDown(button, { button: 0 })).toBe(true)
  })

  it('leaves a primary click to the element', async () => {
    const user = userEvent.setup()
    renderTarget()

    await user.click(screen.getByRole('button'))

    expect(onClick).toHaveBeenCalledTimes(1)
    expect(tabLabels()).toEqual(['Current'])
  })

  it('offers "Open in new tab" in its context menu', async () => {
    const user = userEvent.setup()
    renderTarget()

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button') })
    await user.click(await screen.findByRole('menuitem', { name: 'Open in new tab' }))

    expect(tabLabels()).toEqual(['Current', 'Target page'])
    expect(useTabsStore.getState().activeTabIndex).toBe(0)
    expect(useNavigationStore.getState().currentView).toBe('pages')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('opens only the innermost target when targets nest', async () => {
    const user = userEvent.setup()
    render(
      <NewTabTarget pageId="OUTER" title="Outer">
        <div>
          <NewTabTarget pageId="INNER" title="Inner">
            <button type="button">Inner</button>
          </NewTabTarget>
        </div>
      </NewTabTarget>,
    )
    const inner = screen.getByRole('button', { name: 'Inner' })

    await user.pointer({ keys: '[MouseMiddle]', target: inner })
    await user.pointer({ keys: '[MouseRight]', target: inner })

    expect(await screen.findAllByRole('menu')).toHaveLength(1)
    expect(tabLabels()).toEqual(['Current', 'Inner'])
  })

  it('on mobile, which shows no tabs, renders the element alone', async () => {
    window.innerWidth = 500
    const user = userEvent.setup()
    renderTarget()

    await user.pointer({ keys: '[MouseMiddle]', target: screen.getByRole('button') })
    fireEvent.contextMenu(screen.getByRole('button'))

    expect(tabLabels()).toEqual(['Current'])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('has no a11y violations, closed and with its menu open', async () => {
    const user = userEvent.setup()
    const { container, baseElement } = renderTarget()
    expect(await axe(container)).toHaveNoViolations()

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button') })
    await screen.findByRole('menu')
    // The bare test page has no landmarks for the portal to sit in.
    expect(await axe(baseElement, { rules: { region: { enabled: false } } })).toHaveNoViolations()
  })
})
