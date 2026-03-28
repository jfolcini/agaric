import './App.css'
import { useState } from 'react'
import { BootGate } from './components/BootGate'
import { JournalPage } from './components/JournalPage'
import { PageBrowser } from './components/PageBrowser'
import { TagPanel } from './components/TagPanel'
import { TrashView } from './components/TrashView'

type View = 'journal' | 'pages' | 'tags' | 'trash'

const NAV_ITEMS: { id: View; icon: string; label: string }[] = [
  { id: 'journal', icon: '\u{1F4C5}', label: 'Journal' },
  { id: 'pages', icon: '\u{1F4C4}', label: 'Pages' },
  { id: 'tags', icon: '\u{1F3F7}', label: 'Tags' },
  { id: 'trash', icon: '\u{1F5D1}', label: 'Trash' },
]

function App() {
  const [view, setView] = useState<View>('journal')
  const [collapsed, setCollapsed] = useState(false)

  return (
    <BootGate>
      <div className="app-layout">
        <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
          <button type="button" className="sidebar-toggle" onClick={() => setCollapsed((c) => !c)}>
            {collapsed ? '\u{25B6}' : '\u{25C0}'}
          </button>
          <nav className="sidebar-nav">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`sidebar-link${view === item.id ? ' active' : ''}`}
                onClick={() => setView(item.id)}
                title={item.label}
              >
                <span className="icon">{item.icon}</span>
                <span className="label">{item.label}</span>
              </button>
            ))}
          </nav>
        </aside>
        <main className="main-content">
          {view === 'journal' && <JournalPage />}
          {view === 'pages' && <PageBrowser onPageSelect={() => {}} />}
          {view === 'tags' && <TagPanel blockId={null} />}
          {view === 'trash' && <TrashView />}
        </main>
      </div>
    </BootGate>
  )
}

export default App
