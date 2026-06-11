// @vitest-environment jsdom
// PEND-37: pin to jsdom (matches the sibling PageBrowser.test.tsx) so the
// virtualizer mock behaves deterministically.

/**
 * Multi-select + batch toolbar tests for PageBrowser (#81 / PEND-57).
 *
 * Validates the additive selection mode layered onto the Pages view:
 *  - clicking a row's checkbox selects it; the batch toolbar appears with
 *    the live count;
 *  - shift-click selects a contiguous range;
 *  - Cmd/Ctrl+A selects every visible page; Escape clears;
 *  - the three bulk actions fire the correct typed IPC and clear the
 *    selection on success.
 *
 * Kept in a dedicated file so the 170KB sibling PageBrowser.test.tsx is
 * untouched. Mirrors that file's virtualizer + space-store setup.
 */

import { invoke } from '@tauri-apps/api/core'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { t } from '@/lib/i18n'

import { makePage } from '../../__tests__/fixtures'
import { usePageBrowserFiltersStore } from '../../stores/pageBrowserFilters'
import { useSpaceStore } from '../../stores/space'
import { PageBrowser } from '../PageBrowser'

// Render-all virtualizer mock (jsdom has zero-height containers). Shared
// helper, default mode (see src/__tests__/mocks/react-virtual.ts).
vi.mock('@tanstack/react-virtual', () => mockReactVirtual())

const mockedInvoke = vi.mocked(invoke)
const mockedToastSuccess = vi.mocked(toast.success)
const mockedToastError = vi.mocked(toast.error)

const PAGES = [
  makePage({ id: 'P1', content: 'Alpha' }),
  makePage({ id: 'P2', content: 'Bravo' }),
  makePage({ id: 'P3', content: 'Charlie' }),
  makePage({ id: 'P4', content: 'Delta' }),
]

/** Seed the page list (flagOn metadata path consumes the first invoke). */
function mockPageList() {
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
    if (cmd === 'list_pages_with_metadata' || cmd === 'list_blocks') {
      return Promise.resolve({
        items: PAGES,
        next_cursor: null,
        has_more: false,
        total_count: PAGES.length,
      })
    }
    return Promise.resolve(undefined)
  })
}

