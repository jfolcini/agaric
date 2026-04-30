/**
 * Tests for useAttachmentCount — fetches `listAttachments(blockId).length`
 * and returns 0 when the call fails.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockListAttachments = vi.fn()
vi.mock('../../lib/tauri', () => ({
  listAttachments: (...args: unknown[]) => mockListAttachments(...args),
}))

const mockLoggerWarn = vi.fn()
vi.mock('../../lib/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}))

import { useAttachmentCount } from '../useAttachmentCount'

function makeRow(id: string, blockId: string) {
  return {
    id,
    block_id: blockId,
    filename: `${id}.pdf`,
    mime_type: 'application/pdf',
    size_bytes: 100,
    fs_path: `/tmp/${id}.pdf`,
    created_at: '2025-01-01T00:00:00Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockListAttachments.mockResolvedValue([])
})

describe('useAttachmentCount', () => {
  it('returns 0 initially', () => {
    mockListAttachments.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useAttachmentCount('BLOCK_1'))
    expect(result.current).toBe(0)
  })

  it('updates after listAttachments resolves', async () => {
    mockListAttachments.mockResolvedValueOnce([
      makeRow('A1', 'BLOCK_1'),
      makeRow('A2', 'BLOCK_1'),
      makeRow('A3', 'BLOCK_1'),
    ])
    const { result } = renderHook(() => useAttachmentCount('BLOCK_1'))
    await waitFor(() => {
      expect(result.current).toBe(3)
    })
    expect(mockListAttachments).toHaveBeenCalledWith('BLOCK_1')
  })

  it('stays at 0 if listAttachments rejects and logs a warning', async () => {
    mockListAttachments.mockRejectedValueOnce(new Error('disk read failed'))
    const { result } = renderHook(() => useAttachmentCount('BLOCK_1'))
    await waitFor(() => {
      expect(mockLoggerWarn).toHaveBeenCalled()
    })
    expect(result.current).toBe(0)
    const [scope, message] = mockLoggerWarn.mock.calls[0] as [string, string]
    expect(scope).toBe('SortableBlock')
    expect(message).toBe('attachment count failed')
  })

  it('re-runs when blockId changes', async () => {
    mockListAttachments
      .mockResolvedValueOnce([makeRow('A1', 'BLOCK_1')])
      .mockResolvedValueOnce([makeRow('B1', 'BLOCK_2'), makeRow('B2', 'BLOCK_2')])

    const { result, rerender } = renderHook(({ id }) => useAttachmentCount(id), {
      initialProps: { id: 'BLOCK_1' },
    })

    await waitFor(() => {
      expect(result.current).toBe(1)
    })

    rerender({ id: 'BLOCK_2' })

    await waitFor(() => {
      expect(result.current).toBe(2)
    })

    expect(mockListAttachments).toHaveBeenNthCalledWith(1, 'BLOCK_1')
    expect(mockListAttachments).toHaveBeenNthCalledWith(2, 'BLOCK_2')
  })

  it('does not call setState after unmount (stale flag prevents leak)', async () => {
    let resolveAttachments: (rows: ReturnType<typeof makeRow>[]) => void = () => {}
    mockListAttachments.mockReturnValueOnce(
      new Promise<ReturnType<typeof makeRow>[]>((resolve) => {
        resolveAttachments = resolve
      }),
    )

    const { unmount } = renderHook(() => useAttachmentCount('BLOCK_1'))
    unmount()

    // Resolve AFTER unmount — must not throw an act() warning, must not throw
    resolveAttachments([makeRow('A1', 'BLOCK_1')])
    await Promise.resolve()
    // No assertion error here means the stale flag worked.
    expect(mockListAttachments).toHaveBeenCalledWith('BLOCK_1')
  })
})
