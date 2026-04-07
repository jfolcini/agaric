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
  Plus,
  RefreshCw,
  Search,
  Settings2,
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
import { HistoryView } from './components/HistoryView'
import { GlobalDateControls, JournalControls, JournalPage } from './components/JournalPage'
import { KeyboardShortcuts } from './components/KeyboardShortcuts'
import { PageBrowser } from './components/PageBrowser'
import { PageEditor } from './components/PageEditor'
import { PropertiesView } from './components/PropertiesView'
import { SearchPanel } from './components/SearchPanel'
import { StatusPanel } from './components/StatusPanel'
import { TagFilterPanel } from './components/TagFilterPanel'
import { TagList } from './components/TagList'
import { TemplatesView } from './components/TemplatesView'
import { TrashView } from './components/TrashView'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from './components/ui/sidebar'
import { Toaster } from './components/ui/sonner'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { usePollingQuery } from './hooks/usePollingQuery'
import { useScrollRestore } from './hooks/useScrollRestore'
import { useSyncEvents } from './hooks/useSyncEvents'
import { useSyncTrigger } from './hooks/useSyncTrigger'
import { useUndoShortcuts } from './hooks/useUndoShortcuts'
import { announce } from './lib/announcer'
import { createBlock, getConflicts } from './lib/tauri'
import { useJournalStore } from './stores/journal'
import { useNavigationStore, type View } from './stores/navigation'
import { useResolveStore } from './stores/resolve'
import { useSyncStore } from './stores/sync'

