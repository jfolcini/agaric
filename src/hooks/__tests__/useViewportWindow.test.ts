/**
 * Tests for useViewportWindow (#1268) — narrows a page's full block list to
 * the rows inside the rendered viewport window so the BlockTree-level batch
 * metadata IPCs fetch for the ~visible rows instead of every block.
 *
 * The core contract:
 *   1. The windowed set is exactly { id ∈ blocks : !viewport.isOffscreen(id) }
 *      — on-screen AND not-yet-measured rows are included, off-screen rows are
 *      excluded.
 *   2. Recompute is driven by the coalesced window channel
 *      (`subscribeWindow` / `getWindowVersion`), so a scroll batch re-windows
 *      once, not once per flipped id.
 *   3. A block scrolled OUT drops from the window; a block scrolled back IN
 *      re-enters and resolves lazily.
 *
 * The lazy-resolution / scoped-payload assertions compose `useViewportWindow`
 * with `useBlockPropertiesBatch`, the real downstream batch hook, and assert
 * the actual IPC payload (`getBatchProperties` args — the tauri-lib IPC
 * boundary) carries only the windowed ids, then that revealing a hidden block
 * fires a fresh IPC with the expanded set.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/tauri', () => ({
  getBatchProperties: vi.fn(),
}))

vi.mock('../../lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { getBatchProperties } from '../../lib/tauri'
import { useBlockPropertiesBatch } from '../useBlockPropertiesBatch'
import type { ViewportObserver } from '../useViewportObserver'
import { useViewportWindow } from '../useViewportWindow'

const mockedGetBatchProperties = vi.mocked(getBatchProperties)

/**
 * A controllable fake `ViewportObserver` mirroring the real one's ref-backed
 * external-store semantics: off-screen membership and the monotonic window
 * version live outside React; `flip` mutates the set, bumps the version, and
 * fires the coalesced window subscribers (here synchronously inside an `act`,
 * which is the same observable result as the real microtask coalescing). Only
 * the members `useViewportWindow` consumes are implemented.
 */
function makeFakeViewport(initialOffscreen: string[] = []): {
  viewport: ViewportObserver
  flip: (changes: Record<string, boolean>) => void
} {
  const offscreen = new Set(initialOffscreen)
  let version = 0
  const windowSubscribers = new Set<() => void>()

  const viewport: ViewportObserver = {
    createObserveRef: () => () => {},
    isOffscreen: (id: string) => offscreen.has(id),
    getHeight: () => undefined,
    subscribe: () => () => {},
    subscribeWindow: (cb: () => void) => {
      windowSubscribers.add(cb)
      return () => windowSubscribers.delete(cb)
    },
    getWindowVersion: () => version,
  }

  // Apply a batch of membership changes (true = now off-screen) and notify the
  // coalesced window channel ONCE — the same shape as a real scroll tick.
  const flip = (changes: Record<string, boolean>): void => {
    for (const [id, isOff] of Object.entries(changes)) {
      if (isOff) offscreen.add(id)
      else offscreen.delete(id)
    }
    version += 1
    for (const cb of windowSubscribers) cb()
  }

  return { viewport, flip }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedGetBatchProperties.mockResolvedValue({})
})

