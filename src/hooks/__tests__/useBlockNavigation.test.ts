/**
 * Tests for useBlockNavigation hook (R-11).
 *
 * Validates:
 *  1. handleBlockClick calls onNavigateToPage with correct args
 *  2. handleBlockClick uses pageTitles to resolve title
 *  3. handleBlockClick uses untitledLabel fallback when page not in map
 *  4. handleBlockClick does nothing when block has no parent_id
 *  5. handleBlockClick does nothing when onNavigateToPage is undefined
 *  6. handleBlockKeyDown triggers click on Enter key
 *  7. handleBlockKeyDown triggers click on Space key
 *  8. handleBlockKeyDown ignores other keys (Tab, Escape, 'a')
 *  9. handleBlockKeyDown calls preventDefault on Enter/Space
 */

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockRow } from '../../lib/tauri'
import { useBlockNavigation } from '../useBlockNavigation'

function makeBlock(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'BLOCK_1',
    block_type: 'block',
    content: 'test block',
    parent_id: 'PAGE_1',
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    ...overrides,
  }
}

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

    const { result } = renderHook(() =>
      useBlockNavigation({ onNavigateToPage, pageTitles }),
    )

    result.current.handleBlockClick(makeBlock())

    expect(onNavigateToPage).toHaveBeenCalledWith('PAGE_1', 'My Page', 'BLOCK_1')
  })

  // 2. handleBlockClick uses pageTitles to resolve title
  it('resolves page title from pageTitles map', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map([
      ['PAGE_1', 'Alpha Page'],
      ['PAGE_2', 'Beta Page'],
    ])

    const { result } = renderHook(() =>
      useBlockNavigation({ onNavigateToPage, pageTitles }),
    )

    result.current.handleBlockClick(makeBlock({ parent_id: 'PAGE_2', id: 'B2' }))

    expect(onNavigateToPage).toHaveBeenCalledWith('PAGE_2', 'Beta Page', 'B2')
  })

  // 3. handleBlockClick uses untitledLabel fallback when page not in map
  it('uses default "Untitled" fallback when page not in map', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map<string, string>()

    const { result } = renderHook(() =>
      useBlockNavigation({ onNavigateToPage, pageTitles }),
    )

    result.current.handleBlockClick(makeBlock({ parent_id: 'UNKNOWN_PAGE' }))

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

    result.current.handleBlockClick(makeBlock({ parent_id: 'UNKNOWN_PAGE' }))

    expect(onNavigateToPage).toHaveBeenCalledWith('UNKNOWN_PAGE', 'Sans titre', 'BLOCK_1')
  })

  // 4. handleBlockClick does nothing when block has no parent_id
  it('does nothing when block has no parent_id', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map<string, string>()

    const { result } = renderHook(() =>
      useBlockNavigation({ onNavigateToPage, pageTitles }),
    )

    result.current.handleBlockClick(makeBlock({ parent_id: null }))

    expect(onNavigateToPage).not.toHaveBeenCalled()
  })

  // 5. handleBlockClick does nothing when onNavigateToPage is undefined
  it('does not throw when onNavigateToPage is undefined', () => {
    const pageTitles = new Map([['PAGE_1', 'My Page']])

    const { result } = renderHook(() =>
      useBlockNavigation({ onNavigateToPage: undefined, pageTitles }),
    )

    expect(() => result.current.handleBlockClick(makeBlock())).not.toThrow()
  })

  // 6. handleBlockKeyDown triggers click on Enter key
  it('handleBlockKeyDown triggers navigation on Enter', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map([['PAGE_1', 'My Page']])

    const { result } = renderHook(() =>
      useBlockNavigation({ onNavigateToPage, pageTitles }),
    )

    const event = makeKeyboardEvent('Enter')
    result.current.handleBlockKeyDown(
      event as unknown as React.KeyboardEvent,
      makeBlock(),
    )

    expect(onNavigateToPage).toHaveBeenCalledWith('PAGE_1', 'My Page', 'BLOCK_1')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  // 7. handleBlockKeyDown triggers click on Space key
  it('handleBlockKeyDown triggers navigation on Space', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map([['PAGE_1', 'My Page']])

    const { result } = renderHook(() =>
      useBlockNavigation({ onNavigateToPage, pageTitles }),
    )

    const event = makeKeyboardEvent(' ')
    result.current.handleBlockKeyDown(
      event as unknown as React.KeyboardEvent,
      makeBlock(),
    )

    expect(onNavigateToPage).toHaveBeenCalledWith('PAGE_1', 'My Page', 'BLOCK_1')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  // 8. handleBlockKeyDown ignores other keys
  it('handleBlockKeyDown ignores Tab key', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map([['PAGE_1', 'My Page']])

    const { result } = renderHook(() =>
      useBlockNavigation({ onNavigateToPage, pageTitles }),
    )

    const event = makeKeyboardEvent('Tab')
    result.current.handleBlockKeyDown(
      event as unknown as React.KeyboardEvent,
      makeBlock(),
    )

    expect(onNavigateToPage).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('handleBlockKeyDown ignores Escape key', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map([['PAGE_1', 'My Page']])

    const { result } = renderHook(() =>
      useBlockNavigation({ onNavigateToPage, pageTitles }),
    )

    const event = makeKeyboardEvent('Escape')
    result.current.handleBlockKeyDown(
      event as unknown as React.KeyboardEvent,
      makeBlock(),
    )

    expect(onNavigateToPage).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('handleBlockKeyDown ignores letter keys', () => {
    const onNavigateToPage = vi.fn()
    const pageTitles = new Map([['PAGE_1', 'My Page']])

    const { result } = renderHook(() =>
      useBlockNavigation({ onNavigateToPage, pageTitles }),
    )

    const event = makeKeyboardEvent('a')
    result.current.handleBlockKeyDown(
      event as unknown as React.KeyboardEvent,
      makeBlock(),
    )

    expect(onNavigateToPage).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