/** Sidebar nav items — page-editor is not listed here (it's navigated to programmatically). */
const NAV_ITEMS: { id: Exclude<View, 'page-editor'>; icon: React.ElementType; labelKey: string }[] =
  [
    { id: 'journal', icon: Calendar, labelKey: 'sidebar.journal' },
    { id: 'search', icon: Search, labelKey: 'sidebar.search' },
    { id: 'pages', icon: FileText, labelKey: 'sidebar.pages' },
    { id: 'tags', icon: Tag, labelKey: 'sidebar.tags' },
    { id: 'properties', icon: Settings2, labelKey: 'sidebar.properties' },
    { id: 'trash', icon: Trash2, labelKey: 'sidebar.trash' },
    { id: 'status', icon: Activity, labelKey: 'sidebar.status' },
    { id: 'conflicts', icon: GitMerge, labelKey: 'sidebar.conflicts' },
    { id: 'history', icon: History, labelKey: 'sidebar.history' },
    { id: 'templates', icon: LayoutTemplate, labelKey: 'sidebar.templates' },
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
  const { currentView, pageStack } = useNavigationStore()
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

/** Returns true when at least one unresolved conflict exists. Polls every 30 s and on focus. */
function useHasConflicts(): boolean {
  const currentView = useNavigationStore((s) => s.currentView)
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-poll when view changes (user may have resolved conflicts)
  const queryFn = useCallback(() => getConflicts({ limit: 1 }), [currentView])
  const { data } = usePollingQuery(queryFn, {
    intervalMs: 30_000,
    refetchOnFocus: true,
  })
  return (data?.items.length ?? 0) > 0
}

function App() {
  const { t } = useTranslation()
  const { currentView, pageStack, setView, navigateToPage, goBack } = useNavigationStore()
  const headerLabel = useHeaderLabel()
  const hasConflicts = useHasConflicts()
  const syncState = useSyncStore((s) => s.state)
  const syncPeers = useSyncStore((s) => s.peers)
  const { syncing, syncAll } = useSyncTrigger()
  const isOnline = useOnlineStatus()
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const mainContentRef = useRef<HTMLDivElement>(null)

  // Preload the resolve cache (pages + tags) once on app boot
  useEffect(() => {
    useResolveStore.getState().preload()
  }, [])

  // ── Focus main content when view changes ──────────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentView IS the trigger — we focus when the view changes
  useEffect(() => {
    // Small delay to let the new view render before moving focus
    const id = requestAnimationFrame(() => {
      mainContentRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(id)
  }, [currentView])

  // ── Op-level undo/redo shortcuts (Ctrl+Z / Ctrl+Y) ─────────────────
  useUndoShortcuts()

  // ── Sync event listeners (Tauri → store) ───────────────────────────
  useSyncEvents()

  // ── Journal navigation shortcuts (Alt+Arrow, Alt+T) ────────────────
  useEffect(() => {
    function handleJournalNav(e: KeyboardEvent) {
      if (!e.altKey) return
      const { currentView } = useNavigationStore.getState()
      if (currentView !== 'journal') return

      const target = e.target as HTMLElement
      if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
        return

      const { mode, currentDate, setCurrentDate } = useJournalStore.getState()

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (mode === 'daily') setCurrentDate(subDays(currentDate, 1))
        else if (mode === 'weekly') setCurrentDate(subWeeks(currentDate, 1))
        else setCurrentDate(subMonths(currentDate, 1))
        announce(
          `Navigated to previous ${mode === 'daily' ? 'day' : mode === 'weekly' ? 'week' : 'month'}`,
        )
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (mode === 'daily') setCurrentDate(addDays(currentDate, 1))
        else if (mode === 'weekly') setCurrentDate(addWeeks(currentDate, 1))
        else setCurrentDate(addMonths(currentDate, 1))
        announce(
          `Navigated to next ${mode === 'daily' ? 'day' : mode === 'weekly' ? 'week' : 'month'}`,
        )
      }
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault()
        setCurrentDate(new Date())
        announce('Jumped to today')
      }
    }
    document.addEventListener('keydown', handleJournalNav)
    return () => document.removeEventListener('keydown', handleJournalNav)
  }, [])

  // ── Global shortcuts (Ctrl+F → search, Ctrl+N → new page) ──────────
  useEffect(() => {
    function handleGlobalShortcuts(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      if (e.key === 'f') {
        e.preventDefault()
        useNavigationStore.getState().setView('search')
        announce('Search opened')
      }
      if (e.key === 'n') {
        e.preventDefault()
        createBlock({ blockType: 'page', content: 'Untitled' })
          .then((resp) => {
            useResolveStore.getState().set(resp.id, 'Untitled', false)
            useNavigationStore.getState().navigateToPage(resp.id, 'Untitled')
            announce('New page created')
          })
          .catch(() => toast.error(t('error.createPageFailed')))
      }
    }
    window.addEventListener('keydown', handleGlobalShortcuts)
    return () => window.removeEventListener('keydown', handleGlobalShortcuts)
  }, [t])

  const handleNewPage = useCallback(async () => {
    try {
      const resp = await createBlock({ blockType: 'page', content: 'Untitled' })
      useResolveStore.getState().set(resp.id, 'Untitled', false)
      navigateToPage(resp.id, 'Untitled')
      announce('New page created')
    } catch {
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
      const id = requestAnimationFrame(() => {
        setFadeVisible(true)
      })
      return () => cancelAnimationFrame(id)
    }
    return undefined
  }, [fadeVisible])

  return (
    <BootGate>
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
                            {item.id === 'conflicts' && hasConflicts && (
                              <span
                                role="status"
                                className="ml-auto h-2 w-2 rounded-full bg-destructive"
                                aria-label={t('conflict.unresolvedLabel')}
                              />
                            )}
                            {item.id === 'status' && (
                              <span
                                className={`ml-auto h-2.5 w-2.5 rounded-full ${syncDotClass(syncState, syncPeers.length > 0)}`}
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
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
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
          <div
            ref={mainContentRef}
            tabIndex={-1}
            className="flex-1 overflow-y-auto p-4 md:p-6 outline-none"
          >
            <div
              className={
                fadeVisible ? 'opacity-100 transition-opacity duration-150 ease-out' : 'opacity-0'
              }
              data-testid="view-transition-wrapper"
            >
              {currentView === 'journal' && (
                <FeatureErrorBoundary name="Journal">
                  <JournalPage onNavigateToPage={handlePageSelect} />
                </FeatureErrorBoundary>
              )}
              {currentView === 'search' && (
                <FeatureErrorBoundary name="Search">
                  <SearchPanel />
                </FeatureErrorBoundary>
              )}
              {currentView === 'pages' && (
                <FeatureErrorBoundary name="Pages">
                  <PageBrowser onPageSelect={handlePageSelect} />
                </FeatureErrorBoundary>
              )}
              {currentView === 'tags' && (
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
              )}
              {currentView === 'trash' && (
                <FeatureErrorBoundary name="Trash">
                  <TrashView />
                </FeatureErrorBoundary>
              )}
              {currentView === 'properties' && (
                <FeatureErrorBoundary name="Properties">
                  <PropertiesView />
                </FeatureErrorBoundary>
              )}
              {currentView === 'status' && (
                <FeatureErrorBoundary name="Status">
                  <StatusPanel />
                </FeatureErrorBoundary>
              )}
              {currentView === 'conflicts' && (
                <FeatureErrorBoundary name="Conflicts">
                  <ConflictList />
                </FeatureErrorBoundary>
              )}
              {currentView === 'history' && (
                <FeatureErrorBoundary name="History">
                  <HistoryView />
                </FeatureErrorBoundary>
              )}
              {currentView === 'templates' && (
                <FeatureErrorBoundary name="Templates">
                  <TemplatesView />
                </FeatureErrorBoundary>
              )}
              {currentView === 'page-editor' && activePage && (
                <FeatureErrorBoundary name="PageEditor">
                  <PageEditor
                    pageId={activePage.pageId}
                    title={activePage.title}
                    onBack={goBack}
                    onNavigateToPage={handlePageSelect}
                  />
                </FeatureErrorBoundary>
              )}
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
      <KeyboardShortcuts open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <Toaster position="bottom-right" richColors closeButton />
    </BootGate>
  )
}

export default App
