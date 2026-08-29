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
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { strictInvokeFallback } from '@/__tests__/helpers/invoke'
import { useBlockResolve } from '@/components/block-tree/use-block-resolve'
import {
  NAME_CACHE_FANOUT_MAX_IDS,
  PageBrowserBatchToolbar,
} from '@/components/pages/PageBrowserBatchToolbar'
import { t } from '@/lib/i18n'
import type { NameChange } from '@/lib/name-change-bus'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
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

/**
 * #4480 — `delete_blocks_by_ids` replies with a `BatchDeleteResponse`, not a
 * bare count. `cascadedPageIds` models the half the frontend cannot see: PAGE
 * blocks the backend cascade tombstoned that the caller never selected (a
 * selected page's nested page children). Defaults to the roots alone, which is
 * the flat-selection case every pre-#4480 test was written against.
 */
function trashReply(rootIds: string[], cascadedPageIds: string[] = []) {
  return {
    deleted_count: rootIds.length + cascadedPageIds.length,
    affected_page_ids: [...rootIds, ...cascadedPageIds],
  }
}

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
    mockedInvoke.mockResolvedValueOnce(trashReply(SELECTED)) // delete_blocks_by_ids
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
    mockedInvoke.mockResolvedValueOnce(trashReply(SELECTED))
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

  // #3703 item 3 — Retry re-opens the confirm (#3701) rather than re-firing the
  // id list captured at failure time, which could cascade a delete over a set
  // the user could no longer see. The residue: the toast outlives the toolbar,
  // which the parent unmounts as soon as the selection empties, so
  // `setTrashConfirmOpen(true)` became a no-op on an unmounted component and
  // Retry did nothing and said nothing.
  describe('Retry on the trash-failure toast', () => {
    /** Drive a failed batch trash and hand back the toast's Retry callback. */
    async function failTrash() {
      const user = userEvent.setup()
      mockedInvoke.mockRejectedValueOnce(new Error('backend boom'))
      const utils = renderToolbar()

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
      const call = mockedToastError.mock.calls.find(
        (c) => c[0] === t('pageBrowser.batch.trashFailed'),
      )
      const retry = (call?.[1] as { action?: { onClick?: () => void } } | undefined)?.action
        ?.onClick
      expect(retry).toBeTypeOf('function')
      return { ...utils, user, retry: retry as () => void }
    }

    it('re-opens the confirm while the selection is still there', async () => {
      const { retry } = await failTrash()

      retry()

      expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    })

    it('says why it cannot proceed once the selection is gone', async () => {
      const { retry, unmount } = await failTrash()

      // Clearing the selection unmounts the toolbar (the parent renders it only
      // while ≥1 page is selected) — the toast, and its Retry, remain.
      unmount()
      mockedToastError.mockClear()
      const deletesBefore = mockedInvoke.mock.calls.filter(
        (c) => c[0] === 'delete_blocks_by_ids',
      ).length

      retry()

      expect(mockedToastError).toHaveBeenCalledWith(t('pageBrowser.batch.retryNoSelection'))
      // …and it must NOT silently do the one thing it cannot do safely: re-fire
      // the captured id list over a selection nobody can see any more.
      expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'delete_blocks_by_ids')).toHaveLength(
        deletesBefore,
      )
    })
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

