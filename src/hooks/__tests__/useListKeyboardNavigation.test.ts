/**
 * Tests for useListKeyboardNavigation hook and its pure helpers.
 *
 * Validates:
 *  - ArrowDown increments focusedIndex
 *  - ArrowUp decrements focusedIndex
 *  - Wrapping behavior (wrap: true wraps, wrap: false clamps)
 *  - Vim keys (j/k) when vim: true (ignored in horizontal mode)
 *  - Home/End when homeEnd: true
 *  - PageUp/PageDown when pageUpDown: true
 *  - onSelect called on Enter / Space (skipped when onSelect not provided)
 *  - focusedIndex resets when itemCount changes
 *  - Every key returns false when itemCount === 0
 *  - Returns true for handled keys, false for unhandled
 *  - resolveNavOptions applies defaults and preserves explicit values
 */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { resolveNavOptions, useListKeyboardNavigation } from '../useListKeyboardNavigation'

function keyEvent(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key })
}

describe('useListKeyboardNavigation', () => {
  it('ArrowDown increments focusedIndex', () => {
    const { result } = renderHook(() => useListKeyboardNavigation({ itemCount: 5 }))

    expect(result.current.focusedIndex).toBe(0)

    act(() => {
      result.current.handleKeyDown(keyEvent('ArrowDown'))
    })

    expect(result.current.focusedIndex).toBe(1)
  })

  it('ArrowUp decrements focusedIndex', () => {
    const { result } = renderHook(() => useListKeyboardNavigation({ itemCount: 5 }))

    // Move down first
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

  describe('wrapping behavior', () => {
    it('wrap: true wraps ArrowDown at the end to 0', () => {
      const { result } = renderHook(() => useListKeyboardNavigation({ itemCount: 3, wrap: true }))

      // Go to end
      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowDown'))
        result.current.handleKeyDown(keyEvent('ArrowDown'))
      })
      expect(result.current.focusedIndex).toBe(2)

      // Should wrap to 0
      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowDown'))
      })
      expect(result.current.focusedIndex).toBe(0)
    })

    it('wrap: true wraps ArrowUp at 0 to end', () => {
      const { result } = renderHook(() => useListKeyboardNavigation({ itemCount: 3, wrap: true }))

      expect(result.current.focusedIndex).toBe(0)

      // Should wrap to end
      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowUp'))
      })
      expect(result.current.focusedIndex).toBe(2)
    })

    it('wrap: false clamps ArrowDown at the end', () => {
      const { result } = renderHook(() => useListKeyboardNavigation({ itemCount: 3, wrap: false }))

      // Go to end
      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowDown'))
        result.current.handleKeyDown(keyEvent('ArrowDown'))
      })
      expect(result.current.focusedIndex).toBe(2)

      // Should stay at 2 (clamped)
      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowDown'))
      })
      expect(result.current.focusedIndex).toBe(2)
    })

    it('wrap: false clamps ArrowUp at 0', () => {
      const { result } = renderHook(() => useListKeyboardNavigation({ itemCount: 3, wrap: false }))

      expect(result.current.focusedIndex).toBe(0)

      // Should stay at 0 (clamped)
      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowUp'))
      })
      expect(result.current.focusedIndex).toBe(0)
    })
  })

  describe('Vim keys', () => {
    it('j moves down when vim: true', () => {
      const { result } = renderHook(() => useListKeyboardNavigation({ itemCount: 5, vim: true }))

      act(() => {
        result.current.handleKeyDown(keyEvent('j'))
      })

      expect(result.current.focusedIndex).toBe(1)
    })

    it('k moves up when vim: true', () => {
      const { result } = renderHook(() => useListKeyboardNavigation({ itemCount: 5, vim: true }))

      // Move down first
      act(() => {
        result.current.handleKeyDown(keyEvent('j'))
        result.current.handleKeyDown(keyEvent('j'))
      })
      expect(result.current.focusedIndex).toBe(2)

      act(() => {
        result.current.handleKeyDown(keyEvent('k'))
      })
      expect(result.current.focusedIndex).toBe(1)
    })

    it('j/k are ignored when vim: false', () => {
      const { result } = renderHook(() => useListKeyboardNavigation({ itemCount: 5, vim: false }))

      let handled = false
      act(() => {
        handled = result.current.handleKeyDown(keyEvent('j'))
      })
      expect(handled).toBe(false)
      expect(result.current.focusedIndex).toBe(0)

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('k'))
      })
      expect(handled).toBe(false)
      expect(result.current.focusedIndex).toBe(0)
    })
  })

  describe('Home/End keys', () => {
    it('Home goes to 0 when homeEnd: true', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 5, homeEnd: true }),
      )

      // Move to index 3
      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowDown'))
        result.current.handleKeyDown(keyEvent('ArrowDown'))
        result.current.handleKeyDown(keyEvent('ArrowDown'))
      })
      expect(result.current.focusedIndex).toBe(3)

      act(() => {
        result.current.handleKeyDown(keyEvent('Home'))
      })
      expect(result.current.focusedIndex).toBe(0)
    })

    it('End goes to last item when homeEnd: true', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 5, homeEnd: true }),
      )

      expect(result.current.focusedIndex).toBe(0)

      act(() => {
        result.current.handleKeyDown(keyEvent('End'))
      })
      expect(result.current.focusedIndex).toBe(4)
    })

    it('Home/End are ignored when homeEnd: false', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 5, homeEnd: false }),
      )

      let handled = false
      act(() => {
        handled = result.current.handleKeyDown(keyEvent('Home'))
      })
      expect(handled).toBe(false)

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('End'))
      })
      expect(handled).toBe(false)
    })
  })

  describe('PageUp/PageDown keys', () => {
    it('PageDown jumps by pageSize (default 10)', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 30, pageUpDown: true }),
      )

      expect(result.current.focusedIndex).toBe(0)

      act(() => {
        result.current.handleKeyDown(keyEvent('PageDown'))
      })
      expect(result.current.focusedIndex).toBe(10)
    })

    it('PageUp jumps by pageSize (default 10)', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 30, pageUpDown: true }),
      )

      // Move to index 20
      act(() => {
        result.current.handleKeyDown(keyEvent('PageDown'))
        result.current.handleKeyDown(keyEvent('PageDown'))
      })
      expect(result.current.focusedIndex).toBe(20)

      act(() => {
        result.current.handleKeyDown(keyEvent('PageUp'))
      })
      expect(result.current.focusedIndex).toBe(10)
    })

    it('PageDown clamps at the end (does not wrap)', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 15, pageUpDown: true, wrap: true }),
      )

      // Move to index 10
      act(() => {
        result.current.handleKeyDown(keyEvent('PageDown'))
      })
      expect(result.current.focusedIndex).toBe(10)

      // PageDown again — should clamp at 14, not wrap
      act(() => {
        result.current.handleKeyDown(keyEvent('PageDown'))
      })
      expect(result.current.focusedIndex).toBe(14)
    })

    it('PageUp clamps at 0 (does not wrap)', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 15, pageUpDown: true, wrap: true }),
      )

      // Move to index 5 via arrow keys
      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowDown'))
        result.current.handleKeyDown(keyEvent('ArrowDown'))
        result.current.handleKeyDown(keyEvent('ArrowDown'))
        result.current.handleKeyDown(keyEvent('ArrowDown'))
        result.current.handleKeyDown(keyEvent('ArrowDown'))
      })
      expect(result.current.focusedIndex).toBe(5)

      // PageUp should clamp at 0, not wrap
      act(() => {
        result.current.handleKeyDown(keyEvent('PageUp'))
      })
      expect(result.current.focusedIndex).toBe(0)
    })

    it('PageDown with custom pageSize', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 30, pageUpDown: true, pageSize: 5 }),
      )

      act(() => {
        result.current.handleKeyDown(keyEvent('PageDown'))
      })
      expect(result.current.focusedIndex).toBe(5)

      act(() => {
        result.current.handleKeyDown(keyEvent('PageDown'))
      })
      expect(result.current.focusedIndex).toBe(10)
    })

    it('PageUp/PageDown ignored when pageUpDown: false', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 30, pageUpDown: false }),
      )

      let handled = false
      act(() => {
        handled = result.current.handleKeyDown(keyEvent('PageDown'))
      })
      expect(handled).toBe(false)
      expect(result.current.focusedIndex).toBe(0)

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('PageUp'))
      })
      expect(handled).toBe(false)
      expect(result.current.focusedIndex).toBe(0)
    })

    it('PageUp/PageDown work with small list (fewer items than pageSize)', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 3, pageUpDown: true }),
      )

      // PageDown should clamp to last item
      act(() => {
        result.current.handleKeyDown(keyEvent('PageDown'))
      })
      expect(result.current.focusedIndex).toBe(2)

      // PageUp should clamp to 0
      act(() => {
        result.current.handleKeyDown(keyEvent('PageUp'))
      })
      expect(result.current.focusedIndex).toBe(0)
    })

    it('handleKeyDown returns true for PageUp/PageDown when enabled', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 30, pageUpDown: true }),
      )

      let handled = false

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('PageDown'))
      })
      expect(handled).toBe(true)

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('PageUp'))
      })
      expect(handled).toBe(true)
    })
  })

  describe('onSelect', () => {
    it('calls onSelect with focusedIndex on Enter', () => {
      const onSelect = vi.fn()
      const { result } = renderHook(() => useListKeyboardNavigation({ itemCount: 5, onSelect }))

      // Move to index 2
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

    it('calls onSelect with focusedIndex on Space', () => {
      const onSelect = vi.fn()
      const { result } = renderHook(() => useListKeyboardNavigation({ itemCount: 5, onSelect }))

      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowDown'))
      })

      act(() => {
        result.current.handleKeyDown(keyEvent(' '))
      })

      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(1)
    })

    it('does not call onSelect on Enter when not provided', () => {
      const { result } = renderHook(() => useListKeyboardNavigation({ itemCount: 5 }))

      let handled = false
      act(() => {
        handled = result.current.handleKeyDown(keyEvent('Enter'))
      })
      expect(handled).toBe(false)
    })

    it('does not call onSelect on Space when not provided', () => {
      const { result } = renderHook(() => useListKeyboardNavigation({ itemCount: 5 }))

      let handled = false
      act(() => {
        handled = result.current.handleKeyDown(keyEvent(' '))
      })
      expect(handled).toBe(false)
    })
  })

  it('resets focusedIndex when itemCount changes', () => {
    const { result, rerender } = renderHook(
      ({ itemCount }) => useListKeyboardNavigation({ itemCount }),
      { initialProps: { itemCount: 5 } },
    )

    // Move to index 3
    act(() => {
      result.current.handleKeyDown(keyEvent('ArrowDown'))
      result.current.handleKeyDown(keyEvent('ArrowDown'))
      result.current.handleKeyDown(keyEvent('ArrowDown'))
    })
    expect(result.current.focusedIndex).toBe(3)

    // Change itemCount
    rerender({ itemCount: 10 })

    expect(result.current.focusedIndex).toBe(0)
  })

  describe('horizontal mode', () => {
    it('ArrowRight increments in horizontal mode', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 5, horizontal: true }),
      )

      expect(result.current.focusedIndex).toBe(0)

      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowRight'))
      })

      expect(result.current.focusedIndex).toBe(1)
    })

    it('ArrowLeft decrements in horizontal mode', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 5, horizontal: true }),
      )

      // Move right first
      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowRight'))
        result.current.handleKeyDown(keyEvent('ArrowRight'))
      })
      expect(result.current.focusedIndex).toBe(2)

      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowLeft'))
      })

      expect(result.current.focusedIndex).toBe(1)
    })

    it('ArrowUp is ignored in horizontal mode', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 5, horizontal: true }),
      )

      let handled = false
      act(() => {
        handled = result.current.handleKeyDown(keyEvent('ArrowUp'))
      })
      expect(handled).toBe(false)
      expect(result.current.focusedIndex).toBe(0)
    })

    it('ArrowDown is ignored in horizontal mode', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 5, horizontal: true }),
      )

      let handled = false
      act(() => {
        handled = result.current.handleKeyDown(keyEvent('ArrowDown'))
      })
      expect(handled).toBe(false)
      expect(result.current.focusedIndex).toBe(0)
    })

    it('wraps ArrowRight from last to first in horizontal mode', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 3, horizontal: true, wrap: true }),
      )

      // Go to end
      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowRight'))
        result.current.handleKeyDown(keyEvent('ArrowRight'))
      })
      expect(result.current.focusedIndex).toBe(2)

      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowRight'))
      })
      expect(result.current.focusedIndex).toBe(0)
    })

    it('wraps ArrowLeft from first to last in horizontal mode', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 3, horizontal: true, wrap: true }),
      )

      expect(result.current.focusedIndex).toBe(0)

      act(() => {
        result.current.handleKeyDown(keyEvent('ArrowLeft'))
      })
      expect(result.current.focusedIndex).toBe(2)
    })

    it('vim j/k are ignored in horizontal mode', () => {
      const { result } = renderHook(() =>
        useListKeyboardNavigation({ itemCount: 5, horizontal: true, vim: true }),
      )

      let handled = false
      act(() => {
        handled = result.current.handleKeyDown(keyEvent('j'))
      })
      expect(handled).toBe(false)

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('k'))
      })
      expect(handled).toBe(false)
    })
  })

  describe('return value for handled/unhandled keys', () => {
    it('returns true for handled keys', () => {
      const onSelect = vi.fn()
      const { result } = renderHook(() =>
        useListKeyboardNavigation({
          itemCount: 5,
          vim: true,
          homeEnd: true,
          onSelect,
        }),
      )

      let handled = false

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('ArrowDown'))
      })
      expect(handled).toBe(true)

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('ArrowUp'))
      })
      expect(handled).toBe(true)

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('j'))
      })
      expect(handled).toBe(true)

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('k'))
      })
      expect(handled).toBe(true)

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('Home'))
      })
      expect(handled).toBe(true)

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('End'))
      })
      expect(handled).toBe(true)

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('Enter'))
      })
      expect(handled).toBe(true)
    })

    it('returns false for unhandled keys', () => {
      const { result } = renderHook(() => useListKeyboardNavigation({ itemCount: 5 }))

      let handled = false

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('Tab'))
      })
      expect(handled).toBe(false)

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('Escape'))
      })
      expect(handled).toBe(false)

      act(() => {
        handled = result.current.handleKeyDown(keyEvent('a'))
      })
      expect(handled).toBe(false)
    })

    it('returns false for all keys when itemCount is 0', () => {
      const onSelect = vi.fn()
      const { result } = renderHook(() =>
        useListKeyboardNavigation({
          itemCount: 0,
          vim: true,
          homeEnd: true,
          pageUpDown: true,
          onSelect,
        }),
      )

      const keys = [
        'ArrowDown',
        'ArrowUp',
        'ArrowLeft',
        'ArrowRight',
        'j',
        'k',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        'Enter',
        ' ',
      ]

      for (const key of keys) {
        let handled = true
        act(() => {
          handled = result.current.handleKeyDown(keyEvent(key))
        })
        expect(handled, `expected false for key "${key}"`).toBe(false)
      }

      expect(onSelect).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// resolveNavOptions — pure helper
// ---------------------------------------------------------------------------

describe('resolveNavOptions', () => {
  it('applies all defaults when only itemCount is provided', () => {
    const resolved = resolveNavOptions({ itemCount: 7 })
    expect(resolved).toEqual({
      itemCount: 7,
      horizontal: false,
      wrap: true,
      vim: false,
      homeEnd: false,
      pageUpDown: false,
      pageSize: 10,
      onSelect: undefined,
    })
  })

  it('preserves explicit false values (does not replace with defaults)', () => {
    const resolved = resolveNavOptions({
      itemCount: 3,
      horizontal: false,
      wrap: false,
      vim: false,
      homeEnd: false,
      pageUpDown: false,
    })
    expect(resolved.horizontal).toBe(false)
    expect(resolved.wrap).toBe(false)
    expect(resolved.vim).toBe(false)
    expect(resolved.homeEnd).toBe(false)
    expect(resolved.pageUpDown).toBe(false)
  })

  it('preserves explicit true values', () => {
    const resolved = resolveNavOptions({
      itemCount: 3,
      horizontal: true,
      wrap: true,
      vim: true,
      homeEnd: true,
      pageUpDown: true,
    })
    expect(resolved.horizontal).toBe(true)
    expect(resolved.wrap).toBe(true)
    expect(resolved.vim).toBe(true)
    expect(resolved.homeEnd).toBe(true)
    expect(resolved.pageUpDown).toBe(true)
  })

  it('preserves custom pageSize', () => {
    const resolved = resolveNavOptions({ itemCount: 100, pageSize: 25 })
    expect(resolved.pageSize).toBe(25)
  })

  it('allows pageSize: 0 to override the default', () => {
    const resolved = resolveNavOptions({ itemCount: 100, pageSize: 0 })
    expect(resolved.pageSize).toBe(0)
  })

  it('passes through onSelect reference unchanged', () => {
    const onSelect = vi.fn()
    const resolved = resolveNavOptions({ itemCount: 5, onSelect })
    expect(resolved.onSelect).toBe(onSelect)
  })

  it('leaves onSelect undefined when not provided', () => {
    const resolved = resolveNavOptions({ itemCount: 5 })
    expect(resolved.onSelect).toBeUndefined()
  })
})
