/**
 * Tests for useCheckboxSyntax hook.
 *
 * Validates:
 *  - When setTodoState rejects, the .catch arm logs via `logger.error` AND
 *    surfaces a toast (no silent catch — FE-H-8).
 *  - When setTodoState rejects, the optimistic `todo_state` mutation is
 *    reverted to the prior value (FE-H-7).
 */

import { renderHook, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { act } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { useCheckboxSyntax } from '@/hooks/useCheckboxSyntax'
import { commands } from '@/lib/bindings'
import type { AppError } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import type { PageBlockState } from '@/stores/page-blocks'

// #2927 — the hook calls the generated bindings directly, so the seam this
// suite stubs is `commands.*` rather than the retired `@/lib/tauri` wrapper.
// Spreading `actual.commands` keeps every other command real, and stubbing at
// the envelope level means the production `unwrap` runs for real.
vi.mock('@/lib/bindings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bindings')>('@/lib/bindings')
  return {
    ...actual,
    commands: {
      ...actual.commands,
      setTodoState: vi.fn(),
      // Checkbox-syntax DONE path reads `blocked_by` via the single-key
      // `get_property` command.
      getProperty: vi.fn(),
    },
  }
})

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock('@/stores/undo', () => ({
  useUndoStore: {
    getState: () => ({ onNewAction: vi.fn() }),
  },
}))

const mockedSetTodoState = vi.mocked(commands.setTodoState)
const mockedGetProperty = vi.mocked(commands.getProperty)
const mockedLoggerError = vi.mocked(logger.error)
const mockedToastError = vi.mocked(toast.error)

