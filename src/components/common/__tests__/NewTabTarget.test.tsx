import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import {
  LONG_PRESS_DELAY,
  useBlockTouchLongPress,
} from '@/components/block-tree/use-block-touch-long-press'
import { NewTabTarget } from '@/components/common/NewTabTarget'
import { droppedPageId } from '@/lib/page-drag'
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

const openBlockMenu = vi.fn()

/** A block row wired like `SortableBlock`, holding a target (a query-table `PageLink`). */
function BlockRow(): React.ReactElement {
  const { handleTouchStart, handleTouchEnd, handleContextMenu } = useBlockTouchLongPress({
    openContextMenu: openBlockMenu,
    isDraggingRef: { current: false },
  })
  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onContextMenu={handleContextMenu}
    >
      <NewTabTarget pageId="TARGET" title="Target page">
        <button type="button">Target page</button>
      </NewTabTarget>
    </div>
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

  it('drags the page it opens, when asked to', () => {
    render(
      <NewTabTarget pageId="TARGET" title="Target page" dragsPage>
        <button type="button">Target page</button>
      </NewTabTarget>,
    )
    const button = screen.getByRole('button')
    const dragStart = createEvent.dragStart(button, { dataTransfer: {} }) as DragEvent

    fireEvent(button, dragStart)

    expect(button).toHaveAttribute('draggable', 'true')
    expect(droppedPageId(dragStart.dataTransfer)).toBe('TARGET')
  })

  // A draggable element takes the press that would select its text: a search
  // snippet or a reference preview.
  it('leaves the element undraggable otherwise', () => {
    renderTarget()
    const button = screen.getByRole('button')
    const dragStart = createEvent.dragStart(button, { dataTransfer: {} }) as DragEvent

    fireEvent(button, dragStart)

    expect(button).not.toHaveAttribute('draggable')
    expect(droppedPageId(dragStart.dataTransfer)).toBeNull()
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

  it('inside a block, a right click opens its menu and not the block menu too', async () => {
    const user = userEvent.setup()
    render(<BlockRow />)

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button') })

    expect(await screen.findAllByRole('menu')).toHaveLength(1)
    expect(openBlockMenu).not.toHaveBeenCalled()
  })

  it('inside a block, an Android long-press opens its menu and not the block menu on release', async () => {
    vi.useFakeTimers()
    try {
      render(<BlockRow />)
      const target = screen.getByRole('button')

      fireEvent.touchStart(target, { touches: [{ clientX: 10, clientY: 20 }] })
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_DELAY)
      })
      // Android's own long-press `contextmenu`, while the finger is still down.
      fireEvent.contextMenu(target)
      fireEvent.touchEnd(target, { touches: [] })

      expect(screen.getAllByRole('menu')).toHaveLength(1)
      expect(openBlockMenu).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('inside a block, a long-press that opens its menu by timer opens no block menu on release', () => {
    vi.useFakeTimers()
    try {
      render(<BlockRow />)
      const target = screen.getByRole('button')

      fireEvent.touchStart(target, { touches: [{ clientX: 10, clientY: 20 }] })
      fireEvent.pointerDown(target, { pointerType: 'touch' })
      // Past Radix's own long-press, with no native `contextmenu`.
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(screen.getAllByRole('menu')).toHaveLength(1)
      fireEvent.touchEnd(target, { touches: [] })

      expect(screen.getAllByRole('menu')).toHaveLength(1)
      expect(openBlockMenu).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('inside a block, a hold released before its menu opens opens the block menu', () => {
    vi.useFakeTimers()
    try {
      render(<BlockRow />)
      const target = screen.getByRole('button')

      fireEvent.touchStart(target, { touches: [{ clientX: 10, clientY: 20 }] })
      fireEvent.pointerDown(target, { pointerType: 'touch' })
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_DELAY)
      })
      fireEvent.pointerUp(target, { pointerType: 'touch' })
      fireEvent.touchEnd(target, { touches: [] })
      act(() => {
        vi.advanceTimersByTime(1000)
      })

      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(openBlockMenu).toHaveBeenCalledWith(10, 20, undefined, undefined)
    } finally {
      vi.useRealTimers()
    }
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