// #4008 review note 3 — `notifyPageRemoved` is a SYNCHRONOUS fan-out: every
// mounted `useBlockResolve` rebuilds its whole cached pages list with `filter`
// per event. One event per trashed id, at the `MAX_TRASH_BATCH_IDS` cap of
// 1000 and with the journal's several mounted `BlockTree`s, is tens of
// millions of element copies on the UI thread with no yield. Above
// `NAME_CACHE_FANOUT_MAX_IDS` the toolbar must collapse that into a single
// `invalidateNameCaches()`.
//
// Both arms are asserted because each falsifies a different wrong fix: the
// small-batch arm fails a "just always invalidate" simplification (which would
// cost a `listAllPagesInSpace` round trip on every 3-page delete), and the
// large-batch arm fails the unbounded per-id loop.
describe('batch trash — name-cache fan-out (#4008 review note 3)', () => {
  /** Subscribe to the real bus for the duration of one test. */
  function recordChanges(): { changes: NameChange[]; unsubscribe: () => void } {
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((change) => changes.push(change))
    return { changes, unsubscribe }
  }

  async function confirmTrash(ids: string[], cascadedPageIds: string[] = []): Promise<void> {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(trashReply(ids, cascadedPageIds))
    renderToolbar({ selectedIds: ids })
    await user.click(screen.getByTestId('page-batch-trash-btn'))
    await user.click(
      await screen.findByRole('button', { name: t('pageBrowser.batch.trashConfirmAction') }),
    )
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', { blockIds: ids })
    })
  }

  it(`fires one removal event per id at ${NAME_CACHE_FANOUT_MAX_IDS} ids`, async () => {
    const ids = Array.from({ length: NAME_CACHE_FANOUT_MAX_IDS }, (_, i) => `SMALL_${i}`)
    const { changes, unsubscribe } = recordChanges()
    try {
      await confirmTrash(ids)
      await waitFor(() => {
        expect(changes).toHaveLength(ids.length)
      })
      expect(changes).toEqual(
        ids.map(
          (id) =>
            ({ kind: 'removed', entity: 'page', id, spaceId: 'SPACE_TEST' }) satisfies NameChange,
        ),
      )
    } finally {
      unsubscribe()
    }
  })

  it(`fires exactly one invalidation at ${NAME_CACHE_FANOUT_MAX_IDS + 1} ids`, async () => {
    const ids = Array.from({ length: NAME_CACHE_FANOUT_MAX_IDS + 1 }, (_, i) => `BIG_${i}`)
    const { changes, unsubscribe } = recordChanges()
    try {
      await confirmTrash(ids)
      await waitFor(() => {
        expect(changes).toHaveLength(1)
      })
      expect(changes).toEqual([{ kind: 'invalidated' } satisfies NameChange])
    } finally {
      unsubscribe()
    }
  })
})

