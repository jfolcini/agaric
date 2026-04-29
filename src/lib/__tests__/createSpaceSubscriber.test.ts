/**
 * Tests for `createSpaceSubscriber` — MAINT-122.
 *
 * Validates the three semantic guarantees the navigation / journal /
 * recent-pages stores rely on:
 *   1. On first fire, `onChange` is invoked with `(newKey, newKey)` so
 *      the caller can seed its per-space slice from the rehydrated flat
 *      fields without sampling `currentSpaceId` at module-eval time.
 *   2. A subsequent fire with the same key (e.g. a space-store-internal
 *      `setState` that didn't change `currentSpaceId`) is suppressed.
 *   3. A subsequent fire with a new key invokes
 *      `onChange(prevKey, newKey)` so the caller can flush + pull.
 *
 * Plus the legacy-key fallback: when `currentSpaceId === null`, the
 * callback receives `LEGACY_SPACE_KEY`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSpaceStore } from '../../stores/space'
import { createSpaceSubscriber } from '../createSpaceSubscriber'

beforeEach(() => {
  // Reset to a deterministic starting state. All tests drive
  // `currentSpaceId` directly via `setState`.
  useSpaceStore.setState({ currentSpaceId: null, availableSpaces: [], isReady: true })
})

describe('createSpaceSubscriber', () => {
  it('invokes onChange on first space-store fire with (newKey, newKey)', () => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
    const onChange = vi.fn()
    const unsub = createSpaceSubscriber(onChange)

    // Trigger the first fire by mutating the space store.
    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('SPACE_A', 'SPACE_A')
    unsub()
  })

  it('falls back to LEGACY_SPACE_KEY when currentSpaceId is null', () => {
    const onChange = vi.fn()
    const unsub = createSpaceSubscriber(onChange)

    // currentSpaceId is null at this point — first fire seeds with the
    // legacy key.
    useSpaceStore.setState({ currentSpaceId: null })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('__legacy__', '__legacy__')
    unsub()
  })

  it('suppresses subsequent fires with the same key', () => {
    const onChange = vi.fn()
    const unsub = createSpaceSubscriber(onChange)

    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
    expect(onChange).toHaveBeenCalledTimes(1) // first fire

    // A no-op state change that re-fires the subscriber with the same
    // key (e.g. availableSpaces refresh) must NOT re-invoke onChange.
    useSpaceStore.setState({ availableSpaces: [] })
    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })

    expect(onChange).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('invokes onChange with (prevKey, newKey) on space change', () => {
    const onChange = vi.fn()
    const unsub = createSpaceSubscriber(onChange)

    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' }) // first fire seeds
    onChange.mockClear()

    useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('SPACE_A', 'SPACE_B')
    unsub()
  })

  it('tracks multiple space switches in sequence', () => {
    const onChange = vi.fn()
    const unsub = createSpaceSubscriber(onChange)

    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' }) // first fire: ('SPACE_A', 'SPACE_A')
    useSpaceStore.setState({ currentSpaceId: 'SPACE_B' }) // ('SPACE_A', 'SPACE_B')
    useSpaceStore.setState({ currentSpaceId: 'SPACE_C' }) // ('SPACE_B', 'SPACE_C')
    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' }) // ('SPACE_C', 'SPACE_A')

    expect(onChange.mock.calls).toEqual([
      ['SPACE_A', 'SPACE_A'],
      ['SPACE_A', 'SPACE_B'],
      ['SPACE_B', 'SPACE_C'],
      ['SPACE_C', 'SPACE_A'],
    ])
    unsub()
  })

  it('returned unsubscribe function stops further onChange invocations', () => {
    const onChange = vi.fn()
    const unsub = createSpaceSubscriber(onChange)

    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' }) // first fire
    expect(onChange).toHaveBeenCalledTimes(1)

    unsub()

    useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
    expect(onChange).toHaveBeenCalledTimes(1) // still 1 — no new calls
  })
})
