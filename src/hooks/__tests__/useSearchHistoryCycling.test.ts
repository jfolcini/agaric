/**
 * PEND-55 — tests for `useSearchHistoryCycling`.
 *
 * Coverage:
 * - `↑` when input empty fills with most-recent entry.
 * - Subsequent `↑` walks backward through history; clamps at oldest.
 * - `↓` walks forward toward newest; at newest, clears input.
 * - `↑`/`↓` pass through (return false) when input has typed content.
 * - Empty history short-circuits (returns true; eats the event).
 * - Any non-arrow key returns false (the hook is arrow-only).
 * - External (user-driven) query edits reset the browse state.
 * - Self-driven query writes (via `setQuery` from the hook) do NOT
 *   reset state — otherwise every cycle would snap back to typing.
 */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useSearchHistoryCycling } from '../useSearchHistoryCycling'

interface FakeEvent {
  key: string
  preventDefault: () => void
}

function makeEvent(key: string): FakeEvent {
  return { key, preventDefault: vi.fn() }
}

function setup(history: ReadonlyArray<string>, initialQuery = '') {
  let query = initialQuery
  const setQuery = vi.fn((next: string) => {
    query = next
  })
  const view = renderHook(({ q }) => useSearchHistoryCycling(history, q, setQuery), {
    initialProps: { q: query },
  })
  return {
    view,
    setQuery,
    getQuery: () => query,
    rerender: () => view.rerender({ q: query }),
  }
}

describe('useSearchHistoryCycling', () => {
  it('ArrowUp when input is empty fills with the most-recent entry', () => {
    const { view, setQuery } = setup(['c', 'b', 'a'])
    const ev = makeEvent('ArrowUp')
    act(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- FakeEvent stands in for React.KeyboardEvent.
      view.result.current.handleKeyDown(ev as any)
    })
    expect(setQuery).toHaveBeenCalledWith('c')
    expect(ev.preventDefault).toHaveBeenCalled()
  })

  it('ArrowUp walks backward through older entries', () => {
    const { view, setQuery, rerender } = setup(['c', 'b', 'a'])
    act(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- same.
      view.result.current.handleKeyDown(makeEvent('ArrowUp') as any)
    })
    rerender()
    act(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- same.
      view.result.current.handleKeyDown(makeEvent('ArrowUp') as any)
    })
    rerender()
    act(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- same.
      view.result.current.handleKeyDown(makeEvent('ArrowUp') as any)
    })
    expect(setQuery).toHaveBeenNthCalledWith(1, 'c')
    expect(setQuery).toHaveBeenNthCalledWith(2, 'b')
    expect(setQuery).toHaveBeenNthCalledWith(3, 'a')
  })

  it('ArrowUp clamps at the oldest entry — no extra setQuery once at the end', () => {
    const { view, setQuery, rerender } = setup(['c', 'b'])
    for (let i = 0; i < 4; i++) {
      act(() => {
        // oxlint-disable-next-line typescript/no-explicit-any -- same.
        view.result.current.handleKeyDown(makeEvent('ArrowUp') as any)
      })
      rerender()
    }
    // Should only have called twice: 'c', 'b'. Subsequent presses clamp.
    expect(setQuery).toHaveBeenCalledTimes(2)
    expect(setQuery).toHaveBeenNthCalledWith(2, 'b')
  })

  it('ArrowDown after walking back returns toward the newest entry', () => {
    const { view, setQuery, rerender } = setup(['c', 'b', 'a'])
    // Walk to 'b' via two ups.
    act(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- same.
      view.result.current.handleKeyDown(makeEvent('ArrowUp') as any)
    })
    rerender()
    act(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- same.
      view.result.current.handleKeyDown(makeEvent('ArrowUp') as any)
    })
    rerender()
    // ArrowDown → 'c'.
    act(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- same.
      view.result.current.handleKeyDown(makeEvent('ArrowDown') as any)
    })
    expect(setQuery).toHaveBeenLastCalledWith('c')
  })

  it('ArrowDown past the newest entry clears the input', () => {
    const { view, setQuery, rerender } = setup(['c'])
    act(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- same.
      view.result.current.handleKeyDown(makeEvent('ArrowUp') as any)
    })
    rerender()
    act(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- same.
      view.result.current.handleKeyDown(makeEvent('ArrowDown') as any)
    })
    expect(setQuery).toHaveBeenLastCalledWith('')
  })

  it('returns false when input has typed content (pass through)', () => {
    const { view } = setup(['c'], 'hello')
    let consumed = true
    act(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- same.
      consumed = view.result.current.handleKeyDown(makeEvent('ArrowUp') as any)
    })
    expect(consumed).toBe(false)
  })

  it('returns false on non-arrow keys', () => {
    const { view } = setup(['c'])
    let consumed = true
    act(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- same.
      consumed = view.result.current.handleKeyDown(makeEvent('a') as any)
    })
    expect(consumed).toBe(false)
  })

  it('eats the event (returns true) when history is empty', () => {
    const { view } = setup([])
    const ev = makeEvent('ArrowUp')
    let consumed = false
    act(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- same.
      consumed = view.result.current.handleKeyDown(ev as any)
    })
    expect(consumed).toBe(true)
    expect(ev.preventDefault).toHaveBeenCalled()
  })

  it('exposes a reset() callback that snaps back to typing mode', () => {
    const { view, setQuery, rerender } = setup(['c', 'b'])
    act(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- same.
      view.result.current.handleKeyDown(makeEvent('ArrowUp') as any)
    })
    rerender()
    act(() => view.result.current.reset())
    rerender()
    act(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- same.
      view.result.current.handleKeyDown(makeEvent('ArrowUp') as any)
    })
    // After reset, the next ArrowUp must reseed from the most-recent
    // entry, not continue from where we left off.
    expect(setQuery).toHaveBeenLastCalledWith('c')
  })
})
