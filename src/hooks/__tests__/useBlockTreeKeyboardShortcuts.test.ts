/**
 * Tests for useBlockTreeKeyboardShortcuts hook.
 *
 * Validates that each document-level keyboard shortcut dispatches
 * to the correct callback and that listeners are cleaned up.
 */

import { fireEvent, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlockStore } from '../../stores/blocks'
import type { UseBlockTreeKeyboardShortcutsOptions } from '../useBlockTreeKeyboardShortcuts'
import { useBlockTreeKeyboardShortcuts } from '../useBlockTreeKeyboardShortcuts'

function makeOptions(
  overrides: Partial<UseBlockTreeKeyboardShortcutsOptions> = {},
): UseBlockTreeKeyboardShortcutsOptions {
  return {
    focusedBlockId: 'BLOCK_1',
    selectedBlockIds: [],
    hasChildrenSet: new Set(['BLOCK_1']),
    blocks: [{ id: 'BLOCK_1' }, { id: 'BLOCK_2' }],
    toggleCollapse: vi.fn(),
    rawSelectAll: vi.fn(),
    clearSelected: vi.fn(),
    handleFlush: vi.fn(() => null),
    setFocused: vi.fn(),
    handleToggleTodo: vi.fn(),
    handleSlashCommand: vi.fn(),
    rovingEditor: { editor: null },
    datePickerCursorPos: { current: undefined },
    setDatePickerMode: vi.fn(),
    setDatePickerOpen: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
})

describe('useBlockTreeKeyboardShortcuts', () => {
  describe('Collapse toggle (Mod+.)', () => {
    it('calls toggleCollapse when Ctrl+. is pressed and block has children', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '.', ctrlKey: true })

      expect(opts.toggleCollapse).toHaveBeenCalledWith('BLOCK_1')
    })

    it('does not call toggleCollapse when block has no children', () => {
      const opts = makeOptions({ hasChildrenSet: new Set() })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '.', ctrlKey: true })

      expect(opts.toggleCollapse).not.toHaveBeenCalled()
    })

    it('does not call toggleCollapse when no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '.', ctrlKey: true })

      expect(opts.toggleCollapse).not.toHaveBeenCalled()
    })
  })

  describe('Multi-selection (Ctrl+A)', () => {
    it('calls rawSelectAll when Ctrl+A is pressed and no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'a', ctrlKey: true })

      expect(opts.rawSelectAll).toHaveBeenCalledWith(['BLOCK_1', 'BLOCK_2'])
    })

    it('does not select all when a block is focused', () => {
      const opts = makeOptions({ focusedBlockId: 'BLOCK_1' })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'a', ctrlKey: true })

      expect(opts.rawSelectAll).not.toHaveBeenCalled()
    })
  })

  describe('Escape clears selection', () => {
    it('calls clearSelected when Escape is pressed with active selection', () => {
      const opts = makeOptions({
        focusedBlockId: null,
        selectedBlockIds: ['BLOCK_1'],
      })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(opts.clearSelected).toHaveBeenCalledTimes(1)
    })

    it('does not clear selection when no blocks are selected', () => {
      const opts = makeOptions({ focusedBlockId: null, selectedBlockIds: [] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(opts.clearSelected).not.toHaveBeenCalled()
    })
  })

  describe('Unfocused Escape closes editor (UX-M8)', () => {
    it('calls handleFlush and setFocused(null) when Escape is pressed and editor is unfocused', () => {
      const opts = makeOptions()
      // Simulate the store having a focused block but no selection
      useBlockStore.setState({ focusedBlockId: 'BLOCK_1', selectedBlockIds: [] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(opts.handleFlush).toHaveBeenCalled()
      expect(opts.setFocused).toHaveBeenCalledWith(null)
    })

    it('does not close editor when store has no focused block', () => {
      const opts = makeOptions()
      useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(opts.handleFlush).not.toHaveBeenCalled()
    })
  })

  describe('Task cycling (Ctrl+Enter)', () => {
    it('calls handleToggleTodo when Ctrl+Enter is pressed and block is focused', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true })

      expect(opts.handleToggleTodo).toHaveBeenCalledWith('BLOCK_1')
    })

    it('does not call handleToggleTodo when no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true })

      expect(opts.handleToggleTodo).not.toHaveBeenCalled()
    })
  })

  describe('Date picker (Ctrl+Shift+D)', () => {
    it('opens date picker when Ctrl+Shift+D is pressed', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'D', ctrlKey: true, shiftKey: true })

      expect(opts.setDatePickerMode).toHaveBeenCalledWith('date')
      expect(opts.setDatePickerOpen).toHaveBeenCalledWith(true)
    })

    it('does not open date picker when no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'D', ctrlKey: true, shiftKey: true })

      expect(opts.setDatePickerOpen).not.toHaveBeenCalled()
    })
  })

  describe('Heading shortcut (Ctrl+1-6)', () => {
    it('calls handleSlashCommand with heading level for Ctrl+1', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '1', ctrlKey: true })

      expect(opts.handleSlashCommand).toHaveBeenCalledWith({ id: 'h1', label: 'Heading 1' })
    })

    it('calls handleSlashCommand with heading level for Ctrl+6', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '6', ctrlKey: true })

      expect(opts.handleSlashCommand).toHaveBeenCalledWith({ id: 'h6', label: 'Heading 6' })
    })

    it('ignores Ctrl+Shift+number (reserved for priority)', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '1', ctrlKey: true, shiftKey: true })

      expect(opts.handleSlashCommand).not.toHaveBeenCalled()
    })

    it('does not fire heading shortcut when no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '1', ctrlKey: true })

      expect(opts.handleSlashCommand).not.toHaveBeenCalled()
    })
  })

  describe('Cleanup', () => {
    it('removes event listeners on unmount', () => {
      const opts = makeOptions()
      const { unmount } = renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      unmount()

      // After unmount, keyboard events should not trigger callbacks
      fireEvent.keyDown(document, { key: '.', ctrlKey: true })
      fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true })
      fireEvent.keyDown(document, { key: '1', ctrlKey: true })

      expect(opts.toggleCollapse).not.toHaveBeenCalled()
      expect(opts.handleToggleTodo).not.toHaveBeenCalled()
      expect(opts.handleSlashCommand).not.toHaveBeenCalled()
    })
  })
})
