/**
 * Tests for useSyncExportRefused (#6523): each `sync:export_refused` report
 * replaces the refused spaces in the sync store, so an empty one clears them.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SYNC_EXPORT_REFUSED_EVENT, useSyncExportRefused } from '@/hooks/useSyncExportRefused'
import { logger } from '@/lib/logger'
import { useSyncStore } from '@/stores/sync'

const { mockListen } = vi.hoisted(() => ({
  mockListen: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const tauriWindow = window as { __TAURI_INTERNALS__?: unknown }
let hadTauriInternals: boolean

/** Deliver a payload through the registered `sync:export_refused` handler. */
async function emit(payload: unknown): Promise<void> {
  await waitFor(() => {
    expect(mockListen).toHaveBeenCalledTimes(1)
  })
  const handler = mockListen.mock.calls[0]?.[1] as (event: { payload: unknown }) => void
  handler({ payload })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockListen.mockResolvedValue(vi.fn())
  useSyncStore.getState().reset()
  hadTauriInternals = '__TAURI_INTERNALS__' in window
  tauriWindow.__TAURI_INTERNALS__ = {}
})

afterEach(() => {
  if (!hadTauriInternals) delete tauriWindow.__TAURI_INTERNALS__
})

describe('useSyncExportRefused', () => {
  it('listens for the backend event name', async () => {
    renderHook(() => useSyncExportRefused())
    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledTimes(1)
    })
    expect(SYNC_EXPORT_REFUSED_EVENT).toBe('sync:export_refused')
    expect(mockListen.mock.calls[0]?.[0]).toBe('sync:export_refused')
  })

  it('stores the refused spaces, and a later empty report clears them', async () => {
    renderHook(() => useSyncExportRefused())

    await emit({ type: 'export_refused', space_ids: ['SPACE_WORK'] })
    expect(useSyncStore.getState().exportRefusedSpaces).toEqual(['SPACE_WORK'])

    await emit({ type: 'export_refused', space_ids: [] })
    expect(useSyncStore.getState().exportRefusedSpaces).toEqual([])
  })

  it('does not listen outside Tauri', () => {
    delete tauriWindow.__TAURI_INTERNALS__
    renderHook(() => useSyncExportRefused())
    expect(mockListen).not.toHaveBeenCalled()
  })

  it('logs a rejected listen() and keeps the store as it was', async () => {
    mockListen.mockRejectedValue(new Error('no event bus'))
    renderHook(() => useSyncExportRefused())
    await waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'useSyncExportRefused',
        'Failed to listen to sync:export_refused',
        undefined,
        expect.any(Error),
      )
    })
    expect(useSyncStore.getState().exportRefusedSpaces).toEqual([])
  })
})
