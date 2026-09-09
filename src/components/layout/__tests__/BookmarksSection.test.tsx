/**
 * Tests for BookmarksSection (#4713) — the sidebar view over the one bookmark
 * list, the `starred-pages` preference that the page header and the Pages
 * browser also write.
 *
 * Two properties of that arrangement are what these tests exist for, and both
 * were false while bookmarks were a `pinned` flag on recent pages:
 *   - a bookmark outlives the recents cap, because it is not a recent entry
 *     ("keeps a bookmark that twelve later visits evict from recents"),
 *   - titles come from the resolve cache, which is keyed by space, so another
 *     space's bookmarks are left out ("shows only the active space").
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
import { PREFERENCES, writePreference } from '@/lib/preferences'
import { useRecentPagesStore } from '@/stores/recent-pages'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

const SPACE_A = 'SPACE_A'
const SPACE_B = 'SPACE_B'

/**
 * Seed the bookmark list, and the titles the section renders it with.
 *
 * The two halves are deliberately separate: `starred-pages` holds ids only,
 * and the resolve cache — written here under whatever space is active — is
 * where the titles come from. A test that seeds an id without a title is
 * seeding a bookmark from another space.
 */
function bookmark(entries: Array<{ id: string; title: string }>): void {
  writePreference(PREFERENCES.starredPages, [
    ...new Set([...readBookmarkIds(), ...entries.map((e) => e.id)]),
  ])
  useResolveStore
    .getState()
    .batchSet(entries.map((e) => ({ id: e.id, title: e.title, deleted: false })))
}

