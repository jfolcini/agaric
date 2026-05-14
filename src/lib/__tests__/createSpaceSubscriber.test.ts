/**
 * Tests for `createSpaceSubscriber` — MAINT-122 (semantics) plus the
 * design-system-perf-review-2026-05-09 item 13 migration to the
 * `subscribeWithSelector` middleware on `useSpaceStore`.
 *
 * Validates the three semantic guarantees the navigation / journal /
 * recent-pages / tabs stores rely on:
 *   1. On subscribe, `onChange` is invoked once with `(newKey, newKey)`
 *      so the caller can seed its per-space slice from the rehydrated
 *      flat fields. Now fires synchronously at subscribe time via
 *      `fireImmediately: true` (previously deferred to the first
 *      store-write).
 *   2. A state change that does NOT touch `currentSpaceId` (e.g. an
 *      `availableSpaces` refresh or `isReady` flip) is suppressed by
 *      the selector + `equalityFn`.
 *   3. A `currentSpaceId` change invokes `onChange(prevKey, newKey)`
 *      so the caller can flush + pull.
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
  it('invokes onChange synchronously on subscribe with (newKey, newKey)', () => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
    const onChange = vi.fn()
    const unsub = createSpaceSubscriber(onChange)

    // `fireImmediately: true` seeds the callback at subscribe time
    // using the current `currentSpaceId`.
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('SPACE_A', 'SPACE_A')
    unsub()
  })

  it('falls back to LEGACY_SPACE_KEY when currentSpaceId is null', () => {
    const onChange = vi.fn()
    const unsub = createSpaceSubscriber(onChange)

    // currentSpaceId is null in the beforeEach — seed receives the
    // legacy key.
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('__legacy__', '__legacy__')
    unsub()
  })

  it('suppresses fires that do not touch currentSpaceId', () => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
    const onChange = vi.fn()
    const unsub = createSpaceSubscriber(onChange)

    expect(onChange).toHaveBeenCalledTimes(1) // seed fire

    // Writes that leave `currentSpaceId` unchanged must NOT re-invoke
    // onChange — the subscribeWithSelector middleware compares the
    // selected slice with `Object.is`.
    useSpaceStore.setState({ availableSpaces: [] })
    useSpaceStore.setState({ isReady: true })
    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })

    expect(onChange).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('invokes onChange with (prevKey, newKey) on space change', () => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
    const onChange = vi.fn()
    const unsub = createSpaceSubscriber(onChange)

    onChange.mockClear() // drop the seed call

    useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('SPACE_A', 'SPACE_B')
    unsub()
  })

  it('tracks multiple space switches in sequence', () => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
    const onChange = vi.fn()
    const unsub = createSpaceSubscriber(onChange)
    // seed call: ('SPACE_A', 'SPACE_A')
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
    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
    const onChange = vi.fn()
    const unsub = createSpaceSubscriber(onChange)

    expect(onChange).toHaveBeenCalledTimes(1) // seed

    unsub()

    useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
    expect(onChange).toHaveBeenCalledTimes(1) // still 1 — no new calls
  })
})
