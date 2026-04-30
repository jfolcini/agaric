/**
 * Tests for the `ViewDispatcher` component + the helper hooks
 * (`useHeaderLabel`, `useConflictCount`, `useTrashCount`) that were
 * extracted from App.tsx in MAINT-124 step 4.
 *
 * Pins the new public surface in isolation; full integration scenarios
 * remain covered by the existing App.test.tsx.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '../../lib/i18n'
import { useNavigationStore } from '../../stores/navigation'
import { useTabsStore } from '../../stores/tabs'
import {
  useConflictCount,
  useHeaderLabel,
  useTrashCount,
  ViewDispatcher,
  type ViewDispatcherProps,
} from '../ViewDispatcher'

// ---------------------------------------------------------------------------
// Lazy-view module mocks
// ---------------------------------------------------------------------------
//
// Each lazy-loaded view module is mocked with a synchronous module shape
// that returns a placeholder testid. `JournalPage` is not lazy-loaded but
// is rendered directly by the dispatcher; mock it the same way for
// uniformity (the real JournalPage drags in TipTap + a journal store
// boot path that we don't exercise here).
vi.mock('../JournalPage', () => ({
  JournalPage: () => <div data-testid="journal-mock">journal</div>,
  JournalControls: () => <div />,
  GlobalDateControls: () => <div />,
}))
vi.mock('../ConflictList', () => ({
  ConflictList: () => <div data-testid="conflict-list-mock">conflicts</div>,
}))
vi.mock('../GraphView', () => ({
  GraphView: () => <div data-testid="graph-view-mock">graph</div>,
}))
vi.mock('../HistoryView', () => ({
  HistoryView: () => <div data-testid="history-view-mock">history</div>,
}))
vi.mock('../PageBrowser', () => ({
  PageBrowser: () => <div data-testid="page-browser-mock">pages</div>,
}))
vi.mock('../PageEditor', () => ({
  PageEditor: ({ title }: { title: string }) => (
    <div data-testid="page-editor-mock">{`page-editor:${title}`}</div>
  ),
}))
vi.mock('../PropertiesView', () => ({
  PropertiesView: () => <div data-testid="properties-view-mock">properties</div>,
}))
vi.mock('../SearchPanel', () => ({
  SearchPanel: () => <div data-testid="search-panel-mock">search</div>,
}))
vi.mock('../SettingsView', () => ({
  SettingsView: () => <div data-testid="settings-view-mock">settings</div>,
}))
vi.mock('../StatusPanel', () => ({
  StatusPanel: () => <div data-testid="status-panel-mock">status</div>,
}))
vi.mock('../TagFilterPanel', () => ({
  TagFilterPanel: () => <div data-testid="tag-filter-panel-mock">tag-filter</div>,
}))
vi.mock('../TagList', () => ({
  TagList: () => <div data-testid="tag-list-mock">tag-list</div>,
}))
vi.mock('../TemplatesView', () => ({
  TemplatesView: () => <div data-testid="templates-view-mock">templates</div>,
}))
vi.mock('../TrashView', () => ({
  TrashView: () => <div data-testid="trash-view-mock">trash</div>,
}))

const mockedInvoke = vi.mocked(invoke)
const emptyPage = { items: [], next_cursor: null, has_more: false }

function defaultProps(overrides: Partial<ViewDispatcherProps> = {}): ViewDispatcherProps {
  return {
    currentView: 'journal',
    activePage: null,
    onPageSelect: vi.fn(),
    onBack: vi.fn(),
    navigateToPage: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue(emptyPage)
})

afterEach(() => {
  // Reset navigation store state so `useHeaderLabel` tests don't leak
  // their `currentView` between cases.
  useNavigationStore.setState({ currentView: 'journal' })
})

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('ViewDispatcher — routing', () => {
  // Each non-page-editor branch maps a `currentView` value to the test-id
  // its mock placeholder renders. Driven via `it.each` to keep the suite
  // a one-line-per-route table — adding a future view amounts to one row.
  const routes: Array<[ViewDispatcherProps['currentView'], string]> = [
    ['journal', 'journal-mock'],
    ['search', 'search-panel-mock'],
    ['pages', 'page-browser-mock'],
    ['tags', 'tag-list-mock'],
    ['trash', 'trash-view-mock'],
    ['properties', 'properties-view-mock'],
    ['settings', 'settings-view-mock'],
    ['status', 'status-panel-mock'],
    ['conflicts', 'conflict-list-mock'],
    ['history', 'history-view-mock'],
    ['templates', 'templates-view-mock'],
    ['graph', 'graph-view-mock'],
  ]

  it.each(routes)('routes currentView=%s to its view component', async (view, testid) => {
    render(<ViewDispatcher {...defaultProps({ currentView: view })} />)
    expect(await screen.findByTestId(testid)).toBeInTheDocument()
  })

  it('renders the page editor when activePage is set', async () => {
    render(
      <ViewDispatcher
        {...defaultProps({
          currentView: 'page-editor',
          activePage: { pageId: 'P1', title: 'Hello' },
        })}
      />,
    )
    const node = await screen.findByTestId('page-editor-mock')
    expect(node).toHaveTextContent('page-editor:Hello')
  })

  it('renders nothing for page-editor without an active page', () => {
    const { container } = render(
      <ViewDispatcher {...defaultProps({ currentView: 'page-editor', activePage: null })} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

// ---------------------------------------------------------------------------
// Suspense fallback
// ---------------------------------------------------------------------------

describe('ViewDispatcher — Suspense fallback', () => {
  it('renders ViewFallback during async load and replaces it once resolved', async () => {
    // Trigger a fresh module-level Suspense by importing a separate copy
    // of the dispatcher that hasn't seen the deferred view module yet.
    // We achieve this by isolating modules + a deferred `vi.doMock` for
    // a single view (`StatusPanel` — picked because none of the routing
    // tests above resolve its module).
    vi.resetModules()

    let resolveStatus: (mod: { StatusPanel: () => ReactElement }) => void = () => {}
    const statusImport = new Promise<{ StatusPanel: () => ReactElement }>((r) => {
      resolveStatus = r
    })

    vi.doMock('../StatusPanel', () => statusImport)
    // Re-mock the dependencies the isolated dispatcher pulls in fresh.
    vi.doMock('../JournalPage', () => ({
      JournalPage: () => <div />,
      JournalControls: () => <div />,
      GlobalDateControls: () => <div />,
    }))

    const { ViewDispatcher: IsolatedDispatcher } = await import('../ViewDispatcher')

    render(
      <IsolatedDispatcher
        currentView="status"
        activePage={null}
        onPageSelect={vi.fn()}
        onBack={vi.fn()}
        navigateToPage={vi.fn()}
      />,
    )

    // Fallback present while the lazy import is unresolved.
    expect(await screen.findByTestId('view-fallback')).toBeInTheDocument()
    expect(screen.queryByTestId('status-panel-real')).not.toBeInTheDocument()

    // Resolve the deferred module — fallback should disappear and the
    // resolved component should mount.
    await act(async () => {
      resolveStatus({
        StatusPanel: () => <div data-testid="status-panel-real">status-loaded</div>,
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('status-panel-real')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('view-fallback')).not.toBeInTheDocument()

    vi.doUnmock('../StatusPanel')
    vi.doUnmock('../JournalPage')
  })
})

// ---------------------------------------------------------------------------
// useHeaderLabel
// ---------------------------------------------------------------------------

describe('useHeaderLabel', () => {
  it('returns the translated label for the active sidebar view', () => {
    useNavigationStore.setState({ currentView: 'pages' })
    const { result } = renderHook(() => useHeaderLabel())
    expect(result.current).toBe(t('sidebar.pages'))
  })

  it('returns an empty string when on page-editor with a non-empty page stack', () => {
    useNavigationStore.setState({ currentView: 'page-editor' })
    useTabsStore.getState().navigateToPage('PAGE_X', 'Hello')
    const { result } = renderHook(() => useHeaderLabel())
    expect(result.current).toBe('')
  })
})

// ---------------------------------------------------------------------------
// useConflictCount / useTrashCount polling
// ---------------------------------------------------------------------------

describe('useConflictCount', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls get_conflicts every 30 s', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_conflicts')
        return { items: [{ id: 'c1' }, { id: 'c2' }], next_cursor: null, has_more: false }
      return emptyPage
    })

    const { result } = renderHook(() => useConflictCount())

    // Initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockedInvoke).toHaveBeenCalledWith('get_conflicts', expect.any(Object))
    const initialCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_conflicts').length
    expect(initialCalls).toBe(1)
    expect(result.current).toBe(2)

    // Advance to the next polling tick
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    const afterTickCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_conflicts').length
    expect(afterTickCalls).toBe(2)
  })
})

describe('useTrashCount', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls list_blocks (showDeleted) every 30 s', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks')
        return {
          items: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }],
          next_cursor: null,
          has_more: false,
        }
      return emptyPage
    })

    const { result } = renderHook(() => useTrashCount())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const initialCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks').length
    expect(initialCalls).toBe(1)
    expect(result.current).toBe(3)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    const afterTickCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks').length
    expect(afterTickCalls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe('ViewDispatcher — a11y', () => {
  it('has no a11y violations when rendering a routed view', async () => {
    const { container } = render(<ViewDispatcher {...defaultProps({ currentView: 'pages' })} />)
    await screen.findByTestId('page-browser-mock')
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