// #4480 — the batch trash cascade walks `parent_id` with NO page-boundary
// stop, so selecting a page whose children include PAGES trashes those
// children too. Until #4480 `delete_blocks_by_ids` replied with a bare count,
// so `handleTrash` could only evict the roots it had sent, and the `[[`
// picker's per-space cache (filled from `list_all_pages_in_space`:
// `block_type = 'page' AND deleted_at IS NULL AND space_id = ?`) went on
// offering pages that were now in the trash — #4450's defect one level down.
//
// The fix is the backend reporting `affected_page_ids`, the PAGE membership of
// the cohort it actually tombstoned, and `handleTrash` fanning out over the
// UNION of that and its own input list.
//
// Note the asymmetry with the sibling move tests below, which is measured and
// not a matter of taste: `move_blocks_to_space` does NOT drag nested pages
// along (a page's `space_id` is authoritative, and the `space` projection's
// `WHERE id = ? OR page_id = ?` fan-out cannot reach a page whose `page_id` is
// its own id), so `handleMoveToSpace` evicting only its roots is correct.
// Pinned backend-side by
// `move_blocks_to_space_leaves_nested_pages_in_the_origin_space_4480`.
describe('batch trash — cascaded nested pages (#4480)', () => {
  /** Subscribe to the real bus for the duration of one test. */
  function recordChanges(): { changes: NameChange[]; unsubscribe: () => void } {
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((change) => changes.push(change))
    return { changes, unsubscribe }
  }

  async function confirmTrash(ids: string[], cascadedPageIds: string[] = []): Promise<void> {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(trashReply(ids, cascadedPageIds))
    renderToolbar({ selectedIds: ids })
    await user.click(screen.getByTestId('page-batch-trash-btn'))
    await user.click(
      await screen.findByRole('button', { name: t('pageBrowser.batch.trashConfirmAction') }),
    )
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', { blockIds: ids })
    })
  }

  // THE over-eviction guard, and the reason it has to be an event count.
  //
  // A cache-level assertion cannot carry this weight: the harness's
  // `list_all_pages_in_space` mock is static, so a wholesale
  // `invalidateNameCaches()` self-heals on the next synchronous refetch and an
  // "unrelated sibling still present" arm can never fail on its own. Counting
  // the bus events is what distinguishes a NARROW eviction from a correct-
  // looking wipe.
  //
  // The exact-equality assertion falsifies four distinct wrong versions:
  //   * `for (const id of ids)` (the pre-#4480 code) → 1 event, `P_NESTED`
  //     missing. The bug.
  //   * `invalidateNameCaches()` whenever the cascade touched anything →
  //     `[{kind:'invalidated'}]`. The alternative #4480 rejects; it throws
  //     away a warm cache on a routine delete.
  //   * `[...ids, ...affected_page_ids]` fanned out as an ARRAY, not a Set →
  //     3 events, because the backend echoes the roots back inside
  //     `affected_page_ids`. Duplicate events are O(listeners x pages) of
  //     wasted synchronous work each.
  //   * an event scoped to anything but the origin → `spaceId` mismatch.
  it('evicts the nested pages the cascade swept, and nothing else', async () => {
    const { changes, unsubscribe } = recordChanges()
    try {
      // The user selected P_ROOT only. The backend cascade also tombstoned
      // P_NESTED (a page child) and reports both back.
      await confirmTrash(['P_ROOT'], ['P_NESTED'])
      await waitFor(() => {
        expect(changes).toHaveLength(2)
      })
      expect(changes).toEqual([
        { kind: 'removed', entity: 'page', id: 'P_ROOT', spaceId: 'SPACE_TEST' },
        { kind: 'removed', entity: 'page', id: 'P_NESTED', spaceId: 'SPACE_TEST' },
      ] satisfies NameChange[])
    } finally {
      unsubscribe()
    }
  })

  // The fan-out is the UNION of the selection and the reported cohort, not a
  // replacement. An id the backend SKIPPED — missing, or soft-deleted by a
  // concurrent write between selection and call — is absent from
  // `affected_page_ids` by construction, and dropping it would be a silent
  // regression of the pre-#4480 behaviour on a path no other test covers.
  it('still evicts a selected id the backend skipped', async () => {
    const { changes, unsubscribe } = recordChanges()
    try {
      // P_GONE was selected but never made it into the cohort; the backend
      // reports only P_LIVE.
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        deleted_count: 1,
        affected_page_ids: ['P_LIVE'],
      })
      renderToolbar({ selectedIds: ['P_LIVE', 'P_GONE'] })
      await user.click(screen.getByTestId('page-batch-trash-btn'))
      await user.click(
        await screen.findByRole('button', { name: t('pageBrowser.batch.trashConfirmAction') }),
      )
      await waitFor(() => {
        expect(changes).toHaveLength(2)
      })
      expect(changes.map((c) => (c.kind === 'removed' ? c.id : c.kind))).toEqual([
        'P_LIVE',
        'P_GONE',
      ])
    } finally {
      unsubscribe()
    }
  })

  // The `NAME_CACHE_FANOUT_MAX_IDS` budget exists because `notifyPageRemoved`
  // is a synchronous O(ids x listeners x pages) fan-out. #4480 makes the
  // emitted set larger than the selection, so the threshold must be measured
  // against what will ACTUALLY be emitted.
  //
  // NON-TAUTOLOGY: 20 selected roots is comfortably under the cap of 25, so
  // the pre-#4480 `ids.length > NAME_CACHE_FANOUT_MAX_IDS` test passes and the
  // code takes the per-id branch — firing 30 synchronous events, the exact
  // frame-budget overrun the cap was measured to prevent. Only a check against
  // the union collapses this into one invalidation.
  it('measures the fan-out budget against the union, not the selection', async () => {
    const roots = Array.from({ length: 20 }, (_, i) => `ROOT_${i}`)
    const nested = Array.from({ length: 10 }, (_, i) => `NESTED_${i}`)
    expect(roots.length).toBeLessThanOrEqual(NAME_CACHE_FANOUT_MAX_IDS)
    expect(roots.length + nested.length).toBeGreaterThan(NAME_CACHE_FANOUT_MAX_IDS)

    const { changes, unsubscribe } = recordChanges()
    try {
      await confirmTrash(roots, nested)
      await waitFor(() => {
        expect(changes).toHaveLength(1)
      })
      expect(changes).toEqual([{ kind: 'invalidated' } satisfies NameChange])
    } finally {
      unsubscribe()
    }
  })

  // End-to-end against the picker cache itself, mirroring the #4450 sibling
  // below. `P_STAYS` present alongside `P_NESTED` absent rules out the one
  // alternative explanation that would make the ABSENT arm vacuous — "the
  // cache was never populated" — which is why the `before` assertion checks
  // all three ids are offered first.
  //
  // It does NOT prove the fix is narrow: a full-cache wipe self-heals here,
  // because the list refetches synchronously from the static
  // `list_all_pages_in_space` mock and brings everything back. Narrowness is
  // pinned by the event-count test at the top of this describe. Keep both.
  it('a cascaded nested page stops being offered by the [[ cache, with no space switch', async () => {
    const user = userEvent.setup()
    function pageRow(id: string, content: string) {
      return {
        id,
        content,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
      }
    }
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return Promise.resolve([
          pageRow('P_ROOT', 'Root Page'),
          pageRow('P_NESTED', 'Nested Page'),
          pageRow('P_STAYS', 'Stays Page'),
        ])
      }
      if (cmd === 'delete_blocks_by_ids') {
        // The user selected P_ROOT; the cascade also took its page child.
        return Promise.resolve(trashReply(['P_ROOT'], ['P_NESTED']))
      }
      return strictInvokeFallback(cmd)
    })

    const { result: resolveResult } = renderHook(() => useBlockResolve())
    const before = await resolveResult.current.searchPages('')
    const idsBefore = before.filter((i) => !i.isCreate).map((i) => i.id)
    // The cache is PROVEN warm before the trash — otherwise the absence
    // assertions below would hold against an empty cache for free.
    expect(idsBefore).toEqual(expect.arrayContaining(['P_ROOT', 'P_NESTED', 'P_STAYS']))

    renderToolbar({ selectedIds: ['P_ROOT'] })
    await user.click(screen.getByTestId('page-batch-trash-btn'))
    await user.click(
      await screen.findByRole('button', { name: t('pageBrowser.batch.trashConfirmAction') }),
    )
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', { blockIds: ['P_ROOT'] })
    })

    // Still viewing SPACE_TEST throughout — no space switch.
    const after = await resolveResult.current.searchPages('')
    const idsAfter = after.filter((i) => !i.isCreate).map((i) => i.id)
    expect(idsAfter).not.toContain('P_ROOT')
    // The one #4480 is about: the caller never named this id, and before the
    // fix it survived in the cache.
    expect(idsAfter).not.toContain('P_NESTED')
    expect(idsAfter).toContain('P_STAYS')
  })
})

