import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { createElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { strictInvokeFallback } from '@/__tests__/helpers/invoke'
import { useBlockMultiSelect } from '@/components/block-tree/use-block-multi-select'
import { useBlockResolve } from '@/components/block-tree/use-block-resolve'
import type { NameChange } from '@/lib/name-change-bus'
import { NAME_CACHE_FANOUT_MAX_IDS, subscribeToNameChanges } from '@/lib/name-change-bus'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)

let pageStore: StoreApi<PageBlockState>
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(PageBlockContext.Provider, { value: pageStore }, children)

const originalOnNewAction = useUndoStore.getState().onNewAction
afterEach(() => {
  useUndoStore.setState({
    ...useUndoStore.getState(),
    onNewAction: originalOnNewAction,
    pages: new Map(),
  })
})

function makeDefaultParams(overrides?: Partial<Parameters<typeof useBlockMultiSelect>[0]>) {
  return {
    selectedBlockIds: ['BLOCK_1', 'BLOCK_2'] as string[],
    clearSelected: vi.fn(),
    rootParentId: 'PAGE_1' as string | null,
    pageStore,
    // #4524 — the ORIGIN space every name-cache eviction is scoped to.
    currentSpaceId: 'SPACE_TEST' as string | null,
    t: vi.fn((key: string) => key) as unknown as TFunction,
    handleTogglePriority: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default mock: every batch IPC reports "all input ids handled".
  // Per-test overrides return specific counts to exercise the
  // affected-count branch in the toast logic.
  mockedInvoke.mockImplementation((cmd: string, args: unknown) => {
    const a = args as Record<string, unknown>
    const ids = (a['blockIds'] as string[]) ?? []
    if (cmd === 'set_todo_state_batch') {
      return Promise.resolve(ids.length)
    }
    // #4480 — `delete_blocks_by_ids` replies with a `BatchDeleteResponse`, not
    // a bare count. These fixtures are content blocks, so the page cohort is
    // empty.
    if (cmd === 'delete_blocks_by_ids') {
      return Promise.resolve({ deleted_count: ids.length, affected_page_ids: [] })
    }
    return strictInvokeFallback(cmd)
  })
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({
    blocks: [
      makeBlock({ id: 'BLOCK_1' }),
      makeBlock({ id: 'BLOCK_2' }),
      makeBlock({ id: 'BLOCK_3' }),
    ],
  })
})

describe('useBlockMultiSelect initial state', () => {
  it('returns batchDeleteConfirm as false', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    expect(result.current.batchDeleteConfirm).toBe(false)
  })

  it('returns batchInProgress as false', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    expect(result.current.batchInProgress).toBe(false)
  })
})

describe('useBlockMultiSelect handleBatchSetTodo', () => {
  // Was N IPCs (one `set_todo_state` per block);
  // is now ONE `set_todo_state_batch` IPC carrying the whole id list.
  it('fires a single set_todo_state_batch IPC for the whole selection', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state_batch', {
      blockIds: ['BLOCK_1', 'BLOCK_2'],
      state: 'TODO',
    })
  })

  it('clears selection after success', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(params.clearSelected).toHaveBeenCalled()
  })

  it('shows success toast on success', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(vi.mocked(toast.success)).toHaveBeenCalled()
  })

  it('shows error toast when the batch IPC fails', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalled()
  })

  it('shows error toast when the backend silently skipped some ids', async () => {
    // Backend returns affected_count < ids.length when some ids are
    // missing or already-deleted. The hook surfaces that as a partial
    // failure so the user sees an honest summary.
    mockedInvoke.mockImplementationOnce((cmd: string) => {
      if (cmd === 'set_todo_state_batch') return Promise.resolve(1) // 1 of 2
      return strictInvokeFallback(cmd)
    })
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalled()
  })

  it('guards against concurrent batch operations', async () => {
    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(result.current.batchInProgress).toBe(false)
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
  })

  it('sets null state to clear todo', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo(null)
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state_batch', {
      blockIds: ['BLOCK_1', 'BLOCK_2'],
      state: null,
    })
  })
})

