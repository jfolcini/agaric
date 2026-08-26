/**
 * Tests for useSyncLatestRef (#4377 phase 2).
 *
 * This hook is the single place the latest-value mirror is written, and
 * adopting it moves that write across a hook boundary the React Compiler
 * cannot see through — so `react/refs` no longer checks the 72 call sites.
 * These tests are what replaces that check. They pin exactly the three
 * properties the justification in `useSyncLatestRef.ts` claims:
 *
 *  - it leaves the LATEST value in the ref after a re-render (the whole
 *    point; a stale mirror is the bug the hand-rolled sites were written to
 *    avoid);
 *  - the write is idempotent, so React StrictMode's double-invoke of the
 *    render body is inert;
 *  - the caller's ref identity is untouched, so consumers may hold it across
 *    renders and callers may keep empty dependency arrays.
 *
 * Plus the closure test that is the reason any of this exists: a callback
 * captured on the FIRST render and never re-created must still observe the
 * newest value through the ref.
 */

import { renderHook } from '@testing-library/react'
import { createElement, StrictMode, useRef, type ReactNode, type RefObject } from 'react'
import { describe, expect, it } from 'vitest'

import { useSyncLatestRef } from '@/hooks/useSyncLatestRef'

/** The call-site shape the hook documents: literal `useRef`, then the sync. */
function useMirror<T>(value: T): RefObject<T> {
  const ref = useRef(value)
  useSyncLatestRef(ref, value)
  return ref
}

describe('useSyncLatestRef', () => {
  it('holds the value on the first render', () => {
    const { result } = renderHook(() => useMirror('first'))

    expect(result.current.current).toBe('first')
  })

  it('holds the LATEST value after a re-render', () => {
    const { result, rerender } = renderHook(({ value }) => useMirror(value), {
      initialProps: { value: 'first' },
    })

    expect(result.current.current).toBe('first')

    rerender({ value: 'second' })
    expect(result.current.current).toBe('second')

    rerender({ value: 'third' })
    expect(result.current.current).toBe('third')
  })

  it('leaves the ref identity untouched across re-renders', () => {
    const { result, rerender } = renderHook(({ value }) => useMirror(value), {
      initialProps: { value: 1 },
    })
    const firstRef = result.current

    rerender({ value: 2 })
    rerender({ value: 3 })

    expect(result.current).toBe(firstRef)
  })

  it('lets a callback captured on the first render read the newest value', () => {
    // The idiom this hook centralises: a stable callback (empty deps) that
    // must not close over a stale prop. Capture the ref once, read it later.
    const { result, rerender } = renderHook(
      ({ handler }: { handler: () => string }) => useMirror(handler),
      { initialProps: { handler: (): string => 'v1' } },
    )
    const captured = result.current
    const callLater = (): string => captured.current()

    expect(callLater()).toBe('v1')

    rerender({ handler: (): string => 'v2' })
    expect(callLater()).toBe('v2')
  })

  it('mirrors nullish and object values without special-casing', () => {
    const objA = { id: 'a' }
    const objB = { id: 'b' }
    const { result, rerender } = renderHook(
      ({ value }: { value: { id: string } | null | undefined }) => useMirror(value),
      { initialProps: { value: objA as { id: string } | null | undefined } },
    )

    expect(result.current.current).toBe(objA)

    rerender({ value: null })
    expect(result.current.current).toBeNull()

    rerender({ value: undefined })
    expect(result.current.current).toBeUndefined()

    rerender({ value: objB })
    expect(result.current.current).toBe(objB)
  })

  it('writes idempotently — a repeated sync of the same value is a no-op', () => {
    // Property (1) of the justification, exercised directly: the second write
    // is what StrictMode's double-invoke performs, and it must not accumulate.
    const ref: RefObject<number> = { current: 0 }

    useSyncLatestRef(ref, 7)
    expect(ref.current).toBe(7)

    useSyncLatestRef(ref, 7)
    expect(ref.current).toBe(7)
  })

  it('is inert under StrictMode double-invoke (mount and update)', () => {
    const wrapper = ({ children }: { children: ReactNode }): React.ReactElement =>
      createElement(StrictMode, null, children)

    const { result, rerender } = renderHook(({ value }) => useMirror(value), {
      initialProps: { value: 'first' },
      wrapper,
    })
    const firstRef = result.current

    // The render body ran twice; the second write is the same value as the
    // first, so nothing observable differs from a single-invoke mount.
    expect(result.current.current).toBe('first')

    rerender({ value: 'second' })
    expect(result.current.current).toBe('second')
    expect(result.current).toBe(firstRef)
  })
})
