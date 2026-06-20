/**
 * Tests for useAndroidBackButton (#716).
 *
 * Mocks the Tauri plugin-event source (`addPluginListener`) and the
 * process-exit seam, then drives synthetic back presses through the
 * captured listener callback to validate the full priority chain:
 *
 * - non-Android / non-Tauri → never touches the plugin API
 * - registers `('app', 'back-button')` on Android + Tauri
 * - overlay open → press consumed, no exit
 * - zoom handler registered → consumed before navigation, no exit
 * - page-editor with stack → goBack, no exit
 * - non-root view → back to journal, no exit
 * - true root (journal, no overlay, no zoom) → exit(0)
 * - unmount unregisters the plugin listener AND the chain handlers
 * - unmount before async registration resolves still unregisters
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetBackHandlersForTests,
  BACK_PRIORITY_ZOOM,
  registerBackHandler,
  runBackChain,
} from '../../lib/back-chain'
import { useNavigationStore } from '../../stores/navigation'
import { resetTabIdCounter, useTabsStore } from '../../stores/tabs'
import { useAndroidBackButton } from '../useAndroidBackButton'

const mocks = vi.hoisted(() => ({
  addPluginListener: vi.fn(),
  exit: vi.fn(),
  isAndroid: vi.fn(() => true),
}))

vi.mock('@tauri-apps/api/core', () => ({
  addPluginListener: mocks.addPluginListener,
}))
vi.mock('@tauri-apps/plugin-process', () => ({
  exit: mocks.exit,
}))
vi.mock('../../lib/platform', () => ({
  isAndroid: mocks.isAndroid,
}))

/** The back-press callback captured from `addPluginListener`. */
function capturedBackPress(): () => void {
  const call = mocks.addPluginListener.mock.calls[0]
  expect(call).toBeDefined()
  return call?.[2] as () => void
}

/** Mount the hook and flush the async listener registration. */
async function mountHook() {
  const utils = renderHook(() => useAndroidBackButton())
  await act(async () => {})
  return utils
}

describe('useAndroidBackButton', () => {
  beforeEach(() => {
    __resetBackHandlersForTests()
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
    document.body.innerHTML = ''
    mocks.isAndroid.mockReturnValue(true)
    mocks.exit.mockReset()
    mocks.exit.mockResolvedValue(undefined)
    mocks.addPluginListener.mockReset()
    mocks.addPluginListener.mockResolvedValue({ unregister: vi.fn() })
    ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
  })

  it('does nothing when not on Android', async () => {
    mocks.isAndroid.mockReturnValue(false)
    await mountHook()
    expect(mocks.addPluginListener).not.toHaveBeenCalled()
    expect(runBackChain()).toBe(false) // no chain handlers registered either
  })

  it('does nothing outside a Tauri WebView', async () => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
    await mountHook()
    expect(mocks.addPluginListener).not.toHaveBeenCalled()
  })

  it("registers the 'app' plugin 'back-button' listener on Android + Tauri", async () => {
    await mountHook()
    expect(mocks.addPluginListener).toHaveBeenCalledTimes(1)
    expect(mocks.addPluginListener).toHaveBeenCalledWith('app', 'back-button', expect.any(Function))
  })

  it('consumes the press without exiting when an overlay is open', async () => {
    await mountHook()
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('data-state', 'open')
    document.body.append(overlay)
    useNavigationStore.setState({ currentView: 'settings' })

    act(() => capturedBackPress()())

    expect(mocks.exit).not.toHaveBeenCalled()
    // Overlay outranks navigation: the view must NOT have changed.
    expect(useNavigationStore.getState().currentView).toBe('settings')
  })

  it('zoom handler outranks navigation and prevents exit', async () => {
    await mountHook()
    const zoomOut = vi.fn(() => true)
    registerBackHandler(zoomOut, BACK_PRIORITY_ZOOM)
    useNavigationStore.setState({ currentView: 'settings' })

    act(() => capturedBackPress()())

    expect(zoomOut).toHaveBeenCalledTimes(1)
    expect(mocks.exit).not.toHaveBeenCalled()
    expect(useNavigationStore.getState().currentView).toBe('settings')
  })

  it('pops the page stack when in page-editor with history', async () => {
    await mountHook()
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

    act(() => capturedBackPress()())

    const { tabs, activeTabIndex } = useTabsStore.getState()
    expect(tabs[activeTabIndex]?.pageStack).toEqual([{ pageId: 'P1', title: 'One' }])
    expect(mocks.exit).not.toHaveBeenCalled()
  })

  it('returns to journal from a non-root view without exiting', async () => {
    await mountHook()
    useNavigationStore.setState({ currentView: 'pages' })

    act(() => capturedBackPress()())

    expect(useNavigationStore.getState().currentView).toBe('journal')
    expect(mocks.exit).not.toHaveBeenCalled()
  })

  it('exits the app at the true root', async () => {
    await mountHook()

    act(() => capturedBackPress()())

    expect(mocks.exit).toHaveBeenCalledTimes(1)
    expect(mocks.exit).toHaveBeenCalledWith(0)
  })

  it('unmount unregisters the plugin listener and the chain handlers', async () => {
    const unregister = vi.fn()
    mocks.addPluginListener.mockResolvedValue({ unregister })
    const { unmount } = await mountHook()

    unmount()

    expect(unregister).toHaveBeenCalledTimes(1)
    // Built-in chain handlers are gone: a root-state press is unhandled.
    expect(runBackChain()).toBe(false)
  })

  it('unmount before the async registration resolves still unregisters', async () => {
    const unregister = vi.fn()
    let resolveListener: (l: { unregister: () => void }) => void = () => {}
    mocks.addPluginListener.mockReturnValue(
      new Promise((resolve) => {
        resolveListener = resolve
      }),
    )

    const { unmount } = renderHook(() => useAndroidBackButton())
    unmount()
    await act(async () => {
      resolveListener({ unregister })
    })

    expect(unregister).toHaveBeenCalledTimes(1)
  })
})