describe('useBlockMultiSelect handleBatchSetPriority (#1734)', () => {
  // No dedicated single-IPC batch priority endpoint exists, so the toolbar
  // fans out the canonical per-block cycle (the same path the bulk context
  // menu uses) — one `handleTogglePriority` call per selected block.
  it('fans out handleTogglePriority across the whole selection', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetPriority()
    })

    expect(params.handleTogglePriority).toHaveBeenCalledTimes(2)
    expect(params.handleTogglePriority).toHaveBeenCalledWith('BLOCK_1')
    expect(params.handleTogglePriority).toHaveBeenCalledWith('BLOCK_2')
  })

  it('clears selection after success', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetPriority()
    })

    expect(params.clearSelected).toHaveBeenCalled()
  })

  it('resets batchInProgress after completion', async () => {
    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetPriority()
    })

    expect(result.current.batchInProgress).toBe(false)
  })
})

describe('useBlockMultiSelect handleBatchDelete', () => {
  // Was N IPCs (one `delete_block` per block); is
  // now ONE `delete_blocks_by_ids` IPC carrying the whole id list.
  // The backend's recursive CTE walks every root's subtree in one tx,
  // So the FE no longer needs the ancestor pre-walk.
  it('fires a single delete_blocks_by_ids IPC for the whole selection', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', {
      blockIds: ['BLOCK_1', 'BLOCK_2'],
    })
  })

  it('clears selection after delete', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(params.clearSelected).toHaveBeenCalled()
  })

  // The FE no longer pre-walks ancestors. The
  // backend's recursive CTE handles ancestor coalescing in one tx, so
  // even when both an ancestor and its descendant are selected the FE
  // sends the raw selection unchanged. Asserts the new behaviour:
  // single IPC, every selected id present in the payload.
  it('passes both ancestor and descendant ids through unchanged (backend coalesces)', async () => {
    pageStore.setState({
      blocks: [makeBlock({ id: 'PARENT' }), makeBlock({ id: 'CHILD', parent_id: 'PARENT' })],
    })
    const params = makeDefaultParams({
      selectedBlockIds: ['PARENT', 'CHILD'],
    })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', {
      blockIds: ['PARENT', 'CHILD'],
    })
  })

  // The ancestor-walk filter is gone (the
  // backend's recursive CTE seeded from every root subsumes the same
  // descendant set). Transitive descendants are passed through unchanged.
  it('passes transitive descendants through unchanged (backend coalesces via CTE)', async () => {
    pageStore.setState({
      blocks: [
        makeBlock({ id: 'A' }),
        makeBlock({ id: 'B', parent_id: 'A' }),
        makeBlock({ id: 'C', parent_id: 'B' }),
      ],
    })
    const params = makeDefaultParams({
      selectedBlockIds: ['A', 'C'],
    })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', { blockIds: ['A', 'C'] })
  })

  it('deletes independent siblings when neither is an ancestor of the other', async () => {
    pageStore.setState({
      blocks: [
        makeBlock({ id: 'A' }),
        makeBlock({ id: 'B', parent_id: 'A' }),
        makeBlock({ id: 'C' }),
        makeBlock({ id: 'D', parent_id: 'C' }),
      ],
    })
    const params = makeDefaultParams({
      selectedBlockIds: ['A', 'C'],
    })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', { blockIds: ['A', 'C'] })
  })

  it('deletes a block whose parent_id points to an id not in the store (orphan chain)', async () => {
    pageStore.setState({
      blocks: [makeBlock({ id: 'X', parent_id: 'MISSING' })],
    })
    const params = makeDefaultParams({
      selectedBlockIds: ['X'],
    })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', { blockIds: ['X'] })
  })

  it('shows error toast on failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.deleteFailedMessage')
  })

  it('shows success toast advertising the undo path on success', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    // C4 (#217): batch delete is reversible via the page op-log, so the
    // toast names the Ctrl+Z escape hatch instead of the bare count.
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('blockTree.deletedMessageUndo')
  })

  // #2653 — the backend recursive CTE soft-deletes every selected root AND its
  // whole subtree, but the selection only ever carries the explicitly-clicked
  // parent ids (never their collapsed/hidden children). The FE reconcile must
  // therefore splice out the parents' non-selected descendants too, or they
  // pop into view as ghost rows backed by tombstoned blocks. These tests pin
  // the store shape (`blocks` + the derived `blocksById` map) after delete.
  it('removes non-selected descendants of two deleted parents from the store (no ghost rows)', async () => {
    // Two parents, each with a child + a grandchild; only the PARENTS are
    // selected. `depth` mirrors the flat DFS order the store holds so
    // getDragDescendants can walk each subtree.
    pageStore.setState({
      blocks: [
        makeBlock({ id: 'P1', depth: 0 }),
        makeBlock({ id: 'P1_C', parent_id: 'P1', depth: 1 }),
        makeBlock({ id: 'P1_GC', parent_id: 'P1_C', depth: 2 }),
        makeBlock({ id: 'P2', depth: 0 }),
        makeBlock({ id: 'P2_C', parent_id: 'P2', depth: 1 }),
        makeBlock({ id: 'KEEP', depth: 0 }),
      ],
    })
    const params = makeDefaultParams({ selectedBlockIds: ['P1', 'P2'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    // Only the raw selection is sent — backend coalesces the descendants.
    expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', {
      blockIds: ['P1', 'P2'],
    })
    // The store keeps ONLY the untouched sibling — every deleted subtree is gone.
    const remaining = pageStore.getState().blocks.map((b) => b.id)
    expect(remaining).toEqual(['KEEP'])
    // blocksById invariant: same keys as `blocks`, no stranded descendant rows.
    const map = pageStore.getState().blocksById
    expect([...map.keys()].toSorted()).toEqual(['KEEP'])
    expect(map.size).toBe(pageStore.getState().blocks.length)
  })

  it('removes descendants whether the deleted parent was collapsed or expanded', async () => {
    // Collapse state lives outside the page store (useBlockCollapse); the store
    // holds the same flat array either way, so the reconcile is identical. This
    // asserts a deeply-nested subtree under a single selected root is fully
    // spliced out (the collapsed-parent ghost-row case from the issue).
    pageStore.setState({
      blocks: [
        makeBlock({ id: 'ROOT', depth: 0 }),
        makeBlock({ id: 'L1', parent_id: 'ROOT', depth: 1 }),
        makeBlock({ id: 'L2', parent_id: 'L1', depth: 2 }),
        makeBlock({ id: 'L3', parent_id: 'L2', depth: 3 }),
        makeBlock({ id: 'OTHER', depth: 0 }),
      ],
    })
    const params = makeDefaultParams({ selectedBlockIds: ['ROOT'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(['OTHER'])
    expect([...pageStore.getState().blocksById.keys()]).toEqual(['OTHER'])
  })

  it('preserves the store shape when the selection itself spans an ancestor and its descendant', async () => {
    // Selecting BOTH a parent and one of its descendants must still leave the
    // whole subtree removed exactly once (the removal set is a union — no
    // double-splice, no leftover sibling of the selected descendant).
    pageStore.setState({
      blocks: [
        makeBlock({ id: 'A', depth: 0 }),
        makeBlock({ id: 'A_C1', parent_id: 'A', depth: 1 }),
        makeBlock({ id: 'A_C2', parent_id: 'A', depth: 1 }),
        makeBlock({ id: 'SURVIVOR', depth: 0 }),
      ],
    })
    const params = makeDefaultParams({ selectedBlockIds: ['A', 'A_C1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(['SURVIVOR'])
    expect(pageStore.getState().blocksById.size).toBe(1)
  })

  it('does not mutate the store when the batch delete IPC fails (no partial splice)', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    pageStore.setState({
      blocks: [
        makeBlock({ id: 'P', depth: 0 }),
        makeBlock({ id: 'P_C', parent_id: 'P', depth: 1 }),
      ],
    })
    const params = makeDefaultParams({ selectedBlockIds: ['P'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    // On failure the store is untouched — descendants are only spliced on the
    // success path, so nothing is stranded either way.
    expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(['P', 'P_C'])
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.deleteFailedMessage')
  })

  it('resets batchDeleteConfirm after delete', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    act(() => {
      result.current.setBatchDeleteConfirm(true)
    })
    expect(result.current.batchDeleteConfirm).toBe(true)

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(result.current.batchDeleteConfirm).toBe(false)
  })
})

describe('useBlockMultiSelect undo notifications', () => {
  const onNewActionSpy = vi.fn()

  beforeEach(() => {
    onNewActionSpy.mockClear()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })
  })

  it('calls onNewAction after successful batch set todo', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })

  it('does not call onNewAction when rootParentId is null', async () => {
    const params = makeDefaultParams({ rootParentId: null })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })

  // C4 (#217): batch delete appends DeleteBlock ops to the page op-log,
  // so the toast advertises Ctrl+Z. We mark a new action (resetting the
  // redo stack) so the advertised undo lands on a clean slate.
  it('calls onNewAction after successful batch delete', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })

  it('does not call onNewAction after a batch delete when rootParentId is null', async () => {
    const params = makeDefaultParams({ rootParentId: null })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })

  it('does not call onNewAction after a failed batch delete', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })
})

describe('useBlockMultiSelect reentrancy guard (#)', () => {
  it('rejects a concurrent handleBatchSetTodo call while another is in flight', async () => {
    // Hold the first invoke open so we can fire a second call during it.
    let releaseFirst: (() => void) | null = null
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = () => resolve()
        }),
    )

    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    // Fire first call — it will block on the held promise.
    let firstDone: Promise<void> | null = null
    act(() => {
      firstDone = result.current.handleBatchSetTodo('TODO')
    })

    // Second call should hit the reentrancy guard and return immediately
    // without triggering another invoke.
    await act(async () => {
      await result.current.handleBatchSetTodo('DOING')
    })

    // Only the first invoke has been issued; the second call was rejected.
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state_batch', {
      blockIds: ['BLOCK_1'],
      state: 'TODO',
    })

    // Release the first call and await its completion.
    await act(async () => {
      releaseFirst?.()
      await firstDone
    })
  })

  it('rejects a concurrent handleBatchDelete call while another is in flight', async () => {
    let releaseFirst: (() => void) | null = null
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = () => resolve()
        }),
    )

    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    let firstDone: Promise<void> | null = null
    act(() => {
      firstDone = result.current.handleBatchDelete()
    })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(mockedInvoke).toHaveBeenCalledTimes(1)

    await act(async () => {
      releaseFirst?.()
      await firstDone
    })
  })

  it('allows a fresh call after the previous one finishes', async () => {
    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })
    await act(async () => {
      await result.current.handleBatchSetTodo('DONE')
    })

    // Both calls should have issued an invoke.
    expect(mockedInvoke).toHaveBeenCalledTimes(2)
  })
})