function readBookmarkIds(): string[] {
  const raw = localStorage.getItem('starred-pages')
  if (raw == null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

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

beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  await new Promise<void>((r) => queueMicrotask(r))
  // Steady state: the resolve cache's first full scan has landed.
  useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: true })
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
    it('renders an expanded section listing the bookmarked pages', () => {
      bookmark([{ id: 'A', title: 'Alpha' }])
      // Resolvable, visited, but not bookmarked.
      useResolveStore.getState().batchSet([{ id: 'B', title: 'Bravo', deleted: false }])
      useRecentPagesStore.getState().recordVisit({ pageId: 'B', title: 'Bravo' })

      renderSection()

      expect(screen.getByRole('button', { name: 'Collapse Bookmarks' })).toHaveAttribute(
        'aria-expanded',
        'true',
      )
      expect(bookmarkLabels()).toEqual(['Alpha'])
      expect(within(bookmarkList() as HTMLElement).queryByText('Bravo')).toBeNull()
    })

    it('lists bookmarks in the order they were added', () => {
      bookmark([{ id: 'A', title: 'Alpha' }])
      bookmark([{ id: 'B', title: 'Bravo' }])
      // Visiting Bravo again does not reorder the bookmark list — bookmarks
      // are not recents.
      useRecentPagesStore.getState().recordVisit({ pageId: 'B', title: 'Bravo' })

      renderSection()

      expect(bookmarkLabels()).toEqual(['Alpha', 'Bravo'])
    })

    /**
     * A bookmark is not a recent entry, so the `MAX_RETAINED = 10` cap cannot
     * reach it. Twelve visits after bookmarking is two past the cap, and the
     * title still comes from the resolve cache rather than the evicted row.
     */
    it('keeps a bookmark that twelve later visits evict from recents', () => {
      bookmark([{ id: 'A', title: 'Alpha' }])
      const { recordVisit } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      for (let i = 0; i < 12; i++) recordVisit({ pageId: `P${i}`, title: `Page ${i}` })

      renderSection()

      expect(bookmarkLabels()).toEqual(['Alpha'])
      // Alpha really is gone from recents — the cap did apply.
      const slice = useRecentPagesStore.getState().recentPagesBySpace[SPACE_A] ?? []
      expect(slice).toHaveLength(10)
      expect(slice.map((p) => p.pageId)).not.toContain('A')
    })

    it('renders the empty state when nothing is bookmarked', () => {
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      renderSection()

      expect(bookmarkList()).toBeNull()
      expect(screen.getByText(t('bookmarks.empty'))).toBeInTheDocument()
      expect(screen.getByText(t('bookmarks.emptyHint'))).toBeInTheDocument()
    })

    /**
     * Titles arrive with the resolve cache. Before it holds this bookmark —
     * cold boot, or a space switch that flushed it — an empty state would
     * tell a user with plenty of bookmarks that they have none.
     */
    it('renders neither list nor empty state while a bookmark is unresolved', () => {
      writePreference(PREFERENCES.starredPages, ['A'])

      renderSection()

      expect(bookmarkList()).toBeNull()
      expect(screen.queryByText(t('bookmarks.empty'))).toBeNull()
    })

    it('shows the empty state in a space whose pages have loaded', () => {
      bookmark([{ id: 'A', title: 'Alpha' }])
      useSpaceStore.setState({ currentSpaceId: SPACE_B })
      // SPACE_B's scan landed; it just holds none of the bookmarks.
      useResolveStore.getState().batchSet([{ id: 'OTHER', title: 'Other', deleted: false }])

      renderSection()

      expect(bookmarkList()).toBeNull()
      expect(screen.getByText(t('bookmarks.empty'))).toBeInTheDocument()
    })

    it('shows only the active space bookmarks', () => {
      bookmark([{ id: 'A', title: 'Alpha' }])
      useSpaceStore.setState({ currentSpaceId: SPACE_B })
      bookmark([{ id: 'B', title: 'Bravo' }])

      renderSection()

      // Both ids are in the one list; only Bravo resolves under SPACE_B.
      expect(readBookmarkIds()).toEqual(['A', 'B'])
      expect(bookmarkLabels()).toEqual(['Bravo'])
    })
  })

  describe('interaction', () => {
    it('opens the page in the active tab', async () => {
      const user = userEvent.setup()
      bookmark([{ id: 'A', title: 'ns/Alpha' }])

      renderSection()
      // Namespaced titles render as the leaf; the full path stays as `title`.
      await user.click(screen.getByRole('button', { name: 'Alpha' }))

      const tab = useTabsStore.getState().tabs[0]
      expect(tab?.pageStack.at(-1)).toMatchObject({ pageId: 'A', title: 'ns/Alpha' })
    })

    it('removes a bookmark and leaves the page in recents, durably', async () => {
      const user = userEvent.setup()
      bookmark([{ id: 'A', title: 'Alpha' }])
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      const { unmount } = renderSection()
      await user.click(screen.getByRole('button', { name: 'Remove Alpha from bookmarks' }))
      unmount()
      renderSection()

      expect(bookmarkList()).toBeNull()
      expect(screen.getByText(t('bookmarks.empty'))).toBeInTheDocument()
      expect(readBookmarkIds()).toEqual([])
      // Unbookmarked, not deleted — it is still a recent page.
      const slice = useRecentPagesStore.getState().recentPagesBySpace[SPACE_A] ?? []
      expect(slice.map((p) => p.pageId)).toEqual(['A'])
    })

    it('collapses and stays collapsed across a remount', async () => {
      const user = userEvent.setup()
      bookmark([{ id: 'A', title: 'Alpha' }])

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
      bookmark([{ id: 'A', title: 'Alpha' }])
      const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })

      try {
        renderSection()
        await user.click(screen.getByRole('button', { name: 'Collapse Bookmarks' }))

        expect(screen.getByRole('button', { name: 'Expand Bookmarks' })).toHaveAttribute(
          'aria-expanded',
          'false',
        )
        expect(bookmarkList()).toBeNull()
      } finally {
        setItem.mockRestore()
      }
    })
  })

  describe('accessibility', () => {
    it('has no a11y violations with bookmarks listed', async () => {
      bookmark([{ id: 'A', title: 'Alpha' }])

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
      bookmark([{ id: 'A', title: 'Alpha' }])

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
