/**
 * Tests for useBlockTreeEventListeners hook.
 *
 * Validates that each custom DOM block event dispatches to the correct
 * callback and that listeners are cleaned up on unmount.
 */

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchBlockEvent } from '../../lib/block-events'
import type { UseBlockTreeEventListenersOptions } from '../useBlockTreeEventListeners'
import { useBlockTreeEventListeners } from '../useBlockTreeEventListeners'

function makeOptions(
  overrides: Partial<UseBlockTreeEventListenersOptions> = {},
): UseBlockTreeEventListenersOptions {
  return {
    focusedBlockId: 'BLOCK_1',
    rootParentId: 'PAGE_1',
    handleEscapeCancel: vi.fn(),
    handleToggleTodo: vi.fn(),
    handleTogglePriority: vi.fn(),
    handleShowProperties: vi.fn(),
    rovingEditor: { editor: null },
    datePickerCursorPos: { current: undefined },
    setDatePickerMode: vi.fn(),
    setDatePickerOpen: vi.fn(),
    pageStore: {
      setState: vi.fn(),
      getState: vi.fn(),
      getInitialState: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as UseBlockTreeEventListenersOptions['pageStore'],
    t: (key: string) => key,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useBlockTreeEventListeners', () => {
  describe('DISCARD_BLOCK_EDIT', () => {
    it('calls handleEscapeCancel when event is dispatched and block is focused', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('DISCARD_BLOCK_EDIT')

      expect(opts.handleEscapeCancel).toHaveBeenCalledTimes(1)
    })

    it('does not call handleEscapeCancel when no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('DISCARD_BLOCK_EDIT')

      expect(opts.handleEscapeCancel).not.toHaveBeenCalled()
    })
  })

  describe('CYCLE_PRIORITY', () => {
    it('calls handleTogglePriority when event is dispatched', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('CYCLE_PRIORITY')

      expect(opts.handleTogglePriority).toHaveBeenCalledWith('BLOCK_1')
    })

    it('does not call handleTogglePriority when no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('CYCLE_PRIORITY')

      expect(opts.handleTogglePriority).not.toHaveBeenCalled()
    })
  })

  describe('SET_PRIORITY_1/2/3', () => {
    it('calls setPriority for SET_PRIORITY_1 event', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const mockedInvoke = vi.mocked(invoke)
      mockedInvoke.mockResolvedValue(undefined)

      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('SET_PRIORITY_1')

      // The handler is async — wait for it
      await vi.waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
          blockId: 'BLOCK_1',
          level: '1',
        })
      })
    })

    it('does not call setPriority when no block is focused', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const mockedInvoke = vi.mocked(invoke)
      mockedInvoke.mockClear()

      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('SET_PRIORITY_1')

      // Give a tick for any async handler to fire
      await new Promise((r) => setTimeout(r, 50))

      const callsForSetPriority = mockedInvoke.mock.calls.filter(
        (c: unknown[]) => c[0] === 'set_priority',
      )
      expect(callsForSetPriority).toHaveLength(0)
    })
  })

  describe('OPEN_DATE_PICKER', () => {
    it('opens date picker with "date" mode when event is dispatched', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('OPEN_DATE_PICKER')

      expect(opts.setDatePickerMode).toHaveBeenCalledWith('date')
      expect(opts.setDatePickerOpen).toHaveBeenCalledWith(true)
    })

    it('does not open when no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('OPEN_DATE_PICKER')

      expect(opts.setDatePickerOpen).not.toHaveBeenCalled()
    })
  })

  describe('OPEN_DUE_DATE_PICKER', () => {
    it('opens date picker with "due" mode', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('OPEN_DUE_DATE_PICKER')

      expect(opts.setDatePickerMode).toHaveBeenCalledWith('due')
      expect(opts.setDatePickerOpen).toHaveBeenCalledWith(true)
    })
  })

  describe('OPEN_SCHEDULED_DATE_PICKER', () => {
    it('opens date picker with "schedule" mode', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('OPEN_SCHEDULED_DATE_PICKER')

      expect(opts.setDatePickerMode).toHaveBeenCalledWith('schedule')
      expect(opts.setDatePickerOpen).toHaveBeenCalledWith(true)
    })
  })

  describe('TOGGLE_TODO_STATE', () => {
    it('calls handleToggleTodo when event is dispatched', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('TOGGLE_TODO_STATE')

      expect(opts.handleToggleTodo).toHaveBeenCalledWith('BLOCK_1')
    })

    it('does not call handleToggleTodo when no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('TOGGLE_TODO_STATE')

      expect(opts.handleToggleTodo).not.toHaveBeenCalled()
    })
  })

  describe('OPEN_BLOCK_PROPERTIES', () => {
    it('calls handleShowProperties when event is dispatched', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('OPEN_BLOCK_PROPERTIES')

      expect(opts.handleShowProperties).toHaveBeenCalledWith('BLOCK_1')
    })

    it('does not call handleShowProperties when no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('OPEN_BLOCK_PROPERTIES')

      expect(opts.handleShowProperties).not.toHaveBeenCalled()
    })
  })

  describe('Cleanup', () => {
    it('removes all event listeners on unmount', () => {
      const opts = makeOptions()
      const { unmount } = renderHook(() => useBlockTreeEventListeners(opts))

      unmount()

      // After unmount, events should not trigger callbacks
      dispatchBlockEvent('DISCARD_BLOCK_EDIT')
      dispatchBlockEvent('CYCLE_PRIORITY')
      dispatchBlockEvent('TOGGLE_TODO_STATE')
      dispatchBlockEvent('OPEN_BLOCK_PROPERTIES')

      expect(opts.handleEscapeCancel).not.toHaveBeenCalled()
      expect(opts.handleTogglePriority).not.toHaveBeenCalled()
      expect(opts.handleToggleTodo).not.toHaveBeenCalled()
      expect(opts.handleShowProperties).not.toHaveBeenCalled()
    })
  })
})
