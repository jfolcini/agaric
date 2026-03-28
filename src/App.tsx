import { Calendar, ChevronsLeft, FileText, Tag, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { BootGate } from './components/BootGate'
import { JournalPage } from './components/JournalPage'
import { PageBrowser } from './components/PageBrowser'
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

type View = 'journal' | 'pages' | 'tags' | 'trash'

const NAV_ITEMS: { id: View; icon: React.ElementType; label: string }[] = [
  { id: 'journal', icon: Calendar, label: 'Journal' },
  { id: 'pages', icon: FileText, label: 'Pages' },
  { id: 'tags', icon: Tag, label: 'Tags' },
  { id: 'trash', icon: Trash2, label: 'Trash' },
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

function App() {
  const [view, setView] = useState<View>('journal')

  return (
    <BootGate>
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader className="p-4 pb-2">
            <div className="flex h-7 items-center gap-2 group-data-[collapsible=icon]:justify-center">
              <span className="hidden text-lg font-bold leading-none group-data-[collapsible=icon]:block">
                A
              </span>
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
                        isActive={view === item.id}
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
            <span className="font-medium">{NAV_ITEMS.find((item) => item.id === view)?.label}</span>
          </header>
          <div className="flex-1 overflow-y-auto p-6">
            {view === 'journal' && <JournalPage />}
            {view === 'pages' && <PageBrowser onPageSelect={() => {}} />}
            {view === 'tags' && <TagList />}
            {view === 'trash' && <TrashView />}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </BootGate>
  )
}

export default App
