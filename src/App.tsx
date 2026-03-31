import { addDays, addMonths, addWeeks, subDays, subMonths, subWeeks } from 'date-fns'
import {
  Activity,
  Calendar,
  ChevronsLeft,
  FileText,
  GitMerge,
  Keyboard,
  Search,
  Tag,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { BootGate } from './components/BootGate'
import { ConflictList } from './components/ConflictList'
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
import { createBlock } from './lib/tauri'
import { useJournalStore } from './stores/journal'
import { useNavigationStore, type View } from './stores/navigation'
import { useResolveStore } from './stores/resolve'

/** Sidebar nav items — page-editor is not listed here (it's navigated to programmatically). */
const NAV_ITEMS: { id: Exclude<View, 'page-editor'>; icon: React.ElementType; label: string }[] = [
  { id: 'journal', icon: Calendar, label: 'Journal' },
  { id: 'search', icon: Search, label: 'Search' },
  { id: 'pages', icon: FileText, label: 'Pages' },
  { id: 'tags', icon: Tag, label: 'Tags' },
  { id: 'trash', icon: Trash2, label: 'Trash' },
  { id: 'status', icon: Activity, label: 'Status' },
  { id: 'conflicts', icon: GitMerge, label: 'Conflicts' },
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

function App() {
  const { currentView, pageStack, setView, navigateToPage, goBack } = useNavigationStore()
  const headerLabel = useHeaderLabel()
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  // Preload the resolve cache (pages + tags) once on app boot
  useEffect(() => {
    useResolveStore.getState().preload()
  }, [])

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
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (mode === 'daily') setCurrentDate(addDays(currentDate, 1))
        else if (mode === 'weekly') setCurrentDate(addWeeks(currentDate, 1))
        else setCurrentDate(addMonths(currentDate, 1))
      }
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault()
        setCurrentDate(new Date())
      }
    }
    document.addEventListener('keydown', handleJournalNav)
    return () => document.removeEventListener('keydown', handleJournalNav)
  }, [])

  // ── Global shortcuts (Ctrl/Cmd+F for search, Ctrl/Cmd+N for new page) ──
  useEffect(() => {
    function handleGlobalShortcuts(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return

      if (e.key === 'f') {
        e.preventDefault()
        useNavigationStore.getState().setView('search')
      }

      if (e.key === 'n') {
        e.preventDefault()
        createBlock({ blockType: 'page', content: 'Untitled' }).then((resp) => {
          useNavigationStore.getState().navigateToPage(resp.id, 'Untitled')
        })
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
                        tooltip={item.label}
                        onClick={() => setView(item.id)}
                      >
                        <item.icon />
                        <span>{item.label}</span>
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
          <div className="flex-1 overflow-y-auto p-4 md:p-6">
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
