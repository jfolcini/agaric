/**
 * Tabs store: per-tab page stacks and the active-tab pointer, one tab active
 * at a time. Tabs are partitioned by space (`tabsBySpace`,
 * `activeTabIndexBySpace`); the flat `tabs` / `activeTabIndex` mirror the
 * active space and serve when no space is active. Read through
 * `selectTabsForSpace` so a tab opened in one space never shows in another.
 *
 * Coupling is one-way: tab actions call the navigation store's `setView`, and
 * the navigation store never calls back into this one.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { isDateFormattedPage } from '@/lib/date-utils'
import { logger } from '@/lib/logger'
import { parseDate } from '@/lib/parse-date'
import { safePersistStorage } from '@/lib/safe-persist-storage'
import { activeSpaceKey } from '@/stores/active-space'
import { createPerSpaceSlice } from '@/stores/createPerSpaceSlice'
import { useJournalStore } from '@/stores/journal'
import { coerceView, useNavigationStore } from '@/stores/navigation'
import { useRecentPagesStore } from '@/stores/recent-pages'
import type { View } from '@/types/view'

export interface PageEntry {
  pageId: string
  title: string
}

export interface Tab {
  id: string
  pageStack: PageEntry[]
  label: string
  /**
   * The view the stack was entered from, where `goBack` returns once it pops
   * the stack empty. Recorded by `navigateToPage`, `openInNewTab` and
   * `switchTab` whenever they enter from a non-editor view, a re-open of the
   * top page included (#4707, #4732); consumed by `goBack`. Undefined means
   * unknown, which falls back to `DEFAULT_PAGE_EXIT_VIEW`. One slot only: the
   * header's Back / Forward history lives in `navigation-history`.
   */
  enteredFrom?: View | undefined
  /**
   * The block a background tab was opened on (`openInBackgroundTab`), shown
   * once the tab comes to the front: `enterTab` hands it to the navigation
   * store's one-shot `selectedBlockId` and takes it off the tab.
   */
  blockId?: string | undefined
}

// Module-scoped: the renderer is single-threaded, and keeping it in state
// would need persistence and rehydrate handling for nothing.
let nextTabId = 1

/**
 * Per-tab page-stack cap (#754). Each hop pushes an entry (A → B → A is three),
 * so Back retraces every step like browser history; past the cap the oldest
 * entry drops, bounding the persisted `agaric:tabs` blob.
 */
export const MAX_PAGE_STACK_DEPTH = 50

/** A closed tab, kept for `reopenClosedTab`: its stack, its place, and the space it was in. */
export interface ClosedTab {
  tab: Tab
  index: number
  spaceKey: string
}

/** How many closed tabs `reopenClosedTab` can bring back; the oldest drops first. */
export const MAX_CLOSED_TABS = 20

/**
 * Where leaving the page editor lands when the tab has no `enteredFrom`. The
 * one fallback for both `goBack` and Android back (through `exitViewForTab`),
 * so the two affordances cannot disagree.
 */
export const DEFAULT_PAGE_EXIT_VIEW: View = 'pages'

/**
 * The view to show when `tab`'s stack is left: the route it was opened from,
 * else `DEFAULT_PAGE_EXIT_VIEW`. Never `page-editor`, the view being left.
 */
export function exitViewForTab(tab: Tab | undefined): View {
  const entered = tab?.enteredFrom
  return entered !== undefined && entered !== 'page-editor' ? entered : DEFAULT_PAGE_EXIT_VIEW
}

interface TabsStore {
  /**
   * The active space's tabs, mirroring `tabsBySpace[currentSpaceId]`; also the
   * list when no space is active. Use `selectTabsForSpace` for per-space reads.
   */
  tabs: Tab[]
  /** Active-space active tab index — mirrors `activeTabIndexBySpace[currentSpaceId]`. */
  activeTabIndex: number
  /** Per-space tab lists. Keyed by space id, with `__legacy__` for the no-space slice. */
  tabsBySpace: Record<string, Tab[]>
  /** Per-space active-tab indices. Keyed identically to `tabsBySpace`. */
  activeTabIndexBySpace: Record<string, number>
  /**
   * Tabs `closeTab` closed, newest last. Not persisted, so each window keeps
   * its own for the session, as a browser does.
   */
  closedTabs: ClosedTab[]

