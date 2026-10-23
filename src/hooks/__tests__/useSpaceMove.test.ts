/**
 * `spaceMoveFailureMessage` (#5841 S0.6): a move the backend refuses with its
 * own reason (the undo cap's "move fewer pages") shows that reason; anything
 * else shows the caller's fallback. The hook itself is driven end to end by
 * `SpaceMoveConfirmDialog.test.tsx`; this file pins only that a move which
 * went through is never reported as failed.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { spaceMoveFailureMessage, useSpaceMove } from '@/hooks/useSpaceMove'
import { logger } from '@/lib/logger'

const CAP =
  'undoing this move would take 1201 steps, its pages and the 1200 property values it removes, more than one undo can take; move fewer pages'

describe('spaceMoveFailureMessage', () => {
  it("shows a validation refusal's own reason", () => {
    expect(
      spaceMoveFailureMessage({ kind: 'validation', message: CAP }, 'Failed to move page'),
    ).toBe(CAP)
  })

  it('falls back for any other failure', () => {
    expect(spaceMoveFailureMessage(new Error('write failed'), 'Failed to move page')).toBe(
      'Failed to move page',
    )
    expect(
      spaceMoveFailureMessage(
        { kind: 'database', message: 'disk I/O error' },
        'Failed to move page',
      ),
    ).toBe('Failed to move page')
  })
})

describe('useSpaceMove', () => {
  const onFailed = vi.fn()
  const afterMove = new Error('the caller broke after the move')
  const request = {
    ids: ['PAGE1'],
    targetSpaceId: 'SPACE_B',
    targetName: 'Space B',
    onMoved: () => {
      throw afterMove
    },
    onFailed,
  }

  function mockMove(losses: { key: string; count: number }[]): void {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({ preview_space_move: () => losses, move_blocks_to_space: () => 1 }),
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not report a move that went through as failed when onMoved throws', async () => {
    mockMove([])
    const logged = vi.spyOn(logger, 'error')
    const { result } = renderHook(() => useSpaceMove())

    await act(() => result.current.requestMove(request))

    expect(onFailed).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledWith('useSpaceMove', expect.any(String), { count: 1 }, afterMove)
  })

  it('does not report a confirmed move as failed when onMoved throws', async () => {
    mockMove([{ key: 'stage', count: 1 }])
    const { result } = renderHook(() => useSpaceMove())
    await act(() => result.current.requestMove(request))

    const outcome = await act(() =>
      result.current.confirm().then(
        () => 'closed',
        (err: unknown) => err,
      ),
    )

    expect(onFailed).not.toHaveBeenCalled()
    expect(outcome).toBe('closed')
    expect(result.current.confirmation).toBeNull()
  })
})