// #4450 — `handleMoveToSpace` published nothing at all: no `notifyPageRemoved`,
// no `invalidateNameCaches()`. `list_all_pages_in_space` is what fills the
// `[[` picker's `pagesListRef`, so the ORIGIN space's warm cache kept
// offering the moved-out pages for the rest of the session, until an
// unrelated space switch happened to clear it. The sibling `handleTrash`
// (tested above) already publishes for the identical cache consequence.
//
// The fix must scope the event to the ORIGIN space (`currentSpaceId`, the
// toolbar's active space), not the destination (`selectedSpaceId`) — the
// exact "worse than no scoping" mislabelling #4391's docblock warns about,
// which would leave the origin cache untouched while never being asked to
// touch the destination either.
describe('batch move-to-space — name-cache fan-out (#4450)', () => {
  /** Subscribe to the real bus for the duration of one test. */
  function recordChanges(): { changes: NameChange[]; unsubscribe: () => void } {
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((change) => changes.push(change))
    return { changes, unsubscribe }
  }

  async function confirmMove(ids: string[], destSpaceId: string): Promise<void> {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'move_blocks_to_space') return Promise.resolve(ids.length)
      return strictInvokeFallback(cmd)
    })
    renderToolbar({ selectedIds: ids })
    await user.click(screen.getByTestId('page-batch-move-btn'))
    const select = await screen.findByRole('combobox', {
      name: t('pageBrowser.batch.spacePlaceholder'),
    })
    await user.selectOptions(select, destSpaceId)
    await user.click(screen.getByTestId('page-batch-space-confirm'))
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('move_blocks_to_space', {
        blockIds: ids,
        spaceId: destSpaceId,
      })
    })
  }

  it('fires one removal event per id, scoped to the ORIGIN space (not the destination)', async () => {
    const ids = ['P1', 'P2', 'P3']
    const { changes, unsubscribe } = recordChanges()
    try {
      await confirmMove(ids, 'SPACE_OTHER')
      await waitFor(() => {
        expect(changes).toHaveLength(ids.length)
      })
      // `spaceId: 'SPACE_TEST'` (the origin) on every event — a publish
      // labelled `'SPACE_OTHER'` (the destination) would pass a test that
      // only checked "something was published", which is the mistake this
      // pins against.
      expect(changes).toEqual(
        ids.map(
          (id) =>
            ({ kind: 'removed', entity: 'page', id, spaceId: 'SPACE_TEST' }) satisfies NameChange,
        ),
      )
    } finally {
      unsubscribe()
    }
  })

  it(`fires exactly one invalidation at ${NAME_CACHE_FANOUT_MAX_IDS + 1} ids`, async () => {
    const ids = Array.from({ length: NAME_CACHE_FANOUT_MAX_IDS + 1 }, (_, i) => `BIGMOVE_${i}`)
    const { changes, unsubscribe } = recordChanges()
    try {
      await confirmMove(ids, 'SPACE_OTHER')
      await waitFor(() => {
        expect(changes).toHaveLength(1)
      })
      expect(changes).toEqual([{ kind: 'invalidated' } satisfies NameChange])
    } finally {
      unsubscribe()
    }
  })

  // End-to-end: prove the picker cache itself, not just the bus event.
  //
  // `P_STAYS` is asserted PRESENT alongside `P_MOVED` asserted ABSENT. Be
  // precise about what that pair does and does not establish: it rules out
  // "the cache was never populated, so of course the moved id is missing",
  // which is the alternative explanation that would make the ABSENT arm
  // vacuous. It does NOT prove the fix avoids over-eviction. A full-cache
  // wipe self-heals here — the list refetches synchronously from the static
  // `list_all_pages_in_space` mock and brings BOTH ids back — so an
  // over-evicting implementation fails on the `P_MOVED` arm first and
  // `P_STAYS` never gets the chance to fail on its own.
  //
  // Over-eviction is pinned by the sibling test above, which counts one
  // removal event per moved id rather than inspecting the resulting cache.
  // Keep both: this one proves the cache observably changes, that one proves
  // the change is narrow.
  it('a moved page stops being offered by the origin [[ cache, with no space switch required', async () => {
    const user = userEvent.setup()
    function pageRow(id: string, content: string) {
      return {
        id,
        content,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
      }
    }
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return Promise.resolve([pageRow('P_MOVED', 'Moved Page'), pageRow('P_STAYS', 'Stays Page')])
      }
      if (cmd === 'move_blocks_to_space') return Promise.resolve(1)
      return strictInvokeFallback(cmd)
    })

    const { result: resolveResult } = renderHook(() => useBlockResolve())
    const before = await resolveResult.current.searchPages('')
    expect(before.filter((i) => !i.isCreate).map((i) => i.id)).toEqual(
      expect.arrayContaining(['P_MOVED', 'P_STAYS']),
    )

    renderToolbar({ selectedIds: ['P_MOVED'] })
    await user.click(screen.getByTestId('page-batch-move-btn'))
    const select = await screen.findByRole('combobox', {
      name: t('pageBrowser.batch.spacePlaceholder'),
    })
    await user.selectOptions(select, 'SPACE_OTHER')
    await user.click(screen.getByTestId('page-batch-space-confirm'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('move_blocks_to_space', {
        blockIds: ['P_MOVED'],
        spaceId: 'SPACE_OTHER',
      })
    })

    // Still viewing SPACE_TEST throughout — no space switch. The moved page
    // must be gone; the untouched page must still be offered.
    const after = await resolveResult.current.searchPages('')
    const idsAfter = after.filter((i) => !i.isCreate).map((i) => i.id)
    expect(idsAfter).not.toContain('P_MOVED')
    expect(idsAfter).toContain('P_STAYS')
  })
})