  /** Push a page onto the active tab's stack and switch to page-editor. */
  navigateToPage: (pageId: string, title: string, blockId?: string) => void
  /** Pop the active tab's top page; an emptied stack closes the tab, or on the last tab leaves the editor. */
  goBack: () => void
  /**
   * Retitle every stack entry naming `pageId` in every tab of the active space
   * (#3322). Prefer `renamePage` in `@/stores/page-rename`, which also updates
   * recents and the resolve cache.
   */
  renamePage: (pageId: string, title: string) => void
  /**
   * Drop every stack entry naming one of `pageIds` (just trashed, or moved out of the space) from
   * every tab of the active space. A tab left empty closes; when none is left, the editor is left
   * the way `goBack` leaves it on the last tab. No-op when no tab holds any of them.
   */
  removePages: (pageIds: readonly string[]) => void
  /** Open a page in a new tab and switch to it. */
  openInNewTab: (pageId: string, title: string) => void
  /**
   * Open a page in a new tab behind the active one, leaving the view and active tab as they
   * are; `blockId` takes the cursor once the tab is brought to the front.
   */
  openInBackgroundTab: (pageId: string, title: string, blockId?: string) => void
  /** Close a tab by index. If last tab closed, switch to 'pages' view. */
  closeTab: (tabIndex: number) => void
  /** Reopen the active space's last closed tab at its old place, and switch to it. */
  reopenClosedTab: () => void
  /**
   * Switch to a tab by index; from a non-editor view this also shows the
   * page editor, since the TabBar is visible from every view.
   */
  switchTab: (tabIndex: number) => void
  /** Move the tab at `from` to `to`, shifting the tabs between; the active tab stays active. */
  moveTab: (from: number, to: number) => void
}

type TabsState = TabsStore

/** Selector: the active tab's page stack. */
export function selectPageStack(state: TabsStore): PageEntry[] {
  return state.tabs[state.activeTabIndex]?.pageStack ?? []
}

/**
 * The tab list for `spaceId`, falling back to the flat `state.tabs` mirror
 * when the slice is missing, so a partial `setState({ tabs })` (tests) still
 * renders.
 */
export function selectTabsForSpace(state: TabsState, spaceId: string | null): Tab[] {
  if (spaceId == null) return state.tabs
  return state.tabsBySpace[spaceId] ?? state.tabs
}

/** Per-space active-tab-index selector. Mirrors `selectTabsForSpace`. */
export function selectActiveTabIndexForSpace(state: TabsState, spaceId: string | null): number {
  if (spaceId == null) return state.activeTabIndex
  return state.activeTabIndexBySpace[spaceId] ?? state.activeTabIndex
}

/** Default tab list: a single empty tab. */
function emptyTabList(): Tab[] {
  return [{ id: '0', pageStack: [], label: '' }]
}

function tabLabel(stack: PageEntry[]): string {
  const top = stack.at(-1)
  return top?.title ?? ''
}

/**
 * A `YYYY-MM-DD` title as a local-time `Date`, or `null` when it is not one or
 * names an impossible date (`2026-13-45`).
 */
function parseDateTitleToLocalDate(title: string): Date | null {
  if (!isDateFormattedPage(title)) return null
  const parsed = parseDate(title)
  if (parsed === null) return null
  const parts = parsed.split('-')
  if (parts.length !== 3) return null
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])
  const date = new Date(year, month - 1, day)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * The active space's tabs and index for an action. Reads the flat mirror,
 * which every action and the space-switch subscriber keep current, so a
 * partial `setState({ tabs })` (tests) drives the next action instead of a
 * stale per-space slice.
 */
function readActiveSlice(state: TabsState): { tabs: Tab[]; activeTabIndex: number } {
  const tabs = state.tabs ?? emptyTabList()
  // Clamp on read, so a persisted index past the end self-heals (#1608).
  const activeTabIndex = clampIndex(state.activeTabIndex ?? 0, tabs.length)
  return { tabs, activeTabIndex }
}

/** The per-space unit tabs partitions: a tab list plus its active-tab pointer. */
interface TabSlice {
  tabs: Tab[]
  activeTabIndex: number
}