describe('useCheckboxSyntax', () => {
  beforeEach(() => {
    // Mock call counts accumulate across tests without an explicit reset;
    // the #1341 guard tests assert exact `setTodoState` call counts.
    vi.clearAllMocks()
  })

  it('logs via logger.error AND surfaces a toast when setTodoState rejects', async () => {
    const failure = new Error('ipc failed')
    mockedSetTodoState.mockRejectedValue(failure)

    const pageStore = {
      // G — `useCheckboxSyntax` reads via `blocksById.get(...)`.
      getState: () => ({ blocks: [], blocksById: new Map() }),
      setState: vi.fn(),
    } as unknown as StoreApi<PageBlockState>

    const { result } = renderHook(() =>
      useCheckboxSyntax({
        focusedBlockId: 'B1',
        rootParentId: 'R1',
        pageStore,
        t: ((k: string) => k) as unknown as TFunction,
      }),
    )

    await act(async () => {
      result.current('DONE')
      // Flush the rejection through the microtask queue.
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockedLoggerError).toHaveBeenCalledWith(
      'useCheckboxSyntax',
      'setTodoState failed',
      { focusedBlockId: 'B1', state: 'DONE' },
      failure,
    )
    expect(mockedToastError).toHaveBeenCalledWith('blockTree.setTaskStateFailed')
  })

  it('treats a { status: "error" } envelope as a failure, not a silent success (#2927)', async () => {
    // The retired `@/lib/tauri` wrapper owned the `unwrap`; the call site now
    // does. `commands.*` RESOLVES a `{ status: 'error' }` envelope instead of
    // rejecting, so a call site that dropped `unwrap` would run the SUCCESS
    // branch on a backend failure. No rejection-based test can see that — a
    // rejected mock takes the `.catch` arm whether or not `unwrap` is there.
    const appError: AppError = { kind: 'validation', message: 'bad state' }
    mockedSetTodoState.mockResolvedValue({ status: 'error', error: appError })

    const pageStore = {
      getState: () => ({ blocks: [], blocksById: new Map() }),
      setState: vi.fn(),
    } as unknown as StoreApi<PageBlockState>

    const { result } = renderHook(() =>
      useCheckboxSyntax({
        focusedBlockId: 'B1',
        rootParentId: 'R1',
        pageStore,
        t: ((k: string) => k) as unknown as TFunction,
      }),
    )

    await act(async () => {
      result.current('DONE')
      await Promise.resolve()
    })

    // Also pins the positional argument order of the migrated call.
    expect(mockedSetTodoState).toHaveBeenCalledWith('B1', 'DONE')
    await waitFor(() => {
      expect(mockedLoggerError).toHaveBeenCalledWith(
        'useCheckboxSyntax',
        'setTodoState failed',
        { focusedBlockId: 'B1', state: 'DONE' },
        appError,
      )
    })
    expect(mockedToastError).toHaveBeenCalledWith('blockTree.setTaskStateFailed')
  })

  it('reverts the optimistic todo_state mutation when setTodoState rejects (FE-H-7)', async () => {
    mockedSetTodoState.mockRejectedValue(new Error('ipc failed'))

    const initialBlocks = [makeBlock({ id: 'B1', todo_state: 'TODO' })]
    const pageStore = createStore<PageBlockState>()(() => ({
      blocks: initialBlocks,
      // G — keep Map in sync with `blocks`.
      blocksById: new Map(initialBlocks.map((b) => [b.id, b])),
      rootParentId: 'R1',
      loading: false,
      truncatedTotal: null,
      getBlockById: (id: string) => initialBlocks.find((b) => b.id === id),
      load: vi.fn(),
      createBelow: vi.fn(),
      edit: vi.fn(),
      remove: vi.fn(),
      splitBlock: vi.fn(),
      reorder: vi.fn(),
      moveToParent: vi.fn(),
      moveBlocks: vi.fn(),
      indent: vi.fn(),
      dedent: vi.fn(),
      moveUp: vi.fn(),
      moveDown: vi.fn(),
      pasteBlocks: vi.fn(),
      appendBlock: vi.fn(),
    })) as StoreApi<PageBlockState>

    const { result } = renderHook(() =>
      useCheckboxSyntax({
        focusedBlockId: 'B1',
        rootParentId: 'R1',
        pageStore,
        t: ((k: string) => k) as unknown as TFunction,
      }),
    )

    await act(async () => {
      result.current('DONE')
    })

    await waitFor(() => {
      const block = pageStore.getState().blocks.find((b) => b.id === 'B1')
      expect(block?.todo_state).toBe('TODO')
    })
  })

  it('drops a rapid second invocation on the same block while the first is in flight (#1341)', async () => {
    // Pending (never-resolving) promise keeps the first call in flight so the
    // re-entrancy guard is engaged when the second invocation arrives.
    mockedSetTodoState.mockReturnValue(new Promise(() => {}))

    const pageStore = {
      getState: () => ({ blocks: [], blocksById: new Map() }),
      setState: vi.fn(),
    } as unknown as StoreApi<PageBlockState>

    const { result } = renderHook(() =>
      useCheckboxSyntax({
        focusedBlockId: 'B1',
        rootParentId: 'R1',
        pageStore,
        t: ((k: string) => k) as unknown as TFunction,
      }),
    )

    await act(async () => {
      result.current('DONE')
      result.current('DONE')
      await Promise.resolve()
    })

    // The second invocation is dropped by the guard — only one IPC call fires.
    expect(mockedSetTodoState).toHaveBeenCalledTimes(1)
  })

  it('allows a subsequent invocation after the first settles (guard resets via .finally) (#1341)', async () => {
    // First call resolves so the guard resets; second call is then allowed.
    mockedSetTodoState.mockResolvedValue({
      status: 'ok',
      data: makeBlock({ id: 'B1', todo_state: 'DONE' }),
    })
    // DONE path reads `blocked_by` via `getProperty`; resolve it (no deps).
    mockedGetProperty.mockResolvedValue({ status: 'ok', data: null })

    const pageStore = {
      getState: () => ({ blocks: [], blocksById: new Map() }),
      setState: vi.fn(),
    } as unknown as StoreApi<PageBlockState>

    const { result } = renderHook(() =>
      useCheckboxSyntax({
        focusedBlockId: 'B1',
        rootParentId: 'R1',
        pageStore,
        t: ((k: string) => k) as unknown as TFunction,
      }),
    )

    await act(async () => {
      result.current('DONE')
      // Flush the resolution + the `.finally` guard reset.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      result.current('DONE')
      await Promise.resolve()
    })

    expect(mockedSetTodoState).toHaveBeenCalledTimes(2)
  })
})
