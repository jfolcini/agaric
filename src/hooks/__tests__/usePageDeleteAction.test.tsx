/** Tests for the shared confirm → delete → Undo → restore page flow. */

import { invoke } from '@tauri-apps/api/core'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type InvokeHandler, mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { useBlockResolve } from '@/components/block-tree/use-block-resolve'
import { usePageDeleteAction } from '@/hooks/usePageDeleteAction'
import type { NameChange } from '@/lib/name-change-bus'
import { NAME_CACHE_FANOUT_MAX_IDS, subscribeToNameChanges } from '@/lib/name-change-bus'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

function stubInvoke(overrides: Readonly<Record<string, InvokeHandler>>): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(overrides))
}

function Harness({ onReady }: { onReady: (api: ReturnType<typeof usePageDeleteAction>) => void }) {
  const api = usePageDeleteAction()
  onReady(api)
  return <>{api.confirmDialog}</>
}

function renderHarness(): { api: ReturnType<typeof usePageDeleteAction> } {
  const holder: { api: ReturnType<typeof usePageDeleteAction> | null } = { api: null }
  render(
    <Harness
      onReady={(api) => {
        holder.api = api
      }}
    />,
  )
  if (!holder.api) throw new Error('Harness did not yield an api')
  return holder as { api: ReturnType<typeof usePageDeleteAction> }
}

function lastUndoAction(): () => void {
  const lastCall = vi.mocked(toast.success).mock.calls.at(-1)
  const options = lastCall?.[1] as { action?: { onClick?: () => void } } | undefined
  const onClick = options?.action?.onClick
  if (!onClick) throw new Error('Expected the success toast to expose Undo')
  return onClick
}

beforeEach(() => {
  vi.clearAllMocks()
  useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_A',
    availableSpaces: [{ id: 'SPACE_A', name: 'A', accent_color: null }],
    isReady: true,
  })
})