/**
 * Per-space slice of the coupled `{ tabs, activeTabIndex }` pair. `onSwitch`
 * clears the navigation store's `selectedBlockId`, so a highlight from the
 * previous space's tab does not carry over.
 */
const tabsSlice = createPerSpaceSlice<TabsState, TabSlice>({
  readMirror: (state) => ({ tabs: state.tabs, activeTabIndex: state.activeTabIndex }),
  writeMirror: (value) => ({ tabs: value.tabs, activeTabIndex: value.activeTabIndex }),
  getSlice: (state, key) => {
    const tabs = state.tabsBySpace[key]
    if (tabs === undefined) return undefined
    return { tabs, activeTabIndex: state.activeTabIndexBySpace[key] ?? 0 }
  },
  setSlice: (state, key, value) => ({
    tabsBySpace: { ...state.tabsBySpace, [key]: value.tabs },
    activeTabIndexBySpace: { ...state.activeTabIndexBySpace, [key]: value.activeTabIndex },
  }),
  fallback: () => ({ tabs: emptyTabList(), activeTabIndex: 0 }),
  onSwitch: () => {
    useNavigationStore.setState({ selectedBlockId: null })
  },
})

/** Next state updating the per-space slice and the flat mirror together. */
function spliceTabs(state: TabsState, tabs: Tab[], activeTabIndex: number): Partial<TabsState> {
  return tabsSlice.applyActive(state, { tabs, activeTabIndex })
}

/** The navigation store's `setView`; synchronous. */
function setNavigationView(view: View): void {
  useNavigationStore.getState().setView(view)
}

/**
 * The `enteredFrom` a tab carries after a page push (#4287). A push from inside
 * the editor is a step within the stack and keeps its origin; any other push
 * records the current view. No "empty stack only" guard: leaving the editor
 * does not clear the stack, so such a guard almost never recorded (#4707).
 */
function nextEnteredFrom(tab: Tab): View | undefined {
  return currentEntryView() ?? tab.enteredFrom
}

/**
 * `tabs` with `tabs[index]`'s origin set to `entered`, or the same array when
 * unchanged, so the caller can skip `set()` and not re-render
 * `selectPageStack` subscribers for nothing (#4732).
 */
function withRecordedOrigin(
  tabs: Tab[],
  index: number,
  tab: Tab,
  entered: View | undefined,
): Tab[] {
  if (entered === tab.enteredFrom) return tabs
  const next = [...tabs]
  next[index] = { ...tab, enteredFrom: entered }
  return next
}

/** The current view as a recordable origin; `undefined` for `page-editor`. */
function currentEntryView(): View | undefined {
  const view = useNavigationStore.getState().currentView
  return view === 'page-editor' ? undefined : view
}

function setNavigationSelectedBlockId(id: string | null): void {
  useNavigationStore.setState({ selectedBlockId: id })
}

/**
 * `tabs` with `tabs[index]` brought to the front: its `blockId`, if a
 * background open left one, becomes `selectedBlockId` and leaves the tab.
 */
function enterTab(tabs: Tab[], index: number): Tab[] {
  const tab = tabs[index]
  setNavigationSelectedBlockId(tab?.blockId ?? null)
  return tab?.blockId === undefined ? tabs : tabs.with(index, { ...tab, blockId: undefined })
}

/**
 * Coerce a persisted value into a valid `Tab`, or `null`: `localStorage` can
 * hold anything, and a bare cast lets a malformed blob crash the reducers.
 */
function coerceTab(raw: unknown): Tab | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj['id'] !== 'string') return null
  const pageStack: PageEntry[] = []
  if (Array.isArray(obj['pageStack'])) {
    for (const entry of obj['pageStack']) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      if (typeof e['pageId'] !== 'string' || typeof e['title'] !== 'string') continue
      pageStack.push({ pageId: e['pageId'], title: e['title'] })
    }
  }
  // `enteredFrom` reaches `setView`, so only a real `View` may pass.
  const enteredFrom = coerceView(obj['enteredFrom'])
  return {
    id: obj['id'],
    pageStack,
    label: typeof obj['label'] === 'string' ? obj['label'] : '',
    ...(enteredFrom === null ? {} : { enteredFrom }),
  }
}

