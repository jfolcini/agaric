import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { useTrashCount } from '@/hooks/useTrashCount'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

function stubInvoke(handlers: Readonly<TypedInvokeHandlers>): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(handlers))
}

describe('useTrashCount', () => {
  // #2248 — trash is inherently space-scoped: the badge only counts when a
  // space is active. Seed a valid active space so the hook actually issues the
  // `count_trash` IPC (the null-space short-circuit is covered separately).
  const ACTIVE_SPACE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    useSpaceStore.setState({ currentSpaceId: ACTIVE_SPACE })
  })

  afterEach(() => {
    vi.useRealTimers()
    useSpaceStore.setState({ currentSpaceId: null })
  })

  it('polls count_trash every 30 s', async () => {
    // The hook routes through the dedicated `count_trash` IPC (returns a
    // plain `number`) so the badge stays accurate regardless of trash size.
    stubInvoke({ count_trash: () => 137 })

    const { result } = renderHook(() => useTrashCount())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const initialCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'count_trash').length
    expect(initialCalls).toBe(1)
    // 137 > 100 — the legacy shape would have clamped this to 100; the
    // new IPC returns the true count from `SELECT COUNT(*)`.
    expect(result.current).toBe(137)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    const afterTickCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'count_trash').length
    expect(afterTickCalls).toBe(2)
  })

  // IPC error-path (AGENTS.md § Testing › Conventions / check-ipc-error-path.mjs). When the
  // `countTrash` IPC rejects, the failure is SILENTLY handled: the polling
  // layer (`usePollingQuery`) catches it into `error` state, and
  // `useItemCount` ignores that error, returning the safe fallback `0`
  // (no toast, no banner — a stale/zero badge is preferable to crashing
  // the App shell over a transient count query). We assert the hook
  // reaches that safe state and never throws.
  it('returns 0 (no crash) when count_trash rejects', async () => {
    stubInvoke({
      count_trash: () => {
        throw new Error('boom')
      },
    })

    const { result } = renderHook(() => useTrashCount())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // The rejection was swallowed by the polling layer; the badge count
    // falls back to 0 rather than surfacing an error to the user.
    expect(result.current).toBe(0)
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'count_trash').length).toBe(1)
  })

  // #2248 — the IPC carries a `SpaceScope`, not a bare `spaceId` string. The
  // wrapper wraps the active-space ULID into `{ kind: 'active', space_id }`;
  // there is no cross-space trash count.
  it('sends an active SpaceScope carrying the current space id', async () => {
    stubInvoke({ count_trash: () => 3 })

    renderHook(() => useTrashCount())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockedInvoke).toHaveBeenCalledWith('count_trash', {
      scope: { kind: 'active', space_id: ACTIVE_SPACE },
    })
  })

  // #2248 (the crux) — with no active space, the badge must NOT issue a
  // cross-space count. The old bare-string API relied on an empty-string
  // "no-match" sentinel; the hook now short-circuits to 0 locally and never
  // touches the IPC, so a malformed/global scope can never leak across spaces.
  it('short-circuits to 0 without calling count_trash when no space is active', async () => {
    useSpaceStore.setState({ currentSpaceId: null })
    stubInvoke({ count_trash: () => 99 })

    const { result } = renderHook(() => useTrashCount())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current).toBe(0)
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'count_trash').length).toBe(0)
  })
})
