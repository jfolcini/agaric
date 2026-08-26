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

import { App } from '@/App'
import { useBootStore } from '@/stores/boot'
import { useNavigationStore } from '@/stores/navigation'
import { useTabsStore } from '@/stores/tabs'

vi.mock('@/lib/announcer', () => ({
  announce: vi.fn(),
}))

vi.mock('@/components/peers/DeviceManagement', () => ({
  DeviceManagement: () => <div data-testid="device-management" />,
}))

vi.mock('@/components/backlinks/LinkedReferences', () => ({
  LinkedReferences: () => <div data-testid="linked-references" />,
}))

vi.mock('@/components/pages/PagePropertyTable', () => ({
  PagePropertyTable: () => <div data-testid="page-property-table" />,
}))

vi.mock('@/hooks/useSyncTrigger', () => ({
  useSyncTrigger: () => ({ syncing: false, syncAll: vi.fn() }),
}))

const mockedInvoke = vi.mocked(invoke)
const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

beforeEach(() => {
  vi.clearAllMocks()
  useBootStore.setState({ state: 'ready', error: null })
  useNavigationStore.setState({
    currentView: 'journal',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
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
    expect(wrapper.className).toContain('duration-normal')
    expect(wrapper.className).toContain('ease-smooth')
  })

  it('applies opacity-0 during view transition then fades in', async () => {
    vi.useFakeTimers()

    try {
      render(<App />)

      // Flush pending timers so the App finishes its initial mount and
      // the fade-in setTimeout fires, bringing the wrapper to opacity-100.
      await act(async () => {
        vi.advanceTimersByTime(200)
      })

      expect(screen.getByTestId('view-transition-wrapper')).toBeInTheDocument()

      // Switch view — triggers fade state change during render
      act(() => {
        useNavigationStore.setState({ currentView: 'pages' })
      })

      // Before the 150ms setTimeout fires, wrapper should have opacity-0 (hidden state).
      const wrapper = screen.getByTestId('view-transition-wrapper')
      expect(wrapper.className).toContain('opacity-0')
      expect(wrapper.className).not.toContain('transition-opacity')

      // Advance timers past the 150ms fade delay (B-76)
      await act(async () => {
        vi.advanceTimersByTime(150)
      })

      // Now should be visible with transition classes
      const wrapperAfter = screen.getByTestId('view-transition-wrapper')
      expect(wrapperAfter.className).toContain('opacity-100')
      expect(wrapperAfter.className).toContain('transition-opacity')
    } finally {
      vi.useRealTimers()
    }
  })

  // #3388 / e2e-tauri-weekly — the pane that never faded back in.
  //
  // The single-switch case above is only half the pair. When a second view
  // change coalesces with the pending fade-in, the committed `fadeVisible`
  // went `false → false`, so the old effect was skipped and the pane stayed
  // `opacity-0` for good. The weekly real-backend lane hit this because
  // `navigateTo()` takes ~150 ms — the fade delay itself — so a round trip
  // lands the second switch on top of the first switch's timer: run
  // 32687143146 failed with the tag element in the DOM and `checkVisibility`
  // false for 60 s, while the last green run (30788700755) shows the same
  // transient recovering after ~200 ms. Batching both updates in one `act()`
  // is what reproduces it — React coalesces them into a single render, as it
  // does when a discrete click pre-empts a scheduled default-lane render.
  it('re-arms the fade-in when a view change coalesces with the pending fade-in (#3388)', async () => {
    vi.useFakeTimers()

    try {
      render(<App />)
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      expect(screen.getByTestId('view-transition-wrapper').className).toContain('opacity-100')

      // First switch: hides the pane and arms the 150 ms fade-in.
      act(() => {
        useNavigationStore.setState({ currentView: 'tags' })
      })
      expect(screen.getByTestId('view-transition-wrapper').className).toContain('opacity-0')

      // Fire that timer and land the SECOND switch in the same batch, so the
      // pending `true` never reaches a commit of its own.
      act(() => {
        vi.advanceTimersByTime(150)
        useNavigationStore.setState({ currentView: 'pages' })
      })

      // Give the app far longer than any fade to settle.
      await act(async () => {
        vi.advanceTimersByTime(5_000)
      })

      const wrapper = screen.getByTestId('view-transition-wrapper')
      expect(
        wrapper.className,
        'the content pane must fade back in after the second switch — it stayed opacity-0, i.e. the app is blank',
      ).toContain('opacity-100')
      expect(wrapper.className).not.toContain('opacity-0')
    } finally {
      vi.useRealTimers()
    }
  })
})