describe('useBlockMultiSelect callback stability (#)', () => {
  it('keeps handleBatchSetTodo identity stable across rerenders with unchanged deps', () => {
    const params = makeDefaultParams()
    const { result, rerender } = renderHook(() => useBlockMultiSelect(params), { wrapper })
    const firstRef = result.current.handleBatchSetTodo
    rerender()
    expect(result.current.handleBatchSetTodo).toBe(firstRef)
  })

  it('keeps handleBatchDelete identity stable across rerenders with unchanged deps', () => {
    const params = makeDefaultParams()
    const { result, rerender } = renderHook(() => useBlockMultiSelect(params), { wrapper })
    const firstRef = result.current.handleBatchDelete
    rerender()
    expect(result.current.handleBatchDelete).toBe(firstRef)
  })

  it('does not rebuild callbacks while the reentrancy guard flips during a batch op', async () => {
    // Hold invoke open so the batch op stays mid-flight; we can then observe
    // callback identity while batchInProgressRef is true. A state-based guard
    // would flip a React state and force a rerender with a new callback.
    let releaseFirst: (() => void) | null = null
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = () => resolve()
        }),
    )

    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    const beforeFn = result.current.handleBatchSetTodo

    let firstDone: Promise<void> | null = null
    act(() => {
      firstDone = result.current.handleBatchSetTodo('TODO')
    })

    // While the batch is in flight, the UI state (batchInProgress) has flipped
    // to true. The callback identity MAY have changed due to that state-driven
    // rerender — but the reentrancy guard no longer forces the callback's
    // closure to rebuild on every flip. The key assertion: the guard still
    // works (next call is rejected).
    await act(async () => {
      await result.current.handleBatchSetTodo('DOING')
    })
    expect(mockedInvoke).toHaveBeenCalledTimes(1)

    await act(async () => {
      releaseFirst?.()
      await firstDone
    })

    // After the batch op completes, the callback returns to the original
    // identity because batchInProgress is removed from its deps array.
    expect(result.current.handleBatchSetTodo).toBe(beforeFn)
  })
})

