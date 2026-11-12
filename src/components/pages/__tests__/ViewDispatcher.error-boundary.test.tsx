/**
 * #6554 — a view's error panel stays with that view. The dispatcher renders a
 * `FeatureErrorBoundary` at the same position for every view, so without a
 * key React keeps one boundary instance, and its `hasError` follows the user
 * into every other view, relabelled.
 */

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { ViewDispatcher, type ViewDispatcherProps } from '@/components/pages/ViewDispatcher'

vi.mock('@/components/JournalPage', () => ({
  JournalPage: () => <div data-testid="journal-mock" />,
}))
vi.mock('@/components/PageBrowser', () => ({
  PageBrowser: () => {
    throw new Error('pages blew up')
  },
}))
vi.mock('@/components/pages/PageEditor', () => ({
  PageEditor: ({ pageId }: { pageId: string }) => {
    if (pageId === 'PAGE_A') throw new Error('page A blew up')
    return <div data-testid={`page-editor-${pageId}`} />
  },
}))
vi.mock('@/components/AdvancedQuery/AdvancedQueryView', () => ({ AdvancedQueryView: () => null }))
vi.mock('@/components/graph/GraphView', () => ({ GraphView: () => null }))
vi.mock('@/components/history/HistoryView', () => ({ HistoryView: () => null }))
vi.mock('@/components/SearchPanel', () => ({ SearchPanel: () => null }))
vi.mock('@/components/pages/SettingsView', () => ({ SettingsView: () => null }))
vi.mock('@/components/TagsView', () => ({ TagsView: () => null }))
vi.mock('@/components/templates/TemplatesView', () => ({ TemplatesView: () => null }))
vi.mock('@/components/TrashView', () => ({ TrashView: () => null }))

function props(overrides: Partial<ViewDispatcherProps>): ViewDispatcherProps {
  return {
    currentView: 'journal',
    activePage: null,
    onPageSelect: vi.fn(),
    navigateToPage: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  // React and the boundary both log the deliberate render error.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ViewDispatcher — a crashed view keeps its error panel to itself (#6554)', () => {
  it('leaving a crashed view renders the next view, not the panel', async () => {
    const { rerender } = render(<ViewDispatcher {...props({ currentView: 'pages' })} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('pages blew up')

    rerender(<ViewDispatcher {...props({ currentView: 'journal' })} />)

    expect(screen.getByTestId('journal-mock')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('leaving a crashed page renders the next page, and the crashed one again on return', async () => {
    const pageA = { pageId: 'PAGE_A', title: 'A' }
    const pageB = { pageId: 'PAGE_B', title: 'B' }
    const { rerender } = render(
      <ViewDispatcher {...props({ currentView: 'page-editor', activePage: pageA })} />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('page A blew up')

    rerender(<ViewDispatcher {...props({ currentView: 'page-editor', activePage: pageB })} />)
    expect(await screen.findByTestId('page-editor-PAGE_B')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // Returning re-renders page A, which throws again: its own panel, as a view does.
    rerender(<ViewDispatcher {...props({ currentView: 'page-editor', activePage: pageA })} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('page A blew up')
  })

  it("the crashed view's panel has no a11y violations", async () => {
    const { container } = render(<ViewDispatcher {...props({ currentView: 'pages' })} />)
    await screen.findByRole('alert')

    expect(await axe(container)).toHaveNoViolations()
  })
})
