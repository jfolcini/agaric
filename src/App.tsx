import { addDays, addMonths, addWeeks, subDays, subMonths, subWeeks } from 'date-fns'
import {
  Activity,
  Calendar,
  ChevronsLeft,
  FileText,
  GitMerge,
  History,
  Keyboard,
  LayoutTemplate,
  Moon,
  Network,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sun,
  Tag,
  Trash2,
  WifiOff,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BootGate } from './components/BootGate'
import { BugReportDialog } from './components/BugReportDialog'
import { FeatureErrorBoundary } from './components/FeatureErrorBoundary'
import { GlobalDateControls, JournalControls, JournalPage } from './components/JournalPage'
import { LoadingSkeleton } from './components/LoadingSkeleton'
import { QuickCaptureDialog } from './components/QuickCaptureDialog'
import { RecentPagesStrip } from './components/RecentPagesStrip'
import { SpaceSwitcher } from './components/SpaceSwitcher'
import { TabBar } from './components/TabBar'
import { ScrollArea } from './components/ui/scroll-area'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from './components/ui/sidebar'
import { Toaster } from './components/ui/sonner'
import { ViewHeaderOutletProvider, ViewHeaderOutletSlot } from './components/ViewHeaderOutlet'
import { useIsMobile } from './hooks/use-mobile'
import { useDeepLinkRouter } from './hooks/useDeepLinkRouter'
import { useItemCount } from './hooks/useItemCount'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { usePrimaryFocusRegistry } from './hooks/usePrimaryFocus'
import { useScrollRestore } from './hooks/useScrollRestore'
import { useSyncEvents } from './hooks/useSyncEvents'
import { useSyncTrigger } from './hooks/useSyncTrigger'
import { useTheme } from './hooks/useTheme'
import { useUndoShortcuts } from './hooks/useUndoShortcuts'
import { announce } from './lib/announcer'
import { BUG_REPORT_EVENT, type BugReportEventDetail } from './lib/bug-report-events'
import { formatRelativeTime } from './lib/format-relative-time'
import { matchesShortcutBinding } from './lib/keyboard-config'
import { logger } from './lib/logger'
import { CLOSE_ALL_OVERLAYS_EVENT } from './lib/overlay-events'
import { setPriorityLevels } from './lib/priority-levels'
import {
  loadQuickCaptureShortcut,
  QUICK_CAPTURE_SHORTCUT_STORAGE_KEY,
} from './lib/quick-capture-shortcut'
import {
  createPageInSpace,
  flushDraft,
  getConflicts,
  listBlocks,
  listDrafts,
  listPropertyDefs,
  registerGlobalShortcut,
  unregisterGlobalShortcut,
} from './lib/tauri'
import { cn } from './lib/utils'
import { type JournalMode, useJournalStore } from './stores/journal'
import { type PageEntry, selectPageStack, useNavigationStore, type View } from './stores/navigation'
import { useResolveStore } from './stores/resolve'
import { useSpaceStore } from './stores/space'
import { useSyncStore } from './stores/sync'

// ---------------------------------------------------------------------------
// Lazy-loaded views — PERF-24
// ---------------------------------------------------------------------------
//
// Only the journal (default view) and the sidebar/header shell are in the
// entry chunk. Every other top-level view is split into its own chunk and
// loaded on demand. Keeps the initial parse budget small — especially on
// Android / low-end hardware — without touching page-editor UX (the user
// always clicks _into_ a page, giving us a natural Suspense moment).
//
// Each lazy() import automatically becomes its own Rollup chunk. The
// Suspense fallback uses `LoadingSkeleton` (the shared primitive) so the
// transient state matches the rest of the app visually.
const ConflictList = lazy(() =>
  import('./components/ConflictList').then((m) => ({ default: m.ConflictList })),
)
const GraphView = lazy(() =>
  import('./components/GraphView').then((m) => ({ default: m.GraphView })),
)
const HistoryView = lazy(() =>
  import('./components/HistoryView').then((m) => ({ default: m.HistoryView })),
)
const KeyboardShortcuts = lazy(() =>
  import('./components/KeyboardShortcuts').then((m) => ({ default: m.KeyboardShortcuts })),
)
const PageBrowser = lazy(() =>
  import('./components/PageBrowser').then((m) => ({ default: m.PageBrowser })),
)
const PageEditor = lazy(() =>
  import('./components/PageEditor').then((m) => ({ default: m.PageEditor })),
)
const PropertiesView = lazy(() =>
  import('./components/PropertiesView').then((m) => ({ default: m.PropertiesView })),
)
const SearchPanel = lazy(() =>
  import('./components/SearchPanel').then((m) => ({ default: m.SearchPanel })),
)
const SettingsView = lazy(() =>
  import('./components/SettingsView').then((m) => ({ default: m.SettingsView })),
)
const StatusPanel = lazy(() =>
  import('./components/StatusPanel').then((m) => ({ default: m.StatusPanel })),
)
const TagFilterPanel = lazy(() =>
  import('./components/TagFilterPanel').then((m) => ({ default: m.TagFilterPanel })),
)
const TagList = lazy(() => import('./components/TagList').then((m) => ({ default: m.TagList })))
const TemplatesView = lazy(() =>
  import('./components/TemplatesView').then((m) => ({ default: m.TemplatesView })),
)
const TrashView = lazy(() =>
  import('./components/TrashView').then((m) => ({ default: m.TrashView })),
)
const WelcomeModal = lazy(() =>
  import('./components/WelcomeModal').then((m) => ({ default: m.WelcomeModal })),
)

