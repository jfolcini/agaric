/**
 * Tests for view transition animations in App.
 *
 * Validates:
 *  - Transition wrapper renders with correct CSS classes
 *  - Wrapper toggles opacity classes when view changes
 *  - The fade-in survives a view change that coalesces with it (#3388)
 *  - The 150 ms beat restarts per switch, so it runs from the LAST one
 *  - Re-entering a view inside its own fade window does not re-hide the pane
 *
 * Class assertions go through `toHaveClass` (whole-token matching) rather
 * than `className` substrings, so `not.toHaveClass('opacity-0')` cannot pass
 * merely because the only opacity class present is `opacity-100`.
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
    // `toHaveClass` matches whole class TOKENS. A `className` substring check
    // would let `not.toContain('opacity-0')` pass merely because the string
    // 'opacity-100' does not contain it, so a future `opacity-05` step would
    // silently make the negative assertions vacuous.
    expect(wrapper).toHaveClass('opacity-100')
    expect(wrapper).toHaveClass('transition-opacity')
    expect(wrapper).toHaveClass('duration-normal')
    expect(wrapper).toHaveClass('ease-smooth')
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
      expect(wrapper).toHaveClass('opacity-0')
      expect(wrapper).not.toHaveClass('transition-opacity')

      // Advance timers past the 150ms fade delay (B-76)
      await act(async () => {
        vi.advanceTimersByTime(150)
      })

      // Now should be visible with transition classes
      const wrapperAfter = screen.getByTestId('view-transition-wrapper')
      expect(wrapperAfter).toHaveClass('opacity-100')
      expect(wrapperAfter).toHaveClass('transition-opacity')
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
      expect(screen.getByTestId('view-transition-wrapper')).toHaveClass('opacity-100')

      // First switch: hides the pane and arms the 150 ms fade-in.
      act(() => {
        useNavigationStore.setState({ currentView: 'tags' })
      })
      expect(screen.getByTestId('view-transition-wrapper')).toHaveClass('opacity-0')

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
        wrapper,
        'the content pane must fade back in after the second switch — it stayed opacity-0, i.e. the app is blank',
      ).toHaveClass('opacity-100')
      expect(wrapper).not.toHaveClass('opacity-0')
    } finally {
      vi.useRealTimers()
    }
  })

  // #4393 review, note 1 — the beat restarts on every switch.
  //
  // This is a real difference from the boolean the fix replaced, not just an
  // implementation detail. The boolean armed ONE timer on the first switch
  // (later same-value `setFadeVisible(false)` calls left the deps unchanged,
  // so the effect never re-ran) and then revealed whichever view happened to
  // be current when it fired — a view that could have had 10 ms. Keying on
  // `viewKey` clears and re-arms per switch, so the beat is measured from the
  // LAST one and B-76's promise — every view gets its own load beat before the
  // opacity transition starts — actually holds under rapid navigation.
  //
  // The cost is that clicking faster than 150 ms keeps the pane blank until
  // the user pauses. It is self-limiting (any 150 ms gap ends it) and bounded
  // by the re-entry case below, which returns instantly.
  it('restarts the 150 ms beat on each switch, fading in after the LAST one (#3388)', async () => {
    vi.useFakeTimers()

    try {
      render(<App />)
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      expect(screen.getByTestId('view-transition-wrapper')).toHaveClass('opacity-100')

      // t=0 — first switch hides the pane and arms a 150 ms timer.
      act(() => {
        useNavigationStore.setState({ currentView: 'tags' })
      })
      expect(screen.getByTestId('view-transition-wrapper')).toHaveClass('opacity-0')

      // t=100 — still inside the window, and a second switch lands. The
      // pending timer is cleared and a fresh 150 ms is armed from here.
      await act(async () => {
        vi.advanceTimersByTime(100)
      })
      expect(screen.getByTestId('view-transition-wrapper')).toHaveClass('opacity-0')
      act(() => {
        useNavigationStore.setState({ currentView: 'pages' })
      })

      // t=200 — 150 ms after the FIRST switch. The replaced boolean faded in
      // at exactly this point, showing a `pages` view that had had 100 ms.
      await act(async () => {
        vi.advanceTimersByTime(100)
      })
      expect(
        screen.getByTestId('view-transition-wrapper'),
        'the beat must restart on the second switch, not run out from the first',
      ).toHaveClass('opacity-0')

      // t=250 — 150 ms after the LAST switch.
      await act(async () => {
        vi.advanceTimersByTime(50)
      })
      const wrapper = screen.getByTestId('view-transition-wrapper')
      expect(wrapper).toHaveClass('opacity-100')
      expect(wrapper).not.toHaveClass('opacity-0')
    } finally {
      vi.useRealTimers()
    }
  })

  // #4393 review, note 2 — re-entering a view inside its own fade window
  // skips the hide entirely.
  //
  // A → B → A: B's timer never fired, so `visibleKey` is still A and
  // `fadeVisible` is true on the return render. This is NOT "the DOM still
  // holds A" — `ViewDispatcher` switches on `currentView`, so A is unmounted
  // and remounted and its list re-fetches. It is still what we want: the pane
  // is already `opacity-0` at that instant so nothing is flashed away, A has
  // already earned one beat, and it is what stops the restart above from
  // leaving an oscillating user staring at a blank pane. The old boolean
  // hid again here and made the user wait out B's timer.
  it('does not re-hide the pane when a view is re-entered inside its fade window (#3388)', async () => {
    vi.useFakeTimers()

    try {
      render(<App />)
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      // `journal` is the faded-in key.
      expect(screen.getByTestId('view-transition-wrapper')).toHaveClass('opacity-100')

      act(() => {
        useNavigationStore.setState({ currentView: 'tags' })
      })
      expect(screen.getByTestId('view-transition-wrapper')).toHaveClass('opacity-0')

      // Back to journal at t=50, well inside the 150 ms window.
      await act(async () => {
        vi.advanceTimersByTime(50)
      })
      act(() => {
        useNavigationStore.setState({ currentView: 'journal' })
      })

      const wrapper = screen.getByTestId('view-transition-wrapper')
      expect(
        wrapper,
        'returning to the still-visible key must show the pane at once, not start another beat',
      ).toHaveClass('opacity-100')
      expect(wrapper).not.toHaveClass('opacity-0')

      // And `tags`' timer went with it — nothing later marks a key the user
      // has already left as the visible one.
      await act(async () => {
        vi.advanceTimersByTime(5_000)
      })
      expect(screen.getByTestId('view-transition-wrapper')).toHaveClass('opacity-100')
    } finally {
      vi.useRealTimers()
    }
  })
})
