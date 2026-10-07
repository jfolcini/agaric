/**
 * Tests for useKeyboardNavigableList — the composite hook wrapping
 * useListKeyboardNavigation with a list-container ref.
 *
 * Validates:
 *  - Returns the expected shape (focusedIndex, setFocusedIndex,
 *    handleKeyDown, listRef).
 *  - Delegates ArrowDown / ArrowUp to the underlying primitive.
 *  - Resets focusedIndex to 0 when resetKey changes.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useKeyboardNavigableList } from '@/hooks/useKeyboardNavigableList'

function keyEvent(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key })
}

describe('useKeyboardNavigableList', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the expected shape (focusedIndex, setters, listRef)', () => {
    const { result } = renderHook(() => useKeyboardNavigableList(5, () => {}))

    expect(result.current.focusedIndex).toBe(0)
    expect(typeof result.current.setFocusedIndex).toBe('function')
    expect(typeof result.current.handleKeyDown).toBe('function')
    expect(result.current).toHaveProperty('listRef')
    // listRef is a React ref object; .current is null until attached.
    expect(result.current.listRef.current).toBeNull()
  })

  it('delegates ArrowDown / ArrowUp to the underlying primitive', () => {
    const { result } = renderHook(() => useKeyboardNavigableList(5, () => {}))

    act(() => {
      result.current.handleKeyDown(keyEvent('ArrowDown'))
      result.current.handleKeyDown(keyEvent('ArrowDown'))
    })
    expect(result.current.focusedIndex).toBe(2)

    act(() => {
      result.current.handleKeyDown(keyEvent('ArrowUp'))
    })
    expect(result.current.focusedIndex).toBe(1)
  })

  it('honours homeEnd + pageUpDown options forwarded to the primitive', () => {
    const { result } = renderHook(() =>
      useKeyboardNavigableList(30, () => {}, { homeEnd: true, pageUpDown: true }),
    )

    act(() => {
      result.current.handleKeyDown(keyEvent('End'))
    })
    expect(result.current.focusedIndex).toBe(29)

    act(() => {
      result.current.handleKeyDown(keyEvent('PageUp'))
    })
    expect(result.current.focusedIndex).toBe(19)

    act(() => {
      result.current.handleKeyDown(keyEvent('Home'))
    })
    expect(result.current.focusedIndex).toBe(0)
  })

  it('resets focusedIndex to 0 when resetKey changes', () => {
    const { result, rerender } = renderHook(
      ({ resetKey }) => useKeyboardNavigableList(10, () => {}, { resetKey }),
      { initialProps: { resetKey: 'a' } },
    )

    act(() => {
      result.current.handleKeyDown(keyEvent('ArrowDown'))
      result.current.handleKeyDown(keyEvent('ArrowDown'))
      result.current.handleKeyDown(keyEvent('ArrowDown'))
    })
    expect(result.current.focusedIndex).toBe(3)

    rerender({ resetKey: 'b' })
    expect(result.current.focusedIndex).toBe(0)
  })

  it('preserves focusedIndex when itemCount grows under a stable resetKey', () => {
    const { result, rerender } = renderHook(
      ({ itemCount }: { itemCount: number }) =>
        useKeyboardNavigableList(itemCount, () => {}, { resetKey: 'a' }),
      { initialProps: { itemCount: 10 } },
    )

    act(() => {
      for (let i = 0; i < 5; i++) result.current.handleKeyDown(keyEvent('ArrowDown'))
    })
    expect(result.current.focusedIndex).toBe(5)

    // Load-More grows the list; the focus ring stays where the user left it.
    rerender({ itemCount: 20 })
    expect(result.current.focusedIndex).toBe(5)
  })

  it('clamps focusedIndex to the last row when the list shrinks below it', () => {
    const { result, rerender } = renderHook(
      ({ itemCount }: { itemCount: number }) =>
        useKeyboardNavigableList(itemCount, () => {}, { resetKey: 'a' }),
      { initialProps: { itemCount: 10 } },
    )

    act(() => {
      for (let i = 0; i < 7; i++) result.current.handleKeyDown(keyEvent('ArrowDown'))
    })
    expect(result.current.focusedIndex).toBe(7)

    rerender({ itemCount: 3 })
    expect(result.current.focusedIndex).toBe(2)
  })

  it('invokes onSelect with the current focusedIndex on Enter', () => {
    const onSelect = vi.fn()
    const { result } = renderHook(() => useKeyboardNavigableList(5, onSelect))

    act(() => {
      result.current.handleKeyDown(keyEvent('ArrowDown'))
      result.current.handleKeyDown(keyEvent('ArrowDown'))
    })
    expect(result.current.focusedIndex).toBe(2)

    act(() => {
      result.current.handleKeyDown(keyEvent('Enter'))
    })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(2)
  })
})
