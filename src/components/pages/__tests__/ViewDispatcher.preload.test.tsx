/**
 * #5444 — `ViewDispatcher` preloads every view chunk at idle, and a preloaded
 * view renders on its first visit without the Suspense fallback.
 *
 * Its own file because the lazy views are module singletons: once any test
 * renders a view, its chunk counts as loaded for the rest of the file.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ViewDispatcher, type ViewDispatcherProps } from '@/components/pages/ViewDispatcher'

const imported = vi.hoisted(() => new Set<string>())

vi.mock('@/components/JournalPage', () => ({
  JournalPage: () => <div data-testid="journal-mock" />,
}))
vi.mock('@/components/AdvancedQuery/AdvancedQueryView', () => {
  imported.add('AdvancedQueryView')
  return { AdvancedQueryView: () => <div /> }
})
vi.mock('@/components/graph/GraphView', () => {
  imported.add('GraphView')
  return { GraphView: () => <div /> }
})
vi.mock('@/components/history/HistoryView', () => {
  imported.add('HistoryView')
  return { HistoryView: () => <div /> }
})
vi.mock('@/components/PageBrowser', () => {
  imported.add('PageBrowser')
  return { PageBrowser: () => <div /> }
})
vi.mock('@/components/pages/PageEditor', () => {
  imported.add('PageEditor')
  return { PageEditor: () => <div /> }
})
vi.mock('@/components/SearchPanel', () => {
  imported.add('SearchPanel')
  return { SearchPanel: () => <div data-testid="search-panel-mock" /> }
})
vi.mock('@/components/pages/SettingsView', () => {
  imported.add('SettingsView')
  return { SettingsView: () => <div /> }
})
vi.mock('@/components/TagsView', () => {
  imported.add('TagsView')
  return { TagsView: () => <div /> }
})
vi.mock('@/components/templates/TemplatesView', () => {
  imported.add('TemplatesView')
  return { TemplatesView: () => <div /> }
})
vi.mock('@/components/TrashView', () => {
  imported.add('TrashView')
  return { TrashView: () => <div /> }
})

const props = (currentView: ViewDispatcherProps['currentView']): ViewDispatcherProps => ({
  currentView,
  activePage: null,
  onPageSelect: vi.fn(),
  navigateToPage: vi.fn(),
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ViewDispatcher — idle preload (#5444)', () => {
  it('loads every view chunk once, at idle, and the first visit skips the fallback', async () => {
    const idleCallbacks: Array<() => void> = []
    const requestIdle = vi.fn((cb: () => void) => idleCallbacks.push(cb))
    vi.stubGlobal('requestIdleCallback', requestIdle)
    vi.stubGlobal('cancelIdleCallback', vi.fn())

    const { rerender } = render(<ViewDispatcher {...props('journal')} />)
    expect(requestIdle).toHaveBeenCalledTimes(1)
    expect([...imported]).toEqual([])

    for (const cb of idleCallbacks) cb()
    await waitFor(() =>
      expect([...imported].toSorted()).toEqual([
        'AdvancedQueryView',
        'GraphView',
        'HistoryView',
        'PageBrowser',
        'PageEditor',
        'SearchPanel',
        'SettingsView',
        'TagsView',
        'TemplatesView',
        'TrashView',
      ]),
    )

    rerender(<ViewDispatcher {...props('search')} />)
    // Synchronous: a view that suspends shows `view-fallback` here instead.
    expect(screen.getByTestId('search-panel-mock')).toBeInTheDocument()
    expect(screen.queryByTestId('view-fallback')).not.toBeInTheDocument()
    expect(requestIdle).toHaveBeenCalledTimes(1)
  })
})
