/**
 * Tests for useSyncLocalTextKept (#6561): one toast that stays until dismissed
 * names a single kept page, counts several, and opens the Trash (#6870).
 */

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSyncLocalTextKept } from '@/hooks/useSyncLocalTextKept'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { useNavigationStore } from '@/stores/navigation'

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
    action: { label: 'Open Trash', onClick: expect.any(Function) },
    onDismiss: expect.any(Function),
  }
  const ONE = (title: string) =>
    `Another device deleted or moved “${title}”. The blocks you added under it here that had not synced yet are in the Trash.`
  const MANY = (count: number) =>
    `Another device deleted or moved ${count} pages. The blocks you added under them here that had not synced yet are in the Trash.`

  it('names a single kept page in one lasting toast that opens the Trash', async () => {
    const report = await subscribed()

    report(['Trip notes'])

    expect(vi.mocked(notify.warning).mock.calls).toEqual([[ONE('Trip notes'), LASTING]])
  })

  it('counts the kept pages of a report instead of listing them', async () => {
    const report = await subscribed()

    report(['Trip notes', 'Groceries', 'Recipes'])

    expect(vi.mocked(notify.warning).mock.calls).toEqual([[MANY(3), LASTING]])
  })

  it('shortens a long title so the toast keeps its size', async () => {
    const report = await subscribed()

    report(['A page title that goes on far longer than any toast line can hold'])

    expect(vi.mocked(notify.warning).mock.calls[0]?.[0]).toBe(
      ONE('A page title that goes on far longer th…'),
    )
  })

  it('adds a later report while the toast is up, and counts afresh once it is dismissed', async () => {
    const report = await subscribed()

    report(['Trip notes'])
    report(['Groceries'])
    const opts = vi.mocked(notify.warning).mock.lastCall?.[1] as { onDismiss: () => void }
    opts.onDismiss()
    report(['Recipes'])

    expect(vi.mocked(notify.warning).mock.calls.map(([message]) => message)).toEqual([
      ONE('Trip notes'),
      MANY(2),
      ONE('Recipes'),
    ])
  })

  it('opens the Trash from the toast and counts afresh after it', async () => {
    useNavigationStore.getState().setView('journal')
    const report = await subscribed()

    report(['Trip notes', 'Groceries'])
    const opts = vi.mocked(notify.warning).mock.lastCall?.[1] as unknown as {
      action: { onClick: () => void }
    }
    opts.action.onClick()
    report(['Recipes'])

    expect(useNavigationStore.getState().currentView).toBe('trash')
    expect(vi.mocked(notify.warning).mock.lastCall?.[0]).toBe(ONE('Recipes'))
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