describe('usePageDeleteAction', () => {
  it('opens with default copy and accepts caller-specific button copy', async () => {
    const handle = renderHarness()

    act(() => {
      handle.api.requestDelete('PAGE_1', 'My Page')
    })
    expect(await screen.findByRole('heading', { name: /^Delete page$/i })).toBeInTheDocument()
    expect(screen.getByText(/can be restored from trash/i)).toBeInTheDocument()
    expect(screen.queryByText(/cannot be undone|permanently delete/i)).not.toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: /^Cancel$/i }))
    act(() => {
      handle.api.requestDelete('PAGE_1', 'My Page', {
        confirmCopy: {
          titleKey: 'pageBrowser.deletePage',
          descriptionKey: 'pageHeader.deleteConfirm',
          confirmKey: 'pageBrowser.delete',
          cancelKey: 'pageBrowser.cancel',
          values: { name: 'My Page' },
        },
      })
    })

    expect(await screen.findByRole('heading', { name: 'Delete page?' })).toBeInTheDocument()
    expect(screen.getByText(/can be restored from trash/i)).toBeInTheDocument()
    expect(screen.queryByText(/cannot be undone|permanently delete/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Delete$/i })).toBeInTheDocument()
  })

  it('uses the cached title on a successful delete and calls onDeleted once', async () => {
    stubInvoke({
      delete_block: () => ({
        block_id: 'PAGE_1',
        deleted_at: '2026-01-01T00:00:00Z',
        descendants_affected: 0,
        affected_page_ids: [],
      }),
    })
    useResolveStore.getState().set('PAGE_1', 'Cached title', false)
    const onDeleted = vi.fn()
    const handle = renderHarness()

    act(() => {
      handle.api.requestDelete('PAGE_1', 'Visible fallback', { onDeleted })
    })
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Delete page$/i }))

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(onDeleted).toHaveBeenCalledWith('PAGE_1')
    expect(useResolveStore.getState().cache.get(keyFor('SPACE_A', 'PAGE_1'))).toEqual({
      title: 'Cached title',
      deleted: true,
      resolved: true,
    })
    expect(toast.success).toHaveBeenCalledWith(
      'Page deleted',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
    )
  })

  it('falls back to the visible title, then Undo restores status and calls onRestored', async () => {
    stubInvoke({
      delete_block: () => ({
        block_id: 'PAGE_1',
        deleted_at: '2026-01-01T00:00:00Z',
        descendants_affected: 0,
        affected_page_ids: [],
      }),
      restore_blocks_by_ids: () => ({ affected_count: 1 }),
    })
    const onRestored = vi.fn()
    const handle = renderHarness()

    act(() => {
      handle.api.requestDelete('PAGE_1', 'Visible title', { onRestored })
    })
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Delete page$/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(useResolveStore.getState().cache.get(keyFor('SPACE_A', 'PAGE_1'))).toEqual({
      title: 'Visible title',
      deleted: true,
      resolved: true,
    })

    act(() => {
      lastUndoAction()()
    })

    await waitFor(() => expect(onRestored).toHaveBeenCalledWith('PAGE_1'))
    expect(mockedInvoke).toHaveBeenCalledWith('restore_blocks_by_ids', {
      blockIds: ['PAGE_1'],
    })
    expect(useResolveStore.getState().cache.get(keyFor('SPACE_A', 'PAGE_1'))).toEqual({
      title: 'Visible title',
      deleted: false,
      resolved: true,
    })
  })

  it('keeps the page deleted and skips onRestored when Undo restore fails', async () => {
    stubInvoke({
      delete_block: () => ({
        block_id: 'PAGE_1',
        deleted_at: '2026-01-01T00:00:00Z',
        descendants_affected: 0,
        affected_page_ids: [],
      }),
      restore_blocks_by_ids: () => Promise.reject(new Error('restore failed')),
    })
    const onRestored = vi.fn()
    const handle = renderHarness()
    act(() => {
      handle.api.requestDelete('PAGE_1', 'Still deleted', { onRestored })
    })
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Delete page$/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())

    act(() => {
      lastUndoAction()()
    })

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to restore page'))
    expect(onRestored).not.toHaveBeenCalled()
    expect(useResolveStore.getState().cache.get(keyFor('SPACE_A', 'PAGE_1'))).toEqual({
      title: 'Still deleted',
      deleted: true,
      resolved: true,
    })
  })

  it('does not change resolve status or call onDeleted when delete fails', async () => {
    stubInvoke({ delete_block: () => Promise.reject(new Error('backend boom')) })
    useResolveStore.getState().set('PAGE_1', 'Original title', false)
    const onDeleted = vi.fn()
    const handle = renderHarness()
    act(() => {
      handle.api.requestDelete('PAGE_1', 'Visible title', { onDeleted })
    })
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Delete page$/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to delete page',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Retry' }) }),
      )
    })
    expect(onDeleted).not.toHaveBeenCalled()
    expect(useResolveStore.getState().cache.get(keyFor('SPACE_A', 'PAGE_1'))).toEqual({
      title: 'Original title',
      deleted: false,
      resolved: true,
    })
  })

  it('does not write an originating page into a newly active space', async () => {
    let resolveDelete: ((value: unknown) => void) | undefined
    stubInvoke({
      delete_block: () =>
        new Promise((resolve) => {
          resolveDelete = resolve
        }),
    })
    useResolveStore.getState().set('PAGE_1', 'Space A title', false)
    const handle = renderHarness()
    act(() => {
      handle.api.requestDelete('PAGE_1', 'Fallback')
    })
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Delete page$/i }))
    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
      resolveDelete?.({
        block_id: 'PAGE_1',
        deleted_at: '2026-01-01T00:00:00Z',
        descendants_affected: 0,
        affected_page_ids: [],
      })
    })

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(useResolveStore.getState().cache.has(keyFor('SPACE_B', 'PAGE_1'))).toBe(false)
    expect(useResolveStore.getState().cache.get(keyFor('SPACE_A', 'PAGE_1'))).toEqual({
      title: 'Space A title',
      deleted: false,
      resolved: true,
    })
  })

  // #4007 — the `[[` picker's page-name cache (`pagesListRef` in
  // `useBlockResolve`) is a React ref, not a store, so this flow can only
  // reach it through the name-change bus. Without these two emissions the
  // picker keeps offering a deleted page for the rest of the session (and,
  // after an Undo, keeps hiding a page that is back).
  it('broadcasts the delete — and the Undo — to the picker name caches', async () => {
    stubInvoke({
      delete_block: () => ({
        block_id: 'PAGE_1',
        deleted_at: '2026-01-01T00:00:00Z',
        descendants_affected: 0,
        affected_page_ids: [],
      }),
      restore_blocks_by_ids: () => ({ affected_count: 1 }),
    })
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((change) => changes.push(change))
    try {
      const handle = renderHarness()
      act(() => {
        handle.api.requestDelete('PAGE_1', 'Doomed')
      })
      await userEvent.setup().click(await screen.findByRole('button', { name: /^Delete page$/i }))
      await waitFor(() => expect(toast.success).toHaveBeenCalled())

      expect(changes).toEqual([
        { kind: 'removed', entity: 'page', id: 'PAGE_1', spaceId: 'SPACE_A' },
      ])

      act(() => {
        lastUndoAction()()
      })
      await waitFor(() => expect(changes).toHaveLength(2))
      // A restore ADDS a row back, and the bus has no "added" event: an empty
      // cache means "not fetched yet", so inserting one row would latch a
      // one-row list as the whole space. Hence drop, not patch.
      expect(changes[1]).toEqual({ kind: 'invalidated' })
    } finally {
      unsubscribe()
    }
  })
})