describe('useViewportWindow', () => {
  const blocks = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }]

  it('includes on-screen and not-yet-measured blocks, excludes off-screen ones', () => {
    // B and D are measured off-screen; A is on-screen; C has never been
    // measured (not in the off-screen set) → treated as in-window.
    const { viewport } = makeFakeViewport(['B', 'D'])
    const { result } = renderHook(() => useViewportWindow(viewport, blocks))

    expect(result.current.map((b) => b.id)).toEqual(['A', 'C'])
  })

  it('returns all blocks when none have been measured off-screen yet', () => {
    const { viewport } = makeFakeViewport([])
    const { result } = renderHook(() => useViewportWindow(viewport, blocks))

    expect(result.current.map((b) => b.id)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('drops a block when it scrolls off-screen and re-adds it when it scrolls back', () => {
    const { viewport, flip } = makeFakeViewport([])
    const { result } = renderHook(() => useViewportWindow(viewport, blocks))

    expect(result.current.map((b) => b.id)).toEqual(['A', 'B', 'C', 'D'])

    // Scroll A and B out of view.
    act(() => flip({ A: true, B: true }))
    expect(result.current.map((b) => b.id)).toEqual(['C', 'D'])

    // Scroll A back into view — it re-enters the window (lazy re-resolution).
    act(() => flip({ A: false }))
    expect(result.current.map((b) => b.id)).toEqual(['A', 'C', 'D'])
  })

  it('coalesces a multi-id scroll flip into a single re-window (one version bump)', () => {
    const { viewport, flip } = makeFakeViewport([])
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useViewportWindow(viewport, blocks)
    })
    const baseline = renders

    // A whole scroll tick flips many ids but fires the window channel once.
    act(() => flip({ A: true, B: true, C: true }))

    expect(result.current.map((b) => b.id)).toEqual(['D'])
    // Exactly one additional render for the batch, not one per flipped id.
    expect(renders).toBe(baseline + 1)
  })

  it('re-windows on a page edit even without a viewport flip (blocks identity changes)', () => {
    const { viewport } = makeFakeViewport(['B'])
    const { result, rerender } = renderHook(
      ({ b }: { b: Array<{ id: string }> }) => useViewportWindow(viewport, b),
      { initialProps: { b: blocks } },
    )
    expect(result.current.map((x) => x.id)).toEqual(['A', 'C', 'D'])

    // A new block is appended (page edit). B stays off-screen; E is new and
    // unmeasured → in-window.
    rerender({ b: [...blocks, { id: 'E' }] })
    expect(result.current.map((x) => x.id)).toEqual(['A', 'C', 'D', 'E'])
  })
})

describe('useViewportWindow → batch IPC payload scoping (#1268)', () => {
  it('scopes the get_batch_properties IPC payload to the windowed set, not the full block list', async () => {
    const blocks = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }]
    // B and D are off-screen; only A and C are in the viewport window.
    const { viewport } = makeFakeViewport(['B', 'D'])

    renderHook(() => {
      const windowed = useViewportWindow(viewport, blocks)
      return useBlockPropertiesBatch(windowed)
    })

    await waitFor(() => {
      expect(mockedGetBatchProperties).toHaveBeenCalled()
    })

    // The IPC must NOT carry the full page — only the windowed ids.
    expect(mockedGetBatchProperties).toHaveBeenLastCalledWith(['A', 'C'])
    for (const call of mockedGetBatchProperties.mock.calls) {
      expect(call[0]).not.toContain('B')
      expect(call[0]).not.toContain('D')
    }
  })

  it('fires a fresh IPC scoped to the expanded set when a hidden block scrolls into view (lazy resolution)', async () => {
    const blocks = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }]
    // Start with B and D off-screen.
    const { viewport, flip } = makeFakeViewport(['B', 'D'])

    renderHook(() => {
      const windowed = useViewportWindow(viewport, blocks)
      return useBlockPropertiesBatch(windowed)
    })

    await waitFor(() => {
      expect(mockedGetBatchProperties).toHaveBeenLastCalledWith(['A', 'C'])
    })
    const callsBefore = mockedGetBatchProperties.mock.calls.length

    // D scrolls into view → it must re-enter the window and trigger a resolve.
    act(() => flip({ D: false }))

    await waitFor(() => {
      expect(mockedGetBatchProperties).toHaveBeenLastCalledWith(['A', 'C', 'D'])
    })
    // A genuinely new IPC fired for the newly-visible block — not served stale.
    expect(mockedGetBatchProperties.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('does NOT refire the IPC for a window change that leaves the windowed id set unchanged (signature guard)', async () => {
    const blocks = [{ id: 'A' }, { id: 'B' }]
    const { viewport, flip } = makeFakeViewport([])

    renderHook(() => {
      const windowed = useViewportWindow(viewport, blocks)
      return useBlockPropertiesBatch(windowed)
    })

    await waitFor(() => {
      expect(mockedGetBatchProperties).toHaveBeenCalledTimes(1)
    })
    expect(mockedGetBatchProperties).toHaveBeenLastCalledWith(['A', 'B'])

    // A flip that toggles an id not present in `blocks` bumps the window
    // version but leaves the windowed set { A, B } unchanged → the downstream
    // id-signature guard must suppress a redundant IPC.
    act(() => flip({ Z: true }))
    await new Promise<void>((r) => queueMicrotask(r))

    expect(mockedGetBatchProperties).toHaveBeenCalledTimes(1)
  })
})
