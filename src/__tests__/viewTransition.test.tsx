/**
 * Tests for view transition animations in App.
 *
 * Validates:
 *  - Transition wrapper renders with correct CSS classes
 *  - Wrapper toggles opacity classes when view changes
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { useBootStore } from '../stores/boot'
import { useNavigationStore } from '../stores/navigation'

vi.mock('../lib/announcer', () => ({
  announce: vi.fn(),
}))

vi.mock('../components/DeviceManagement', () => ({
  DeviceManagement: () => <div data-testid="device-management" />,
}))

vi.mock('../components/LinkedReferences', () => ({
  LinkedReferences: () => <div data-testid="linked-references" />,
}))

vi.mock('../components/PagePropertyTable', () => ({
  PagePropertyTable: () => <div data-testid="page-property-table" />,
}))

vi.mock('../hooks/useSyncTrigger', () => ({
  useSyncTrigger: () => ({ syncing: false, syncAll: vi.fn() }),
}))

const mockedInvoke = vi.mocked(invoke)
const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
  useBootStore.setState({ state: 'ready', error: null })
  useNavigationStore.setState({
    currentView: 'journal',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    selectedBlockId: null,
  })
  mockedInvoke.mockResolvedValue(emptyPage)
})

describe('view transition wrapper', () => {
  it('renders wrapper with transition classes on initial load', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('view-transition-wrapper')).toBeInTheDocument()
    })

    const wrapper = screen.getByTestId('view-transition-wrapper')
    expect(wrapper.className).toContain('opacity-100')
    expect(wrapper.className).toContain('transition-opacity')
    expect(wrapper.className).toContain('duration-150')
    expect(wrapper.className).toContain('ease-out')
  })

  it('applies opacity-0 during view transition then fades in', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('view-transition-wrapper')).toBeInTheDocument()
    })

    // Intercept rAF to observe the intermediate opacity-0 state
    const rafCallbacks: FrameRequestCallback[] = []
    const origRAF = globalThis.requestAnimationFrame
    const origCancelRAF = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = (cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    }
    globalThis.cancelAnimationFrame = () => {}

    try {
      // Switch view — triggers fade state change during render
      act(() => {
        useNavigationStore.setState({ currentView: 'pages' })
      })

      // rAF callbacks have been captured but not fired.
      // The wrapper should have opacity-0 (hidden state).
      const wrapper = screen.getByTestId('view-transition-wrapper')
      expect(wrapper.className).toContain('opacity-0')
      expect(wrapper.className).not.toContain('transition-opacity')

      // Fire captured rAF callbacks → triggers setFadeVisible(true)
      act(() => {
        for (const cb of rafCallbacks) cb(16)
      })

      // Now should be visible with transition classes
      const wrapperAfter = screen.getByTestId('view-transition-wrapper')
      expect(wrapperAfter.className).toContain('opacity-100')
      expect(wrapperAfter.className).toContain('transition-opacity')
    } finally {
      globalThis.requestAnimationFrame = origRAF
      globalThis.cancelAnimationFrame = origCancelRAF
    }
  })
})