/** The selection checkbox for a given page id. */
function selectCheckbox(id: string): HTMLElement {
  return screen.getByTestId(`page-select-${id}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  localStorage.removeItem('starred-pages')
  localStorage.removeItem('pageBrowser.densityV1')
  usePageBrowserFiltersStore.setState({ filtersBySpace: {}, nextAddId: 0 })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [
      { id: 'SPACE_TEST', name: 'Test', accent_color: null },
      { id: 'SPACE_OTHER', name: 'Other', accent_color: null },
    ],
    isReady: true,
  })
  mockPageList()
})

afterEach(() => {
  cleanup()
})

describe('PageBrowser multi-select', () => {
  it('clicking a checkbox selects a page and reveals the toolbar with the count', async () => {
    const user = userEvent.setup()
    render(<PageBrowser />)
    await screen.findByText('Alpha')

    // No toolbar before any selection.
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()

    await user.click(selectCheckbox('P1'))

    expect(await screen.findByRole('toolbar')).toBeInTheDocument()
    expect(screen.getByText(t('batch.selectedCount', { count: 1 }))).toBeInTheDocument()

    await user.click(selectCheckbox('P2'))
    expect(screen.getByText(t('batch.selectedCount', { count: 2 }))).toBeInTheDocument()
  })

  it('shift-click selects a contiguous range', async () => {
    const user = userEvent.setup()
    render(<PageBrowser />)
    await screen.findByText('Alpha')

    await user.click(selectCheckbox('P1'))
    // Shift-click the 4th row → P1..P4 all selected.
    await user.keyboard('{Shift>}')
    await user.click(selectCheckbox('P4'))
    await user.keyboard('{/Shift}')

    expect(screen.getByText(t('batch.selectedCount', { count: 4 }))).toBeInTheDocument()
  })

  it('Cmd/Ctrl+A selects all visible pages and Escape clears', async () => {
    const user = userEvent.setup()
    render(<PageBrowser />)
    await screen.findByText('Alpha')

    await user.keyboard('{Control>}a{/Control}')
    expect(await screen.findByRole('toolbar')).toBeInTheDocument()
    expect(screen.getByText(t('batch.selectedCount', { count: 4 }))).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    })
  })

  it('bulk Trash fires delete_blocks_by_ids with the selected ids and clears', async () => {
    const user = userEvent.setup()
    render(<PageBrowser />)
    await screen.findByText('Alpha')

    await user.click(selectCheckbox('P1'))
    await user.click(selectCheckbox('P3'))

    mockedInvoke.mockResolvedValueOnce(2) // delete_blocks_by_ids count
    await user.click(screen.getByTestId('page-batch-trash-btn'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', { blockIds: ['P1', 'P3'] })
    })
    // Selection cleared → toolbar gone.
    await waitFor(() => {
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith(t('pageBrowser.batch.trashed', { count: 2 }))
  })

  it('bulk Add tag fires add_tags_by_ids with the chosen tag and clears', async () => {
    const user = userEvent.setup()
    render(<PageBrowser />)
    await screen.findByText('Alpha')

    await user.click(selectCheckbox('P2'))

    // Open the tag picker; the toolbar lazily loads the space tags.
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_tags_in_space')
        return Promise.resolve([
          { tag_id: 'TAG_A', name: 'alpha', usage_count: 1, updated_at: '2025-01-01T00:00:00Z' },
        ])
      if (cmd === 'add_tags_by_ids') return Promise.resolve(1)
      return Promise.resolve(undefined)
    })

    await user.click(screen.getByTestId('page-batch-add-tag-btn'))
    const select = await screen.findByRole('combobox', {
      name: t('pageBrowser.batch.tagPlaceholder'),
    })
    await waitFor(() => {
      expect(within(select).getByRole('option', { name: 'alpha' })).toBeInTheDocument()
    })
    await user.selectOptions(select, 'TAG_A')
    await user.click(screen.getByTestId('page-batch-tag-confirm'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('add_tags_by_ids', {
        blockIds: ['P2'],
        tagId: 'TAG_A',
      })
    })
    await waitFor(() => {
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    })
  })

  it('bulk Move to space fires move_blocks_to_space with the chosen target and clears', async () => {
    const user = userEvent.setup()
    render(<PageBrowser />)
    await screen.findByText('Alpha')

    await user.click(selectCheckbox('P1'))

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'move_blocks_to_space') return Promise.resolve(1)
      return Promise.resolve(undefined)
    })

    await user.click(screen.getByTestId('page-batch-move-btn'))
    const select = await screen.findByRole('combobox', {
      name: t('pageBrowser.batch.spacePlaceholder'),
    })
    await user.selectOptions(select, 'SPACE_OTHER')
    await user.click(screen.getByTestId('page-batch-space-confirm'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('move_blocks_to_space', {
        blockIds: ['P1'],
        spaceId: 'SPACE_OTHER',
      })
    })
    await waitFor(() => {
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    })
  })

  it('surfaces an error toast when a bulk action fails', async () => {
    const user = userEvent.setup()
    render(<PageBrowser />)
    await screen.findByText('Alpha')

    await user.click(selectCheckbox('P1'))

    mockedInvoke.mockRejectedValueOnce(new Error('backend boom'))
    await user.click(screen.getByTestId('page-batch-trash-btn'))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('pageBrowser.batch.trashFailed'))
    })
    // Failure leaves the selection intact (toolbar still present).
    expect(screen.getByRole('toolbar')).toBeInTheDocument()
  })

  it('has no a11y violations with a selection active', async () => {
    const user = userEvent.setup()
    const { container } = render(<PageBrowser />)
    await screen.findByText('Alpha')
    await user.click(selectCheckbox('P1'))
    await screen.findByRole('toolbar')
    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
