/**
 * HistoryView scoped to one page (#6535): the page menu writes the navigation
 * store's `pendingHistoryPage` handoff before switching to History, and the
 * view lists and restores that page only until the user asks for all pages.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyPage, makeHistoryEntry } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { stubInvoke, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { HistoryView } from '@/components/history/HistoryView'
import { t } from '@/lib/i18n'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/components/templates/CompactionCard', () => ({
  CompactionCard: () => <div data-testid="compaction-card" />,
}))
vi.mock('@/lib/announcer', () => ({ announce: vi.fn() }))
vi.mock('@tanstack/react-virtual', () => mockReactVirtual())

const mockedInvoke = vi.mocked(invoke)

const PAGE_A = { id: 'PAGE_A', title: 'Alpha page' }

const pageAHistory = {
  items: [makeHistoryEntry(7, 'edit_block', { to_text: 'alpha edit' }, 1736942400000)],
  next_cursor: null,
  has_more: false,
  total_count: null,
}

function stub(handlers: TypedInvokeHandlers): void {
  stubInvoke(mockedInvoke, {
    list_spaces: () => useSpaceStore.getState().availableSpaces,
    list_all_pages_in_space: () => [],
    list_all_tags_in_space: () => [],
    ...handlers,
  })
}

function listArgs(pageId: string) {
  return {
    pageId,
    opTypeFilter: null,
    scope: { kind: 'active', space_id: 'SPACE_1' },
    cursor: null,
    limit: 50,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_1',
    availableSpaces: [{ id: 'SPACE_1', name: 'Space 1', accent_color: null }],
  })
  useNavigationStore.setState({ pendingHistoryPage: PAGE_A })
  stub({
    list_page_history: (args) => (args['pageId'] === PAGE_A.id ? pageAHistory : emptyPage),
  })
})

describe('HistoryView scoped to a page', () => {
  it('lists the handed-off page, names it, and consumes the handoff', async () => {
    render(<HistoryView />)

    expect(await screen.findByText('alpha edit')).toBeInTheDocument()
    expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', listArgs(PAGE_A.id))
    expect(mockedInvoke).not.toHaveBeenCalledWith('list_page_history', listArgs('__all__'))
    expect(screen.getByText(t('history.pageScope', { title: PAGE_A.title }))).toBeInTheDocument()
    expect(useNavigationStore.getState().pendingHistoryPage).toBeNull()
    // Removing old history acts on every page, so a page's history leaves it out.
    expect(screen.queryByTestId('compaction-card')).not.toBeInTheDocument()
  })

  it('goes back to every page and moves focus to the list', async () => {
    const user = userEvent.setup()
    stub({
      list_page_history: (args) =>
        args['pageId'] === PAGE_A.id
          ? pageAHistory
          : {
              ...pageAHistory,
              items: [makeHistoryEntry(8, 'edit_block', { to_text: 'bravo edit' })],
            },
    })
    render(<HistoryView />)
    await screen.findByText('alpha edit')

    await user.click(screen.getByRole('button', { name: t('history.showAllPages') }))

    expect(await screen.findByText('bravo edit')).toBeInTheDocument()
    expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', listArgs('__all__'))
    expect(
      screen.queryByText(t('history.pageScope', { title: PAGE_A.title })),
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('compaction-card')).toBeInTheDocument()
    expect(screen.getByRole('grid', { name: t('history.entriesLabel') })).toHaveFocus()
  })

  it('lists every page when nothing was handed off', async () => {
    useNavigationStore.setState({ pendingHistoryPage: null })
    render(<HistoryView />)

    expect(await screen.findByText(t('history.emptyCurrentSpace'))).toBeInTheDocument()
    expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', listArgs('__all__'))
    expect(screen.getByTestId('compaction-card')).toBeInTheDocument()
  })

  it('drops the page when the space changes while mounted', async () => {
    render(<HistoryView />)
    await screen.findByText('alpha edit')

    act(() => {
      useSpaceStore.setState({
        currentSpaceId: 'SPACE_2',
        availableSpaces: [{ id: 'SPACE_2', name: 'Space 2', accent_color: null }],
      })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', {
        ...listArgs('__all__'),
        scope: { kind: 'active', space_id: 'SPACE_2' },
      })
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('list_page_history', {
      ...listArgs(PAGE_A.id),
      scope: { kind: 'active', space_id: 'SPACE_2' },
    })
    expect(
      screen.queryByText(t('history.pageScope', { title: PAGE_A.title })),
    ).not.toBeInTheDocument()
  })

  it('says the page has no changes when its history is empty', async () => {
    stub({ list_page_history: () => emptyPage })
    render(<HistoryView />)

    expect(await screen.findByText(t('history.emptyPage'))).toBeInTheDocument()
    expect(screen.queryByText(t('history.emptyCurrentSpace'))).not.toBeInTheDocument()
  })

  it('restores within the page, not across every page', async () => {
    const user = userEvent.setup()
    stub({
      list_page_history: (args) => (args['pageId'] === PAGE_A.id ? pageAHistory : emptyPage),
      restore_page_to_op: () => ({ ops_reverted: 1, non_reversible_skipped: 0, results: [] }),
    })
    render(<HistoryView />)
    await screen.findByText('alpha edit')

    await user.click(screen.getByRole('button', { name: t('history.restoreToHereLabel') }))
    await user.click(screen.getByRole('button', { name: t('history.restoreButton') }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('restore_page_to_op', {
        pageId: PAGE_A.id,
        targetDeviceId: 'DEVICE01',
        targetSeq: 7,
      })
    })
  })

  it('shows the error banner and keeps the page named when the scoped query rejects', async () => {
    stub({
      list_page_history: () => Promise.reject(new Error('history unavailable')),
    })
    render(<HistoryView />)

    expect(await screen.findByRole('alert')).toHaveTextContent(t('history.loadFailed'))
    expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', listArgs(PAGE_A.id))
    expect(screen.getByText(t('history.pageScope', { title: PAGE_A.title }))).toBeInTheDocument()
  })

  it('has no a11y violations while scoped', async () => {
    const { container } = render(<HistoryView />)
    await screen.findByText('alpha edit')

    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