/** Coerce a persisted value into a `Tab[]`, dropping invalid tabs. */
function coerceTabList(raw: unknown): Tab[] {
  if (!Array.isArray(raw)) return emptyTabList()
  const tabs: Tab[] = []
  for (const item of raw) {
    const tab = coerceTab(item)
    if (tab) tabs.push(tab)
  }
  return tabs.length > 0 ? tabs : emptyTabList()
}

/** Coerce a persisted value into a `Record<string, Tab[]>`. */
function coerceTabsBySpace(raw: unknown): Record<string, Tab[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, Tab[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const tabs: Tab[] = []
    for (const item of value) {
      const tab = coerceTab(item)
      if (tab) tabs.push(tab)
    }
    if (tabs.length > 0) out[key] = tabs
  }
  return out
}

/** Coerce a persisted value into a non-negative integer tab index. */
function coerceIndex(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0
}

/**
 * Clamp a tab index into `[0, length - 1]` (0 when empty). A corrupt blob can
 * hold an in-range-looking index past the end of `tabs`, which turned every
 * page click into a silent no-op (#1608).
 */
function clampIndex(idx: number, length: number): number {
  if (length <= 0) return 0
  if (idx < 0) return 0
  return Math.min(idx, length - 1)
}

/** Coerce a persisted value into a `Record<string, number>`. */
function coerceIndexBySpace(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[key] = value
  }
  return out
}

/**
 * Coerce a whole persisted blob field by field. Both `migrate` and `merge` call
 * it: zustand runs `migrate` only on a version mismatch, so a corrupt blob with
 * the current version reaches `merge` raw (#823). Idempotent.
 */
function coercePersistedTabs(
  persisted: unknown,
): Pick<TabsState, 'tabs' | 'activeTabIndex' | 'tabsBySpace' | 'activeTabIndexBySpace'> {
  const blob = (persisted != null && typeof persisted === 'object' ? persisted : {}) as Record<
    string,
    unknown
  >
  const tabs = coerceTabList(blob['tabs'])
  const tabsBySpace = coerceTabsBySpace(blob['tabsBySpace'])
  // Clamp each space's index against its own slice, or the flat list without one.
  const rawIndexBySpace = coerceIndexBySpace(blob['activeTabIndexBySpace'])
  const activeTabIndexBySpace: Record<string, number> = {}
  for (const [space, idx] of Object.entries(rawIndexBySpace)) {
    const slice = tabsBySpace[space] ?? tabs
    activeTabIndexBySpace[space] = clampIndex(idx, slice.length)
  }
  return {
    tabs,
    activeTabIndex: clampIndex(coerceIndex(blob['activeTabIndex']), tabs.length),
    tabsBySpace,
    activeTabIndexBySpace,
  }
}

/**
 * A completed page open: the `recent-pages` visit, and the device-local stamp
 * the Pages view's "Last opened" sort reads (#5371). The stamp is
 * fire-and-forget; a failed one only leaves that sort an open behind.
 */
function recordPageOpen(pageId: string, title: string): void {
  useRecentPagesStore.getState().recordVisit({ pageId, title })
  commands
    .recordPageOpen(pageId)
    .then(unwrap)
    .catch((err: unknown) => {
      logger.warn('tabs', 'record_page_open failed', { pageId }, err)
    })
}