// #4523 — the single-page delete's cascade walks `parent_id` with NO
// page-boundary stop (`collect_subtree_ids_unbounded` filters on `deleted_at`
// and depth, never on `block_type`), so deleting one page also tombstones its
// nested PAGE children. Until now `delete_block` replied with no cohort, so
// this hook could only evict the one id it had sent, and the `[[` picker's
// per-space cache — filled from `list_all_pages_in_space` (`block_type =
// 'page' AND deleted_at IS NULL AND space_id = ?`) — went on offering pages
// that were now in the trash. Selecting one linked to a trashed page.
//
// Same defect and same fix as the batch arm (#4480/#4521,
// `PageBrowserBatchToolbar.handleTrash`), one command over — and the single
// delete is the more common gesture of the two.
describe('single delete — cascaded nested pages (#4523)', () => {
  /** Subscribe to the real bus for the duration of one test. */
  function recordChanges(): { changes: NameChange[]; unsubscribe: () => void } {
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((change) => changes.push(change))
    return { changes, unsubscribe }
  }

  /** A `WithOps<DeleteResponse>` whose cascade reported `affectedPageIds`. */
  function deleteReply(pageId: string, affectedPageIds: string[]) {
    return {
      block_id: pageId,
      deleted_at: 1_700_000_000_000,
      descendants_affected: affectedPageIds.length,
      affected_page_ids: affectedPageIds,
      op_refs: [],
    }
  }

  /** Drive the confirm dialog through to a resolved `delete_block`. */
  async function confirmDelete(pageId: string): Promise<void> {
    const handle = renderHarness()
    act(() => {
      handle.api.requestDelete(pageId, 'Doomed')
    })
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Delete page$/i }))
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: pageId })
    })
  }

  // THE over-eviction guard, and the reason it has to be an event count.
  //
  // A cache-level assertion cannot carry this weight: the harness's
  // `list_all_pages_in_space` mock is static, so a wholesale
  // `invalidateNameCaches()` self-heals on the next synchronous refetch and an
  // "unrelated sibling still present" arm can never fail on its own (#4480
  // documented this; #4521 confirmed it). Counting the bus events is what
  // distinguishes a NARROW eviction from a correct-looking wipe.
  //
  // The exact-equality assertion falsifies four distinct wrong versions:
  //   * `notifyPageRemoved(id, ...)` alone (the pre-#4523 code) → 1 event,
  //     both nested pages missing. The bug.
  //   * `invalidateNameCaches()` whenever the cascade touched anything →
  //     `[{kind:'invalidated'}]`. It throws away a warm cache, and costs a
  //     `listAllPagesInSpace` round trip on the next keystroke, for a routine
  //     one-page delete.
  //   * the union fanned out as an ARRAY rather than a Set → 4 events,
  //     because the backend echoes the deleted seed back inside
  //     `affected_page_ids`. A duplicate event is O(listeners x pages) of
  //     wasted synchronous work.
  //   * the seed scoped to anything but the origin space → `spaceId` mismatch.
  //
  // #4558 — the two cascaded ids are published SPACE-LESSLY (`spaceId: null`)
  // while the seed keeps `SPACE_A`.
  it('evicts the nested pages the cascade swept, and nothing else', async () => {
    // The user deleted PAGE_ROOT. The cascade also tombstoned its two page
    // children and the backend reports all three (seed included).
    stubInvoke({
      delete_block: () => deleteReply('PAGE_ROOT', ['PAGE_ROOT', 'NESTED_1', 'NESTED_2']),
    })
    const { changes, unsubscribe } = recordChanges()
    try {
      await confirmDelete('PAGE_ROOT')
      await waitFor(() => {
        expect(changes).toHaveLength(3)
      })
      expect(changes).toEqual([
        { kind: 'removed', entity: 'page', id: 'PAGE_ROOT', spaceId: 'SPACE_A' },
        { kind: 'removed', entity: 'page', id: 'NESTED_1', spaceId: null },
        { kind: 'removed', entity: 'page', id: 'NESTED_2', spaceId: null },
      ] satisfies NameChange[])
    } finally {
      unsubscribe()
    }
  })

  // The fan-out is the UNION of the requested id and the reported cohort, not
  // a replacement. `delete_block` errors on a missing or already-deleted seed
  // rather than skipping it, so — unlike the batch arm — a successful reply
  // always names the seed and this arm should never fire in production. It is
  // pinned anyway because the cost is one `Set` entry and the failure it
  // prevents is silent: swapping the union for `new Set(affected_page_ids)`
  // would leave the deleted page itself in the picker the moment the backend's
  // cohort ever came back narrower than the request.
  it('still evicts the requested id when the cohort does not name it', async () => {
    stubInvoke({ delete_block: () => deleteReply('PAGE_1', []) })
    const { changes, unsubscribe } = recordChanges()
    try {
      await confirmDelete('PAGE_1')
      await waitFor(() => {
        expect(changes).toHaveLength(1)
      })
      expect(changes).toEqual([
        { kind: 'removed', entity: 'page', id: 'PAGE_1', spaceId: 'SPACE_A' },
      ] satisfies NameChange[])
    } finally {
      unsubscribe()
    }
  })

  // The `NAME_CACHE_FANOUT_MAX_IDS` budget exists because `notifyPageRemoved`
  // is a synchronous O(ids x listeners x pages) fan-out. #4523 makes the
  // emitted set larger than the request, so the threshold must be measured
  // against what will ACTUALLY be emitted.
  //
  // NON-TAUTOLOGY: the request is ONE id, so a budget measured against the
  // request can never trip — it would take the per-id branch and fire 31
  // synchronous events, the exact frame-budget overrun the cap was measured to
  // prevent. Only a check against the union collapses this into one
  // invalidation. This is the arm that makes `1 <= budget` a bug rather than a
  // tautology.
  it('measures the fan-out budget against the union, not the requested id', async () => {
    const nested = Array.from({ length: 30 }, (_, i) => `NESTED_${i}`)
    expect(1).toBeLessThanOrEqual(NAME_CACHE_FANOUT_MAX_IDS)
    expect(1 + nested.length).toBeGreaterThan(NAME_CACHE_FANOUT_MAX_IDS)
    stubInvoke({ delete_block: () => deleteReply('PAGE_ROOT', ['PAGE_ROOT', ...nested]) })

    const { changes, unsubscribe } = recordChanges()
    try {
      await confirmDelete('PAGE_ROOT')
      await waitFor(() => {
        expect(changes).toHaveLength(1)
      })
      expect(changes).toEqual([{ kind: 'invalidated' } satisfies NameChange])
    } finally {
      unsubscribe()
    }
  })

  // #4523's acceptance criterion, end-to-end against the picker cache itself:
  // delete a page with page children, then run an origin-space `[[` query with
  // NO space switch. The children must not be offered — and the unrelated
  // sibling must still be.
  //
  // `SIBLING` present alongside `NESTED` absent rules out the one alternative
  // explanation that would make the ABSENT arm vacuous — "the cache was never
  // populated" — which is why the `before` assertion checks all three ids are
  // offered first.
  //
  // It does NOT prove the fix is NARROW, and the reason is worth being exact
  // about because it is the trap #4480 documented. The list refetches
  // synchronously from a STATIC `list_all_pages_in_space` mock, so a wholesale
  // `invalidateNameCaches()` brings every row back — including PAGE_ROOT and
  // NESTED, which is why the two absence arms above happen to catch that
  // particular wipe here. The arm that CANNOT catch it is the one #4523's
  // acceptance criterion leans on: `SIBLING` is present after a wipe exactly
  // as it is after a correct narrow eviction, so "the unrelated sibling
  // survives" can never fail on its own. Over-eviction is pinned by the
  // event-count test at the top of this describe, which reddens on
  // `[{kind:'invalidated'}]`. Keep both.
  // #4558 — the cascaded child in ANOTHER SPACE.
  it("a cascaded child in another space is evicted from THAT space's [[ cache", async () => {
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
    stubInvoke({
      // The live space is SPACE_B; these are ITS pages.
      list_all_pages_in_space: () => [
        pageRow('MOVED_CHILD', 'Moved Child'),
        pageRow('MOVED_SIBLING', 'Moved Sibling'),
      ],
      delete_block: () => deleteReply('PAGE_ROOT', ['PAGE_ROOT', 'MOVED_CHILD']),
    })

    // The delete is decided in SPACE_A, where PAGE_ROOT lives.
    const handle = renderHarness()
    act(() => {
      handle.api.requestDelete('PAGE_ROOT', 'Doomed')
    })

    // The user is now looking at SPACE_B, where the moved child lives, and
    // its picker cache is warm and offering it.
    act(() => {
      useSpaceStore.setState({
        currentSpaceId: 'SPACE_B',
        availableSpaces: [
          { id: 'SPACE_A', name: 'A', accent_color: null },
          { id: 'SPACE_B', name: 'B', accent_color: null },
        ],
        isReady: true,
      })
    })
    const { result: resolveResult } = renderHook(() => useBlockResolve())
    const before = await resolveResult.current.searchPages('')
    expect(before.filter((i) => !i.isCreate).map((i) => i.id)).toEqual(
      expect.arrayContaining(['MOVED_CHILD', 'MOVED_SIBLING']),
    )

    await userEvent.setup().click(await screen.findByRole('button', { name: /^Delete page$/i }))
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'PAGE_ROOT' })
    })

    const after = await resolveResult.current.searchPages('')
    const idsAfter = after.filter((i) => !i.isCreate).map((i) => i.id)
    expect(idsAfter).not.toContain('MOVED_CHILD')
    expect(idsAfter).toContain('MOVED_SIBLING')
  })

  it('a cascaded nested page stops being offered by the [[ cache, with no space switch', async () => {
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
    stubInvoke({
      list_all_pages_in_space: () => [
        pageRow('PAGE_ROOT', 'Root Page'),
        pageRow('NESTED', 'Nested Page'),
        pageRow('SIBLING', 'Sibling Page'),
      ],
      delete_block: () => deleteReply('PAGE_ROOT', ['PAGE_ROOT', 'NESTED']),
    })

    const { result: resolveResult } = renderHook(() => useBlockResolve())
    const before = await resolveResult.current.searchPages('')
    const idsBefore = before.filter((i) => !i.isCreate).map((i) => i.id)
    // The cache is PROVEN warm before the delete — otherwise the absence
    // assertions below would hold against an empty cache for free.
    expect(idsBefore).toEqual(expect.arrayContaining(['PAGE_ROOT', 'NESTED', 'SIBLING']))

    await confirmDelete('PAGE_ROOT')

    // Still viewing SPACE_A throughout — no space switch.
    const after = await resolveResult.current.searchPages('')
    const idsAfter = after.filter((i) => !i.isCreate).map((i) => i.id)
    expect(idsAfter).not.toContain('PAGE_ROOT')
    // The one #4523 is about: the user never named this id, and before the fix
    // it survived in the cache and linked to a page in the trash.
    expect(idsAfter).not.toContain('NESTED')
    expect(idsAfter).toContain('SIBLING')
  })
})
