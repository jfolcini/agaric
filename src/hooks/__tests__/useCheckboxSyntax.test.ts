/**
 * Tests for useCheckboxSyntax hook.
 *
 * Validates:
 *  - When setTodoState rejects, the .catch arm logs via `logger.error` AND
 *    surfaces a toast (no silent catch — see REVIEW-LATER FE-H-8).
 */

import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { logger } from '../../lib/logger'
import { setTodoState } from '../../lib/tauri'
import type { PageBlockState } from '../../stores/page-blocks'
import { useCheckboxSyntax } from '../useCheckboxSyntax'

vi.mock('../../lib/tauri', () => ({
  setTodoState: vi.fn(),
  getProperties: vi.fn(),
}))

vi.mock('../../lib/logger', () => ({
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

vi.mock('../../stores/undo', () => ({
  useUndoStore: {
    getState: () => ({ onNewAction: vi.fn() }),
  },
}))

const mockedSetTodoState = vi.mocked(setTodoState)
const mockedLoggerError = vi.mocked(logger.error)
const mockedToastError = vi.mocked(toast.error)

describe('useCheckboxSyntax', () => {
  it('logs via logger.error AND surfaces a toast when setTodoState rejects', async () => {
    const failure = new Error('ipc failed')
    mockedSetTodoState.mockRejectedValue(failure)

    const pageStore = {
      setState: vi.fn(),
    } as unknown as StoreApi<PageBlockState>

    const { result } = renderHook(() =>
      useCheckboxSyntax({
        focusedBlockId: 'B1',
        rootParentId: 'R1',
        pageStore,
        t: (k: string) => k,
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
})
