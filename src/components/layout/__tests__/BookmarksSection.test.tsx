/**
 * Tests for BookmarksSection (#4713) — the sidebar view over the one bookmark
 * list, the `bookmark` page property (#6544) that the page header and the
 * Pages browser also write.
 *
 * Two properties of that arrangement are what these tests exist for, and both
 * were false while bookmarks were a `pinned` flag on recent pages:
 *   - a bookmark outlives the recents cap, because it is not a recent entry
 *     ("keeps a bookmark that twelve later visits evict from recents"),
 *   - the list is the active space's ("shows only the active space").
 *
 * A third since #5075: a bookmark the resolve cache has never held is
 * RESOLVED on demand rather than dropped, and the empty state waits until
 * every bookmark has been looked up.
 *
 * Everything else is durable, re-queried effect: `held` is what the backend
 * holds after each interaction, and a remount re-reads the list.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { bookmarkInvokeHandlers, seedBookmarks } from '@/__tests__/helpers/bookmarks'
import { mockInvokeCommands, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { BookmarksSection } from '@/components/layout/BookmarksSection'
import { SidebarProvider } from '@/components/ui/sidebar'
import type { ResolvedBlock } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import { useRecentPagesStore } from '@/stores/recent-pages'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

const SPACE_A = 'SPACE_A'
const SPACE_B = 'SPACE_B'

/** The bookmarks the backend holds, page id → sidebar number, and each page's space. */
const held = new Map<string, number>()
const spaceOf = new Map<string, string>()

/** Show each space's share of `held` as its bookmark list, as a read would. */
function seedLists(): void {
  for (const space of [SPACE_A, SPACE_B]) {
    seedBookmarks(space, new Map([...held].filter(([id]) => spaceOf.get(id) === space)))
  }
}

/** Bookmark `ids` (after the existing ones) in `space`, with no title in the resolve cache. */
function bookmarkIds(ids: string[], space = SPACE_A): void {
  for (const id of ids) {
    held.set(id, held.size + 1)
    spaceOf.set(id, space)
  }
  seedLists()
}

/**
 * Bookmark pages of the active space, and put the titles the section renders
 * them with in the resolve cache.
 */
function bookmark(entries: Array<{ id: string; title: string }>): void {
  bookmarkIds(
    entries.map((e) => e.id),
    useSpaceStore.getState().currentSpaceId ?? SPACE_A,
  )
  useResolveStore
    .getState()
    .batchSet(entries.map((e) => ({ id: e.id, title: e.title, deleted: false })))
}

/** The held bookmark ids, in number order. */
function readBookmarkIds(): string[] {
  return [...held].toSorted((a, b) => a[1] - b[1]).map(([id]) => id)
}

/** The backend this suite runs against, with `handlers` over its defaults. */
function stub(handlers: Readonly<TypedInvokeHandlers> = {}): void {
  vi.mocked(invoke).mockImplementation(
    mockInvokeCommands({
      ...bookmarkInvokeHandlers(held, spaceOf),
      // It knows none of the ids the section asks about.
      batch_resolve: () => [],
      // Opening a page stamps it for the Pages view's "Last opened" sort (#5371).
      record_page_open: () => null,
      ...handlers,
    }),
  )
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

/**
 * One row `batch_resolve` hands back. The section asks for every bookmarked
 * id the cache does not hold; what the backend returns is what it may render.
 */
function resolvedRow(id: string, title: string): ResolvedBlock {
  return { id, title, block_type: 'page', deleted: false }
}

/** The `batch_resolve` argument objects, in call order. */
function resolveArgs(): Array<Record<string, unknown>> {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([cmd]) => cmd === 'batch_resolve')
    .map(([, args]) => args as Record<string, unknown>)
}

beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  held.clear()
  spaceOf.clear()
  await new Promise<void>((r) => queueMicrotask(r))
  // Steady state: the resolve cache's first full scan has landed, and so has
  // each space's bookmark list.
  useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: true })
  seedLists()
  useRecentPagesStore.setState({ recentPages: [], recentPagesBySpace: {}, rawKeysMerged: true })
  useSpaceStore.setState({
    currentSpaceId: SPACE_A,
    availableSpaces: [{ id: SPACE_A, name: 'A', accent_color: 'accent-emerald' }],
    isReady: true,
  })
  useTabsStore.setState({ tabs: [{ id: '0', pageStack: [], label: '' }], activeTabIndex: 0 })
  stub()
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
      // One quiet line, not a bordered empty-state box with its own landmark.
      const hint = screen.getByText(t('bookmarks.emptyHint'))
      expect(hint).toHaveClass('text-xs', 'text-muted-foreground')
      expect(screen.queryByRole('region')).toBeNull()
      expect(hint.closest('.border-dashed')).toBeNull()
    })

    /** Until the list has been read, an empty state would be a guess. */
    it('renders neither list nor empty state while the bookmark list is being read', async () => {
      // No list has been read yet, and this read never answers.
      queryClient.clear()
      stub({ query_by_property: () => new Promise<never>(() => {}) })

      renderSection()

      await waitFor(() => {
        expect(vi.mocked(invoke)).toHaveBeenCalledWith('query_by_property', expect.anything())
      })
      expect(bookmarkList()).toBeNull()
      expect(screen.queryByText(t('bookmarks.emptyHint'))).toBeNull()
    })

    /**
     * #5075 — `preload` scans on boot, on a space switch and on
     * `sync:complete` only, so a page bookmarked in the session it was created
     * in is in nobody's cache. Dropping it told a user with one bookmark that
     * they had none.
     */
    it('resolves a bookmark the cache has never held', async () => {
      bookmarkIds(['NEW'])
      stub({
        batch_resolve: (args) =>
          (args['ids'] as string[]).map((id) => resolvedRow(id, 'Brand New Page')),
      })

      const { unmount } = renderSection()

      expect(await screen.findByRole('button', { name: 'Brand New Page' })).toBeInTheDocument()
      // Durable: the title landed in the shared cache, so a remount lists it
      // without asking again.
      unmount()
      renderSection()
      expect(bookmarkLabels()).toEqual(['Brand New Page'])
      expect(resolveArgs()).toHaveLength(1)
    })

    /**
     * A space switch flushes the space it leaves (`clearAllForSpace`), but this
     * section never unmounts, so the record of what it has already asked about
     * outlives the cache that record was about. Scoped per space, coming back
     * re-asks; shared across spaces, the id is uncached AND already marked
     * asked, so it is neither rendered nor pending and the empty state claims
     * the user has no bookmarks — #5075's symptom, restored by its own fix.
     */
    it('re-asks for a bookmark after a space round trip flushed the cache', async () => {
      bookmarkIds(['NEW'])
      stub({
        batch_resolve: (args) =>
          (args['ids'] as string[]).map((id) => resolvedRow(id, 'Brand New Page')),
      })

      renderSection()
      expect(await screen.findByRole('button', { name: 'Brand New Page' })).toBeInTheDocument()
      expect(resolveArgs()).toHaveLength(1)

      // Away. The flush is what `useAppSpaceLifecycle` does on every switch;
      // it is driven directly here because that hook is App-level.
      await act(async () => {
        useSpaceStore.setState({ currentSpaceId: SPACE_B })
        useResolveStore.getState().clearAllForSpace(SPACE_A)
      })
      // B holds no bookmarks, so B is legitimately empty.
      expect(await screen.findByText(t('bookmarks.emptyHint'))).toBeInTheDocument()

      await act(async () => {
        useSpaceStore.setState({ currentSpaceId: SPACE_A })
      })

      expect(await screen.findByRole('button', { name: 'Brand New Page' })).toBeInTheDocument()
      expect(screen.queryByText(t('bookmarks.emptyHint'))).not.toBeInTheDocument()
      // Asked again, because the answer A had was thrown away with the cache.
      expect(resolveArgs()).toHaveLength(2)
    })

    /**
     * Titles arrive with the resolve cache, and a bookmark it does not hold is
     * looked up. Until that lookup answers, an empty state would tell a user
     * with plenty of bookmarks that they have none — including here, where the
     * cache is warm for this space and simply does not hold this id.
     */
    it('renders neither list nor empty state while a bookmark is being resolved', async () => {
      useResolveStore.getState().batchSet([{ id: 'OTHER', title: 'Other', deleted: false }])
      bookmarkIds(['A'])
      stub({ batch_resolve: () => new Promise<ResolvedBlock[]>(() => {}) })

      renderSection()

      await waitFor(() => {
        expect(resolveArgs()).toHaveLength(1)
      })
      expect(bookmarkList()).toBeNull()
      expect(screen.queryByText(t('bookmarks.emptyHint'))).toBeNull()
    })

    it('shows the empty state once every bookmark has been looked up', async () => {
      // The cache's scan landed; it just does not hold A, and the backend
      // resolves nothing for it either.
      useResolveStore.getState().batchSet([{ id: 'OTHER', title: 'Other', deleted: false }])
      bookmarkIds(['A'])

      renderSection()

      expect(await screen.findByText(t('bookmarks.emptyHint'))).toBeInTheDocument()
      expect(bookmarkList()).toBeNull()
      // Asked once — an id the answer left out must not be asked for again on
      // every store write the answer triggers.
      expect(resolveArgs()).toHaveLength(1)
    })

    it('shows only the active space bookmarks', () => {
      bookmark([{ id: 'A', title: 'Alpha' }])
      useSpaceStore.setState({ currentSpaceId: SPACE_B })
      bookmark([{ id: 'B', title: 'Bravo' }])

      renderSection()

      expect(bookmarkLabels()).toEqual(['Bravo'])
      // A is still bookmarked, in its own space.
      expect(readBookmarkIds()).toEqual(['A', 'B'])
      expect(resolveArgs()).toHaveLength(0)
    })

    /**
     * #5293 — a trashed page keeps its bookmark (a restore must bring it
     * back) but every click on it only toasts "in the trash", so the sidebar
     * leaves it out.
     */
    it('does not list a bookmarked page that was deleted, and keeps it bookmarked', () => {
      bookmark([
        { id: 'A', title: 'Alpha' },
        { id: 'B', title: 'Bravo' },
      ])
      useResolveStore.getState().markDeleted(SPACE_A, ['A'])

      renderSection()

      expect(bookmarkLabels()).toEqual(['Bravo'])
      expect(readBookmarkIds()).toEqual(['A', 'B'])
      // Resolved-and-deleted is an answer, not a gap to look up.
      expect(resolveArgs()).toHaveLength(0)
    })

    /**
     * After a restart the cache is empty, so the deleted page is resolved on
     * demand and `batch_resolve` hands the soft-deleted row back with
     * `deleted: true`.
     */
    it('does not list a bookmark the backend returns as deleted', async () => {
      bookmarkIds(['A'])
      stub({
        batch_resolve: (args) =>
          (args['ids'] as string[]).map((id) =>
            Object.assign(resolvedRow(id, 'Alpha'), { deleted: true }),
          ),
      })

      renderSection()

      expect(await screen.findByText(t('bookmarks.emptyHint'))).toBeInTheDocument()
      expect(bookmarkList()).toBeNull()
      expect(resolveArgs()).toHaveLength(1)
    })

    it('lists a deleted bookmark again once it is restored', async () => {
      bookmark([{ id: 'A', title: 'Alpha' }])
      useResolveStore.getState().markDeleted(SPACE_A, ['A'])

      renderSection()
      expect(bookmarkList()).toBeNull()

      // What the trash view does after a restore.
      stub({
        batch_resolve: (args) => (args['ids'] as string[]).map((id) => resolvedRow(id, 'Alpha')),
      })
      await act(async () => {
        await useResolveStore.getState().refreshDeleted(SPACE_A)
      })

      expect(bookmarkLabels()).toEqual(['Alpha'])
    })

    /**
     * Rejection path. A lookup that never answered is not evidence of
     * emptiness, so the section stays blank rather than claiming the user has
     * no bookmarks, and the failure is logged rather than swallowed.
     */
    it('keeps the section blank and logs when resolving a bookmark fails', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      useResolveStore.getState().batchSet([{ id: 'OTHER', title: 'Other', deleted: false }])
      bookmarkIds(['A'])
      stub({ batch_resolve: () => Promise.reject(new Error('IPC failed')) })

      renderSection()

      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalled()
      })
      expect(bookmarkList()).toBeNull()
      expect(screen.queryByText(t('bookmarks.emptyHint'))).toBeNull()
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
      await waitFor(() => expect(readBookmarkIds()).toEqual([]))
      unmount()
      renderSection()

      expect(bookmarkList()).toBeNull()
      expect(screen.getByText(t('bookmarks.emptyHint'))).toBeInTheDocument()
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
        // The toggle happens whether or not the write throws, so this is what
        // pins the failure path this test is named for.
        expect(setItem).toHaveBeenCalled()
      } finally {
        setItem.mockRestore()
      }
    })
  })

  describe('reordering', () => {
    /**
     * dnd-kit finds the row an arrow key moves to by measuring the rows, and
     * happy-dom lays nothing out. Stack them 40px apart, in DOM order.
     */
    function layOutRows(): void {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element,
      ) {
        const row = this.closest('[data-sidebar="menu-item"]')
        const index = row?.parentElement ? [...row.parentElement.children].indexOf(row) : 0
        return new DOMRect(0, index * 40, 200, 32)
      })
    }

    /**
     * X is a bookmarked page in the trash, which the section does not list.
     * Alpha moves across it, so a move computed over the visible list alone
     * would land Alpha on the wrong side of X.
     */
    it('moves a bookmark with Space, ArrowDown, Space, durably, without opening it', async () => {
      const user = userEvent.setup()
      bookmark([
        { id: 'A', title: 'Alpha' },
        { id: 'X', title: 'Xray' },
        { id: 'B', title: 'Bravo' },
        { id: 'C', title: 'Charlie' },
      ])
      useResolveStore.getState().markDeleted(SPACE_A, ['X'])
      layOutRows()

      const { unmount } = renderSection()
      screen.getByRole('button', { name: 'Alpha' }).focus()
      await user.keyboard('[Space][ArrowDown][Space]')

      await waitFor(() => expect(bookmarkLabels()).toEqual(['Bravo', 'Alpha', 'Charlie']))
      await waitFor(() => expect(readBookmarkIds()).toEqual(['X', 'B', 'A', 'C']))
      // Only Alpha was written.
      expect(held.get('A')).toBe(3.5)
      // Announced by title: dnd-kit's default reads the id (#2943).
      expect(screen.getByRole('status')).toHaveTextContent('Alpha dropped over Bravo.')
      expect(useTabsStore.getState().tabs[0]?.pageStack).toEqual([])

      unmount()
      renderSection()
      expect(bookmarkLabels()).toEqual(['Bravo', 'Alpha', 'Charlie'])
    })

    it('still opens the page on Enter', async () => {
      const user = userEvent.setup()
      bookmark([
        { id: 'A', title: 'Alpha' },
        { id: 'B', title: 'Bravo' },
      ])

      renderSection()
      screen.getByRole('button', { name: 'Alpha' }).focus()
      await user.keyboard('{Enter}')

      const tab = useTabsStore.getState().tabs[0]
      expect(tab?.pageStack.at(-1)).toMatchObject({ pageId: 'A', title: 'Alpha' })
      expect(readBookmarkIds()).toEqual(['A', 'B'])
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
