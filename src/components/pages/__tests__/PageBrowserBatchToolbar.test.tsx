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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { strictInvokeFallback } from '@/__tests__/helpers/invoke'
import { PageBrowserBatchToolbar } from '@/components/pages/PageBrowserBatchToolbar'
import { t } from '@/lib/i18n'
import { getStarredPages } from '@/lib/starred-pages'
import { setPropertyBatch } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

// Partial-mock the typed tauri lib so the bulk set-property path can be
// asserted directly (ids/key/value) without threading through `invoke`. All
// OTHER wrappers (trash/tag/space) keep their real implementation and still
// hit the mocked `invoke`.
vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>()
  return { ...actual, setPropertyBatch: vi.fn() }
})

const mockedInvoke = vi.mocked(invoke)
const mockedSetPropertyBatch = vi.mocked(setPropertyBatch)
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
  localStorage.clear()
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

  // #3339 — the batch trash cascades a soft-delete over every selected root's
  // whole subtree and "Select all" is one Ctrl/Cmd+A away, so the toolbar
  // button must open the app's ConfirmDialog rather than fire the IPC.
  it('Trash asks for confirmation and fires nothing until the user confirms', async () => {
    const user = userEvent.setup()
    const { onClearSelection, onMutated } = renderToolbar()

    await user.click(screen.getByTestId('page-batch-trash-btn'))

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_blocks_by_ids', expect.anything())
    expect(onClearSelection).not.toHaveBeenCalled()
    expect(onMutated).not.toHaveBeenCalled()

    // Cancelling leaves everything untouched.
    await user.click(screen.getByRole('button', { name: t('dialog.cancel') }))
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_blocks_by_ids', expect.anything())
  })

  it('Trash fires delete_blocks_by_ids and clears + refreshes once confirmed', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(3) // delete_blocks_by_ids → count
    const { onClearSelection, onMutated } = renderToolbar()

    await user.click(screen.getByTestId('page-batch-trash-btn'))
    await user.click(
      await screen.findByRole('button', { name: t('pageBrowser.batch.trashConfirmAction') }),
    )

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', { blockIds: SELECTED })
    })
    expect(onClearSelection).toHaveBeenCalledTimes(1)
    expect(onMutated).toHaveBeenCalledTimes(1)
    expect(mockedToastSuccess).toHaveBeenCalledWith(
      t('pageBrowser.batch.trashed', { count: 3 }),
      expect.objectContaining({
        action: expect.objectContaining({ label: t('action.undo') }),
      }),
    )
  })

  // #3339 — the success toast's Undo must restore the SAME id list, via the
  // list-accepting IPC `usePageDeleteAction` already uses.
  it('the success toast exposes an Undo that restores the trashed ids', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(3)
    const { onMutated } = renderToolbar()

    await user.click(screen.getByTestId('page-batch-trash-btn'))
    await user.click(
      await screen.findByRole('button', { name: t('pageBrowser.batch.trashConfirmAction') }),
    )
    await waitFor(() => {
      expect(mockedToastSuccess).toHaveBeenCalled()
    })

    const call = mockedToastSuccess.mock.calls.at(-1)
    const undo = (call?.[1] as { action?: { label?: string; onClick?: () => void } } | undefined)
      ?.action
    expect(undo?.label).toBe(t('action.undo'))

    mockedInvoke.mockResolvedValueOnce({ restored: SELECTED.length })
    undo?.onClick?.()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('restore_blocks_by_ids', { blockIds: SELECTED })
    })
    // The list refreshes again so the restored pages reappear.
    await waitFor(() => {
      expect(onMutated).toHaveBeenCalledTimes(2)
    })
  })

  it('Trash surfaces an error toast with Retry and does NOT clear on failure', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockRejectedValueOnce(new Error('backend boom'))
    const { onClearSelection, onMutated } = renderToolbar()

    await user.click(screen.getByTestId('page-batch-trash-btn'))
    await user.click(
      await screen.findByRole('button', { name: t('pageBrowser.batch.trashConfirmAction') }),
    )

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(
        t('pageBrowser.batch.trashFailed'),
        expect.objectContaining({
          action: expect.objectContaining({ label: t('action.retry') }),
        }),
      )
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
      return strictInvokeFallback(cmd)
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
    expect(mockedInvoke).toHaveBeenCalledWith('list_all_tags_in_space', {
      scope: { kind: 'active', space_id: 'SPACE_TEST' },
    })
    expect(onClearSelection).toHaveBeenCalledTimes(1)
    expect(onMutated).toHaveBeenCalledTimes(1)
    expect(mockedToastSuccess).toHaveBeenCalledWith(t('pageBrowser.batch.tagged', { count: 2 }))
  })

  it('Move to space lists target spaces (excluding current) and fires move_blocks_to_space', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'move_blocks_to_space') return Promise.resolve(3)
      return strictInvokeFallback(cmd)
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

  it('Set property: choosing todo_state=DONE fires setPropertyBatch, clears + refreshes + notifies', async () => {
    const user = userEvent.setup()
    mockedSetPropertyBatch.mockResolvedValueOnce(3)
    const { onClearSelection, onMutated } = renderToolbar()

    await user.click(screen.getByTestId('page-batch-set-property-btn'))

    const propertySelect = await screen.findByRole('combobox', {
      name: t('pageBrowser.batch.propertyPlaceholder'),
    })
    await user.selectOptions(propertySelect, 'todo_state')

    const valueSelect = await screen.findByRole('combobox', {
      name: t('pageBrowser.batch.valuePlaceholder'),
    })
    await user.selectOptions(valueSelect, 'DONE')

    await user.click(screen.getByTestId('page-batch-property-confirm'))

    await waitFor(() => {
      expect(mockedSetPropertyBatch).toHaveBeenCalledWith(SELECTED, 'todo_state', 'DONE')
    })
    expect(onClearSelection).toHaveBeenCalledTimes(1)
    expect(onMutated).toHaveBeenCalledTimes(1)
    expect(mockedToastSuccess).toHaveBeenCalledWith(
      t('pageBrowser.batch.propertySet', { count: 3 }),
    )
  })

  it('Set property: a date key routes a date value through setPropertyBatch', async () => {
    const user = userEvent.setup()
    mockedSetPropertyBatch.mockResolvedValueOnce(2)
    renderToolbar()

    await user.click(screen.getByTestId('page-batch-set-property-btn'))

    const propertySelect = await screen.findByRole('combobox', {
      name: t('pageBrowser.batch.propertyPlaceholder'),
    })
    await user.selectOptions(propertySelect, 'due_date')

    const dateInput = await screen.findByTestId('page-batch-property-date')
    fireEvent.change(dateInput, { target: { value: '2026-07-10' } })

    await user.click(screen.getByTestId('page-batch-property-confirm'))

    await waitFor(() => {
      expect(mockedSetPropertyBatch).toHaveBeenCalledWith(SELECTED, 'due_date', '2026-07-10')
    })
  })

  it('Set property: the Clear value option sends null to clear the property', async () => {
    const user = userEvent.setup()
    mockedSetPropertyBatch.mockResolvedValueOnce(3)
    renderToolbar()

    await user.click(screen.getByTestId('page-batch-set-property-btn'))

    const propertySelect = await screen.findByRole('combobox', {
      name: t('pageBrowser.batch.propertyPlaceholder'),
    })
    await user.selectOptions(propertySelect, 'priority')

    const valueSelect = await screen.findByRole('combobox', {
      name: t('pageBrowser.batch.valuePlaceholder'),
    })
    await user.selectOptions(valueSelect, '__clear__')

    await user.click(screen.getByTestId('page-batch-property-confirm'))

    await waitFor(() => {
      expect(mockedSetPropertyBatch).toHaveBeenCalledWith(SELECTED, 'priority', null)
    })
  })

  it('Set property: surfaces an error toast and does NOT clear on failure', async () => {
    const user = userEvent.setup()
    mockedSetPropertyBatch.mockRejectedValueOnce(new Error('backend boom'))
    const { onClearSelection, onMutated } = renderToolbar()

    await user.click(screen.getByTestId('page-batch-set-property-btn'))
    const propertySelect = await screen.findByRole('combobox', {
      name: t('pageBrowser.batch.propertyPlaceholder'),
    })
    await user.selectOptions(propertySelect, 'todo_state')
    const valueSelect = await screen.findByRole('combobox', {
      name: t('pageBrowser.batch.valuePlaceholder'),
    })
    await user.selectOptions(valueSelect, 'TODO')
    await user.click(screen.getByTestId('page-batch-property-confirm'))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('pageBrowser.batch.setPropertyFailed'))
    })
    expect(onClearSelection).not.toHaveBeenCalled()
    expect(onMutated).not.toHaveBeenCalled()
  })

  it('the set-property picker has no a11y violations', async () => {
    const user = userEvent.setup()
    const { container } = renderToolbar()
    await user.click(screen.getByTestId('page-batch-set-property-btn'))
    await screen.findByRole('combobox', { name: t('pageBrowser.batch.propertyPlaceholder') })
    await user.selectOptions(
      screen.getByRole('combobox', { name: t('pageBrowser.batch.propertyPlaceholder') }),
      'todo_state',
    )
    await screen.findByRole('combobox', { name: t('pageBrowser.batch.valuePlaceholder') })
    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  it('renders a Star button (no page starred yet) and stars the whole selection + clears on click', async () => {
    const user = userEvent.setup()
    const { onClearSelection, onMutated } = renderToolbar()

    const starBtn = screen.getByTestId('page-batch-star-btn')
    expect(starBtn).toBeInTheDocument()
    expect(screen.queryByTestId('page-batch-unstar-btn')).not.toBeInTheDocument()

    await user.click(starBtn)

    // Pure-FE: the whole selection is now starred in localStorage, selection
    // clears, and no backend mutation / list-refresh is triggered.
    expect(getStarredPages()).toEqual(SELECTED)
    expect(onClearSelection).toHaveBeenCalledTimes(1)
    expect(onMutated).not.toHaveBeenCalled()
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('renders an Unstar button when every selected page is already starred and unstars on click', async () => {
    const user = userEvent.setup()
    localStorage.setItem('starred-pages', JSON.stringify(SELECTED))
    const { onClearSelection } = renderToolbar()

    const unstarBtn = screen.getByTestId('page-batch-unstar-btn')
    expect(unstarBtn).toBeInTheDocument()
    expect(screen.queryByTestId('page-batch-star-btn')).not.toBeInTheDocument()

    await user.click(unstarBtn)

    expect(getStarredPages()).toEqual([])
    expect(onClearSelection).toHaveBeenCalledTimes(1)
  })

  it('mixed selection (some starred, some not) renders Star (not Unstar) and stars the whole selection on click', async () => {
    const user = userEvent.setup()
    // Only P1 is starred going in; P2/P3 are not — the selection is NOT
    // fully starred, so the toggle must read as "Star", never "Unstar".
    localStorage.setItem('starred-pages', JSON.stringify(['P1']))
    const { onClearSelection } = renderToolbar()

    const starBtn = screen.getByTestId('page-batch-star-btn')
    expect(starBtn).toBeInTheDocument()
    expect(screen.queryByTestId('page-batch-unstar-btn')).not.toBeInTheDocument()

    await user.click(starBtn)

    // Clicking "Star" on a mixed selection stars the WHOLE selection
    // (least-surprising toggle reading), leaving the already-starred page
    // starred (idempotent) and adding the rest.
    expect(getStarredPages().toSorted()).toEqual(SELECTED.toSorted())
    expect(onClearSelection).toHaveBeenCalledTimes(1)
  })

  it('the star toggle control has no a11y violations', async () => {
    const { container } = renderToolbar()
    const starBtn = screen.getByTestId('page-batch-star-btn')
    expect(starBtn).toHaveAccessibleName(t('pageBrowser.batch.starSelected'))
    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
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
