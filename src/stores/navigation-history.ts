/**
 * Navigation history — the header's browser-style Back / Forward.
 *
 * Records a `NavLocation` whenever the place on screen changes: the view, the
 * page on top of the active tab, or the journal's mode and period. Recording
 * waits for a microtask, so one user action that writes several stores
 * (opening a page writes tabs then navigation; switching space rewrites every
 * per-space store) lands as ONE entry, read after the stores have settled.
 *
 * Back / Forward move the index, then replay the location. The recorder then
 * finds the screen equal to the current entry and records nothing. A replay
 * that lands somewhere slightly different (the tab was closed, so the page
 * opened in the active one) REPLACES the current entry instead of pushing, so
 * it cannot cut off the forward half of the list.
 *
 * Cross-store like `page-rename`: it reads navigation, tabs, journal, space
 * and resolve, and keeps its state in `useNavigationStore.navHistoryBySpace`.
 */

import { format } from 'date-fns'

import { activeSpaceKey } from '@/lib/active-space'
import { getWeekRange } from '@/lib/date-utils'
import { type JournalMode, parseISODate, useJournalStore } from '@/stores/journal'
import {
  MAX_NAV_HISTORY,
  type NavHistory,
  type NavLocation,
  selectNavHistory,
  useNavigationStore,
} from '@/stores/navigation'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

/** The first day of the journal period `date` falls in; agenda and stream have none. */
function periodStart(mode: JournalMode, date: Date): string {
  if (mode === 'daily') return format(date, 'yyyy-MM-dd')
  if (mode === 'weekly') return format(getWeekRange(date).start, 'yyyy-MM-dd')
  if (mode === 'monthly') return format(date, 'yyyy-MM-01')
  return ''
}

/** Where the user is now, or `null` for the page editor with nothing open. */
function currentNavLocation(): NavLocation | null {
  const view = useNavigationStore.getState().currentView
  if (view === 'journal') {
    const { mode, currentDate } = useJournalStore.getState()
    return { kind: 'journal', mode, date: periodStart(mode, currentDate) }
  }
  if (view === 'page-editor') {
    const { tabs, activeTabIndex } = useTabsStore.getState()
    const tab = tabs[activeTabIndex]
    const top = tab?.pageStack.at(-1)
    if (tab === undefined || top === undefined) return null
    return { kind: 'page', tabId: tab.id, pageId: top.pageId, title: top.title }
  }
  return { kind: 'view', view }
}

function sameLocation(a: NavLocation, b: NavLocation): boolean {
  switch (a.kind) {
    case 'journal': {
      return b.kind === 'journal' && a.mode === b.mode && a.date === b.date
    }
    case 'page': {
      return b.kind === 'page' && a.tabId === b.tabId && a.pageId === b.pageId
    }
    case 'view': {
      return b.kind === 'view' && a.view === b.view
    }
  }
}

/** Set by a replay or `recordNextAsReplace`; the next record replaces instead of pushing. */
let replaying = false

/** The next location recorded replaces the current entry instead of pushing a new one. */
export function recordNextAsReplace(): void {
  replaying = true
}

function record(): void {
  const loc = currentNavLocation()
  const wasReplay = replaying
  replaying = false
  if (loc === null) return
  const space = activeSpaceKey()
  const nav = useNavigationStore.getState()
  const { entries, index } = selectNavHistory(nav, space)
  const current = entries[index]
  if (current !== undefined && sameLocation(current, loc)) return
  if (wasReplay && current !== undefined) {
    const replaced = [...entries]
    replaced[index] = loc
    nav.setNavHistory(space, { entries: replaced, index })
    return
  }
  const pushed = [...entries.slice(0, index + 1), loc].slice(-MAX_NAV_HISTORY)
  nav.setNavHistory(space, { entries: pushed, index: pushed.length - 1 })
}

let recordScheduled = false

function scheduleRecord(): void {
  if (recordScheduled) return
  recordScheduled = true
  queueMicrotask(() => {
    recordScheduled = false
    record()
  })
}

function isDeletedPage(loc: NavLocation): boolean {
  if (loc.kind !== 'page') return false
  const resolve = useResolveStore.getState()
  return resolve.has(loc.pageId) && resolve.resolveStatus(loc.pageId) === 'deleted'
}

function replayPage(loc: Extract<NavLocation, { kind: 'page' }>): void {
  const tabsStore = useTabsStore.getState()
  const tabIndex = tabsStore.tabs.findIndex((tab) => tab.id === loc.tabId)
  if (tabIndex !== -1) tabsStore.switchTab(tabIndex)
  const { tabs, activeTabIndex } = useTabsStore.getState()
  const stack = tabs[activeTabIndex]?.pageStack ?? []
  if (stack.at(-1)?.pageId === loc.pageId) {
    useNavigationStore.getState().setView('page-editor')
    return
  }
  // Back to the page below the top pops, as the tab's own Back does; pushing
  // would grow the stack, and reorder the recents, on every step.
  if (stack.at(-2)?.pageId === loc.pageId) {
    useTabsStore.getState().goBack()
    useNavigationStore.getState().setView('page-editor')
    return
  }
  // Forward to a page Back popped, a page deeper in the stack, or one whose
  // tab was closed: open it in the active tab, under its current title in
  // case it was renamed since.
  const resolve = useResolveStore.getState()
  const title = resolve.has(loc.pageId) ? resolve.resolveTitle(loc.pageId) : loc.title
  useTabsStore.getState().navigateToPage(loc.pageId, title)
}

function replay(loc: NavLocation): void {
  switch (loc.kind) {
    case 'journal': {
      const journal = useJournalStore.getState()
      const date = parseISODate(loc.date)
      if (date === null) journal.setMode(loc.mode)
      else journal.navigateToDate(date, loc.mode)
      useNavigationStore.getState().setView('journal')
      return
    }
    case 'page': {
      replayPage(loc)
      return
    }
    case 'view': {
      useNavigationStore.getState().setView(loc.view)
    }
  }
}

/** The index Back (-1) or Forward (1) lands on, or `-1` when there is none. */
function stepTarget({ entries, index }: NavHistory, delta: -1 | 1): number {
  let target = index + delta
  // A deleted page would open as a dead editor; step over it.
  while (entries[target] !== undefined && isDeletedPage(entries[target] as NavLocation)) {
    target += delta
  }
  return entries[target] === undefined ? -1 : target
}

function step(delta: -1 | 1): void {
  const space = activeSpaceKey()
  const nav = useNavigationStore.getState()
  const history = selectNavHistory(nav, space)
  const target = stepTarget(history, delta)
  const loc = history.entries[target]
  if (loc === undefined) return
  replaying = true
  nav.setNavHistory(space, { entries: history.entries, index: target })
  replay(loc)
}

export function navigateBack(): void {
  step(-1)
}

export function navigateForward(): void {
  step(1)
}

/** Whether Back (-1) or Forward (1) has somewhere to go in `history`. */
export function canStep(history: NavHistory, delta: -1 | 1): boolean {
  return stepTarget(history, delta) !== -1
}

/** Whether Back has somewhere to go in the active space. */
export function canNavigateBack(): boolean {
  return canStep(selectNavHistory(useNavigationStore.getState(), activeSpaceKey()), -1)
}

useNavigationStore.subscribe(scheduleRecord)
useTabsStore.subscribe(scheduleRecord)
useJournalStore.subscribe(scheduleRecord)
useSpaceStore.subscribe(scheduleRecord)
scheduleRecord()
