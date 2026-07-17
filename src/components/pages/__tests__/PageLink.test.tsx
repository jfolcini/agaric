/**
 * Tests for PageLink component.
 *
 * Covers: rendering, navigation on click, stopPropagation, custom children,
 * custom className, and a11y audit.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { PageLink } from '@/components/pages/PageLink'
import {
  _resetPrefetchPageSubtreeForTest,
  PAGE_PREFETCH_DWELL_MS,
  prefetchPageSubtree,
} from '@/lib/prefetch-page-subtree'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, useTabsStore } from '@/stores/tabs'

// Spy on `prefetchPageSubtree` without letting it run for real (the real
// implementation dispatches an IPC via `loadPageSubtree`, which this test
// file doesn't mock) — keep every other export (the TTL/dwell constants,
// the test reset) live from the actual module.
vi.mock('@/lib/prefetch-page-subtree', async () => {
  const actual = await vi.importActual<typeof import('@/lib/prefetch-page-subtree')>(
    '@/lib/prefetch-page-subtree',
  )
  return { ...actual, prefetchPageSubtree: vi.fn() }
})

const mockedPrefetchPageSubtree = vi.mocked(prefetchPageSubtree)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  _resetPrefetchPageSubtreeForTest()
  useNavigationStore.setState({
    currentView: 'journal',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
  })
  useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PageLink', () => {
  it('renders the title as button text', () => {
    render(<PageLink pageId="P1" title="My Page" />)
    expect(screen.getByRole('link', { name: 'My Page' })).toBeInTheDocument()
  })

  it('renders custom children instead of title', () => {
    render(
      <PageLink pageId="P1" title="My Page">
        <span>Custom Label</span>
      </PageLink>,
    )
    expect(screen.getByText('Custom Label')).toBeInTheDocument()
    expect(screen.queryByText('My Page')).not.toBeInTheDocument()
  })

  it('navigates to page on click', async () => {
    const user = userEvent.setup()
    render(<PageLink pageId="P1" title="My Page" />)

    await user.click(screen.getByRole('link', { name: 'My Page' }))

    const state = useNavigationStore.getState()
    const pageStack = selectPageStack(useTabsStore.getState())
    expect(state.currentView).toBe('page-editor')
    expect(pageStack).toEqual([{ pageId: 'P1', title: 'My Page' }])
  })

  it('navigates to page on Enter key', async () => {
    const user = userEvent.setup()
    render(<PageLink pageId="P1" title="My Page" />)

    screen.getByRole('link', { name: 'My Page' }).focus()
    await user.keyboard('{Enter}')

    const state = useNavigationStore.getState()
    const pageStack = selectPageStack(useTabsStore.getState())
    expect(state.currentView).toBe('page-editor')
    expect(pageStack).toEqual([{ pageId: 'P1', title: 'My Page' }])
  })

  it('navigates to page on Space key', async () => {
    const user = userEvent.setup()
    render(<PageLink pageId="P1" title="My Page" />)

    screen.getByRole('link', { name: 'My Page' }).focus()
    await user.keyboard(' ')

    const state = useNavigationStore.getState()
    const pageStack = selectPageStack(useTabsStore.getState())
    expect(state.currentView).toBe('page-editor')
    expect(pageStack).toEqual([{ pageId: 'P1', title: 'My Page' }])
  })

  it('stops event propagation on click', async () => {
    const parentClick = vi.fn()
    const user = userEvent.setup()
    render(
      // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- test wrapper to verify stopPropagation
      <div onClick={parentClick} onKeyDown={() => {}}>
        <PageLink pageId="P1" title="My Page" />
      </div>,
    )

    await user.click(screen.getByRole('link', { name: 'My Page' }))

    expect(parentClick).not.toHaveBeenCalled()
  })

  it('applies custom className', () => {
    render(<PageLink pageId="P1" title="My Page" className="text-xs" />)
    const link = screen.getByRole('link', { name: 'My Page' })
    expect(link).toHaveClass('text-xs')
    expect(link).toHaveClass('hover:underline')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<PageLink pageId="P1" title="My Page" />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // #2850 — hover/focus intent schedules a speculative prefetch after a
  // short dwell; leaving/blurring before the dwell elapses cancels it.
  describe('prefetch intent (#2850)', () => {
    it('schedules a prefetch after the hover dwell elapses', () => {
      vi.useFakeTimers()
      render(<PageLink pageId="P1" title="My Page" />)
      const link = screen.getByRole('link', { name: 'My Page' })

      act(() => {
        fireEvent.mouseEnter(link)
      })
      expect(mockedPrefetchPageSubtree).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(PAGE_PREFETCH_DWELL_MS)
      })
      expect(mockedPrefetchPageSubtree).toHaveBeenCalledTimes(1)
      expect(mockedPrefetchPageSubtree).toHaveBeenCalledWith('SPACE_TEST', 'P1')
    })

    it('cancels the pending prefetch if the pointer leaves before the dwell elapses', () => {
      vi.useFakeTimers()
      render(<PageLink pageId="P1" title="My Page" />)
      const link = screen.getByRole('link', { name: 'My Page' })

      act(() => {
        fireEvent.mouseEnter(link)
      })
      act(() => {
        vi.advanceTimersByTime(PAGE_PREFETCH_DWELL_MS - 1)
      })
      act(() => {
        fireEvent.mouseLeave(link)
      })
      act(() => {
        vi.advanceTimersByTime(PAGE_PREFETCH_DWELL_MS)
      })

      expect(mockedPrefetchPageSubtree).not.toHaveBeenCalled()
    })

    it('schedules a prefetch after a keyboard focus dwell, and blur cancels it', () => {
      vi.useFakeTimers()
      render(<PageLink pageId="P1" title="My Page" />)
      const link = screen.getByRole('link', { name: 'My Page' })

      act(() => {
        fireEvent.focus(link)
      })
      act(() => {
        vi.advanceTimersByTime(PAGE_PREFETCH_DWELL_MS)
      })
      expect(mockedPrefetchPageSubtree).toHaveBeenCalledTimes(1)

      // A subsequent focus/blur cycle that never dwells long enough must
      // not fire a second prefetch.
      mockedPrefetchPageSubtree.mockClear()
      act(() => {
        fireEvent.blur(link)
        fireEvent.focus(link)
      })
      act(() => {
        vi.advanceTimersByTime(PAGE_PREFETCH_DWELL_MS - 1)
      })
      act(() => {
        fireEvent.blur(link)
      })
      act(() => {
        vi.advanceTimersByTime(PAGE_PREFETCH_DWELL_MS)
      })
      expect(mockedPrefetchPageSubtree).not.toHaveBeenCalled()
    })
  })
})
