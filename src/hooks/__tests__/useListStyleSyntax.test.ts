/**
 * Tests for useListStyleSyntax hook (#4552 slice 2).
 *
 * Mirrors `useCheckboxSyntax.test.ts`'s shape: the hook is invoked when
 * `ListStyleInputRule` (`list-style-input-rule.ts`) detects a typed `1. ` /
 * `- ` marker and calls back with the implied style.
 */

import { renderHook } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { act } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useListStyleSyntax } from '@/hooks/useListStyleSyntax'
import { logger } from '@/lib/logger'

const mockedSetListStyle = vi.fn()

vi.mock('@/lib/list-style', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/list-style')>()
  return {
    ...actual,
    setListStyle: (...args: Parameters<typeof actual.setListStyle>) => mockedSetListStyle(...args),
  }
})

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}))

const mockedLoggerError = vi.mocked(logger.error)
const mockedToastError = vi.mocked(toast.error)
const t = ((k: string) => k) as unknown as TFunction as (key: string) => string

describe('useListStyleSyntax', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls setListStyle with the focused block id and the given style', async () => {
    mockedSetListStyle.mockResolvedValue(undefined)
    const { result } = renderHook(() => useListStyleSyntax({ focusedBlockId: 'B1', t }))

    await act(async () => {
      result.current('ordered')
      await Promise.resolve()
    })

    expect(mockedSetListStyle).toHaveBeenCalledWith('B1', 'ordered')
  })

  it('no-ops when no block is focused', async () => {
    mockedSetListStyle.mockResolvedValue(undefined)
    const { result } = renderHook(() => useListStyleSyntax({ focusedBlockId: null, t }))

    await act(async () => {
      result.current('bullet')
      await Promise.resolve()
    })

    expect(mockedSetListStyle).not.toHaveBeenCalled()
  })

  it('logs via logger.error AND surfaces a toast when setListStyle rejects', async () => {
    const failure = new Error('ipc failed')
    mockedSetListStyle.mockRejectedValue(failure)
    const { result } = renderHook(() => useListStyleSyntax({ focusedBlockId: 'B1', t }))

    await act(async () => {
      result.current('bullet')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockedLoggerError).toHaveBeenCalledWith(
      'useListStyleSyntax',
      'setListStyle failed',
      { focusedBlockId: 'B1', style: 'bullet' },
      failure,
    )
    expect(mockedToastError).toHaveBeenCalledWith('blockTree.setListStyleFailed')
  })

  it('drops a rapid second invocation on the same block while the first is in flight', async () => {
    mockedSetListStyle.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useListStyleSyntax({ focusedBlockId: 'B1', t }))

    await act(async () => {
      result.current('ordered')
      result.current('bullet')
      await Promise.resolve()
    })

    expect(mockedSetListStyle).toHaveBeenCalledTimes(1)
  })

  it('allows a subsequent invocation after the first settles', async () => {
    mockedSetListStyle.mockResolvedValue(undefined)
    const { result } = renderHook(() => useListStyleSyntax({ focusedBlockId: 'B1', t }))

    await act(async () => {
      result.current('ordered')
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      result.current('bullet')
      await Promise.resolve()
    })

    expect(mockedSetListStyle).toHaveBeenCalledTimes(2)
    expect(mockedSetListStyle).toHaveBeenNthCalledWith(1, 'B1', 'ordered')
    expect(mockedSetListStyle).toHaveBeenNthCalledWith(2, 'B1', 'bullet')
  })
})
