/**
 * Tests for useKeyboardNavigableList — the composite hook wrapping
 * useListKeyboardNavigation + scroll-into-view + reset-on-resetKey.
 *
 * Validates:
 *  - Returns the expected shape (focusedIndex, setFocusedIndex,
 *    handleKeyDown, listRef).
 *  - Delegates ArrowDown / ArrowUp to the underlying primitive.
 *  - Resets focusedIndex to 0 when resetKey changes.
 *  - Calls scrollIntoView on the focused item when focus is inside
 *    the list — the focused one, not the Nth mounted one, since a
 *    virtualised list mounts only a window of its items (#5302).
 *  - Skips scrollIntoView when focus is outside the list (avoids
 *    hijacking scroll position).
 *  - Respects prefers-reduced-motion: 'smooth' downgrades to 'auto'.
 *  - Honours custom itemSelector.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useKeyboardNavigableList } from '@/hooks/useKeyboardNavigableList'

function keyEvent(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key })
}

/** Build a list container with N items inside document.body and return both. */
function buildList(itemCount: number, selector = 'data-block-list-item') {
  const list = document.createElement('div')
  for (let i = 0; i < itemCount; i++) {
    const item = document.createElement('button')
    item.setAttribute(selector, '')
    item.textContent = `item-${i}`
    list.append(item)
  }
  document.body.append(list)
  return { list, items: Array.from(list.children) as HTMLElement[] }
}

describe('useKeyboardNavigableList', () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
  })

  afterEach(() => {
    document.body.innerHTML = ''
    scrollSpy.mockRestore()
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

  // The rows rove (`useRovingRowFocus`): the cursor row takes DOM focus in its
  // own effect, which runs before this hook's, so these tests move focus in the
  // same act() as the key.
  it('calls scrollIntoView on the focused item when focus is inside the list', () => {
    const { list, items } = buildList(3)

    const { result } = renderHook(() => useKeyboardNavigableList(3, () => {}))

    act(() => {
      result.current.listRef.current = list as HTMLDivElement
    })
    items[0]?.focus()

    act(() => {
      result.current.handleKeyDown(keyEvent('ArrowDown'))
      items[1]?.focus()
    })

    expect(result.current.focusedIndex).toBe(1)
    expect(scrollSpy.mock.instances).toEqual([items[1]])
  })

  it('scrolls the focused row, not the Nth mounted one, when only a window is mounted', () => {
    // A virtualised list of 30 with rows 20-29 mounted: End's row is items[9].
    const { list, items } = buildList(10)

    const { result } = renderHook(() => useKeyboardNavigableList(30, () => {}, { homeEnd: true }))

    act(() => {
      result.current.listRef.current = list as HTMLDivElement
    })
    items[0]?.focus()

    act(() => {
      result.current.handleKeyDown(keyEvent('End'))
      items[9]?.focus()
    })

    expect(result.current.focusedIndex).toBe(29)
    expect(scrollSpy.mock.instances).toEqual([items[9]])
  })

  it('does NOT call scrollIntoView when focus is outside the list', () => {
    const { list } = buildList(3)
    // A row of another list on the page (Due and Done share the journal) holds focus.
    const outside = buildList(1).items[0] as HTMLElement
    outside.focus()
    expect(document.activeElement).toBe(outside)

    const { result } = renderHook(() => useKeyboardNavigableList(3, () => {}))

    act(() => {
      result.current.listRef.current = list as HTMLDivElement
    })

    act(() => {
      result.current.handleKeyDown(keyEvent('ArrowDown'))
    })

    expect(result.current.focusedIndex).toBe(1)
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('respects prefers-reduced-motion: smooth downgrades to auto', () => {
    const { list, items } = buildList(3)

    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia

    try {
      const { result } = renderHook(() =>
        useKeyboardNavigableList(3, () => {}, { scrollBehavior: 'smooth' }),
      )

      act(() => {
        result.current.listRef.current = list as HTMLDivElement
      })
      items[0]?.focus()

      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowDown'))
        items[1]?.focus()
      })

      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' })
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it('uses smooth behavior when reduced motion is NOT preferred', () => {
    const { list, items } = buildList(3)

    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia

    try {
      const { result } = renderHook(() =>
        useKeyboardNavigableList(3, () => {}, { scrollBehavior: 'smooth' }),
      )

      act(() => {
        result.current.listRef.current = list as HTMLDivElement
      })
      items[0]?.focus()

      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowDown'))
        items[1]?.focus()
      })

      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' })
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it('honours a custom itemSelector', () => {
    const list = document.createElement('div')
    const a = document.createElement('div')
    a.className = 'custom-item'
    a.tabIndex = -1
    const b = document.createElement('div')
    b.className = 'custom-item'
    b.tabIndex = -1
    list.append(a)
    list.append(b)
    document.body.append(list)

    const { result } = renderHook(() =>
      useKeyboardNavigableList(2, () => {}, { itemSelector: '.custom-item' }),
    )

    act(() => {
      result.current.listRef.current = list as HTMLDivElement
    })
    a.focus()

    act(() => {
      result.current.handleKeyDown(keyEvent('ArrowDown'))
      b.focus()
    })

    expect(result.current.focusedIndex).toBe(1)
    expect(scrollSpy.mock.instances).toEqual([b])
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
