/**
 * Tests for useHistoryKeyboardNav — wraps useListKeyboardNavigation
 * with HistoryView-specific document-level shortcuts (Space toggles
 * focused row, Ctrl/Cmd+A selects all, Enter confirms revert when
 * selection is non-empty, Escape clears selection) plus a
 * scroll-into-view effect for the focused row inside `listRef`.
 */

import { act, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHistoryKeyboardNav } from '../useHistoryKeyboardNav'

interface HookOpts {
  itemCount: number
  hasSelection: boolean
  onToggleSelection: (index: number) => void
  onSelectAll: () => void
  onConfirmRevert: () => void
  onClearSelection: () => void
}

function renderNav(opts: HookOpts, listEl: HTMLDivElement | null = null) {
  return renderHook(
    (props: HookOpts) => {
      const ref = useRef<HTMLDivElement | null>(listEl)
      return useHistoryKeyboardNav({
        itemCount: props.itemCount,
        listRef: ref,
        hasSelection: props.hasSelection,
        onToggleSelection: props.onToggleSelection,
        onSelectAll: props.onSelectAll,
        onConfirmRevert: props.onConfirmRevert,
        onClearSelection: props.onClearSelection,
      })
    },
    { initialProps: opts },
  )
}

function dispatchKey(
  key: string,
  init: KeyboardEventInit & { ctrlKey?: boolean; metaKey?: boolean } = {},
) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  document.dispatchEvent(event)
  return event
}

const baseOpts = (): HookOpts => ({
  itemCount: 5,
  hasSelection: false,
  onToggleSelection: vi.fn(),
  onSelectAll: vi.fn(),
  onConfirmRevert: vi.fn(),
  onClearSelection: vi.fn(),
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useHistoryKeyboardNav', () => {
  it('starts at focusedIndex 0', () => {
    const { result } = renderNav(baseOpts())
    expect(result.current.focusedIndex).toBe(0)
  })

  it('ArrowDown / ArrowUp move focused index (clamped, no wrap)', () => {
    const { result } = renderNav(baseOpts())

    act(() => {
      dispatchKey('ArrowDown')
    })
    expect(result.current.focusedIndex).toBe(1)

    act(() => {
      dispatchKey('ArrowDown')
      dispatchKey('ArrowDown')
    })
    expect(result.current.focusedIndex).toBe(3)

    act(() => {
      dispatchKey('ArrowUp')
    })
    expect(result.current.focusedIndex).toBe(2)
  })

  it('Space invokes onToggleSelection with the focused index', () => {
    const opts = baseOpts()
    const { result } = renderNav(opts)

    act(() => {
      dispatchKey('ArrowDown')
      dispatchKey('ArrowDown')
    })
    expect(result.current.focusedIndex).toBe(2)

    act(() => {
      dispatchKey(' ')
    })
    expect(opts.onToggleSelection).toHaveBeenCalledTimes(1)
    expect(opts.onToggleSelection).toHaveBeenCalledWith(2)
  })

  it('Ctrl+A invokes onSelectAll', () => {
    const opts = baseOpts()
    renderNav(opts)

    act(() => {
      dispatchKey('a', { ctrlKey: true })
    })
    expect(opts.onSelectAll).toHaveBeenCalledTimes(1)
  })

  it('Enter invokes onConfirmRevert only when hasSelection is true', () => {
    const opts = baseOpts()
    const { rerender } = renderNav(opts)

    // No selection — Enter is a no-op.
    act(() => {
      dispatchKey('Enter')
    })
    expect(opts.onConfirmRevert).not.toHaveBeenCalled()

    rerender({ ...opts, hasSelection: true })

    act(() => {
      dispatchKey('Enter')
    })
    expect(opts.onConfirmRevert).toHaveBeenCalledTimes(1)
  })

  it('Escape invokes onClearSelection', () => {
    const opts = baseOpts()
    renderNav(opts)

    act(() => {
      dispatchKey('Escape')
    })
    expect(opts.onClearSelection).toHaveBeenCalledTimes(1)
  })

  it('ignores keys originating from inputs / selects / textareas', () => {
    const opts = baseOpts()
    const { result } = renderNav(opts)

    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      act(() => {
        const event = new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        })
        input.dispatchEvent(event)
      })
      // Focused index should NOT change when the source is an input.
      expect(result.current.focusedIndex).toBe(0)
      expect(opts.onSelectAll).not.toHaveBeenCalled()
    } finally {
      document.body.removeChild(input)
    }
  })

  it('Home / End jump to first / last item', () => {
    const { result } = renderNav(baseOpts())

    act(() => {
      dispatchKey('End')
    })
    expect(result.current.focusedIndex).toBe(4)

    act(() => {
      dispatchKey('Home')
    })
    expect(result.current.focusedIndex).toBe(0)
  })

  it('removes the document keydown listener on unmount', () => {
    const opts = baseOpts()
    const { unmount } = renderNav(opts)

    unmount()

    act(() => {
      dispatchKey(' ')
      dispatchKey('a', { ctrlKey: true })
      dispatchKey('Escape')
    })

    expect(opts.onToggleSelection).not.toHaveBeenCalled()
    expect(opts.onSelectAll).not.toHaveBeenCalled()
    expect(opts.onClearSelection).not.toHaveBeenCalled()
  })
})
