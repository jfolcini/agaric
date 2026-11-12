/**
 * #6554 — a view's error panel stays with that view. The dispatcher renders a
 * `FeatureErrorBoundary` at the same position for every view, so without a
 * key React keeps one boundary instance, and its `hasError` follows the user
 * into every other view, relabelled.
 */

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { ViewDispatcher, type ViewDispatcherProps } from '@/components/pages/ViewDispatcher'

const broken = vi.hoisted(() => ({ view: '' }))

vi.mock('@/components/JournalPage', () => ({
  JournalPage: () => <div data-testid="journal-mock" />,
}))
vi.mock('@/components/PageBrowser', () => ({
  PageBrowser: () => {
    if (broken.view === 'pages') throw new Error('pages blew up')
    return null
  },
}))
vi.mock('@/components/pages/PageEditor', () => ({ PageEditor: () => null }))
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
  broken.view = ''
  vi.restoreAllMocks()
})

describe('ViewDispatcher — a crashed view keeps its error panel to itself (#6554)', () => {
  it('leaving a crashed view renders the next view, not the panel', async () => {
    broken.view = 'pages'
    const { rerender } = render(<ViewDispatcher {...props({ currentView: 'pages' })} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('pages blew up')

    rerender(<ViewDispatcher {...props({ currentView: 'journal' })} />)

    expect(screen.getByTestId('journal-mock')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('the error panel has no a11y violations', async () => {
    broken.view = 'pages'
    const { container } = render(<ViewDispatcher {...props({ currentView: 'pages' })} />)
    await screen.findByRole('alert')
    expect(await axe(container)).toHaveNoViolations()
  })
})
