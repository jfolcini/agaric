/**
 * Tests for useBindExposure (#3864): the live event, the mount-time backfill, and
 * the clear on an endpoint rebind.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SYNC_INTERNET_FACING_BIND_EVENT, useBindExposure } from '@/hooks/useBindExposure'
import { SYNC_ENDPOINT_BINDING_EVENT } from '@/hooks/useMdnsStatus'
import type { BindExposureStatus } from '@/lib/bindings'

const { mockUnlisten, mockListen, mockGetBindExposureStatus } = vi.hoisted(() => {
  const unlisten = vi.fn()
  const listen = vi.fn().mockResolvedValue(unlisten)
  const getBindExposureStatus = vi.fn()
  return {
    mockUnlisten: unlisten,
    mockListen: listen,
    mockGetBindExposureStatus: getBindExposureStatus,
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/lib/bindings', () => ({
  commands: {
    getBindExposureStatus: (...args: unknown[]) => mockGetBindExposureStatus(...args),
  },
}))

const ok = <T>(data: T) => ({ status: 'ok' as const, data })

const PRIVATE: BindExposureStatus = { internet_facing: null }
const PUBLIC: BindExposureStatus = { internet_facing: { address: '192.160.160.80', port: 54321 } }

let hadTauriInternals: boolean

beforeEach(() => {
  vi.clearAllMocks()
  hadTauriInternals = '__TAURI_INTERNALS__' in window
  if (!hadTauriInternals) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      writable: true,
      configurable: true,
    })
  }
  mockListen.mockResolvedValue(mockUnlisten)
  mockGetBindExposureStatus.mockResolvedValue(ok(PRIVATE))
})

afterEach(() => {
  if (!hadTauriInternals) {
    delete (window as any).__TAURI_INTERNALS__
  }
})

function getListenerCallback(eventName: string): (event: { payload: unknown }) => void {
  const call = mockListen.mock.calls.find((c) => c[0] === eventName)
  if (!call) throw new Error(`No listener registered for "${eventName}"`)
  return call[1] as (event: { payload: unknown }) => void
}

describe('useBindExposure — endpoint rebind', () => {
  it('clears a live internet-facing bind when the daemon binds a new endpoint', async () => {
    const { result } = renderHook(() => useBindExposure())
    await waitFor(() => expect(mockGetBindExposureStatus).toHaveBeenCalledTimes(1))
    act(() => {
      getListenerCallback(SYNC_INTERNET_FACING_BIND_EVENT)({
        payload: { address: '203.0.113.9', port: 41234 },
      })
    })
    expect(result.current).toEqual({ address: '203.0.113.9', port: 41234 })

    act(() => {
      getListenerCallback(SYNC_ENDPOINT_BINDING_EVENT)({ payload: { type: 'endpoint_binding' } })
    })
    expect(result.current).toBeNull()
  })

  it('clears a backfilled internet-facing bind when the daemon binds a new endpoint', async () => {
    mockGetBindExposureStatus.mockResolvedValue(ok(PUBLIC))
    const { result } = renderHook(() => useBindExposure())
    await waitFor(() => expect(result.current).toEqual({ address: '192.160.160.80', port: 54321 }))

    act(() => {
      getListenerCallback(SYNC_ENDPOINT_BINDING_EVENT)({ payload: { type: 'endpoint_binding' } })
    })
    expect(result.current).toBeNull()
  })
})