// ---------------------------------------------------------------------------
// Keyboard shortcut dispatch tables
// ---------------------------------------------------------------------------

/** Returns true when the event target is an editable input/textarea/contentEditable. */
function isTypingInField(target: HTMLElement | null): boolean {
  if (!target) return false
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return true
  // Check both the IDL property (reflects inherited contenteditable) and
  // the attribute directly so jsdom-based tests that construct a bare
  // `<div contenteditable="true">` without a full document inheritance
  // chain still behave like the real browser. Matches the `?` global
  // listener in `KeyboardShortcuts.tsx`.
  if (target.isContentEditable) return true
  return target.getAttribute?.('contenteditable') === 'true'
}

/** Per-mode date shifters used by journal nav shortcuts. */
const JOURNAL_SHIFT_PREV: Record<JournalMode, (d: Date) => Date> = {
  daily: (d) => subDays(d, 1),
  weekly: (d) => subWeeks(d, 1),
  monthly: (d) => subMonths(d, 1),
  agenda: (d) => subMonths(d, 1),
}
const JOURNAL_SHIFT_NEXT: Record<JournalMode, (d: Date) => Date> = {
  daily: (d) => addDays(d, 1),
  weekly: (d) => addWeeks(d, 1),
  monthly: (d) => addMonths(d, 1),
  agenda: (d) => addMonths(d, 1),
}

interface JournalShortcut {
  /** Shortcut id routed through `matchesShortcutBinding`. */
  readonly binding: string
  /** Returns the next date for the current mode. */
  readonly nextDate: (current: Date, mode: JournalMode) => Date
  /** i18n key for the screen-reader announcement. */
  readonly announceKey: string
}

/**
 * Journal-view keyboard shortcuts. Same pattern as `KEY_RULES` in
 * `editor/use-block-keyboard.ts`: first match wins, keeps the dispatch
 * handler well under the cognitive-complexity budget.
 */
const JOURNAL_SHORTCUTS: ReadonlyArray<JournalShortcut> = [
  {
    binding: 'prevDayWeekMonth',
    nextDate: (d, mode) => JOURNAL_SHIFT_PREV[mode](d),
    announceKey: 'announce.navigatedToPrevious',
  },
  {
    binding: 'nextDayWeekMonth',
    nextDate: (d, mode) => JOURNAL_SHIFT_NEXT[mode](d),
    announceKey: 'announce.navigatedToNext',
  },
  {
    binding: 'goToToday',
    nextDate: () => new Date(),
    announceKey: 'announce.jumpedToToday',
  },
]

interface TabShortcut {
  /** Shortcut id routed through `matchesShortcutBinding`. */
  readonly binding: string
  /** Runs the action against the current navigation store snapshot. */
  readonly run: (state: ReturnType<typeof useNavigationStore.getState>) => void
}

/**
 * Tab-management keyboard shortcuts. `previousTab` (Ctrl+Shift+Tab) is listed
 * before `nextTab` (Ctrl+Tab) because the Shift+Tab binding is strictly more
 * specific — without the ordering the nextTab matcher would fire first and
 * Shift+Tab would be misrouted once the user rebound one of them.
 */
const TAB_SHORTCUTS: ReadonlyArray<TabShortcut> = [
  {
    binding: 'openInNewTab',
    run: (state) => {
      const activeTab = state.tabs[state.activeTabIndex]
      const top = activeTab?.pageStack[activeTab.pageStack.length - 1]
      if (top) {
        state.openInNewTab(top.pageId, top.title)
      }
    },
  },
  {
    binding: 'closeActiveTab',
    run: (state) => {
      state.closeTab(state.activeTabIndex)
    },
  },
  {
    binding: 'previousTab',
    run: (state) => {
      if (state.tabs.length <= 1) return
      const prev = state.activeTabIndex === 0 ? state.tabs.length - 1 : state.activeTabIndex - 1
      state.switchTab(prev)
    },
  },
  {
    binding: 'nextTab',
    run: (state) => {
      if (state.tabs.length <= 1) return
      const next = (state.activeTabIndex + 1) % state.tabs.length
      state.switchTab(next)
    },
  },
]

/** Sidebar nav items — page-editor is not listed here (it's navigated to programmatically). */
const NAV_ITEMS: { id: Exclude<View, 'page-editor'>; icon: React.ElementType; labelKey: string }[] =
  [
    { id: 'journal', icon: Calendar, labelKey: 'sidebar.journal' },
    { id: 'search', icon: Search, labelKey: 'sidebar.search' },
    { id: 'pages', icon: FileText, labelKey: 'sidebar.pages' },
    { id: 'tags', icon: Tag, labelKey: 'sidebar.tags' },
    { id: 'settings', icon: Settings, labelKey: 'sidebar.settings' },
    { id: 'trash', icon: Trash2, labelKey: 'sidebar.trash' },
    { id: 'status', icon: Activity, labelKey: 'sidebar.status' },
    { id: 'conflicts', icon: GitMerge, labelKey: 'sidebar.conflicts' },
    { id: 'history', icon: History, labelKey: 'sidebar.history' },
    { id: 'templates', icon: LayoutTemplate, labelKey: 'sidebar.templates' },
    { id: 'graph', icon: Network, labelKey: 'sidebar.graph' },
  ]

