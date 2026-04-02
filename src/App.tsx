import { addDays, addMonths, addWeeks, subDays, subMonths, subWeeks } from 'date-fns'
import {
  Activity,
  Calendar,
  ChevronsLeft,
  FileText,
  GitMerge,
  History,
  Keyboard,
  RefreshCw,
  Search,
  Tag,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { BootGate } from './components/BootGate'
import { ConflictList } from './components/ConflictList'
import { HistoryView } from './components/HistoryView'
import { JournalControls, JournalPage } from './components/JournalPage'
import { KeyboardShortcuts } from './components/KeyboardShortcuts'
import { PageBrowser } from './components/PageBrowser'
import { PageEditor } from './components/PageEditor'
import { SearchPanel } from './components/SearchPanel'
import { StatusPanel } from './components/StatusPanel'
import { TagFilterPanel } from './components/TagFilterPanel'
import { TagList } from './components/TagList'
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
const NAV_ITEMS: { id: Exclude<View, 'page-editor'>; icon: React.ElementType; label: string }[] = [
  { id: 'journal', icon: Calendar, label: 'Journal' },
  { id: 'search', icon: Search, label: 'Search' },
  { id: 'pages', icon: FileText, label: 'Pages' },
  { id: 'tags', icon: Tag, label: 'Tags' },
  { id: 'trash', icon: Trash2, label: 'Trash' },
  { id: 'status', icon: Activity, label: 'Status' },
  { id: 'conflicts', icon: GitMerge, label: 'Conflicts' },
  { id: 'history', icon: History, label: 'History' },
]

function CollapseButton() {
  const { toggleSidebar } = useSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip="Toggle Sidebar" onClick={toggleSidebar}>
          <ChevronsLeft className="transition-transform group-data-[state=collapsed]:rotate-180" />
          <span>Collapse</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

/** Resolve the header label from the current navigation state. */
function useHeaderLabel(): string {
  const { currentView, pageStack } = useNavigationStore()
  // page-editor has its own editable title — don't duplicate it in the header
  if (currentView === 'page-editor' && pageStack.length > 0) {
    return ''
  }
  return NAV_ITEMS.find((item) => item.id === currentView)?.label ?? ''
}

/** Compute the CSS class for the sync status dot colour. */
function syncDotClass(syncState: string, hasPeers: boolean): string {
  if (!hasPeers) return 'bg-muted-foreground'
  switch (syncState) {
    case 'idle':
      return 'bg-emerald-500'
    case 'syncing':
    case 'discovering':
    case 'pairing':
      return 'bg-amber-500'
    case 'error':
      return 'bg-destructive'
    default:
      return 'bg-muted-foreground'
  }
}

/** Returns true when at least one unresolved conflict exists. Polls every 30 s and on focus. */
function useHasConflicts(): boolean {
  const [hasConflicts, setHasConflicts] = useState(false)
  const currentView = useNavigationStore((s) => s.currentView)

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-poll when view changes (user may have resolved conflicts)
  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const resp = await getConflicts({ limit: 1 })
        if (!cancelled) setHasConflicts(resp.items.length > 0)
      } catch {
        if (!cancelled) setHasConflicts(false)
      }
    }

    poll()
    const id = setInterval(poll, 30_000)

    // Re-poll immediately when the window regains focus (e.g. after resolving
    // conflicts and switching apps, the badge updates without waiting 30 s).
    window.addEventListener('focus', poll)

    return () => {
      cancelled = true
      clearInterval(id)
      window.removeEventListener('focus', poll)
    }
  }, [currentView])

  return hasConflicts
}

function App() {
  const { currentView, pageStack, setView, navigateToPage, goBack } = useNavigationStore()
  const headerLabel = useHeaderLabel()
  const hasConflicts = useHasConflicts()
  const syncState = useSyncStore((s) => s.state)
  const syncPeers = useSyncStore((s) => s.peers)
  const { syncing, syncAll } = useSyncTrigger()
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
          .catch(() => toast.error('Failed to create page'))
      }
    }
    window.addEventListener('keydown', handleGlobalShortcuts)
    return () => window.removeEventListener('keydown', handleGlobalShortcuts)
  }, [])

  const handlePageSelect = useCallback(
    (pageId: string, title?: string, blockId?: string) => {
      navigateToPage(pageId, title ?? 'Untitled', blockId)
    },
    [navigateToPage],
  )

  const activePage = pageStack.length > 0 ? pageStack[pageStack.length - 1] : null

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
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {NAV_ITEMS.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={currentView === item.id}
                        aria-current={currentView === item.id ? 'page' : undefined}
                        tooltip={item.label}
                        onClick={() => setView(item.id)}
                      >
                        <item.icon />
                        <span>{item.label}</span>
                        {item.id === 'conflicts' && hasConflicts && (
                          <span
                            role="status"
                            className="ml-auto h-2 w-2 rounded-full bg-destructive"
                            aria-label="Has unresolved conflicts"
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
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip={syncing ? 'Syncing...' : 'Sync all devices'} onClick={syncAll} disabled={syncing}>
                  <RefreshCw className={syncing ? 'animate-spin' : ''} />
                  <span>Sync</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Shortcuts" onClick={() => setShortcutsOpen(true)}>
                  <Keyboard />
                  <span>Shortcuts</span>
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
              <span className="font-medium" data-testid="header-label">
                {headerLabel}
              </span>
            )}
          </header>
          <div
            ref={mainContentRef}
            tabIndex={-1}
            className="flex-1 overflow-y-auto p-4 md:p-6 outline-none"
          >
            {currentView === 'journal' && <JournalPage onNavigateToPage={handlePageSelect} />}
            {currentView === 'search' && <SearchPanel />}
            {currentView === 'pages' && <PageBrowser onPageSelect={handlePageSelect} />}
            {currentView === 'tags' && (
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
            )}
            {currentView === 'trash' && <TrashView />}
            {currentView === 'status' && <StatusPanel />}
            {currentView === 'conflicts' && <ConflictList />}
            {currentView === 'history' && <HistoryView />}
            {currentView === 'page-editor' && activePage && (
              <PageEditor
                pageId={activePage.pageId}
                title={activePage.title}
                onBack={goBack}
                onNavigateToPage={handlePageSelect}
              />
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
      <KeyboardShortcuts open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <Toaster position="bottom-right" richColors closeButton />
    </BootGate>
  )
}

export default App
