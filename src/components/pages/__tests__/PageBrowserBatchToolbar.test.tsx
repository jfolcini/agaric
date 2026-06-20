// @vitest-environment jsdom

/**
 * Tests for PageBrowserBatchToolbar (#81 / CORE scope).
 *
 * Validates the three bulk actions wired to the typed Tauri bindings:
 *  - Trash       → delete_blocks_by_ids
 *  - Add tag     → list_all_tags_in_space (picker) + add_tags_by_ids
 *  - Move space  → move_blocks_to_space (target list from the space store)
 *
 * Each action asserts the exact `invoke` command + args, that the
 * selection clears (`onClearSelection`) and the list refreshes
 * (`onMutated`) on success, and that errors surface via the toast.
 */

import { invoke } from '@tauri-apps/api/core'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { PageBrowserBatchToolbar } from '@/components/pages/PageBrowserBatchToolbar'
import { t } from '@/lib/i18n'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)
const mockedToastSuccess = vi.mocked(toast.success)
const mockedToastError = vi.mocked(toast.error)

const SELECTED = ['P1', 'P2', 'P3']

const tagRows = [
  { tag_id: 'TAG_A', name: 'alpha', usage_count: 2, updated_at: '2025-01-01T00:00:00Z' },
  { tag_id: 'TAG_B', name: 'beta', usage_count: 1, updated_at: '2025-01-01T00:00:00Z' },
]

function renderToolbar(overrides: Partial<Parameters<typeof PageBrowserBatchToolbar>[0]> = {}) {
  const onSelectAll = vi.fn()
  const onClearSelection = vi.fn()
  const onMutated = vi.fn()
  const utils = render(
    <PageBrowserBatchToolbar
      selectedIds={SELECTED}
      currentSpaceId="SPACE_TEST"
      onSelectAll={onSelectAll}
      onClearSelection={onClearSelection}
      onMutated={onMutated}
      {...overrides}
    />,
  )
  return { ...utils, onSelectAll, onClearSelection, onMutated }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [
      { id: 'SPACE_TEST', name: 'Test', accent_color: null },
      { id: 'SPACE_OTHER', name: 'Other', accent_color: null },
      { id: 'SPACE_THIRD', name: 'Third', accent_color: null },
    ],
    isReady: true,
  })
  mockedInvoke.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe('PageBrowserBatchToolbar', () => {
  it('renders the selection count and the three actions', () => {
    renderToolbar()
    expect(screen.getByText(t('batch.selectedCount', { count: 3 }))).toBeInTheDocument()
    expect(screen.getByTestId('page-batch-trash-btn')).toBeInTheDocument()
    expect(screen.getByTestId('page-batch-add-tag-btn')).toBeInTheDocument()
    expect(screen.getByTestId('page-batch-move-btn')).toBeInTheDocument()
  })

  it('Trash fires delete_blocks_by_ids and clears + refreshes on success', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(3) // delete_blocks_by_ids → count
    const { onClearSelection, onMutated } = renderToolbar()

    await user.click(screen.getByTestId('page-batch-trash-btn'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', { blockIds: SELECTED })
    })
    expect(onClearSelection).toHaveBeenCalledTimes(1)
    expect(onMutated).toHaveBeenCalledTimes(1)
    expect(mockedToastSuccess).toHaveBeenCalledWith(t('pageBrowser.batch.trashed', { count: 3 }))
  })

  it('Trash surfaces an error toast and does NOT clear on failure', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockRejectedValueOnce(new Error('backend boom'))
    const { onClearSelection, onMutated } = renderToolbar()

    await user.click(screen.getByTestId('page-batch-trash-btn'))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('pageBrowser.batch.trashFailed'))
    })
    expect(onClearSelection).not.toHaveBeenCalled()
    expect(onMutated).not.toHaveBeenCalled()
  })

  it('Add tag loads the space tags, fires add_tags_by_ids with the chosen tag, clears + refreshes', async () => {
    const user = userEvent.setup()
    // list_all_tags_in_space → tag rows; add_tags_by_ids → count
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_tags_in_space') return Promise.resolve(tagRows)
      if (cmd === 'add_tags_by_ids') return Promise.resolve(2)
      return Promise.resolve(undefined)
    })
    const { onClearSelection, onMutated } = renderToolbar()

    await user.click(screen.getByTestId('page-batch-add-tag-btn'))

    // Tag picker (mocked Radix Select → native <select>) appears with options.
    const select = await screen.findByRole('combobox', {
      name: t('pageBrowser.batch.tagPlaceholder'),
    })
    await waitFor(() => {
      expect(within(screenPicker()).getByRole('option', { name: 'alpha' })).toBeInTheDocument()
    })
    await user.selectOptions(select, 'TAG_A')

    await user.click(screen.getByTestId('page-batch-tag-confirm'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('add_tags_by_ids', {
        blockIds: SELECTED,
        tagId: 'TAG_A',
      })
    })
    expect(mockedInvoke).toHaveBeenCalledWith('list_all_tags_in_space', { spaceId: 'SPACE_TEST' })
    expect(onClearSelection).toHaveBeenCalledTimes(1)
    expect(onMutated).toHaveBeenCalledTimes(1)
    expect(mockedToastSuccess).toHaveBeenCalledWith(t('pageBrowser.batch.tagged', { count: 2 }))
  })

  it('Move to space lists target spaces (excluding current) and fires move_blocks_to_space', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'move_blocks_to_space') return Promise.resolve(3)
      return Promise.resolve(undefined)
    })
    const { onClearSelection, onMutated } = renderToolbar()

    await user.click(screen.getByTestId('page-batch-move-btn'))

    const select = await screen.findByRole('combobox', {
      name: t('pageBrowser.batch.spacePlaceholder'),
    })
    // Current space (Test) excluded; only Other + Third are offered.
    expect(within(screenPicker()).queryByRole('option', { name: 'Test' })).not.toBeInTheDocument()
    expect(within(screenPicker()).getByRole('option', { name: 'Other' })).toBeInTheDocument()
    expect(within(screenPicker()).getByRole('option', { name: 'Third' })).toBeInTheDocument()

    await user.selectOptions(select, 'SPACE_OTHER')
    await user.click(screen.getByTestId('page-batch-space-confirm'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('move_blocks_to_space', {
        blockIds: SELECTED,
        spaceId: 'SPACE_OTHER',
      })
    })
    expect(onClearSelection).toHaveBeenCalledTimes(1)
    expect(onMutated).toHaveBeenCalledTimes(1)
    expect(mockedToastSuccess).toHaveBeenCalledWith(t('pageBrowser.batch.moved', { count: 3 }))
  })

  it('has no a11y violations', async () => {
    const { container } = renderToolbar()
    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})

// The mocked Select renders the native <select> inside the toolbar; scope
// option queries to it so duplicate option text across pickers can't clash.
function screenPicker(): HTMLElement {
  return document.querySelector('[role="toolbar"]') as HTMLElement
}
