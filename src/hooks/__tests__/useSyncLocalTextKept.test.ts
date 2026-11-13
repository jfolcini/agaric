/**
 * Tests for useSyncLocalTextKept (#6561): each title in a
 * `sync:local_text_kept` report gets a toast that stays until dismissed.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSyncLocalTextKept } from '@/hooks/useSyncLocalTextKept'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

const { mockListen } = vi.hoisted(() => ({
  mockListen: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/notify', () => ({
  notify: { warning: vi.fn() },
}))

const tauriWindow = window as { __TAURI_INTERNALS__?: unknown }
let hadTauriInternals: boolean

beforeEach(() => {
  vi.clearAllMocks()
  mockListen.mockResolvedValue(vi.fn())
  hadTauriInternals = '__TAURI_INTERNALS__' in window
  tauriWindow.__TAURI_INTERNALS__ = {}
})

afterEach(() => {
  if (!hadTauriInternals) delete tauriWindow.__TAURI_INTERNALS__
})

describe('useSyncLocalTextKept', () => {
  it('shows one lasting toast per kept page, naming it', async () => {
    renderHook(() => useSyncLocalTextKept())
    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledTimes(1)
    })
    expect(mockListen.mock.calls[0]?.[0]).toBe('sync:local_text_kept')
    const handler = mockListen.mock.calls[0]?.[1] as (event: { payload: unknown }) => void

    handler({ payload: { type: 'local_text_kept', page_titles: ['Trip notes', 'Groceries'] } })

    expect(vi.mocked(notify.warning).mock.calls).toEqual([
      [
        'Another device deleted or moved “Trip notes”. The blocks you added under it here that had not synced yet are in the Trash.',
        { duration: Number.POSITIVE_INFINITY },
      ],
      [
        'Another device deleted or moved “Groceries”. The blocks you added under it here that had not synced yet are in the Trash.',
        { duration: Number.POSITIVE_INFINITY },
      ],
    ])
  })

  it('does not listen outside Tauri', () => {
    delete tauriWindow.__TAURI_INTERNALS__
    renderHook(() => useSyncLocalTextKept())
    expect(mockListen).not.toHaveBeenCalled()
  })

  it('logs a rejected listen() and shows nothing', async () => {
    mockListen.mockRejectedValue(new Error('no event bus'))
    renderHook(() => useSyncLocalTextKept())
    await waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'useSyncLocalTextKept',
        'Failed to listen to sync:local_text_kept',
        undefined,
        expect.any(Error),
      )
    })
    expect(notify.warning).not.toHaveBeenCalled()
  })
})
