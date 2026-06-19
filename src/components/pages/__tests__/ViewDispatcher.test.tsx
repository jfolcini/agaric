/**
 * Tests for the `ViewDispatcher` component + the helper hooks
 * (`useHeaderLabel`, `useTrashCount`) that were extracted from App.tsx
 * in MAINT-124 step 4.
 *
 * Pins the new public surface in isolation; full integration scenarios
 * remain covered by the existing App.test.tsx.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import {
  useHeaderLabel,
  useTrashCount,
  ViewDispatcher,
  type ViewDispatcherProps,
} from '@/components/pages/ViewDispatcher'
import { t } from '@/lib/i18n'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, useTabsStore } from '@/stores/tabs'

// ---------------------------------------------------------------------------
// Lazy-view module mocks
// ---------------------------------------------------------------------------
//
// Each lazy-loaded view module is mocked with a synchronous module shape
// that returns a placeholder testid. `JournalPage` is not lazy-loaded but
// is rendered directly by the dispatcher; mock it the same way for
// uniformity (the real JournalPage drags in TipTap + a journal store
// boot path that we don't exercise here).
vi.mock('@/components/JournalPage', () => ({
  JournalPage: () => <div data-testid="journal-mock">journal</div>,
  JournalControls: () => <div />,
  GlobalDateControls: () => <div />,
}))
vi.mock('@/components/graph/GraphView', () => ({
  GraphView: () => <div data-testid="graph-view-mock">graph</div>,
}))
vi.mock('@/components/history/HistoryView', () => ({
  HistoryView: () => <div data-testid="history-view-mock">history</div>,
}))
vi.mock('@/components/PageBrowser', () => ({
  PageBrowser: () => <div data-testid="page-browser-mock">pages</div>,
}))
vi.mock('../PageEditor', () => ({
  PageEditor: ({ title }: { title: string }) => (
    <div data-testid="page-editor-mock">{`page-editor:${title}`}</div>
  ),
}))
vi.mock('@/components/SearchPanel', () => ({
  SearchPanel: () => <div data-testid="search-panel-mock">search</div>,
}))
vi.mock('../SettingsView', () => ({
  SettingsView: () => <div data-testid="settings-view-mock">settings</div>,
}))
vi.mock('@/components/agenda/StatusPanel', () => ({
  StatusPanel: () => <div data-testid="status-panel-mock">status</div>,
}))
vi.mock('@/components/TagsView', () => ({
  TagsView: () => <div data-testid="tags-view-mock">tags</div>,
}))
vi.mock('@/components/templates/TemplatesView', () => ({
  TemplatesView: () => <div data-testid="templates-view-mock">templates</div>,
}))
vi.mock('@/components/TrashView', () => ({
  TrashView: () => <div data-testid="trash-view-mock">trash</div>,
}))

const mockedInvoke = vi.mocked(invoke)
const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

function defaultProps(overrides: Partial<ViewDispatcherProps> = {}): ViewDispatcherProps {
  return {
    currentView: 'journal',
    activePage: null,
    onPageSelect: vi.fn(),
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
    ['tags', 'tags-view-mock'],
    ['trash', 'trash-view-mock'],
    ['settings', 'settings-view-mock'],
    ['status', 'status-panel-mock'],
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

  // #1723: a fresh-space switch can force currentView='page-editor' with a
  // null activePage (empty tab list). The branch must render an EmptyState
  // with a CTA, NOT return null (which painted a blank content region).
  it('renders an empty state (not null) for page-editor without an active page', () => {
    const { container } = render(
      <ViewDispatcher {...defaultProps({ currentView: 'page-editor', activePage: null })} />,
    )
    expect(container).not.toBeEmptyDOMElement()
    expect(screen.getByText(t('pageEditor.empty.message'))).toBeInTheDocument()
    // The page editor itself must NOT mount when there is no active page.
    expect(screen.queryByTestId('page-editor-mock')).not.toBeInTheDocument()
  })

  it('offers a Go to Journal CTA that switches the view when there is no active page', async () => {
    const user = userEvent.setup()
    useNavigationStore.setState({ currentView: 'page-editor' })
    render(<ViewDispatcher {...defaultProps({ currentView: 'page-editor', activePage: null })} />)

    const cta = screen.getByRole('button', { name: t('pageEditor.empty.goToJournal') })
    expect(cta).toBeInTheDocument()

    await user.click(cta)
    expect(useNavigationStore.getState().currentView).toBe('journal')
  })

  // #1577: the `default` branch is exhaustive over the `View` union via a
  // `never`-check (a compile error guards against a future missing case),
  // but at runtime an unknown view must still render a recoverable fallback
  // — never `return null`, which silently painted a blank content region.
  // We force an out-of-union value with a cast to exercise the branch.
  it('renders a recoverable fallback (not null) for an unknown view', () => {
    const { container } = render(
      <ViewDispatcher
        {...defaultProps({
          currentView: 'totally-unknown-view' as ViewDispatcherProps['currentView'],
        })}
      />,
    )
    expect(container).not.toBeEmptyDOMElement()
    expect(screen.getByText(t('pageEditor.empty.message'))).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: t('pageEditor.empty.goToJournal') }),
    ).toBeInTheDocument()
  })

  it('the unknown-view fallback CTA recovers to Journal', async () => {
    const user = userEvent.setup()
    useNavigationStore.setState({ currentView: 'page-editor' })
    render(
      <ViewDispatcher
        {...defaultProps({
          currentView: 'totally-unknown-view' as ViewDispatcherProps['currentView'],
        })}
      />,
    )

    await user.click(screen.getByRole('button', { name: t('pageEditor.empty.goToJournal') }))
    expect(useNavigationStore.getState().currentView).toBe('journal')
  })
})

// ---------------------------------------------------------------------------
// #1685 — fresh-space default render path (integration)
// ---------------------------------------------------------------------------
//
// The space-switch subscriber in navigation.ts:327 forces
// currentView='page-editor' when a user switches into a brand-new space
// (one with no recorded per-space view). For a fresh space the tab list is
// also empty, so App derives activePage=null. Prior coverage asserted only
// the store-state outcome (getState().currentView === 'page-editor') with no
// render, leaving the riskiest IA path — a fresh space's first paint —
// false-green. These tests drive the REAL space-switch subscriber (via
// useSpaceStore) and the REAL tabs store, then feed the resulting
// currentView + derived activePage into the dispatcher to assert the content
// region renders a real view (an EmptyState with a CTA), never null/blank.
describe('ViewDispatcher — fresh-space default render path (#1685)', () => {
  beforeEach(() => {
    // Start from "no active space" with empty per-space partitions so the
    // subscriber never races leftovers from a sibling test.
    useSpaceStore.setState({ currentSpaceId: null, availableSpaces: [], isReady: true })
    useNavigationStore.setState({ currentView: 'journal', currentViewBySpace: {} })
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [], label: '' }],
      activeTabIndex: 0,
      tabsBySpace: {},
      activeTabIndexBySpace: {},
    })
  })

  afterEach(() => {
    useSpaceStore.setState({ currentSpaceId: null, availableSpaces: [], isReady: true })
    useNavigationStore.setState({ currentView: 'journal', currentViewBySpace: {} })
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [], label: '' }],
      activeTabIndex: 0,
      tabsBySpace: {},
      activeTabIndexBySpace: {},
    })
  })

  // Mirror App.tsx:365 — activePage is the top of the active tab's stack, or
  // null when the stack is empty (the fresh-space case).
  function deriveActivePage() {
    const stack = selectPageStack(useTabsStore.getState())
    return stack.length > 0 ? (stack[stack.length - 1] ?? null) : null
  }

  it('renders a real view (EmptyState + CTA), not a blank region, after switching into a fresh space', () => {
    // space-1 was used on `search`; space-2 has never been visited.
    useSpaceStore.setState({
      currentSpaceId: 'space-1',
      availableSpaces: [
        { id: 'space-1', name: 'One', accent_color: null },
        { id: 'space-2', name: 'Two', accent_color: null },
      ],
      isReady: true,
    })
    useNavigationStore.getState().setView('search')

    // Switch into the fresh space-2 — drives the real navigation subscriber.
    useSpaceStore.setState({ currentSpaceId: 'space-2' })

    // The subscriber forced page-editor; the fresh space has no tabs → null.
    const currentView = useNavigationStore.getState().currentView
    expect(currentView).toBe('page-editor')
    const activePage = deriveActivePage()
    expect(activePage).toBeNull()

    const { container } = render(<ViewDispatcher {...defaultProps({ currentView, activePage })} />)

    // The riskiest IA path must paint something real, not an empty region.
    expect(container).not.toBeEmptyDOMElement()
    expect(screen.getByText(t('pageEditor.empty.message'))).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: t('pageEditor.empty.goToJournal') }),
    ).toBeInTheDocument()
    // The page editor itself must NOT mount without an active page.
    expect(screen.queryByTestId('page-editor-mock')).not.toBeInTheDocument()
  })

  it('the fresh-space CTA recovers to Journal', async () => {
    const user = userEvent.setup()
    useSpaceStore.setState({
      currentSpaceId: 'space-1',
      availableSpaces: [
        { id: 'space-1', name: 'One', accent_color: null },
        { id: 'space-2', name: 'Two', accent_color: null },
      ],
      isReady: true,
    })
    useNavigationStore.getState().setView('search')
    useSpaceStore.setState({ currentSpaceId: 'space-2' })

    render(
      <ViewDispatcher
        {...defaultProps({
          currentView: useNavigationStore.getState().currentView,
          activePage: deriveActivePage(),
        })}
      />,
    )

    await user.click(screen.getByRole('button', { name: t('pageEditor.empty.goToJournal') }))
    expect(useNavigationStore.getState().currentView).toBe('journal')
  })

  it('has no a11y violations rendering the fresh-space default', async () => {
    useSpaceStore.setState({
      currentSpaceId: 'space-1',
      availableSpaces: [
        { id: 'space-1', name: 'One', accent_color: null },
        { id: 'space-2', name: 'Two', accent_color: null },
      ],
      isReady: true,
    })
    useNavigationStore.getState().setView('search')
    useSpaceStore.setState({ currentSpaceId: 'space-2' })

    const { container } = render(
      <ViewDispatcher
        {...defaultProps({
          currentView: useNavigationStore.getState().currentView,
          activePage: deriveActivePage(),
        })}
      />,
    )
    await screen.findByText(t('pageEditor.empty.message'))
    const results = await axe(container)
    expect(results).toHaveNoViolations()
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

    vi.doMock('@/components/agenda/StatusPanel', () => statusImport)
    // Re-mock the dependencies the isolated dispatcher pulls in fresh.
    vi.doMock('@/components/JournalPage', () => ({
      JournalPage: () => <div />,
      JournalControls: () => <div />,
      GlobalDateControls: () => <div />,
    }))

    try {
      const { ViewDispatcher: IsolatedDispatcher } = await import('../ViewDispatcher')

      render(
        <IsolatedDispatcher
          currentView="status"
          activePage={null}
          onPageSelect={vi.fn()}
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
    } finally {
      vi.doUnmock('@/components/agenda/StatusPanel')
      vi.doUnmock('@/components/JournalPage')
    }
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
// useTrashCount polling
// ---------------------------------------------------------------------------

describe('useTrashCount', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls count_trash every 30 s', async () => {
    // The hook routes through the dedicated `count_trash` IPC (returns a
    // plain `number`) so the badge stays accurate regardless of trash size.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'count_trash') return 137 as unknown as never
      return emptyPage
    })

    const { result } = renderHook(() => useTrashCount())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const initialCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'count_trash').length
    expect(initialCalls).toBe(1)
    // 137 > 100 — the legacy shape would have clamped this to 100; the
    // new IPC returns the true count from `SELECT COUNT(*)`.
    expect(result.current).toBe(137)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    const afterTickCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'count_trash').length
    expect(afterTickCalls).toBe(2)
  })

  // IPC error-path (AGENTS.md:198 / check-ipc-error-path.mjs). When the
  // `countTrash` IPC rejects, the failure is SILENTLY handled: the polling
  // layer (`usePollingQuery`) catches it into `error` state, and
  // `useItemCount` ignores that error, returning the safe fallback `0`
  // (no toast, no banner — a stale/zero badge is preferable to crashing
  // the App shell over a transient count query). We assert the hook
  // reaches that safe state and never throws.
  it('returns 0 (no crash) when count_trash rejects', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'count_trash') throw new Error('boom')
      return emptyPage
    })

    const { result } = renderHook(() => useTrashCount())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // The rejection was swallowed by the polling layer; the badge count
    // falls back to 0 rather than surfacing an error to the user.
    expect(result.current).toBe(0)
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'count_trash').length).toBe(1)
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

  it('has no a11y violations rendering the page-editor empty state (#1723)', async () => {
    const { container } = render(
      <ViewDispatcher {...defaultProps({ currentView: 'page-editor', activePage: null })} />,
    )
    await screen.findByText(t('pageEditor.empty.message'))
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations rendering the unknown-view fallback (#1577)', async () => {
    const { container } = render(
      <ViewDispatcher
        {...defaultProps({
          currentView: 'totally-unknown-view' as ViewDispatcherProps['currentView'],
        })}
      />,
    )
    await screen.findByText(t('pageEditor.empty.message'))
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