function CollapseButton() {
  const { t } = useTranslation()
  const { toggleSidebar } = useSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip={t('sidebar.toggleSidebar')} onClick={toggleSidebar}>
          <ChevronsLeft className="transition-transform group-data-[state=collapsed]:rotate-180" />
          <span>{t('sidebar.collapse')}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

/** Resolve the header label from the current navigation state. */
function useHeaderLabel(): string {
  const { t } = useTranslation()
  const currentView = useNavigationStore((s) => s.currentView)
  const pageStack = useNavigationStore(selectPageStack)
  // page-editor has its own editable title — don't duplicate it in the header
  if (currentView === 'page-editor' && pageStack.length > 0) {
    return ''
  }
  const item = NAV_ITEMS.find((item) => item.id === currentView)
  return item ? t(item.labelKey) : ''
}

/** Compute the CSS class for the sync status dot colour. */
function syncDotClass(syncState: string, hasPeers: boolean): string {
  if (!hasPeers) return 'bg-muted-foreground'
  switch (syncState) {
    case 'idle':
      return 'bg-sync-idle'
    case 'syncing':
    case 'discovering':
    case 'pairing':
      return 'bg-sync-active'
    case 'error':
      return 'bg-destructive'
    default:
      return 'bg-muted-foreground'
  }
}

/** Returns the number of unresolved conflicts. Polls every 30 s and on focus. */
function useConflictCount(): number {
  const currentView = useNavigationStore((s) => s.currentView)
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-poll when view changes (user may have resolved conflicts)
  const queryFn = useCallback(() => getConflicts({ limit: 100 }), [currentView])
  return useItemCount(queryFn, 30_000)
}

/** Returns the number of trashed items. Polls every 30 s and on focus. */
function useTrashCount(): number {
  const currentView = useNavigationStore((s) => s.currentView)
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-poll when view changes (user may have restored items)
  const queryFn = useCallback(() => listBlocks({ showDeleted: true, limit: 100 }), [currentView])
  return useItemCount(queryFn, 30_000)
}

/** Signature used by views that want to open another page. */
type PageSelectHandler = (pageId: string, title?: string, blockId?: string) => void

interface ViewRouterProps {
  currentView: View
  activePage: PageEntry | null
  onPageSelect: PageSelectHandler
  onBack: () => void
  navigateToPage: (pageId: string, title: string, blockId?: string) => void
}

/**
 * Shared Suspense fallback for lazy-loaded views. Matches the visual
 * language of other loading states (skeleton rows). `aria-busy` tells
 * assistive tech the region is mid-load.
 */
function ViewFallback() {
  return (
    <div className="space-y-2" aria-busy="true" role="status" data-testid="view-fallback">
      <LoadingSkeleton count={4} height="h-6" />
    </div>
  )
}

/**
 * Renders the main view body based on `currentView`. Extracted from `App`
 * so the parent component stays well under the cognitive-complexity budget
 * (MAINT-52). Each branch is a `FeatureErrorBoundary` so a crashed view
 * never unmounts the shell. Non-journal views are lazy-loaded (PERF-24);
 * the nested `Suspense` boundary shows a skeleton until the chunk arrives.
 */
function ViewRouter({
  currentView,
  activePage,
  onPageSelect,
  onBack,
  navigateToPage,
}: ViewRouterProps): React.ReactElement | null {
  switch (currentView) {
    case 'journal':
      return (
        <FeatureErrorBoundary name="Journal">
          <JournalPage onNavigateToPage={onPageSelect} />
        </FeatureErrorBoundary>
      )
    case 'search':
      return (
        <FeatureErrorBoundary name="Search">
          <Suspense fallback={<ViewFallback />}>
            <SearchPanel />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'pages':
      return (
        <FeatureErrorBoundary name="Pages">
          <Suspense fallback={<ViewFallback />}>
            <PageBrowser onPageSelect={onPageSelect} />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'tags':
      return (
        <FeatureErrorBoundary name="Tags">
          <Suspense fallback={<ViewFallback />}>
            <div className="space-y-8">
              <TagList onTagClick={(tagId, tagName) => navigateToPage(tagId, tagName)} />
              <div className="flex items-center gap-4">
                <div className="flex-1 border-t border-border" />
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Filter
                </span>
                <div className="flex-1 border-t border-border" />
              </div>
              <TagFilterPanel />
            </div>
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'trash':
      return (
        <FeatureErrorBoundary name="Trash">
          <Suspense fallback={<ViewFallback />}>
            <TrashView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'properties':
      return (
        <FeatureErrorBoundary name="Properties">
          <Suspense fallback={<ViewFallback />}>
            <PropertiesView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'settings':
      return (
        <FeatureErrorBoundary name="Settings">
          <Suspense fallback={<ViewFallback />}>
            <SettingsView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'status':
      return (
        <FeatureErrorBoundary name="Status">
          <Suspense fallback={<ViewFallback />}>
            <StatusPanel />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'conflicts':
      return (
        <FeatureErrorBoundary name="Conflicts">
          <Suspense fallback={<ViewFallback />}>
            <ConflictList />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'history':
      return (
        <FeatureErrorBoundary name="History">
          <Suspense fallback={<ViewFallback />}>
            <HistoryView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'templates':
      return (
        <FeatureErrorBoundary name="Templates">
          <Suspense fallback={<ViewFallback />}>
            <TemplatesView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'graph':
      return (
        <FeatureErrorBoundary name="Graph">
          <Suspense fallback={<ViewFallback />}>
            <GraphView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'page-editor':
      if (!activePage) return null
      return (
        <FeatureErrorBoundary name="PageEditor">
          <Suspense fallback={<ViewFallback />}>
            <PageEditor
              pageId={activePage.pageId}
              title={activePage.title}
              onBack={onBack}
              onNavigateToPage={onPageSelect}
            />
          </Suspense>
        </FeatureErrorBoundary>
      )
    default:
      return null
  }
}

function App() {
  const { t } = useTranslation()
  const currentView = useNavigationStore((s) => s.currentView)
  const setView = useNavigationStore((s) => s.setView)
  const navigateToPage = useNavigationStore((s) => s.navigateToPage)
  const goBack = useNavigationStore((s) => s.goBack)
  const pageStack = useNavigationStore(selectPageStack)
  const headerLabel = useHeaderLabel()
  const conflictCount = useConflictCount()
  const trashCount = useTrashCount()
  const { isDark, toggleTheme } = useTheme()
  const syncState = useSyncStore((s) => s.state)
  const syncPeers = useSyncStore((s) => s.peers)
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt)
  // FEAT-3 Phase 2 — subscribe to `currentSpaceId` so the
  // `clearPagesList` effect below re-runs whenever the active space
  // changes (e.g. the user picks a different space in `SpaceSwitcher`).
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const { syncing, syncAll } = useSyncTrigger()
  const isOnline = useOnlineStatus()
  const isMobile = useIsMobile()
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // UX-279: top-level BugReportDialog mount that listens for the
  // `BUG_REPORT_EVENT` global event from `FeatureErrorBoundary`. The
  // section-level boundary can't open the dialog directly because it lives
  // inside the crashed subtree — a global event lets it bubble to the
  // shell without prop-drilling.
  const [bugReportOpen, setBugReportOpen] = useState<boolean>(false)
  const [bugReportPrefill, setBugReportPrefill] = useState<BugReportEventDetail | null>(null)
  // FEAT-12: quick-capture dialog open state. Driven by the global
  // shortcut handler registered below; the dialog itself is mounted
  // unconditionally so we don't need a Suspense fallback for it.
  const [quickCaptureOpen, setQuickCaptureOpen] = useState<boolean>(false)
  // FEAT-12: lift the chord into state so the registration effect
  // re-runs when SettingsView changes it. Lazy-init from localStorage
  // so we don't read on every render. The storage-event listener
  // below feeds new chords into this state.
  const [quickCaptureChord, setQuickCaptureChord] = useState<string>(loadQuickCaptureShortcut)
  const mainContentRef = useRef<HTMLDivElement | null>(null)

  // The main content scroller is a `ScrollArea`; `mainContentRef` points at
  // the scrollable viewport. We need `id="main-content"` and `tabIndex=-1`
  // on that viewport so the skip link (`href="#main-content"`) and the
  // drag-to-auto-scroll logic in `BlockTree` (which does
  // `document.getElementById('main-content')`) operate on the real scroll
  // container, not a non-scrolling ancestor. A callback ref runs every
  // time the DOM node is attached, which is important because the viewport
  // only mounts after the boot gate resolves.
  const setMainContentViewport = useCallback((el: HTMLDivElement | null) => {
    mainContentRef.current = el
    if (el) {
      el.id = 'main-content'
      el.tabIndex = -1
    }
  }, [])

  // Preload the resolve cache (pages + tags) once on app boot
  useEffect(() => {
    useResolveStore.getState().preload()
  }, [])

  useEffect(() => {
    // FEAT-3 Phase 2 — clear the global page-title search cache on space
    // switch so the link picker's short-query path doesn't surface
    // other-space matches. Resolve cache (title→ULID map) is kept intact
    // so existing cross-space `[[ULID]]` chips still render their names.
    //
    // The `void currentSpaceId` pin is deliberate: biome's exhaustive-deps
    // can't see that `clearPagesList` semantically depends on the current
    // space (it reads state indirectly via the store getter), so we
    // reference `currentSpaceId` once to keep the dep array meaningful.
    void currentSpaceId
    useResolveStore.getState().clearPagesList()
  }, [currentSpaceId])

  // ── Boot recovery: flush orphaned drafts from previous crash ──────
  useEffect(() => {
    listDrafts()
      .then((drafts) => {
        for (const draft of drafts) {
          flushDraft(draft.block_id).catch((err: unknown) => {
            logger.warn(
              'App',
              'Failed to flush orphaned draft during boot recovery',
              {
                blockId: draft.block_id,
              },
              err,
            )
          })
        }
        if (drafts.length > 0) {
          logger.info('boot', `Recovered ${drafts.length} unsaved draft(s)`)
        }
      })
      .catch((err: unknown) => {
        logger.warn('App', 'Failed to list drafts during boot recovery', undefined, err)
      })
  }, [])

  // ── Load user-configured priority levels (UX-201b) ────────────────
  // The `priority` property definition's `options` JSON is the source of
  // truth for the active level set. Parse defensively — malformed JSON
  // or a missing definition leaves the default `['1','2','3']` levels in
  // place.
  useEffect(() => {
    listPropertyDefs()
      .then((defs) => {
        if (!Array.isArray(defs)) return
        const priorityDef = defs.find((d) => d.key === 'priority')
        if (!priorityDef) return
        if (priorityDef.options == null) return
        let parsed: unknown
        try {
          parsed = JSON.parse(priorityDef.options)
        } catch (err) {
          logger.warn(
            'App',
            'priority property definition has invalid JSON options',
            { options: priorityDef.options },
            err,
          )
          return
        }
        if (!Array.isArray(parsed)) {
          logger.warn('App', 'priority property options is not an array', {
            options: priorityDef.options,
          })
          return
        }
        const levels = parsed.filter((v): v is string => typeof v === 'string')
        if (levels.length === 0) return
        setPriorityLevels(levels)
      })
      .catch((err: unknown) => {
        logger.warn(
          'App',
          'Failed to load property definitions for priority levels',
          undefined,
          err,
        )
      })
  }, [])

  // ── Focus main content when view changes ──────────────────────────
  // Each view can register its preferred primary-focus element (search
  // input, first list item, first block, etc.) via `useRegisterPrimaryFocus`.
  // We defer one rAF so the new view has mounted and registered its ref
  // before we attempt `focus()`; if nothing registered, fall back to the
  // generic main-content container.
  const focusRegistry = usePrimaryFocusRegistry()
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentView IS the trigger — we focus when the view changes
  useEffect(() => {
    // Small delay to let the new view render before moving focus
    const id = requestAnimationFrame(() => {
      const focusedPrimary = focusRegistry?.focus() ?? false
      if (!focusedPrimary) {
        mainContentRef.current?.focus({ preventScroll: true })
      }
    })
    return () => cancelAnimationFrame(id)
  }, [currentView])

  // ── Bug-report event listener (UX-279) ────────────────────────────
  // FeatureErrorBoundary dispatches `BUG_REPORT_EVENT` from its "Report
  // bug" button. The boundary is inside the crashed subtree and can't
  // open a dialog itself, so the App shell mounts a top-level
  // BugReportDialog and opens it here with the event detail pre-filled.
  useEffect(() => {
    function handleReportBug(e: Event) {
      const detail = (e as CustomEvent<BugReportEventDetail>).detail
      if (detail == null) return
      setBugReportPrefill(detail)
      setBugReportOpen(true)
    }
    window.addEventListener(BUG_REPORT_EVENT, handleReportBug)
    return () => window.removeEventListener(BUG_REPORT_EVENT, handleReportBug)
  }, [])

  // ── Op-level undo/redo shortcuts (Ctrl+Z / Ctrl+Y) ─────────────────
  useUndoShortcuts()

  // ── Sync event listeners (Tauri → store) ───────────────────────────
  useSyncEvents()

  // ── Deep-link router (FEAT-10) ─────────────────────────────────────
  // Listens for `deeplink:navigate-to-{block,page}` / `deeplink:open-settings`
  // events emitted by the Rust router and feeds them into the
  // navigation store / settings localStorage key.  Also backfills the
  // launch URL on mount (Linux / Windows deliver the deep-link as a
  // CLI argument BEFORE the React listener registers).  No-op outside
  // Tauri.
  useDeepLinkRouter()

  // ── Journal navigation shortcuts (Alt+Arrow, Alt+T) ────────────────
  // Uses keyboard-config matchers so users can rebind these (BUG-18).
  // Dispatches through JOURNAL_SHORTCUTS so the handler stays well under
  // the cognitive-complexity budget (MAINT-53).
  useEffect(() => {
    function handleJournalNav(e: KeyboardEvent) {
      // MAINT-105: ignore auto-repeat so holding Alt+Arrow doesn't spam
      // setCurrentDate / SR announcements.
      if (e.repeat) return
      if (useNavigationStore.getState().currentView !== 'journal') return
      if (isTypingInField(e.target as HTMLElement | null)) return

      const shortcut = JOURNAL_SHORTCUTS.find((s) => matchesShortcutBinding(e, s.binding))
      if (!shortcut) return

      e.preventDefault()
      const { mode, currentDate, setCurrentDate } = useJournalStore.getState()
      setCurrentDate(shortcut.nextDate(currentDate, mode))
      announce(t(shortcut.announceKey))
    }
    document.addEventListener('keydown', handleJournalNav)
    return () => document.removeEventListener('keydown', handleJournalNav)
  }, [t])

  // ── Global shortcuts (focusSearch, createNewPage, gotoConflicts) ──
  // All go through matchesShortcutBinding so rebinding in Settings takes
  // effect (BUG-18).
  useEffect(() => {
    function handleGlobalShortcuts(e: KeyboardEvent) {
      // MAINT-105: ignore auto-repeat so holding the shortcut doesn't
      // re-fire view changes / new-page creation on every keypress.
      if (e.repeat) return
      const target = e.target as HTMLElement | null
      const typingInField =
        target?.isContentEditable || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'

      // Alt+C → jump to Conflicts view (UX-216). Only fire when not typing.
      if (matchesShortcutBinding(e, 'gotoConflicts')) {
        if (typingInField) return
        e.preventDefault()
        useNavigationStore.getState().setView('conflicts')
        announce(t('announce.conflictsOpened'))
        return
      }

      if (matchesShortcutBinding(e, 'focusSearch')) {
        e.preventDefault()
        useNavigationStore.getState().setView('search')
        announce(t('announce.searchOpened'))
        return
      }
      if (matchesShortcutBinding(e, 'createNewPage')) {
        e.preventDefault()
        // FEAT-3 Phase 2 — every page must belong to a space. Route
        // through the atomic `createPageInSpace` Tauri command. The
        // `isReady`/`currentSpaceId` check is defensive: the shortcut
        // only fires after boot has resolved `refreshAvailableSpaces()`.
        const { currentSpaceId, isReady } = useSpaceStore.getState()
        if (!isReady || currentSpaceId == null) {
          logger.warn('App', 'createNewPage shortcut fired before space hydrated')
          toast.error(t('space.notReady'))
          return
        }
        createPageInSpace({ content: 'Untitled', spaceId: currentSpaceId })
          .then((newId) => {
            useResolveStore.getState().set(newId, 'Untitled', false)
            useNavigationStore.getState().navigateToPage(newId, 'Untitled')
            announce(t('announce.newPageCreated'))
          })
          .catch((err: unknown) => {
            logger.error('App', 'Failed to create page via shortcut', undefined, err)
            toast.error(t('error.createPageFailed'))
          })
      }
    }
    window.addEventListener('keydown', handleGlobalShortcuts)
    return () => window.removeEventListener('keydown', handleGlobalShortcuts)
  }, [t])

  // ── FEAT-12: register the quick-capture global hotkey ─────────────
  // Registers the user-configured chord (default Ctrl+Alt+N on Linux /
  // Windows, Cmd+Option+N on macOS) via `tauri-plugin-global-shortcut`.
  // When the chord fires the handler:
  //   1. Brings the window forward (unminimize + show + setFocus) so
  //      the dialog is visible even if the app was hidden / minimized.
  //   2. Opens `QuickCaptureDialog` via `setQuickCaptureOpen(true)`.
  //
  // The effect re-runs whenever the localStorage key changes (Settings
  // panel triggers a `storage`-event-style rerender by writing the new
  // chord). On unmount or re-bind, we unregister the previous chord so
  // we don't leak OS-level bindings across hot reloads.
  //
  // Desktop-only: `registerGlobalShortcut` itself short-circuits on
  // mobile, so there is no platform gate here.
  // Storage-event listener that updates the chord state, kept in its
  // own effect so it never tears down between chord-driven re-binds.
  // SettingsView writes the new chord to localStorage and dispatches
  // a synthetic storage event; we re-read and feed it into state.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== QUICK_CAPTURE_SHORTCUT_STORAGE_KEY) return
      const next = loadQuickCaptureShortcut()
      setQuickCaptureChord((prev) => (prev === next ? prev : next))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Register / re-register the global chord whenever it changes.
  // Cleanup unregisters the previous chord before the new one is
  // registered, so the OS only ever has one binding at a time.
  // Desktop-only: `registerGlobalShortcut` short-circuits on mobile.
  useEffect(() => {
    let active = true
    const accelerator = quickCaptureChord

    const handler = () => {
      // Best-effort window focus. The IPC failures here are non-fatal —
      // the dialog still opens; only the visibility / focus state may
      // be wrong if the user already closed the window manually.
      void (async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window')
          const w = getCurrentWindow()
          // Order matters: unminimize before show before setFocus.
          if (await w.isMinimized().catch(() => false)) {
            await w.unminimize().catch(() => {})
          }
          await w.show().catch(() => {})
          await w.setFocus().catch(() => {})
        } catch (err) {
          logger.warn('App', 'quick-capture window focus failed', undefined, err)
        }
      })()
      if (active) setQuickCaptureOpen(true)
    }

    registerGlobalShortcut(accelerator, handler).catch((err: unknown) => {
      logger.warn('App', 'failed to register quick-capture global shortcut', { accelerator }, err)
    })

    return () => {
      active = false
      unregisterGlobalShortcut(accelerator).catch((err: unknown) => {
        logger.warn(
          'App',
          'failed to unregister quick-capture global shortcut',
          { accelerator },
          err,
        )
      })
    }
  }, [quickCaptureChord])

  // ── Global "close all overlays" shortcut (Escape by default) ────────
  // UX-228: dispatch a plain DOM CustomEvent on `window` so any top-level
  // overlay (KeyboardShortcuts sheet, WelcomeModal, future non-Radix
  // popovers) can listen and close itself. The shortcut is rebindable
  // through Settings — we route via `matchesShortcutBinding` rather than
  // hardcoding `e.key === 'Escape'`. Deliberately skipped when focus is
  // inside the block editor or an input/textarea so the key keeps its
  // native semantics there (blur, cancel suggestion, etc.).
  useEffect(() => {
    function handleCloseOverlays(e: KeyboardEvent) {
      // MAINT-105: ignore auto-repeat so holding Escape doesn't dispatch
      // the custom event / SR announcement on every keypress.
      if (e.repeat) return
      if (!matchesShortcutBinding(e, 'closeOverlays')) return
      if (isTypingInField(e.target as HTMLElement | null)) return
      e.preventDefault()
      window.dispatchEvent(new CustomEvent(CLOSE_ALL_OVERLAYS_EVENT))
      announce(t('announce.overlaysClosed'))
    }
    window.addEventListener('keydown', handleCloseOverlays)
    return () => window.removeEventListener('keydown', handleCloseOverlays)
  }, [t])

  // ── Close the shortcuts sheet when "close all overlays" fires ───────
  // UX-228: the sheet is Radix-managed and already closes when Escape is
  // pressed *inside* it, but if focus has drifted elsewhere the global
  // handler above is what dismisses it.
  useEffect(() => {
    function handleClose() {
      setShortcutsOpen(false)
    }
    window.addEventListener(CLOSE_ALL_OVERLAYS_EVENT, handleClose)
    return () => window.removeEventListener(CLOSE_ALL_OVERLAYS_EVENT, handleClose)
  }, [])

  // ── Tab shortcuts (openInNewTab, closeActiveTab, nextTab, previousTab) ──
  // Routed through matchesShortcutBinding so users can rebind (BUG-18).
  // Dispatches through TAB_SHORTCUTS so the handler stays well under the
  // cognitive-complexity budget (MAINT-54).
  //
  // FEAT-7: the TabBar is now shell-wide on desktop, so these shortcuts fire
  // from any view (not just page-editor). We still short-circuit on mobile
  // because the TabBar itself is hidden there and the shortcuts have no
  // meaningful UI affordance.
  useEffect(() => {
    function handleTabShortcuts(e: KeyboardEvent) {
      // MAINT-105: ignore auto-repeat so holding the tab-cycle shortcut
      // doesn't spin through every tab on each frame.
      if (e.repeat) return
      if (isMobile) return
      const state = useNavigationStore.getState()

      const shortcut = TAB_SHORTCUTS.find((s) => matchesShortcutBinding(e, s.binding))
      if (!shortcut) return

      e.preventDefault()

      // FEAT-7 follow-up: Ctrl+T in a fresh tab (empty pageStack) would
      // silently do nothing. Surface a toast so the user gets feedback
      // instead of a silent failure. The other tab shortcuts (close,
      // next, previous) are well-defined regardless of stack state.
      if (shortcut.binding === 'openInNewTab') {
        const activeTab = state.tabs[state.activeTabIndex]
        const top = activeTab?.pageStack[activeTab.pageStack.length - 1]
        if (!top) {
          toast.error(t('tabs.openInNewTabEmpty'))
          return
        }
      }

      shortcut.run(state)
    }
    window.addEventListener('keydown', handleTabShortcuts)
    return () => window.removeEventListener('keydown', handleTabShortcuts)
  }, [isMobile, t])

  const handleNewPage = useCallback(async () => {
    // FEAT-3 Phase 2 — route through the atomic `createPageInSpace`
    // Tauri command (CreateBlock + SetProperty('space') in one tx).
    const { currentSpaceId, isReady } = useSpaceStore.getState()
    if (!isReady || currentSpaceId == null) {
      logger.warn('App', 'handleNewPage fired before space hydrated')
      toast.error(t('space.notReady'))
      return
    }
    try {
      const newId = await createPageInSpace({ content: 'Untitled', spaceId: currentSpaceId })
      useResolveStore.getState().set(newId, 'Untitled', false)
      navigateToPage(newId, 'Untitled')
      announce(t('announce.newPageCreated'))
    } catch (err) {
      logger.error('App', 'Failed to create new page', undefined, err)
      toast.error(t('error.createPageFailed'))
    }
  }, [navigateToPage, t])

  const handlePageSelect = useCallback(
    (pageId: string, title?: string, blockId?: string) => {
      navigateToPage(pageId, title ?? 'Untitled', blockId)
    },
    [navigateToPage],
  )

  const activePage = pageStack.length > 0 ? pageStack[pageStack.length - 1] : null

  // ── View key for scroll restore + transition ──────────────────────
  const viewKey =
    currentView === 'page-editor' && activePage ? `page-editor:${activePage.pageId}` : currentView

  // ── Scroll position restoration ──────────────────────────────────
  useScrollRestore(mainContentRef, viewKey)

  // ── View transition fade ─────────────────────────────────────────
  // Uses the "set state during render" pattern to synchronously hide
  // content when the view key changes, then fades in via CSS transition.
  const [prevViewKey, setPrevViewKey] = useState(viewKey)
  const [fadeVisible, setFadeVisible] = useState(true)

  if (prevViewKey !== viewKey) {
    setPrevViewKey(viewKey)
    setFadeVisible(false)
  }

  useEffect(() => {
    if (!fadeVisible) {
      // Delay fade-in by 150ms to allow page content to load from SQLite
      // before the opacity transition begins, preventing CLS from skeleton
      // placeholders being replaced by actual content mid-fade (B-76).
      const id = setTimeout(() => {
        setFadeVisible(true)
      }, 150)
      return () => clearTimeout(id)
    }
    return undefined
  }, [fadeVisible])

  return (
    <BootGate>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-2 focus:ring-ring"
      >
        {t('accessibility.skipToMain')}
      </a>
      <SidebarProvider>
        {/*
         * "icon" collapses the sidebar to a 48px icon-only rail rather than
         * fully off-canvas. Chosen over "offcanvas" so that on desktop the
         * primary nav stays one click away (vs. requiring a swipe/click to
         * re-open). See UX.md § Mobile Sidebar.
         */}
        <Sidebar collapsible="icon">
          <SidebarHeader className="p-4 pb-2">
            {/*
             * FEAT-3 Phase 1: replace static branding with the
             * SpaceSwitcher. The switcher occupies the same vertical
             * footprint so downstream sidebar height math stays valid.
             * It is hidden when the sidebar collapses to icon mode to
             * preserve the compact rail layout (the switcher
             * re-appears on expand).
             */}
            <div className="group-data-[collapsible=icon]:hidden">
              <SpaceSwitcher />
            </div>
          </SidebarHeader>
          <SidebarContent>
            <FeatureErrorBoundary name="Sidebar">
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {NAV_ITEMS.map((item) => {
                      const label = t(item.labelKey)
                      return (
                        <SidebarMenuItem key={item.id}>
                          <SidebarMenuButton
                            isActive={currentView === item.id}
                            aria-current={currentView === item.id ? 'page' : undefined}
                            tooltip={label}
                            onClick={() => setView(item.id)}
                          >
                            <item.icon />
                            <span>{label}</span>
                            {item.id === 'conflicts' && conflictCount > 0 && (
                              <SidebarMenuBadge
                                aria-label={t('sidebar.conflictCount', { count: conflictCount })}
                              >
                                {conflictCount}
                              </SidebarMenuBadge>
                            )}
                            {item.id === 'trash' && trashCount > 0 && (
                              <SidebarMenuBadge
                                aria-label={t('sidebar.trashCount', { count: trashCount })}
                              >
                                {trashCount}
                              </SidebarMenuBadge>
                            )}
                            {item.id === 'status' && (
                              <span
                                className={cn(
                                  'ml-auto h-2.5 w-2.5 rounded-full',
                                  syncDotClass(syncState, syncPeers.length > 0),
                                )}
                                aria-hidden="true"
                              />
                            )}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </FeatureErrorBoundary>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip={t('sidebar.newPageTooltip')} onClick={handleNewPage}>
                  <Plus />
                  <span>{t('sidebar.newPage')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip={
                    !isOnline
                      ? t('sidebar.offline')
                      : syncing
                        ? t('sidebar.syncing')
                        : t('sidebar.syncTooltip')
                  }
                  onClick={syncAll}
                  disabled={syncing || !isOnline}
                >
                  {!isOnline ? (
                    <WifiOff className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <RefreshCw className={syncing ? 'animate-spin' : ''} />
                  )}
                  <span>{isOnline ? t('sidebar.sync') : t('sidebar.offline')}</span>
                  <span
                    className={cn(
                      'sync-button-status-dot ml-auto h-2.5 w-2.5 rounded-full',
                      syncDotClass(syncState, syncPeers.length > 0),
                    )}
                    data-testid="sync-button-status-dot"
                    data-sync-state={syncState}
                    aria-hidden="true"
                  />
                </SidebarMenuButton>
                <span
                  className="px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden"
                  data-testid="last-synced"
                >
                  {lastSyncedAt
                    ? t('sidebar.lastSynced', { time: formatRelativeTime(lastSyncedAt, t) })
                    : t('sidebar.lastSyncedNever')}
                </span>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip={t('sidebar.toggleTheme')}
                  onClick={toggleTheme}
                  data-testid="theme-toggle"
                >
                  {isDark ? <Sun /> : <Moon />}
                  <span>{t('sidebar.toggleTheme')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip={t('sidebar.shortcuts')}
                  onClick={() => setShortcutsOpen(true)}
                >
                  <Keyboard />
                  <span>{t('sidebar.shortcuts')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <CollapseButton />
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <ViewHeaderOutletProvider>
            <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
              <SidebarTrigger className="md:hidden" />
              {currentView === 'journal' ? (
                <JournalControls />
              ) : (
                <>
                  <span className="font-medium" data-testid="header-label">
                    {headerLabel}
                  </span>
                  <div className="flex-1" />
                  <GlobalDateControls />
                </>
              )}
            </header>
            {/*
             * FEAT-7: TabBar is hoisted out of the page-editor view router
             * case and rendered at shell level so tabs stay visible across
             * every sidebar destination (journal, pages, search, …). The
             * autohide guard on `tabs.length <= 1` and the desktop-only
             * mobile gate live inside the component itself.
             */}
            <TabBar />
            {/*
             * FEAT-9: desktop-only "Recently visited" chip strip, mounted
             * between the hoisted TabBar above and the ViewHeaderOutletSlot
             * below. Responsive grid auto-fits chips; auto-hides on mobile
             * and when the visible list is empty.
             */}
            <RecentPagesStrip />
            {/*
             * UX-198: view-level sticky headers didn't stick because the
             * nearest scroll ancestor was the <ScrollArea> viewport below,
             * not the view component. Hoisting the headers to an outlet
             * that lives _outside_ the scroll container lets them stay
             * visible as the view scrolls, without relying on sticky
             * positioning at all.
             */}
            <ViewHeaderOutletSlot className="border-b border-border/40 px-4 md:px-6 py-3 space-y-2" />
            <ScrollArea
              viewportRef={setMainContentViewport}
              className="flex-1"
              // UX-225: re-apply the bottom safe-area inset to the scroll
              // viewport so the last block of a long scroll doesn't sit
              // under the iPhone home indicator / Android gesture bar.
              // `scroll-pb-[env(…)]` extends the scroll end so keyboard
              // scroll-into-view stops short of the inset as well.
              viewportClassName="p-4 md:p-6 outline-none pb-[calc(1rem+env(safe-area-inset-bottom))] md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] scroll-pb-[env(safe-area-inset-bottom)]"
              data-slot="main-content"
            >
              <div
                className={cn(
                  'flex flex-1 min-h-0 flex-col',
                  fadeVisible
                    ? 'opacity-100 transition-opacity duration-150 ease-out'
                    : 'opacity-0',
                )}
                data-testid="view-transition-wrapper"
              >
                <ViewRouter
                  currentView={currentView}
                  activePage={activePage ?? null}
                  onPageSelect={handlePageSelect}
                  onBack={goBack}
                  navigateToPage={navigateToPage}
                />
              </div>
            </ScrollArea>
          </ViewHeaderOutletProvider>
        </SidebarInset>
      </SidebarProvider>
      <Suspense fallback={null}>
        <KeyboardShortcuts open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <WelcomeModal />
      </Suspense>
      {/*
       * UX-279: top-level BugReportDialog driven by `BUG_REPORT_EVENT`.
       * `initialTitle` / `initialDescription` are conditionally spread so
       * the dialog only sees them once a prefill payload exists, keeping
       * `exactOptionalPropertyTypes` happy.
       */}
      <BugReportDialog
        open={bugReportOpen}
        onOpenChange={(open) => {
          setBugReportOpen(open)
          if (!open) setBugReportPrefill(null)
        }}
        {...(bugReportPrefill != null
          ? {
              initialTitle: bugReportPrefill.message,
              initialDescription: bugReportPrefill.stack ?? '',
            }
          : {})}
      />
      {/* FEAT-12: Quick-capture dialog — driven by the global hotkey
          registered in App's startup effect. Mounted unconditionally so
          the global shortcut handler can flip `open` instantly. */}
      <QuickCaptureDialog open={quickCaptureOpen} onOpenChange={setQuickCaptureOpen} />
      <Toaster position="bottom-right" richColors closeButton />
    </BootGate>
  )
}

export { App }
