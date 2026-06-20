/**
 * Tests for the built-in Android back-chain steps (#716).
 *
 * overlayBackHandler:
 * - declines when no overlay is open
 * - consumes the press and dispatches a synthetic Escape keydown when a
 *   Radix-style overlay surface is open (dialog/alertdialog/menu/listbox)
 * - ignores `data-state="open"` on non-overlay roles (collapsibles)
 *
 * navigationBackHandler:
 * - page-editor with a page stack → `useTabsStore.goBack()`
 * - page-editor with an empty stack → return to journal
 * - any non-journal view → return to journal
 * - journal (true root) → declines
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useNavigationStore } from '../../stores/navigation'
import { resetTabIdCounter, useTabsStore } from '../../stores/tabs'
import { navigationBackHandler, overlayBackHandler } from '../back-handlers'

function resetStores() {
  resetTabIdCounter()
  useNavigationStore.setState({
    currentView: 'journal',
    currentViewBySpace: {},
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    tabsBySpace: {},
    activeTabIndexBySpace: {},
  })
}

describe('overlayBackHandler', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('declines when nothing is open', () => {
    expect(overlayBackHandler()).toBe(false)
  })

  it.each(['dialog', 'alertdialog', 'menu', 'listbox'] as const)(
    'consumes the press and dispatches Escape when a %s overlay is open',
    (role) => {
      const overlay = document.createElement('div')
      overlay.setAttribute('role', role)
      overlay.setAttribute('data-state', 'open')
      document.body.append(overlay)

      const onKeydown = vi.fn()
      window.addEventListener('keydown', onKeydown)
      try {
        expect(overlayBackHandler()).toBe(true)
        expect(onKeydown).toHaveBeenCalledTimes(1)
        const event = onKeydown.mock.calls[0]?.[0] as KeyboardEvent
        expect(event.key).toBe('Escape')
        expect(event.bubbles).toBe(true)
      } finally {
        window.removeEventListener('keydown', onKeydown)
      }
    },
  )

  it('dispatches the Escape on the focused element, not document.body', () => {
    // React ≥17 delegates keydown at root/portal containers; an event
    // dispatched on `document.body` never passes through them, so React
    // `onKeyDown` Escape handlers (palette action menu, …) would never
    // fire. A real hardware Escape targets the focused element — the
    // synthetic press must reproduce that path. Regression test for the
    // dead-back-button scenario (#716 review).
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('data-state', 'open')
    const button = document.createElement('button')
    overlay.append(button)
    document.body.append(overlay)
    button.focus()
    expect(document.activeElement).toBe(button)

    const onOverlayKeydown = vi.fn()
    overlay.addEventListener('keydown', onOverlayKeydown)

    expect(overlayBackHandler()).toBe(true)

    // The event bubbled THROUGH the overlay (target = focused button),
    // which only happens when it is dispatched on the focused element.
    expect(onOverlayKeydown).toHaveBeenCalledTimes(1)
    const event = onOverlayKeydown.mock.calls[0]?.[0] as KeyboardEvent
    expect(event.target).toBe(button)
  })

  it('falls back to document.body when nothing is focused', () => {
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('data-state', 'open')
    document.body.append(overlay)
    ;(document.activeElement as HTMLElement | null)?.blur()

    const onKeydown = vi.fn()
    window.addEventListener('keydown', onKeydown)
    try {
      expect(overlayBackHandler()).toBe(true)
      expect(onKeydown).toHaveBeenCalledTimes(1)
      const event = onKeydown.mock.calls[0]?.[0] as KeyboardEvent
      expect(event.target).toBe(document.body)
    } finally {
      window.removeEventListener('keydown', onKeydown)
    }
  })

  it('ignores closed overlays and open non-overlay surfaces', () => {
    const closedDialog = document.createElement('div')
    closedDialog.setAttribute('role', 'dialog')
    closedDialog.setAttribute('data-state', 'closed')
    document.body.append(closedDialog)

    // Collapsible / accordion triggers also carry data-state="open" but
    // must never swallow a back press.
    const collapsible = document.createElement('div')
    collapsible.setAttribute('data-state', 'open')
    document.body.append(collapsible)

    expect(overlayBackHandler()).toBe(false)
  })
})

describe('navigationBackHandler', () => {
  beforeEach(() => {
    resetStores()
  })

  it('pops the page stack via goBack when in page-editor with history', () => {
    useTabsStore.setState({
      tabs: [
        {
          id: '0',
          pageStack: [
            { pageId: 'P1', title: 'One' },
            { pageId: 'P2', title: 'Two' },
          ],
          label: 'Two',
        },
      ],
      activeTabIndex: 0,
    })
    useNavigationStore.setState({ currentView: 'page-editor' })

    expect(navigationBackHandler()).toBe(true)
    const { tabs, activeTabIndex } = useTabsStore.getState()
    expect(tabs[activeTabIndex]?.pageStack).toEqual([{ pageId: 'P1', title: 'One' }])
    expect(useNavigationStore.getState().currentView).toBe('page-editor')
  })

  it('returns to journal when in page-editor with an empty stack', () => {
    useNavigationStore.setState({ currentView: 'page-editor' })

    expect(navigationBackHandler()).toBe(true)
    expect(useNavigationStore.getState().currentView).toBe('journal')
  })

  it('returns to journal from any non-journal view', () => {
    useNavigationStore.setState({ currentView: 'settings' })

    expect(navigationBackHandler()).toBe(true)
    expect(useNavigationStore.getState().currentView).toBe('journal')
  })

  it('declines at the journal root so the caller can exit', () => {
    expect(navigationBackHandler()).toBe(false)
    expect(useNavigationStore.getState().currentView).toBe('journal')
  })
})