// #4524 — until now this hook published NOTHING to the name-change bus: not
// the selected roots, not the descendants the backend cascade swept. The `[[`
// picker's per-space page cache is filled once from `list_all_pages_in_space`
// and has no other delete signal, so a page trashed from the block tree went
// on being offered for the rest of the session — #4450's plain symptom on a
// surface #4450 never covered, over the SAME `delete_blocks_by_ids` command
// the Pages-view batch toolbar has published for since #4007.
//
// Read these alongside `PageBrowserBatchToolbar.test.tsx`'s
// `batch trash — cascaded nested pages (#4480)` describe, whose shape they
// follow. The one deliberate divergence is the page-subset filter: the
// toolbar's selection is pages by construction, this one is mostly CONTENT
// rows, and publishing those would both waste O(listeners x pages) per id and
// let a routine 30-block content delete blow `NAME_CACHE_FANOUT_MAX_IDS` and
// wipe a warm cache. `content-only selection publishes nothing` is that arm.
describe('useBlockMultiSelect handleBatchDelete — name-cache fan-out (#4524)', () => {
  /** Subscribe to the real bus for the duration of one test. */
  function recordChanges(): { changes: NameChange[]; unsubscribe: () => void } {
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((change) => changes.push(change))
    return { changes, unsubscribe }
  }

  /** Make `delete_blocks_by_ids` reply with an explicit page cohort. */
  function replyWithCohort(cohort: string[]): void {
    mockedInvoke.mockImplementation((cmd: string, args: unknown) => {
      if (cmd === 'delete_blocks_by_ids') {
        const ids = ((args as Record<string, unknown>)['blockIds'] as string[]) ?? []
        return Promise.resolve({ deleted_count: ids.length, affected_page_ids: cohort })
      }
      return strictInvokeFallback(cmd)
    })
  }

  beforeEach(() => {
    useSpaceStore.setState({
      currentSpaceId: 'SPACE_TEST',
      availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
      isReady: true,
    })
  })

  // THE over-eviction guard, and the reason it has to be an event count.
  //
  // A cache-level assertion cannot carry this weight: the harness's
  // `list_all_pages_in_space` mock is static, so a wholesale
  // `invalidateNameCaches()` self-heals on the next synchronous refetch and an
  // "unrelated sibling still present" arm can never fail on its own. Counting
  // the bus events is what distinguishes a NARROW eviction from a correct-
  // looking wipe.
  //
  // The exact-equality assertion falsifies five distinct wrong versions:
  //   * publishing nothing (today's code) → 0 events. The bug.
  //   * evicting only the selected roots → 1 event, `P_NESTED` missing.
  //   * `invalidateNameCaches()` whenever anything was deleted →
  //     `[{kind:'invalidated'}]` — a warm cache thrown away on every delete.
  //   * an ARRAY fan-out instead of a `Set` → 3 events, because
  //     `affected_page_ids` echoes the selected root back.
  //   * an event scoped to anything but the origin space → `spaceId` mismatch.
  it('evicts the selected page roots AND the nested pages the cascade swept, and nothing else', async () => {
    pageStore.setState({
      blocks: [
        makeBlock({ id: 'P_ROOT', block_type: 'page', depth: 0 }),
        makeBlock({ id: 'C_KEEP', depth: 0 }),
      ],
    })
    // The user selected P_ROOT only; the backend cascade also tombstoned its
    // nested page child P_NESTED — a row this store never held — and reports
    // both back.
    replyWithCohort(['P_ROOT', 'P_NESTED'])
    const params = makeDefaultParams({ selectedBlockIds: ['P_ROOT'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    const { changes, unsubscribe } = recordChanges()
    try {
      await act(async () => {
        await result.current.handleBatchDelete()
      })
      expect(changes).toEqual([
        { kind: 'removed', entity: 'page', id: 'P_ROOT', spaceId: 'SPACE_TEST' },
        { kind: 'removed', entity: 'page', id: 'P_NESTED', spaceId: 'SPACE_TEST' },
      ] satisfies NameChange[])
    } finally {
      unsubscribe()
    }
  })

  // #4391 — the event must carry the space the user ACTED in, which is the
  // prop closed over when React handed the click its callback, NOT a fresh
  // `useSpaceStore.getState()` read taken after the IPC settles. Those two
  // diverge exactly when the user switches spaces mid-delete, and this drives
  // them apart deliberately: the live store says SPACE_LIVE, the prop says
  // SPACE_ORIGIN, and only the prop is right. A fresh read would tag the
  // removal as belonging to a space those pages were never in — the "worse
  // than no scoping" mislabelling the bus docblock warns about, and worse
  // than publishing nothing, because the origin cache is then never touched.
  it('scopes the event to the ORIGIN space prop, not the live space store', async () => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_LIVE' })
    pageStore.setState({
      blocks: [makeBlock({ id: 'P_ROOT', block_type: 'page', depth: 0 })],
    })
    replyWithCohort(['P_ROOT'])
    const params = makeDefaultParams({
      selectedBlockIds: ['P_ROOT'],
      currentSpaceId: 'SPACE_ORIGIN',
    })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    const { changes, unsubscribe } = recordChanges()
    try {
      await act(async () => {
        await result.current.handleBatchDelete()
      })
      expect(changes).toEqual([
        { kind: 'removed', entity: 'page', id: 'P_ROOT', spaceId: 'SPACE_ORIGIN' },
      ] satisfies NameChange[])
    } finally {
      unsubscribe()
    }
  })

  // The block tree's divergence from `handleTrash`, and the reason this hook
  // cannot simply union its raw `ids`. A block-tree selection is normally pure
  // CONTENT rows, which the picker never offers: an event per content id is
  // O(listeners x pages) of synchronous work that cannot match anything, and
  // past the cap it would collapse into a full `invalidateNameCaches()` —
  // wiping a warm cache to announce that no page was removed.
  //
  // NON-VACUOUS: `deleted_count` is 2, so the delete unambiguously happened
  // and the store splice below proves the hook ran to completion. Zero events
  // is a decision, not a no-op.
  it('publishes nothing when the selection and the cascade contain no pages', async () => {
    pageStore.setState({
      blocks: [makeBlock({ id: 'BLOCK_1' }), makeBlock({ id: 'BLOCK_2' })],
    })
    replyWithCohort([])
    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1', 'BLOCK_2'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    const { changes, unsubscribe } = recordChanges()
    try {
      await act(async () => {
        await result.current.handleBatchDelete()
      })
      expect(changes).toEqual([])
      // The delete really ran — the rows are gone from the store.
      expect(pageStore.getState().blocks).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  // Same shape as the toolbar's union test. An id the backend SKIPPED
  // (missing, or soft-deleted by a concurrent write between selection and
  // call) is absent from `affected_page_ids` by construction — but the store
  // says it is a page and the user asked for it gone, so it must still be
  // evicted.
  it('still evicts a selected page id the backend left out of the cohort', async () => {
    pageStore.setState({
      blocks: [
        makeBlock({ id: 'P_LIVE', block_type: 'page', depth: 0 }),
        makeBlock({ id: 'P_GONE', block_type: 'page', depth: 0 }),
      ],
    })
    replyWithCohort(['P_LIVE'])
    const params = makeDefaultParams({ selectedBlockIds: ['P_LIVE', 'P_GONE'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    const { changes, unsubscribe } = recordChanges()
    try {
      await act(async () => {
        await result.current.handleBatchDelete()
      })
      expect(changes.map((c) => (c.kind === 'removed' ? c.id : c.kind))).toEqual([
        'P_LIVE',
        'P_GONE',
      ])
    } finally {
      unsubscribe()
    }
  })

  // The `NAME_CACHE_FANOUT_MAX_IDS` budget is measured against what will
  // ACTUALLY be emitted — the de-duplicated union — not against the selection.
  //
  // NON-TAUTOLOGY: 20 selected roots is comfortably under the cap of 25, so a
  // budget checked on `ids.length` takes the per-id branch and fires 30
  // synchronous events, the exact frame-budget overrun the cap was measured to
  // prevent.
  it('measures the fan-out budget against the union, not the selection', async () => {
    const roots = Array.from({ length: 20 }, (_, i) => `ROOT_${i}`)
    const nested = Array.from({ length: 10 }, (_, i) => `NESTED_${i}`)
    expect(roots.length).toBeLessThanOrEqual(NAME_CACHE_FANOUT_MAX_IDS)
    expect(roots.length + nested.length).toBeGreaterThan(NAME_CACHE_FANOUT_MAX_IDS)

    pageStore.setState({
      blocks: roots.map((id) => makeBlock({ id, block_type: 'page', depth: 0 })),
    })
    replyWithCohort([...roots, ...nested])
    const params = makeDefaultParams({ selectedBlockIds: roots })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    const { changes, unsubscribe } = recordChanges()
    try {
      await act(async () => {
        await result.current.handleBatchDelete()
      })
      expect(changes).toEqual([{ kind: 'invalidated' } satisfies NameChange])
    } finally {
      unsubscribe()
    }
  })

  // #4391 — with no active space there is nothing to scope a per-id event to,
  // so the conservative fallback fires. Paired with the content-only test
  // above, which proves the fallback is NOT reached for an empty cohort: a
  // null space plus nothing removed must still publish nothing.
  it('falls back to one invalidation when there is no active space', async () => {
    pageStore.setState({
      blocks: [makeBlock({ id: 'P_ROOT', block_type: 'page', depth: 0 })],
    })
    replyWithCohort(['P_ROOT'])
    const params = makeDefaultParams({ selectedBlockIds: ['P_ROOT'], currentSpaceId: null })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    const { changes, unsubscribe } = recordChanges()
    try {
      await act(async () => {
        await result.current.handleBatchDelete()
      })
      expect(changes).toEqual([{ kind: 'invalidated' } satisfies NameChange])
    } finally {
      unsubscribe()
    }
  })

  it('publishes nothing when there is no active space and no page was removed', async () => {
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1' })] })
    replyWithCohort([])
    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'], currentSpaceId: null })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    const { changes, unsubscribe } = recordChanges()
    try {
      await act(async () => {
        await result.current.handleBatchDelete()
      })
      expect(changes).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it('publishes nothing when the delete IPC fails', async () => {
    pageStore.setState({
      blocks: [makeBlock({ id: 'P_ROOT', block_type: 'page', depth: 0 })],
    })
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    const params = makeDefaultParams({ selectedBlockIds: ['P_ROOT'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    const { changes, unsubscribe } = recordChanges()
    try {
      await act(async () => {
        await result.current.handleBatchDelete()
      })
      expect(changes).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  // End-to-end against the picker cache itself, mirroring the toolbar's
  // sibling test.
  //
  // `P_STAYS` present alongside `P_ROOT`/`P_NESTED` absent rules out the one
  // alternative explanation that would make the ABSENT arms vacuous — "the
  // cache was never populated" — which is why the `before` assertion checks
  // all three ids are offered first.
  //
  // It does NOT prove the fix is narrow: a full-cache wipe self-heals here,
  // because the list refetches synchronously from the static
  // `list_all_pages_in_space` mock and brings everything back. Narrowness is
  // pinned by the event-count tests above. Keep both.
  it('a deleted page stops being offered by the [[ cache, with no space switch', async () => {
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
        return Promise.resolve({ deleted_count: 2, affected_page_ids: ['P_ROOT', 'P_NESTED'] })
      }
      return strictInvokeFallback(cmd)
    })

    const { result: resolveResult } = renderHook(() => useBlockResolve())
    const before = await resolveResult.current.searchPages('')
    const idsBefore = before.filter((i) => !i.isCreate).map((i) => i.id)
    // The cache is PROVEN warm before the delete — otherwise the absence
    // assertions below would hold against an empty cache for free.
    expect(idsBefore).toEqual(expect.arrayContaining(['P_ROOT', 'P_NESTED', 'P_STAYS']))

    pageStore.setState({
      blocks: [makeBlock({ id: 'P_ROOT', block_type: 'page', depth: 0 })],
    })
    const params = makeDefaultParams({ selectedBlockIds: ['P_ROOT'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })
    await act(async () => {
      await result.current.handleBatchDelete()
    })

    // Still viewing SPACE_TEST throughout — no space switch.
    const after = await resolveResult.current.searchPages('')
    const idsAfter = after.filter((i) => !i.isCreate).map((i) => i.id)
    expect(idsAfter).not.toContain('P_ROOT')
    // The cascaded half: the user never named this id, and it is not in this
    // page store either — only `affected_page_ids` can reach it.
    expect(idsAfter).not.toContain('P_NESTED')
    expect(idsAfter).toContain('P_STAYS')
  })
})
