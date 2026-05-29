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
 *    the list.
 *  - Skips scrollIntoView when focus is outside the list (avoids
 *    hijacking scroll position).
 *  - Respects prefers-reduced-motion: 'smooth' downgrades to 'auto'.
 *  - Honours custom itemSelector.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useKeyboardNavigableList } from '../useKeyboardNavigableList'

function keyEvent(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key })
}

/** Build a list container with N items inside document.body and return both. */
function buildList(itemCount: number, selector = 'data-block-list-item') {
  const list = document.createElement('div')
  list.tabIndex = 0
  for (let i = 0; i < itemCount; i++) {
    const item = document.createElement('button')
    item.setAttribute(selector, '')
    item.textContent = `item-${i}`
    list.appendChild(item)
  }
  document.body.appendChild(list)
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

  it('calls scrollIntoView on the focused item when focus is inside the list', () => {
    const { list, items } = buildList(3)

    const { result } = renderHook(() => useKeyboardNavigableList(3, () => {}))

    act(() => {
      result.current.listRef.current = list as HTMLDivElement
    })

    // Focus the container so the focus-inside guard passes.
    list.focus()
    expect(document.activeElement).toBe(list)

    act(() => {
      result.current.handleKeyDown(keyEvent('ArrowDown'))
    })

    expect(result.current.focusedIndex).toBe(1)
    // scrollIntoView should have been called on the second item.
    expect(scrollSpy).toHaveBeenCalled()
    const calledTargets = scrollSpy.mock.instances
    expect(calledTargets).toContain(items[1])
  })

  it('does NOT call scrollIntoView when focus is outside the list', () => {
    const { list } = buildList(3)
    // External element holds focus.
    const outside = document.createElement('button')
    document.body.appendChild(outside)
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
    const { list } = buildList(3)

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
      list.focus()

      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowDown'))
      })

      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' })
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it('uses smooth behavior when reduced motion is NOT preferred', () => {
    const { list } = buildList(3)

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
      list.focus()

      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowDown'))
      })

      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' })
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it('honours a custom itemSelector', () => {
    const list = document.createElement('div')
    list.tabIndex = 0
    const a = document.createElement('div')
    a.className = 'custom-item'
    const b = document.createElement('div')
    b.className = 'custom-item'
    list.appendChild(a)
    list.appendChild(b)
    document.body.appendChild(list)

    const { result } = renderHook(() =>
      useKeyboardNavigableList(2, () => {}, { itemSelector: '.custom-item' }),
    )

    act(() => {
      result.current.listRef.current = list as HTMLDivElement
    })
    list.focus()

    act(() => {
      result.current.handleKeyDown(keyEvent('ArrowDown'))
    })

    expect(result.current.focusedIndex).toBe(1)
    expect(scrollSpy.mock.instances).toContain(b)
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
