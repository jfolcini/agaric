/**
 * Tests for the header's Back / Forward history (`navigation-history`).
 *
 * The recorder runs on a microtask, so each step awaits `settle()` before the
 * next, the way separate user actions are separated in the app.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { useJournalStore } from '@/stores/journal'
import { MAX_NAV_HISTORY, selectNavHistory, useNavigationStore } from '@/stores/navigation'
import { navigateBack, navigateForward } from '@/stores/navigation-history'
import { useResolveStore } from '@/stores/resolve'
import { LEGACY_SPACE_KEY, useSpaceStore } from '@/stores/space'
import { resetTabIdCounter, useTabsStore } from '@/stores/tabs'

function settle(): Promise<void> {
  return Promise.resolve()
}

function history(space: string = LEGACY_SPACE_KEY) {
  return selectNavHistory(useNavigationStore.getState(), space)
}

function view() {
  return useNavigationStore.getState().currentView
}

function topPageId(): string | undefined {
  const { tabs, activeTabIndex } = useTabsStore.getState()
  return tabs[activeTabIndex]?.pageStack.at(-1)?.pageId
}

beforeEach(async () => {
  resetTabIdCounter()
  useSpaceStore.setState({ currentSpaceId: null })
  useResolveStore.setState({ cache: new Map() })
  useJournalStore.setState({ mode: 'daily', currentDate: new Date(2026, 3, 20) })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    tabsBySpace: {},
    activeTabIndexBySpace: {},
  })
  useNavigationStore.setState({
    currentView: 'journal',
    currentViewBySpace: {},
    selectedBlockId: null,
    navHistoryBySpace: {},
  })
  await settle()
})

describe('navigation history', () => {
  it('records the starting screen, then one entry per user action', async () => {
    useTabsStore.getState().navigateToPage('P1', 'One')
    await settle()

    // navigateToPage writes the tabs store, then the navigation store: one step.
    expect(history().entries).toEqual([
      { kind: 'journal', mode: 'daily', date: '2026-04-20' },
      { kind: 'page', tabId: '0', pageId: 'P1', title: 'One' },
    ])
    expect(history().index).toBe(1)
  })

  it('goes Back and Forward across views, pages and journal days', async () => {
    useJournalStore.getState().setCurrentDate(new Date(2026, 3, 19))
    await settle()
    useTabsStore.getState().navigateToPage('P1', 'One')
    await settle()
    useNavigationStore.getState().setView('settings')
    await settle()

    navigateBack()
    await settle()
    expect(view()).toBe('page-editor')
    expect(topPageId()).toBe('P1')

    navigateBack()
    await settle()
    expect(view()).toBe('journal')
    expect(useJournalStore.getState().currentDate).toEqual(new Date(2026, 3, 19))

    navigateBack()
    await settle()
    expect(useJournalStore.getState().currentDate).toEqual(new Date(2026, 3, 20))
    expect(history().index).toBe(0)

    navigateForward()
    await settle()
    navigateForward()
    await settle()
    navigateForward()
    await settle()
    expect(view()).toBe('settings')
    expect(history().index).toBe(3)
    expect(history().entries).toHaveLength(4)
  })

  it('a new step after going Back drops the Forward entries', async () => {
    useNavigationStore.getState().setView('settings')
    await settle()
    useNavigationStore.getState().setView('pages')
    await settle()

    navigateBack()
    await settle()
    useNavigationStore.getState().setView('tags')
    await settle()

    expect(history().entries.map((e) => (e.kind === 'view' ? e.view : e.kind))).toEqual([
      'journal',
      'settings',
      'tags',
    ])
    navigateForward()
    await settle()
    expect(view()).toBe('tags')
  })

  it('treats the same week as one step in week view', async () => {
    useJournalStore.getState().navigateToDate(new Date(2026, 3, 20), 'weekly')
    await settle()
    const before = history().entries.length
    useJournalStore.getState().setCurrentDate(new Date(2026, 3, 22))
    await settle()

    expect(history().entries).toHaveLength(before)
  })

  it('returns to a page in the tab it was opened in', async () => {
    useTabsStore.getState().navigateToPage('P1', 'One')
    await settle()
    useTabsStore.getState().openInNewTab('P2', 'Two')
    await settle()

    navigateBack()
    await settle()

    const { tabs, activeTabIndex } = useTabsStore.getState()
    expect(tabs[activeTabIndex]?.id).toBe('0')
    expect(topPageId()).toBe('P1')
    expect(tabs).toHaveLength(2)
  })

  it('reopens a page whose tab was closed without losing the Forward half', async () => {
    useTabsStore.getState().openInNewTab('P1', 'One')
    await settle()
    useNavigationStore.getState().setView('settings')
    await settle()
    useTabsStore.getState().closeTab(1)
    useNavigationStore.getState().setView('settings')
    await settle()

    navigateBack()
    await settle()

    expect(view()).toBe('page-editor')
    expect(topPageId()).toBe('P1')
    // Forward still leads to Settings: the replay replaced its entry rather
    // than pushing a new one over the rest of the list.
    navigateForward()
    await settle()
    expect(view()).toBe('settings')
  })

  it('steps over a page that has since been deleted', async () => {
    useNavigationStore.getState().setView('settings')
    await settle()
    useTabsStore.getState().navigateToPage('P1', 'One')
    await settle()
    useNavigationStore.getState().setView('pages')
    await settle()
    useResolveStore.getState().set('P1', 'One', true)

    navigateBack()
    await settle()

    expect(view()).toBe('settings')
  })

  it('keeps a separate history per space', async () => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
    await settle()
    useNavigationStore.getState().setView('settings')
    await settle()
    useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
    await settle()
    useNavigationStore.getState().setView('tags')
    await settle()
    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
    await settle()

    navigateBack()
    await settle()

    // SPACE_A's history knows nothing of SPACE_B's Tags visit.
    expect(history('SPACE_A').entries.some((e) => e.kind === 'view' && e.view === 'tags')).toBe(
      false,
    )
    expect(history('SPACE_B').entries.some((e) => e.kind === 'view' && e.view === 'tags')).toBe(
      true,
    )
  })

  // A space switch rewrites every per-space store one after another; read
  // before they settle, the new space's history would get the old space's
  // journal day.
  it('records a space switch once, after every store has switched', async () => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
    await settle()
    useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
    await settle()
    useNavigationStore.getState().setView('journal')
    useJournalStore.getState().navigateToDate(new Date(2026, 3, 10), 'daily')
    await settle()

    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
    await settle()

    const dates = history('SPACE_A').entries.map((e) => (e.kind === 'journal' ? e.date : e.kind))
    expect(dates).toHaveLength(1)
    expect(dates).not.toContain('2026-04-10')
  })

  it('caps the list at MAX_NAV_HISTORY, dropping the oldest', async () => {
    for (let i = 0; i <= MAX_NAV_HISTORY; i++) {
      useNavigationStore.getState().setView(i % 2 === 0 ? 'settings' : 'tags')
      await settle()
    }

    expect(history().entries).toHaveLength(MAX_NAV_HISTORY)
    expect(history().index).toBe(MAX_NAV_HISTORY - 1)
    expect(history().entries[0]).not.toEqual({ kind: 'journal', mode: 'daily', date: '2026-04-20' })
  })

  it('does nothing past either end', async () => {
    navigateBack()
    await settle()
    expect(view()).toBe('journal')
    expect(history().index).toBe(0)

    navigateForward()
    await settle()
    expect(history().index).toBe(0)
  })
})
