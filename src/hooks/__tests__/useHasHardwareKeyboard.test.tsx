/**
 * PEND-68 — tests for useHasHardwareKeyboard.
 */

import { fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  _resetHardwareKeyboardLatchForTests,
  useHasHardwareKeyboard,
} from '../useHasHardwareKeyboard'

beforeEach(() => {
  _resetHardwareKeyboardLatchForTests()
})

afterEach(() => {
  _resetHardwareKeyboardLatchForTests()
})

describe('useHasHardwareKeyboard', () => {
  it('returns false on mount (no signal yet)', () => {
    const { result } = renderHook(() => useHasHardwareKeyboard())
    expect(result.current).toBe(false)
  })

  it('flips to true on first non-modifier keydown', () => {
    const { result, rerender } = renderHook(() => useHasHardwareKeyboard())
    expect(result.current).toBe(false)
    fireEvent.keyDown(document, { key: 'a' })
    rerender()
    expect(result.current).toBe(true)
  })

  it('ignores modifier-only keydowns', () => {
    const { result, rerender } = renderHook(() => useHasHardwareKeyboard())
    for (const key of ['Shift', 'Control', 'Alt', 'Meta']) {
      fireEvent.keyDown(document, { key })
    }
    rerender()
    expect(result.current).toBe(false)
  })

  it('a modifier followed by a non-modifier still flips on the non-modifier', () => {
    const { result, rerender } = renderHook(() => useHasHardwareKeyboard())
    fireEvent.keyDown(document, { key: 'Shift' })
    rerender()
    expect(result.current).toBe(false)
    fireEvent.keyDown(document, { key: 'a' })
    rerender()
    expect(result.current).toBe(true)
  })

  it('is sticky-true across re-renders', () => {
    const { result, rerender } = renderHook(() => useHasHardwareKeyboard())
    fireEvent.keyDown(document, { key: 'a' })
    rerender()
    expect(result.current).toBe(true)
    rerender()
    rerender()
    expect(result.current).toBe(true)
  })

  it('a second mount in the same session reads true synchronously', () => {
    const first = renderHook(() => useHasHardwareKeyboard())
    fireEvent.keyDown(document, { key: 'a' })
    first.rerender()
    expect(first.result.current).toBe(true)

    // Second mount — the latch persists across mounts within a session.
    const second = renderHook(() => useHasHardwareKeyboard())
    expect(second.result.current).toBe(true)
  })

  it('cleans up the keydown listener on unmount', () => {
    // When the last consumer unmounts, its cleanup removes BOTH the
    // React subscriber and the document keydown listener. A keydown
    // after unmount-with-no-mounts therefore lands on nothing — the
    // latch stays false. A fresh mount re-registers everything; the
    // next keydown flips the latch normally.
    const { unmount } = renderHook(() => useHasHardwareKeyboard())
    unmount()
    fireEvent.keyDown(document, { key: 'a' })
    const fresh = renderHook(() => useHasHardwareKeyboard())
    expect(fresh.result.current).toBe(false)
    fireEvent.keyDown(document, { key: 'b' })
    fresh.rerender()
    expect(fresh.result.current).toBe(true)
  })

  it('component using the hook re-renders when latch flips', () => {
    function Probe(): React.ReactElement {
      const has = useHasHardwareKeyboard()
      return <div data-testid="probe">{has ? 'yes' : 'no'}</div>
    }
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('probe').textContent).toBe('no')
    fireEvent.keyDown(document, { key: 'a' })
    expect(getByTestId('probe').textContent).toBe('yes')
  })
})
