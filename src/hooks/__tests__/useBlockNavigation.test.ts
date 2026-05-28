/**
 * Tests for useBlockNavigation hook (R-11).
 *
 * Validates:
 *  1. handleBlockClick calls onNavigateToPage with correct args
 *  2. handleBlockClick uses pageTitles to resolve title
 *  3. handleBlockClick uses untitledLabel fallback when page not in map
 *  4. handleBlockClick does nothing when block has no page_id
 *  5. handleBlockClick does nothing when onNavigateToPage is undefined
 *  6. handleBlockKeyDown triggers click on Enter key
 *  7. handleBlockKeyDown triggers click on Space key
 *  8. handleBlockKeyDown ignores other keys (Tab, Escape, 'a')
 *  9. handleBlockKeyDown calls preventDefault on Enter/Space
 * 10. getRowHandlers returns stable identities across renders for the same id
 *     and a fresh entry per distinct block id (Tier 1.4 memo-defeat fix).
 */

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '../../__tests__/fixtures'
import { useBlockNavigation } from '../useBlockNavigation'

function makeKeyboardEvent(key: string): {
  key: string
  preventDefault: ReturnType<typeof vi.fn>
} {
  return { key, preventDefault: vi.fn() }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useBlockNavigation', () => {
  // 1. handleBlockClick calls onNavigateToPage with correct args
  it('handleBlockClick calls onNavigateToPage with pageId, title, blockId', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map([['PAGE_1', 'My Page']])

    const { result } = renderHook(() => useBlockNavigation({ onNavigateToPage, pageTitles }))

    result.current.handleBlockClick(
      makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE_1', page_id: 'PAGE_1' }),
    )

    expect(onNavigateToPage).toHaveBeenCalledWith('PAGE_1', 'My Page', 'BLOCK_1')
  })

  // 2. handleBlockClick uses pageTitles to resolve title
  it('resolves page title from pageTitles map', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map([
      ['PAGE_1', 'Alpha Page'],
      ['PAGE_2', 'Beta Page'],
    ])

    const { result } = renderHook(() => useBlockNavigation({ onNavigateToPage, pageTitles }))

    result.current.handleBlockClick(makeBlock({ id: 'B2', parent_id: 'PAGE_1', page_id: 'PAGE_2' }))

    expect(onNavigateToPage).toHaveBeenCalledWith('PAGE_2', 'Beta Page', 'B2')
  })

  // 3. handleBlockClick uses untitledLabel fallback when page not in map
  it('uses default "Untitled" fallback when page not in map', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map<string, string>()

    const { result } = renderHook(() => useBlockNavigation({ onNavigateToPage, pageTitles }))

    result.current.handleBlockClick(
      makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE_1', page_id: 'UNKNOWN_PAGE' }),
    )

    expect(onNavigateToPage).toHaveBeenCalledWith('UNKNOWN_PAGE', 'Untitled', 'BLOCK_1')
  })

  // 3b. Custom untitledLabel
  it('uses custom untitledLabel when page not in map', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map<string, string>()

    const { result } = renderHook(() =>
      useBlockNavigation({
        onNavigateToPage,
        pageTitles,
        untitledLabel: 'Sans titre',
      }),
    )

    result.current.handleBlockClick(
      makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE_1', page_id: 'UNKNOWN_PAGE' }),
    )

    expect(onNavigateToPage).toHaveBeenCalledWith('UNKNOWN_PAGE', 'Sans titre', 'BLOCK_1')
  })

  // 3c. Nested block navigates to page_id, not parent_id
  it('navigates using page_id even when parent_id differs (nested blocks)', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map([['PAGE_ROOT', 'My Page']])

    const { result } = renderHook(() => useBlockNavigation({ onNavigateToPage, pageTitles }))

    result.current.handleBlockClick(
      makeBlock({ id: 'NESTED', parent_id: 'PARENT_BLOCK', page_id: 'PAGE_ROOT' }),
    )

    expect(onNavigateToPage).toHaveBeenCalledWith('PAGE_ROOT', 'My Page', 'NESTED')
  })

  // 4. handleBlockClick does nothing when block has no page_id
  it('does nothing when block has no page_id', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map<string, string>()

    const { result } = renderHook(() => useBlockNavigation({ onNavigateToPage, pageTitles }))

    result.current.handleBlockClick(
      makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE_1', page_id: null }),
    )

    expect(onNavigateToPage).not.toHaveBeenCalled()
  })

  // 5. handleBlockClick does nothing when onNavigateToPage is undefined
  it('does not throw when onNavigateToPage is undefined', () => {
    const pageTitles = new Map([['PAGE_1', 'My Page']])

    const { result } = renderHook(() =>
      useBlockNavigation({ onNavigateToPage: undefined, pageTitles }),
    )

    expect(() =>
      result.current.handleBlockClick(
        makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE_1', page_id: 'PAGE_1' }),
      ),
    ).not.toThrow()
  })

  // 6. handleBlockKeyDown triggers click on Enter key
  it('handleBlockKeyDown triggers navigation on Enter', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map([['PAGE_1', 'My Page']])

    const { result } = renderHook(() => useBlockNavigation({ onNavigateToPage, pageTitles }))

    const event = makeKeyboardEvent('Enter')
    result.current.handleBlockKeyDown(
      event as unknown as React.KeyboardEvent,
      makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE_1', page_id: 'PAGE_1' }),
    )

    expect(onNavigateToPage).toHaveBeenCalledWith('PAGE_1', 'My Page', 'BLOCK_1')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  // 7. handleBlockKeyDown triggers click on Space key
  it('handleBlockKeyDown triggers navigation on Space', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map([['PAGE_1', 'My Page']])

    const { result } = renderHook(() => useBlockNavigation({ onNavigateToPage, pageTitles }))

    const event = makeKeyboardEvent(' ')
    result.current.handleBlockKeyDown(
      event as unknown as React.KeyboardEvent,
      makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE_1', page_id: 'PAGE_1' }),
    )

    expect(onNavigateToPage).toHaveBeenCalledWith('PAGE_1', 'My Page', 'BLOCK_1')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  // 8. handleBlockKeyDown ignores other keys
  it('handleBlockKeyDown ignores Tab key', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map([['PAGE_1', 'My Page']])

    const { result } = renderHook(() => useBlockNavigation({ onNavigateToPage, pageTitles }))

    const event = makeKeyboardEvent('Tab')
    result.current.handleBlockKeyDown(
      event as unknown as React.KeyboardEvent,
      makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE_1', page_id: 'PAGE_1' }),
    )

    expect(onNavigateToPage).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('handleBlockKeyDown ignores Escape key', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map([['PAGE_1', 'My Page']])

    const { result } = renderHook(() => useBlockNavigation({ onNavigateToPage, pageTitles }))

    const event = makeKeyboardEvent('Escape')
    result.current.handleBlockKeyDown(
      event as unknown as React.KeyboardEvent,
      makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE_1', page_id: 'PAGE_1' }),
    )

    expect(onNavigateToPage).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('handleBlockKeyDown ignores letter keys', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map([['PAGE_1', 'My Page']])

    const { result } = renderHook(() => useBlockNavigation({ onNavigateToPage, pageTitles }))

    const event = makeKeyboardEvent('a')
    result.current.handleBlockKeyDown(
      event as unknown as React.KeyboardEvent,
      makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE_1', page_id: 'PAGE_1' }),
    )

    expect(onNavigateToPage).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  // 10. getRowHandlers — Tier 1.4 perf-review memo-defeat fix
  describe('getRowHandlers (Tier 1.4 stable per-block handlers)', () => {
    it('returns the same handler bundle across renders for the same block id', () => {
      const onNavigateToPage = vi.fn()
      const pageTitles = new Map([['PAGE_1', 'My Page']])

      const { result, rerender } = renderHook(() =>
        useBlockNavigation({ onNavigateToPage, pageTitles }),
      )

      const block = makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE_1', page_id: 'PAGE_1' })
      const first = result.current.getRowHandlers(block)
      rerender()
      const second = result.current.getRowHandlers(block)

      expect(second).toBe(first)
      expect(second.onClick).toBe(first.onClick)
      expect(second.onKeyDown).toBe(first.onKeyDown)
    })

    it('returns distinct handler bundles for distinct block ids', () => {
      const onNavigateToPage = vi.fn()
      const pageTitles = new Map([['PAGE_1', 'My Page']])

      const { result } = renderHook(() => useBlockNavigation({ onNavigateToPage, pageTitles }))

      const blockA = makeBlock({ id: 'A', parent_id: 'PAGE_1', page_id: 'PAGE_1' })
      const blockB = makeBlock({ id: 'B', parent_id: 'PAGE_1', page_id: 'PAGE_1' })

      const a = result.current.getRowHandlers(blockA)
      const b = result.current.getRowHandlers(blockB)

      expect(a).not.toBe(b)
      expect(a.onClick).not.toBe(b.onClick)
    })

    it('row onClick navigates to the block s parent page', () => {
      const onNavigateToPage = vi.fn()
      const pageTitles = new Map([['PAGE_1', 'My Page']])

      const { result } = renderHook(() => useBlockNavigation({ onNavigateToPage, pageTitles }))

      const block = makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE_1', page_id: 'PAGE_1' })
      result.current.getRowHandlers(block).onClick()

      expect(onNavigateToPage).toHaveBeenCalledWith('PAGE_1', 'My Page', 'BLOCK_1')
    })

    it('row onKeyDown delegates Enter to navigation', () => {
      const onNavigateToPage = vi.fn()
      const pageTitles = new Map([['PAGE_1', 'My Page']])

      const { result } = renderHook(() => useBlockNavigation({ onNavigateToPage, pageTitles }))

      const block = makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE_1', page_id: 'PAGE_1' })
      const event = makeKeyboardEvent('Enter')
      result.current.getRowHandlers(block).onKeyDown(event as unknown as React.KeyboardEvent)

      expect(onNavigateToPage).toHaveBeenCalledWith('PAGE_1', 'My Page', 'BLOCK_1')
      expect(event.preventDefault).toHaveBeenCalledTimes(1)
    })

    it('invalidates the cache when onNavigateToPage identity changes', () => {
      const pageTitles = new Map([['PAGE_1', 'My Page']])

      let onNavigateToPage = vi.fn()
      const { result, rerender } = renderHook(
        ({ cb }: { cb: typeof onNavigateToPage }) =>
          useBlockNavigation({ onNavigateToPage: cb, pageTitles }),
        { initialProps: { cb: onNavigateToPage } },
      )

      const block = makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE_1', page_id: 'PAGE_1' })
      const first = result.current.getRowHandlers(block)

      onNavigateToPage = vi.fn()
      rerender({ cb: onNavigateToPage })

      const second = result.current.getRowHandlers(block)
      expect(second).not.toBe(first)
    })
  })
})
