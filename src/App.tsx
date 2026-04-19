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
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BootGate } from './components/BootGate'
import { ConflictList } from './components/ConflictList'
import { FeatureErrorBoundary } from './components/FeatureErrorBoundary'
import { GraphView } from './components/GraphView'
import { HistoryView } from './components/HistoryView'
import { GlobalDateControls, JournalControls, JournalPage } from './components/JournalPage'
import { KeyboardShortcuts } from './components/KeyboardShortcuts'
import { PageBrowser } from './components/PageBrowser'
import { PageEditor } from './components/PageEditor'
import { PropertiesView } from './components/PropertiesView'
import { SearchPanel } from './components/SearchPanel'
import { SettingsView } from './components/SettingsView'
import { StatusPanel } from './components/StatusPanel'
import { TabBar } from './components/TabBar'
import { TagFilterPanel } from './components/TagFilterPanel'
import { TagList } from './components/TagList'
import { TemplatesView } from './components/TemplatesView'
import { TrashView } from './components/TrashView'
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
import { WelcomeModal } from './components/WelcomeModal'
import { useItemCount } from './hooks/useItemCount'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { usePrimaryFocusRegistry } from './hooks/usePrimaryFocus'
import { useScrollRestore } from './hooks/useScrollRestore'
import { useSyncEvents } from './hooks/useSyncEvents'
import { useSyncTrigger } from './hooks/useSyncTrigger'
import { useTheme } from './hooks/useTheme'
import { useUndoShortcuts } from './hooks/useUndoShortcuts'
import { announce } from './lib/announcer'
import { formatRelativeTime } from './lib/format-relative-time'
import { matchesShortcutBinding } from './lib/keyboard-config'
import { logger } from './lib/logger'
import { CLOSE_ALL_OVERLAYS_EVENT } from './lib/overlay-events'
import { setPriorityLevels } from './lib/priority-levels'
import {
  createBlock,
  flushDraft,
  getConflicts,
  listBlocks,
  listDrafts,
  listPropertyDefs,
} from './lib/tauri'
import { cn } from './lib/utils'
import { type JournalMode, useJournalStore } from './stores/journal'
import { type PageEntry, selectPageStack, useNavigationStore, type View } from './stores/navigation'
import { useResolveStore } from './stores/resolve'
import { useSyncStore } from './stores/sync'

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
 * Renders the main view body based on `currentView`. Extracted from `App`
 * so the parent component stays well under the cognitive-complexity budget
 * (MAINT-52). Each branch is a `FeatureErrorBoundary` so a crashed view
 * never unmounts the shell.
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
          <SearchPanel />
        </FeatureErrorBoundary>
      )
    case 'pages':
      return (
        <FeatureErrorBoundary name="Pages">
          <PageBrowser onPageSelect={onPageSelect} />
        </FeatureErrorBoundary>
      )
    case 'tags':
      return (
        <FeatureErrorBoundary name="Tags">
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
        </FeatureErrorBoundary>
      )
    case 'trash':
      return (
        <FeatureErrorBoundary name="Trash">
          <TrashView />
        </FeatureErrorBoundary>
      )
    case 'properties':
      return (
        <FeatureErrorBoundary name="Properties">
          <PropertiesView />
        </FeatureErrorBoundary>
      )
    case 'settings':
      return (
        <FeatureErrorBoundary name="Settings">
          <SettingsView />
        </FeatureErrorBoundary>
      )
    case 'status':
      return (
        <FeatureErrorBoundary name="Status">
          <StatusPanel />
        </FeatureErrorBoundary>
      )
    case 'conflicts':
      return (
        <FeatureErrorBoundary name="Conflicts">
          <ConflictList />
        </FeatureErrorBoundary>
      )
    case 'history':
      return (
        <FeatureErrorBoundary name="History">
          <HistoryView />
        </FeatureErrorBoundary>
      )
    case 'templates':
      return (
        <FeatureErrorBoundary name="Templates">
          <TemplatesView />
        </FeatureErrorBoundary>
      )
    case 'graph':
      return (
        <FeatureErrorBoundary name="Graph">
          <GraphView />
        </FeatureErrorBoundary>
      )
    case 'page-editor':
      if (!activePage) return null
      return (
        <>
          <TabBar />
          <FeatureErrorBoundary name="PageEditor">
            <PageEditor
              pageId={activePage.pageId}
              title={activePage.title}
              onBack={onBack}
              onNavigateToPage={onPageSelect}
            />
          </FeatureErrorBoundary>
        </>
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
  const { syncing, syncAll } = useSyncTrigger()
  const isOnline = useOnlineStatus()
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
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

  // ── Op-level undo/redo shortcuts (Ctrl+Z / Ctrl+Y) ─────────────────
  useUndoShortcuts()

  // ── Sync event listeners (Tauri → store) ───────────────────────────
  useSyncEvents()

  // ── Journal navigation shortcuts (Alt+Arrow, Alt+T) ────────────────
  // Uses keyboard-config matchers so users can rebind these (BUG-18).
  // Dispatches through JOURNAL_SHORTCUTS so the handler stays well under
  // the cognitive-complexity budget (MAINT-53).
  useEffect(() => {
    function handleJournalNav(e: KeyboardEvent) {
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
        createBlock({ blockType: 'page', content: 'Untitled' })
          .then((resp) => {
            useResolveStore.getState().set(resp.id, 'Untitled', false)
            useNavigationStore.getState().navigateToPage(resp.id, 'Untitled')
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
  useEffect(() => {
    function handleTabShortcuts(e: KeyboardEvent) {
      const state = useNavigationStore.getState()
      if (state.currentView !== 'page-editor') return

      const shortcut = TAB_SHORTCUTS.find((s) => matchesShortcutBinding(e, s.binding))
      if (!shortcut) return

      e.preventDefault()
      shortcut.run(state)
    }
    window.addEventListener('keydown', handleTabShortcuts)
    return () => window.removeEventListener('keydown', handleTabShortcuts)
  }, [])

  const handleNewPage = useCallback(async () => {
    try {
      const resp = await createBlock({ blockType: 'page', content: 'Untitled' })
      useResolveStore.getState().set(resp.id, 'Untitled', false)
      navigateToPage(resp.id, 'Untitled')
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
        <Sidebar collapsible="icon">
          <SidebarHeader className="p-4 pb-2">
            <div className="flex h-7 items-center gap-2 group-data-[collapsible=icon]:justify-center">
              <img src="/agaric.svg" alt="Agaric" className="h-6 w-6 shrink-0" />
              <span className="text-base font-semibold leading-none tracking-tight group-data-[collapsible=icon]:hidden">
                Agaric
              </span>
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
                className={
                  fadeVisible ? 'opacity-100 transition-opacity duration-150 ease-out' : 'opacity-0'
                }
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
      <KeyboardShortcuts open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <WelcomeModal />
      <Toaster position="bottom-right" richColors closeButton />
    </BootGate>
  )
}

export { App }
