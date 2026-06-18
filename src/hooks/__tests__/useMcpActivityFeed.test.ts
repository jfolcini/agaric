/**
 * Tests for useMcpActivityFeed hook.
 *
 * Validates:
 * - entries start empty
 * - each `mcp:activity` event prepends newest-first
 * - the render buffer is bounded at ACTIVITY_RENDER_CAP (100)
 * - a `listen()` rejection leaves the feed empty (no throw)
 *
 * The listen/unlisten lifecycle now lives in the shared
 * useTauriEventListener hook; these tests drive the same
 * `@tauri-apps/api/event` mock to confirm behaviour is preserved.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let eventListeners: Map<string, (event: unknown) => void>
let listenImpl: (eventName: string, handler: (event: unknown) => void) => Promise<() => void>

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((eventName: string, handler: (event: unknown) => void) =>
    listenImpl(eventName, handler),
  ),
}))

import {
  ACTIVITY_RENDER_CAP,
  MCP_ACTIVITY_EVENT,
  useMcpActivityFeed,
  type ActivityEntry,
} from '../useMcpActivityFeed'

beforeEach(() => {
  eventListeners = new Map()
  listenImpl = async (eventName, handler) => {
    eventListeners.set(eventName, handler)
    return () => {
      eventListeners.delete(eventName)
    }
  }
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

function makeEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    toolName: 'read',
    summary: 'read a block',
    timestamp: '2026-06-19T00:00:00.000Z',
    actorKind: 'agent',
    result: { kind: 'ok' },
    sessionId: '01HZZ',
    ...overrides,
  }
}

function fireActivity(entry: ActivityEntry) {
  const handler = eventListeners.get(MCP_ACTIVITY_EVENT)
  if (handler) {
    handler({ payload: entry })
  }
}

describe('useMcpActivityFeed', () => {
  it('starts with an empty feed', async () => {
    const { result } = renderHook(() => useMcpActivityFeed())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.entries).toEqual([])
  })

  it('prepends new entries newest-first', async () => {
    const { result } = renderHook(() => useMcpActivityFeed())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    act(() => {
      fireActivity(makeEntry({ summary: 'first' }))
    })
    act(() => {
      fireActivity(makeEntry({ summary: 'second' }))
    })

    expect(result.current.entries.map((e) => e.summary)).toEqual(['second', 'first'])
  })

  it('bounds the render buffer at ACTIVITY_RENDER_CAP', async () => {
    const { result } = renderHook(() => useMcpActivityFeed())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    act(() => {
      for (let i = 0; i < ACTIVITY_RENDER_CAP + 10; i++) {
        fireActivity(makeEntry({ summary: `entry-${i}` }))
      }
    })

    expect(result.current.entries).toHaveLength(ACTIVITY_RENDER_CAP)
    // Newest-first: the last-fired entry is at the head.
    expect(result.current.entries[0]?.summary).toBe(`entry-${ACTIVITY_RENDER_CAP + 10 - 1}`)
  })

  it('keeps the feed empty when listen() rejects (non-Tauri context)', async () => {
    listenImpl = () => Promise.reject(new Error('not in tauri'))
    const { result } = renderHook(() => useMcpActivityFeed())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.entries).toEqual([])
  })
})
