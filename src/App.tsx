import {
  Activity,
  Calendar,
  ChevronsLeft,
  FileText,
  GitMerge,
  Search,
  Tag,
  Trash2,
} from 'lucide-react'
import { useCallback } from 'react'
import { BootGate } from './components/BootGate'
import { ConflictList } from './components/ConflictList'
import { JournalPage } from './components/JournalPage'
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
import { useNavigationStore, type View } from './stores/navigation'

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
  if (currentView === 'page-editor' && pageStack.length > 0) {
    return pageStack[pageStack.length - 1].title
  }
  return NAV_ITEMS.find((item) => item.id === currentView)?.label ?? ''
}

function App() {
  const { currentView, pageStack, setView, navigateToPage, goBack } = useNavigationStore()
  const headerLabel = useHeaderLabel()

  const handlePageSelect = useCallback(
    (pageId: string, title?: string) => {
      navigateToPage(pageId, title ?? 'Untitled')
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
            <CollapseButton />
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="md:hidden" />
            <span className="font-medium">{headerLabel}</span>
          </header>
          <div className="flex-1 overflow-y-auto p-6">
            {currentView === 'journal' && <JournalPage onNavigateToPage={handlePageSelect} />}
            {currentView === 'search' && <SearchPanel />}
            {currentView === 'pages' && <PageBrowser onPageSelect={handlePageSelect} />}
            {currentView === 'tags' && (
              <div className="space-y-8">
                <TagList />
                <hr className="border-border" />
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
      <Toaster position="bottom-right" richColors closeButton />
    </BootGate>
  )
}

export default App
