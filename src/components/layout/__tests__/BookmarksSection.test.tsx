/**
 * Tests for BookmarksSection (#4713) — the sidebar view over the pinned
 * entries of `recent-pages`.
 *
 * The section adds no state of its own beyond the disclosure preference, so
 * the tests that matter are the ones pinning the two store behaviours it is
 * built on:
 *   - pin-first ordering — a bookmark pinned earlier lists ahead of one
 *     visited more recently ("lists bookmarks pin-first …"),
 *   - the `MAX_RETAINED` pin exemption — a bookmark survives twelve later
 *     visits ("keeps a bookmark …").
 * Both are asserted from the rendered list, and both go red when
 * `applyPinFirstCap` is weakened (see the session notes for the two
 * falsifying mutations).
 *
 * Everything else is durable, re-queried effect: unmount + re-render after
 * each interaction, so a state change that only lived in a React closure
 * fails.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { BookmarksSection } from '@/components/layout/BookmarksSection'
import { SidebarProvider } from '@/components/ui/sidebar'
import { t } from '@/lib/i18n'
import { useRecentPagesStore } from '@/stores/recent-pages'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

const SPACE_A = 'SPACE_A'
const SPACE_B = 'SPACE_B'

function renderSection() {
  return render(
    <SidebarProvider>
      <BookmarksSection />
    </SidebarProvider>,
  )
}

/** The section's bookmark list — absent while collapsed or empty. */
function bookmarkList(): HTMLElement | null {
  return screen.queryByRole('list', { name: t('bookmarks.title') })
}

