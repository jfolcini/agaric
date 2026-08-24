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
 * - page-editor with an empty stack → the SAME exit view `goBack` would use
 *   (#4287: the tab's recorded origin, else `DEFAULT_PAGE_EXIT_VIEW`). This
 *   used to hard-code `journal` while `goBack` hard-coded `pages`.
 * - any non-journal view → return to journal
 * - journal (true root) → declines
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { navigationBackHandler, overlayBackHandler } from '@/lib/back-handlers'
import { useNavigationStore } from '@/stores/navigation'
import { DEFAULT_PAGE_EXIT_VIEW, resetTabIdCounter, useTabsStore } from '@/stores/tabs'

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

  // #4287 — was `'journal'`, which disagreed with `goBack`'s hard-coded
  // `'pages'` for the same "leave the editor" intent. Both now resolve through
  // `exitViewForTab`, so the gesture and the in-page Back button agree.
  it('leaves the editor for the shared fallback when the stack is already empty', () => {
    useNavigationStore.setState({ currentView: 'page-editor' })

    expect(navigationBackHandler()).toBe(true)
    expect(useNavigationStore.getState().currentView).toBe(DEFAULT_PAGE_EXIT_VIEW)
  })

  it('honours the tab’s recorded origin when the stack is already empty', () => {
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [], label: '', enteredFrom: 'tags' }],
      activeTabIndex: 0,
    })
    useNavigationStore.setState({ currentView: 'page-editor' })

    expect(navigationBackHandler()).toBe(true)
    expect(useNavigationStore.getState().currentView).toBe('tags')
  })

  // The two fallbacks agree: the Android gesture and `goBack` (the in-page
  // Back button / delete-page / stale-page heal) land on the SAME view for the
  // same tab — both for a recorded origin and for an unknown one.
  it.each([
    { origin: 'journal' as const, expected: 'journal' },
    { origin: undefined, expected: DEFAULT_PAGE_EXIT_VIEW },
  ])(
    'gesture and goBack agree on the exit view (origin: $origin)',
    ({ origin, expected }: { origin: 'journal' | undefined; expected: string }) => {
      const tabWith = (stack: { pageId: string; title: string }[]) => [
        { id: '0', pageStack: stack, label: '', ...(origin ? { enteredFrom: origin } : {}) },
      ]

      // Path A — the Android gesture on a one-page stack (delegates to goBack).
      useTabsStore.setState({
        tabs: tabWith([{ pageId: 'P1', title: 'One' }]),
        activeTabIndex: 0,
      })
      useNavigationStore.setState({ currentView: 'page-editor' })
      expect(navigationBackHandler()).toBe(true)
      const viaGesture = useNavigationStore.getState().currentView

      // Path B — the in-page Back button / delete flow calling goBack directly.
      useTabsStore.setState({
        tabs: tabWith([{ pageId: 'P1', title: 'One' }]),
        activeTabIndex: 0,
      })
      useNavigationStore.setState({ currentView: 'page-editor' })
      useTabsStore.getState().goBack()
      const viaButton = useNavigationStore.getState().currentView

      expect(viaGesture).toBe(expected)
      expect(viaButton).toBe(expected)
    },
  )

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
