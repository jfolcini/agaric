/**
 * #3322 — the page-title fan-out.
 *
 * A page title is denormalised into three stores: the resolve cache
 * (`resolve.ts`, which calls itself the single source of truth), the tab
 * stacks (`tabs.ts`, persisted) and the recents MRU (`recent-pages.ts`, also
 * persisted). Every rename call site used to update the first two and forget
 * the third, so the recents strip kept the OLD title — and because the strip
 * passes that title straight back into `navigateToPage(pageId, title)`, one
 * click resurrected the stale title in the tab bar, persisted, across
 * restarts, while `PageHeader` rendered the new one.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { renamePage } from '@/stores/page-rename'
import { selectRecentPagesForSpace, useRecentPagesStore } from '@/stores/recent-pages'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, useTabsStore } from '@/stores/tabs'

const SPACE = 'SPACE_TEST'
const PAGE = 'PAGE_P'

describe('renamePage fan-out', () => {
  beforeEach(() => {
    useSpaceStore.setState({
      currentSpaceId: SPACE,
      availableSpaces: [{ id: SPACE, name: 'Test', accent_color: null }],
      isReady: true,
    })
    useRecentPagesStore.setState({
      recentPages: [],
      recentPagesBySpace: {},
      rawKeysMerged: true,
    })
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [], label: '' }],
      activeTabIndex: 0,
      tabsBySpace: {},
      activeTabIndexBySpace: {},
    })
    useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
  })

  it('updates the tab stack, the recents MRU and the resolve cache together', () => {
    useTabsStore.getState().navigateToPage(PAGE, 'Old')
    expect(selectRecentPagesForSpace(useRecentPagesStore.getState(), SPACE)[0]?.title).toBe('Old')

    renamePage(PAGE, 'New', SPACE)

    expect(selectPageStack(useTabsStore.getState()).at(-1)).toEqual({
      pageId: PAGE,
      title: 'New',
    })
    expect(useTabsStore.getState().tabs[0]?.label).toBe('New')
    expect(selectRecentPagesForSpace(useRecentPagesStore.getState(), SPACE)[0]?.title).toBe('New')
    expect(useResolveStore.getState().resolveTitle(PAGE)).toBe('New')
  })

  // The issue's reproduction, end to end: navigate away, then click the page's
  // chip in the recents strip (`QuickAccessBar` calls
  // `navigateToPage(item.pageId, item.title)` with the title it read out of
  // the recents entry). With a stale recents title this re-stamped "Old" onto
  // the tab and back into the MRU.
  it('survives a round-trip through the recents strip', () => {
    const tabs = useTabsStore.getState()
    tabs.navigateToPage(PAGE, 'Old')
    renamePage(PAGE, 'New', SPACE)
    tabs.navigateToPage('OTHER_PAGE', 'Other')

    const chip = selectRecentPagesForSpace(useRecentPagesStore.getState(), SPACE).find(
      (p) => p.pageId === PAGE,
    )
    expect(chip?.title).toBe('New')

    useTabsStore.getState().navigateToPage(PAGE, chip?.title ?? '')

    expect(selectPageStack(useTabsStore.getState()).at(-1)).toEqual({
      pageId: PAGE,
      title: 'New',
    })
    expect(useTabsStore.getState().tabs[0]?.label).toBe('New')
    expect(selectRecentPagesForSpace(useRecentPagesStore.getState(), SPACE)[0]?.title).toBe('New')
  })

  it('retitles the page in a background tab, not just the active one', () => {
    const tabs = useTabsStore.getState()
    tabs.navigateToPage(PAGE, 'Old')
    tabs.openInNewTab('OTHER_PAGE', 'Other')

    renamePage(PAGE, 'New', SPACE)

    const state = useTabsStore.getState()
    expect(state.activeTabIndex).toBe(1)
    expect(state.tabs[0]?.pageStack.at(-1)).toEqual({ pageId: PAGE, title: 'New' })
    expect(state.tabs[0]?.label).toBe('New')
  })
})