export const useTabsStore = create<TabsStore>()(
  persist(
    (set, get) => ({
      tabs: emptyTabList(),
      activeTabIndex: 0,
      tabsBySpace: {},
      activeTabIndexBySpace: {},
      closedTabs: [],

      navigateToPage: (pageId: string, title: string, blockId?: string) => {
        // Several cross-store `set()`s in one tick are fine: React 19 batches
        // them into one render per subscriber, pinned by a test in
        // `src/stores/__tests__/navigation.test.ts`. An await between them
        // would break that.

        // Each branch records the visit only after its bail-outs, so an aborted
        // navigation leaves recents alone (#753). Date titles route to the
        // journal's daily view for every caller; an impossible date falls
        // through to the editor so the page stays reachable.
        const parsedDate = parseDateTitleToLocalDate(title)
        if (parsedDate !== null) {
          recordPageOpen(pageId, title)
          useJournalStore.getState().navigateToDate(parsedDate, 'daily')
          // The journal does not use the page stack. The day's editor reads
          // `selectedBlockId` on mount and clears it.
          setNavigationView('journal')
          setNavigationSelectedBlockId(blockId ?? null)
          return
        }

        const state = get()
        const { tabs, activeTabIndex } = readActiveSlice(state)
        const activeTab = tabs[activeTabIndex]
        if (!activeTab) return
        recordPageOpen(pageId, title)

        const pageStack = activeTab.pageStack
        const top = pageStack.at(-1)
        if (top?.pageId === pageId) {
          // Already on top: still show the editor, since the user may have left
          // for another view, but skip the `set()` when nothing changed so
          // `selectPageStack` subscribers do not re-render.
          const entered = nextEnteredFrom(activeTab)
          if (entered !== activeTab.enteredFrom) {
            const tabsWithOrigin = [...tabs]
            tabsWithOrigin[activeTabIndex] = { ...activeTab, enteredFrom: entered }
            set(spliceTabs(state, tabsWithOrigin, activeTabIndex))
          }
          setNavigationView('page-editor')
          setNavigationSelectedBlockId(blockId ?? null)
          return
        }

        const pushed = [...pageStack, { pageId, title }]
        const newStack =
          pushed.length > MAX_PAGE_STACK_DEPTH
            ? pushed.slice(pushed.length - MAX_PAGE_STACK_DEPTH)
            : pushed
        const newTabs = [...tabs]
        newTabs[activeTabIndex] = {
          ...activeTab,
          pageStack: newStack,
          label: tabLabel(newStack),
          // Read before `setNavigationView` below overwrites `currentView`.
          enteredFrom: nextEnteredFrom(activeTab),
        }
        set(spliceTabs(state, newTabs, activeTabIndex))
        setNavigationView('page-editor')
        setNavigationSelectedBlockId(blockId ?? null)
      },

      goBack: () => {
        const state = get()
        const { tabs, activeTabIndex } = readActiveSlice(state)
        const activeTab = tabs[activeTabIndex]
        const pageStack = activeTab?.pageStack ?? []
        if (pageStack.length === 0) return

        const newStack = pageStack.slice(0, -1)
        if (newStack.length === 0) {
          if (tabs.length > 1) {
            const newTabs = tabs.filter((_, i) => i !== activeTabIndex)
            const newIndex = Math.min(activeTabIndex, newTabs.length - 1)
            set(spliceTabs(state, enterTab(newTabs, newIndex), newIndex))
          } else {
            // Last tab: leave for the stack's origin (#4287), consuming it, so
            // the next stack opened in this tab records its own.
            const exitView = exitViewForTab(activeTab)
            const newTabs = [{ id: activeTab?.id ?? '0', pageStack: [], label: '' }]
            set(spliceTabs(state, newTabs, 0))
            setNavigationView(exitView)
            setNavigationSelectedBlockId(null)
          }
        } else {
          const newTabs = [...tabs]
          if (activeTab) {
            newTabs[activeTabIndex] = {
              ...activeTab,
              pageStack: newStack,
              label: tabLabel(newStack),
            }
          }
          set(spliceTabs(state, newTabs, activeTabIndex))
          setNavigationSelectedBlockId(null)
        }
      },

      renamePage: (pageId: string, title: string) => {
        const state = get()
        const { tabs, activeTabIndex } = readActiveSlice(state)

        // Match on pageId across every tab and depth: the same page can sit in
        // several stacks, and a rename must not touch an unrelated top entry.
        let changed = false
        const newTabs = tabs.map((tab) => {
          if (!tab.pageStack.some((entry) => entry.pageId === pageId && entry.title !== title)) {
            return tab
          }
          changed = true
          const newStack = tab.pageStack.map((entry) =>
            entry.pageId === pageId ? { pageId, title } : entry,
          )
          // Built field by field (`no-map-spread`): every `Tab` field must be
          // carried here, or a rename drops it.
          const renamed: Tab = { id: tab.id, pageStack: newStack, label: tabLabel(newStack) }
          if (tab.enteredFrom !== undefined) renamed.enteredFrom = tab.enteredFrom
          if (tab.blockId !== undefined) renamed.blockId = tab.blockId
          return renamed
        })
        if (!changed) return
        set(spliceTabs(state, newTabs, activeTabIndex))
      },

      removePages: (pageIds: readonly string[]) => {
        const removed = new Set(pageIds)
        const state = get()
        const { tabs, activeTabIndex } = readActiveSlice(state)
        let changed = false
        // The active tab's slot in `kept`: itself if it survives, else the tab that followed it.
        let keptActiveIndex = 0
        const kept: Tab[] = []
        for (const [i, tab] of tabs.entries()) {
          if (i === activeTabIndex) keptActiveIndex = kept.length
          if (!tab.pageStack.some((entry) => removed.has(entry.pageId))) {
            kept.push(tab)
            continue
          }
          changed = true
          const newStack = tab.pageStack.filter((entry) => !removed.has(entry.pageId))
          if (newStack.length > 0) {
            kept.push({ ...tab, pageStack: newStack, label: tabLabel(newStack) })
          }
        }
        if (!changed) return
        if (kept.length > 0) {
          const index = clampIndex(keptActiveIndex, kept.length)
          set(spliceTabs(state, enterTab(kept, index), index))
          return
        }
        setNavigationSelectedBlockId(null)
        const activeTab = tabs[activeTabIndex]
        set(spliceTabs(state, [{ id: activeTab?.id ?? '0', pageStack: [], label: '' }], 0))
        if (useNavigationStore.getState().currentView === 'page-editor') {
          setNavigationView(exitViewForTab(activeTab))
        }
      },

      openInNewTab: (pageId: string, title: string) => {
        const state = get()
        const { tabs } = readActiveSlice(state)
        const newStack: PageEntry[] = [{ pageId, title }]
        const newTab: Tab = {
          id: String(nextTabId++),
          pageStack: newStack,
          label: title,
          // A fresh stack records its own origin, read before `setNavigationView`.
          enteredFrom: currentEntryView(),
        }
        const newTabs = [...tabs, newTab]
        const newIndex = newTabs.length - 1
        set(spliceTabs(state, newTabs, newIndex))
        setNavigationView('page-editor')
        setNavigationSelectedBlockId(null)
      },

      openInBackgroundTab: (pageId: string, title: string, blockId?: string) => {
        const state = get()
        const { tabs, activeTabIndex } = readActiveSlice(state)
        // No `enteredFrom`: the tab is entered later through `switchTab`,
        // which records the route it is entered from.
        const newTab: Tab = {
          id: String(nextTabId++),
          pageStack: [{ pageId, title }],
          label: title,
          blockId,
        }
        set(spliceTabs(state, [...tabs, newTab], activeTabIndex))
      },

      closeTab: (tabIndex: number) => {
        const state = get()
        const { tabs, activeTabIndex } = readActiveSlice(state)
        if (tabIndex < 0 || tabIndex >= tabs.length) return
        const closing = tabs[tabIndex]
        const closedTabs =
          closing === undefined || closing.pageStack.length === 0
            ? state.closedTabs
            : [
                ...state.closedTabs,
                { tab: closing, index: tabIndex, spaceKey: activeSpaceKey() },
              ].slice(-MAX_CLOSED_TABS)

        if (tabs.length <= 1) {
          set({ ...spliceTabs(state, emptyTabList(), 0), closedTabs })
          setNavigationView('pages')
          setNavigationSelectedBlockId(null)
          return
        }

        const newTabs = tabs.filter((_, i) => i !== tabIndex)
        let newIndex: number
        if (tabIndex < activeTabIndex) {
          newIndex = activeTabIndex - 1
        } else if (tabIndex === activeTabIndex) {
          newIndex = Math.min(activeTabIndex, newTabs.length - 1)
        } else {
          newIndex = activeTabIndex
        }
        set({ ...spliceTabs(state, enterTab(newTabs, newIndex), newIndex), closedTabs })
      },

      reopenClosedTab: () => {
        const state = get()
        const spaceKey = activeSpaceKey()
        const at = state.closedTabs.findLastIndex((closed) => closed.spaceKey === spaceKey)
        const closed = state.closedTabs[at]
        if (closed === undefined) return
        const { tabs } = readActiveSlice(state)
        // Closing the last tab leaves one empty tab, which the reopened one replaces.
        const kept = tabs.length === 1 && tabs[0]?.pageStack.length === 0 ? [] : tabs
        const index = Math.min(closed.index, kept.length)
        // A fresh id: the old one may be in use again (the empty tab closing the last leaves is '0').
        const tab: Tab = {
          ...closed.tab,
          id: String(nextTabId++),
          enteredFrom: nextEnteredFrom(closed.tab),
        }
        set({
          ...spliceTabs(state, enterTab(kept.toSpliced(index, 0, tab), index), index),
          closedTabs: state.closedTabs.toSpliced(at, 1),
        })
        setNavigationView('page-editor')
      },

      switchTab: (tabIndex: number) => {
        const state = get()
        const { tabs, activeTabIndex } = readActiveSlice(state)
        if (tabIndex < 0 || tabIndex >= tabs.length) return
        const target = tabs[tabIndex]
        if (!target) return
        const inEditor = useNavigationStore.getState().currentView === 'page-editor'
        const sameTab = tabIndex === activeTabIndex
        if (sameTab && inEditor) return
        // A switch from a non-editor view enters the stack from that route, its
        // new origin (#4732); read before `setNavigationView` overwrites
        // `currentView`. From inside the editor the origin stays as it was.
        const entered = nextEnteredFrom(target)
        if (sameTab) {
          // Same tab from another view: show the editor; write only if the
          // origin changed.
          const withOrigin = withRecordedOrigin(tabs, tabIndex, target, entered)
          if (withOrigin !== tabs) set(spliceTabs(state, withOrigin, tabIndex))
          setNavigationView('page-editor')
          return
        }
        if (inEditor) {
          set(spliceTabs(state, enterTab(tabs, tabIndex), tabIndex))
          return
        }
        const withOrigin = withRecordedOrigin(tabs, tabIndex, target, entered)
        set(spliceTabs(state, enterTab(withOrigin, tabIndex), tabIndex))
        setNavigationView('page-editor')
      },

      moveTab: (from: number, to: number) => {
        const state = get()
        const { tabs, activeTabIndex } = readActiveSlice(state)
        const moving = tabs[from]
        if (moving === undefined || to < 0 || to >= tabs.length || from === to) return
        const active = tabs[activeTabIndex]
        const moved = tabs.toSpliced(from, 1).toSpliced(to, 0, moving)
        set(
          spliceTabs(
            state,
            moved,
            moved.findIndex((tab) => tab === active),
          ),
        )
      },
    }),
    {
      name: 'agaric:tabs',
      version: 1,
      storage: safePersistStorage,
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabIndex: state.activeTabIndex,
        tabsBySpace: state.tabsBySpace,
        activeTabIndexBySpace: state.activeTabIndexBySpace,
      }),
      // Both coerce: zustand calls `migrate` only on a version mismatch and
      // hands a same-version blob straight to `merge` (#823). Without
      // `migrate`, a version bump would discard every tab.
      migrate: (persisted, _version) => coercePersistedTabs(persisted),
      merge: (persisted, current) => ({
        ...current,
        ...coercePersistedTabs(persisted),
      }),
      onRehydrateStorage: () => (state) => {
        // Derive `nextTabId` from every persisted tab, all spaces included.
        if (!state) return
        const idStreams: Tab[][] = []
        if (Array.isArray(state.tabs)) idStreams.push(state.tabs)
        if (state.tabsBySpace) {
          for (const slice of Object.values(state.tabsBySpace)) {
            if (Array.isArray(slice)) idStreams.push(slice)
          }
        }
        const maxId = idStreams.flat().reduce((max, tab) => {
          const id = Number.parseInt(tab.id, 10)
          return Number.isNaN(id) ? max : Math.max(max, id)
        }, 0)
        nextTabId = maxId + 1
      },
    },
  ),
)

/** Reset the tab ID counter, for test determinism. */
export function resetTabIdCounter(): void {
  nextTabId = 1
}

/**
 * Swap the flat mirror with the per-space slice on every space switch. On
 * first fire an absent slice is seeded from the rehydrated flat tabs, so tabs
 * persisted before per-space slices survive.
 */
tabsSlice.attach(useTabsStore)