/** Visible bookmark labels, in render order. */
function bookmarkLabels(): string[] {
  const list = bookmarkList()
  if (list == null) return []
  return within(list)
    .getAllByRole('button', { name: (name) => !name.startsWith('Remove ') })
    .map((b) => b.textContent ?? '')
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useRecentPagesStore.setState({ recentPages: [], recentPagesBySpace: {}, rawKeysMerged: true })
  useSpaceStore.setState({
    currentSpaceId: SPACE_A,
    availableSpaces: [{ id: SPACE_A, name: 'A', accent_color: 'accent-emerald' }],
    isReady: true,
  })
  useTabsStore.setState({ tabs: [{ id: '0', pageStack: [], label: '' }], activeTabIndex: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BookmarksSection', () => {
  describe('listing', () => {
    it('renders an expanded section listing the pinned pages', () => {
      const { recordVisit, togglePinRecentPage } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      recordVisit({ pageId: 'B', title: 'Bravo' })
      togglePinRecentPage('A')

      renderSection()

      expect(screen.getByRole('button', { name: 'Collapse Bookmarks' })).toHaveAttribute(
        'aria-expanded',
        'true',
      )
      expect(bookmarkLabels()).toEqual(['Alpha'])
      // Unpinned recents are NOT bookmarks.
      expect(within(bookmarkList() as HTMLElement).queryByText('Bravo')).toBeNull()
    })

    /**
     * Pin-first ordering, observed from the list: Alpha is pinned first,
     * Bravo is visited AFTER that and pinned second. Recency alone would put
     * Bravo first; the store's pin partition keeps Alpha ahead.
     */
    it('lists bookmarks pin-first, ahead of a page visited more recently', () => {
      const { recordVisit, togglePinRecentPage } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      recordVisit({ pageId: 'B', title: 'Bravo' })
      recordVisit({ pageId: 'C', title: 'Charlie' })
      togglePinRecentPage('A')
      recordVisit({ pageId: 'B', title: 'Bravo' })
      togglePinRecentPage('B')

      renderSection()

      expect(bookmarkLabels()).toEqual(['Alpha', 'Bravo'])
    })

    /**
     * The `MAX_RETAINED = 10` pin exemption. Twelve visits after the pin is
     * two more than the cap, so an unpinned Alpha would have been evicted.
     */
    it('keeps a bookmark that twelve later visits would otherwise have evicted', () => {
      const { recordVisit, togglePinRecentPage } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      togglePinRecentPage('A')
      for (let i = 0; i < 12; i++) recordVisit({ pageId: `P${i}`, title: `Page ${i}` })

      renderSection()

      expect(bookmarkLabels()).toEqual(['Alpha'])
      // The cap did apply — to the unpinned partition only.
      const slice = useRecentPagesStore.getState().recentPagesBySpace[SPACE_A] ?? []
      expect(slice.filter((p) => p.pinned !== true)).toHaveLength(10)
    })

    it('renders the empty state when nothing is pinned', () => {
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      renderSection()

      expect(bookmarkList()).toBeNull()
      expect(screen.getByText(t('bookmarks.empty'))).toBeInTheDocument()
      expect(screen.getByText(t('bookmarks.emptyHint'))).toBeInTheDocument()
    })

    it('shows only the active space bookmarks', () => {
      useSpaceStore.setState({ currentSpaceId: SPACE_B })
      useRecentPagesStore.setState({
        recentPages: [],
        recentPagesBySpace: {
          [SPACE_A]: [{ pageId: 'A', title: 'Alpha', pinned: true }],
          [SPACE_B]: [{ pageId: 'B', title: 'Bravo', pinned: true }],
        },
      })

      renderSection()

      expect(bookmarkLabels()).toEqual(['Bravo'])
    })
  })

  describe('interaction', () => {
    it('opens the page in the active tab', async () => {
      const user = userEvent.setup()
      const { recordVisit, togglePinRecentPage } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'ns/Alpha' })
      togglePinRecentPage('A')

      renderSection()
      // Namespaced titles render as the leaf; the full path stays as `title`.
      await user.click(screen.getByRole('button', { name: 'Alpha' }))

      const tab = useTabsStore.getState().tabs[0]
      expect(tab?.pageStack.at(-1)).toMatchObject({ pageId: 'A', title: 'ns/Alpha' })
    })

    it('removes a bookmark and leaves the page in recents, durably', async () => {
      const user = userEvent.setup()
      const { recordVisit, togglePinRecentPage } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      togglePinRecentPage('A')

      const { unmount } = renderSection()
      await user.click(screen.getByRole('button', { name: 'Remove Alpha from bookmarks' }))
      unmount()
      renderSection()

      expect(bookmarkList()).toBeNull()
      expect(screen.getByText(t('bookmarks.empty'))).toBeInTheDocument()
      // Unpinned, not deleted — it is still a recent page.
      const slice = useRecentPagesStore.getState().recentPagesBySpace[SPACE_A] ?? []
      expect(slice.map((p) => p.pageId)).toEqual(['A'])
      expect(slice[0]?.pinned).toBeUndefined()
    })

    it('collapses and stays collapsed across a remount', async () => {
      const user = userEvent.setup()
      const { recordVisit, togglePinRecentPage } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      togglePinRecentPage('A')

      const { unmount } = renderSection()
      await user.click(screen.getByRole('button', { name: 'Collapse Bookmarks' }))
      expect(bookmarkList()).toBeNull()

      unmount()
      renderSection()

      const header = screen.getByRole('button', { name: 'Expand Bookmarks' })
      expect(header).toHaveAttribute('aria-expanded', 'false')
      expect(bookmarkList()).toBeNull()

      await user.click(header)
      expect(bookmarkLabels()).toEqual(['Alpha'])
    })

    /**
     * Failure path: `localStorage` writes throw in private mode / at quota.
     * `useLocalStoragePreference` swallows the write, so the disclosure must
     * still respond for the session instead of appearing stuck.
     */
    it('still toggles when persisting the preference throws', async () => {
      const user = userEvent.setup()
      const { recordVisit, togglePinRecentPage } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      togglePinRecentPage('A')
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })

      renderSection()
      await user.click(screen.getByRole('button', { name: 'Collapse Bookmarks' }))

      expect(screen.getByRole('button', { name: 'Expand Bookmarks' })).toHaveAttribute(
        'aria-expanded',
        'false',
      )
      expect(bookmarkList()).toBeNull()
    })
  })

  describe('accessibility', () => {
    it('has no a11y violations with bookmarks listed', async () => {
      const { recordVisit, togglePinRecentPage } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      togglePinRecentPage('A')

      const { container } = renderSection()
      await waitFor(async () => {
        expect(await axe(container)).toHaveNoViolations()
      })
    })

    it('has no a11y violations when empty', async () => {
      const { container } = renderSection()
      await waitFor(async () => {
        expect(await axe(container)).toHaveNoViolations()
      })
    })

    it('has no a11y violations when collapsed', async () => {
      const user = userEvent.setup()
      const { recordVisit, togglePinRecentPage } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      togglePinRecentPage('A')

      const { container } = renderSection()
      await act(async () => {
        await user.click(screen.getByRole('button', { name: 'Collapse Bookmarks' }))
      })
      await waitFor(async () => {
        expect(await axe(container)).toHaveNoViolations()
      })
    })
  })
})
