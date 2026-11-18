/**
 * Tests for useSyncLocalTextKept (#6561): one toast that stays until dismissed
 * names every page a `sync:local_text_kept` report kept (#6870).
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
  async function subscribed(): Promise<(titles: string[]) => void> {
    renderHook(() => useSyncLocalTextKept())
    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledTimes(1)
    })
    expect(mockListen.mock.calls[0]?.[0]).toBe('sync:local_text_kept')
    const handler = mockListen.mock.calls[0]?.[1] as (event: { payload: unknown }) => void
    return (titles) => handler({ payload: { type: 'local_text_kept', page_titles: titles } })
  }

  const LASTING = {
    id: 'sync-local-text-kept',
    duration: Number.POSITIVE_INFINITY,
    onDismiss: expect.any(Function),
  }

  it('names a single kept page in one lasting toast', async () => {
    const report = await subscribed()

    report(['Trip notes'])

    expect(vi.mocked(notify.warning).mock.calls).toEqual([
      [
        'Another device deleted or moved “Trip notes”. The blocks you added under it here that had not synced yet are in the Trash.',
        LASTING,
      ],
    ])
  })

  it('names every kept page of a report in one toast', async () => {
    const report = await subscribed()

    report(['Trip notes', 'Groceries'])

    expect(vi.mocked(notify.warning).mock.calls).toEqual([
      [
        'Another device deleted or moved 2 pages: “Trip notes”, “Groceries”. The blocks you added under them here that had not synced yet are in the Trash.',
        LASTING,
      ],
    ])
  })

  it('adds a later report to the toast while it is up, and starts over once dismissed', async () => {
    const report = await subscribed()

    report(['Trip notes'])
    report(['Groceries'])
    const opts = vi.mocked(notify.warning).mock.lastCall?.[1] as { onDismiss: () => void }
    opts.onDismiss()
    report(['Recipes'])

    expect(vi.mocked(notify.warning).mock.calls.map(([message]) => message)).toEqual([
      'Another device deleted or moved “Trip notes”. The blocks you added under it here that had not synced yet are in the Trash.',
      'Another device deleted or moved 2 pages: “Trip notes”, “Groceries”. The blocks you added under them here that had not synced yet are in the Trash.',
      'Another device deleted or moved “Recipes”. The blocks you added under it here that had not synced yet are in the Trash.',
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
