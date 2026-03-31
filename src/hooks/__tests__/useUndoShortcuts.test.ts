import { fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUndoShortcuts } from '../useUndoShortcuts'

// -- Mock stores --------------------------------------------------------------

const mockUndo = vi.fn().mockResolvedValue(null)
const mockRedo = vi.fn().mockResolvedValue(null)

vi.mock('@/stores/navigation', () => ({
  useNavigationStore: {
    getState: vi.fn(() => ({
      currentView: 'page-editor',
      pageStack: [{ pageId: 'PAGE_1', title: 'Test Page' }],
    })),
  },
}))

vi.mock('@/stores/undo', () => ({
  useUndoStore: {
    getState: vi.fn(() => ({
      undo: mockUndo,
      redo: mockRedo,
    })),
  },
}))

import { useNavigationStore } from '@/stores/navigation'
import { useUndoStore } from '@/stores/undo'

const mockedNavGetState = vi.mocked(useNavigationStore.getState)
const mockedUndoGetState = vi.mocked(useUndoStore.getState)

// -- Minimal renderHook (matches project pattern) -----------------------------

// biome-ignore lint/suspicious/noExplicitAny: act typing varies across React versions
let act: (cb: () => void) => void = undefined as any

function renderHook(hookFn: () => void): { unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root

  function TestComponent(): null {
    hookFn()
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(TestComponent))
  })

  return {
    unmount() {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

// -- Setup / teardown ---------------------------------------------------------

beforeEach(async () => {
  // biome-ignore lint/suspicious/noExplicitAny: React test env global
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const React = await import('react')
  // biome-ignore lint/suspicious/noExplicitAny: act typing varies across React versions
  act = (React as any).act
  vi.clearAllMocks()

  // Reset default mock return values
  mockedNavGetState.mockReturnValue({
    currentView: 'page-editor',
    pageStack: [{ pageId: 'PAGE_1', title: 'Test Page' }],
  } as ReturnType<typeof useNavigationStore.getState>)

  mockedUndoGetState.mockReturnValue({
    undo: mockUndo,
    redo: mockRedo,
  } as unknown as ReturnType<typeof useUndoStore.getState>)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// -- Tests --------------------------------------------------------------------

describe('useUndoShortcuts', () => {
  it('Ctrl+Z dispatches undo(pageId) when on page-editor view', () => {
    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })

    expect(mockUndo).toHaveBeenCalledWith('PAGE_1')
    expect(mockUndo).toHaveBeenCalledTimes(1)

    unmount()
  })

  it('Ctrl+Y dispatches redo(pageId) when on page-editor view', () => {
    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'y', ctrlKey: true })

    expect(mockRedo).toHaveBeenCalledWith('PAGE_1')
    expect(mockRedo).toHaveBeenCalledTimes(1)

    unmount()
  })

  it('does NOT fire when currentView is not page-editor', () => {
    mockedNavGetState.mockReturnValue({
      currentView: 'journal',
      pageStack: [],
    } as unknown as ReturnType<typeof useNavigationStore.getState>)

    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(document, { key: 'y', ctrlKey: true })

    expect(mockUndo).not.toHaveBeenCalled()
    expect(mockRedo).not.toHaveBeenCalled()

    unmount()
  })

  it('does NOT fire when pageStack is empty', () => {
    mockedNavGetState.mockReturnValue({
      currentView: 'page-editor',
      pageStack: [],
    } as unknown as ReturnType<typeof useNavigationStore.getState>)

    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })

    expect(mockUndo).not.toHaveBeenCalled()

    unmount()
  })

  it('does NOT fire when target is contentEditable', () => {
    const { unmount } = renderHook(() => useUndoShortcuts())

    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    // jsdom may not fully implement isContentEditable — set it explicitly
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    document.body.appendChild(editable)

    fireEvent.keyDown(editable, { key: 'z', ctrlKey: true })

    expect(mockUndo).not.toHaveBeenCalled()

    editable.remove()
    unmount()
  })

  it('does NOT fire when target is INPUT element', () => {
    const { unmount } = renderHook(() => useUndoShortcuts())

    const input = document.createElement('input')
    document.body.appendChild(input)

    fireEvent.keyDown(input, { key: 'z', ctrlKey: true })

    expect(mockUndo).not.toHaveBeenCalled()

    input.remove()
    unmount()
  })

  it('does NOT fire when target is TEXTAREA element', () => {
    const { unmount } = renderHook(() => useUndoShortcuts())

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)

    fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true })

    expect(mockUndo).not.toHaveBeenCalled()

    textarea.remove()
    unmount()
  })

  it('Cmd+Z works (metaKey for Mac)', () => {
    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', metaKey: true })

    expect(mockUndo).toHaveBeenCalledWith('PAGE_1')

    unmount()
  })

  it('Ctrl+Shift+Z does NOT trigger undo (that is TipTap redo)', () => {
    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true, shiftKey: true })

    expect(mockUndo).not.toHaveBeenCalled()
    expect(mockRedo).not.toHaveBeenCalled()

    unmount()
  })

  it('Ctrl+Z calls preventDefault', () => {
    const { unmount } = renderHook(() => useUndoShortcuts())

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    const spy = vi.spyOn(event, 'preventDefault')
    document.dispatchEvent(event)

    expect(spy).toHaveBeenCalled()

    unmount()
  })

  it('Ctrl+Y calls preventDefault', () => {
    const { unmount } = renderHook(() => useUndoShortcuts())

    const event = new KeyboardEvent('keydown', {
      key: 'y',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    const spy = vi.spyOn(event, 'preventDefault')
    document.dispatchEvent(event)

    expect(spy).toHaveBeenCalled()

    unmount()
  })

  it('uses the last page in the stack for pageId', () => {
    mockedNavGetState.mockReturnValue({
      currentView: 'page-editor',
      pageStack: [
        { pageId: 'PAGE_1', title: 'First' },
        { pageId: 'PAGE_2', title: 'Second' },
        { pageId: 'PAGE_3', title: 'Third' },
      ],
    } as ReturnType<typeof useNavigationStore.getState>)

    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })

    expect(mockUndo).toHaveBeenCalledWith('PAGE_3')

    unmount()
  })

  it('removes event listener on unmount', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const { unmount } = renderHook(() => useUndoShortcuts())

    unmount()

    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function))

    removeSpy.mockRestore()
  })
})

describe('error handling', () => {
  it('does not crash when undo rejects (unhandled rejection)', () => {
    mockUndo.mockRejectedValueOnce(new Error('undo failed'))

    const { unmount } = renderHook(() => useUndoShortcuts())

    // Should not throw synchronously
    expect(() => {
      fireEvent.keyDown(document, { key: 'z', ctrlKey: true })
    }).not.toThrow()

    expect(mockUndo).toHaveBeenCalledWith('PAGE_1')

    unmount()
  })

  it('does not crash when redo rejects', () => {
    mockRedo.mockRejectedValueOnce(new Error('redo failed'))

    const { unmount } = renderHook(() => useUndoShortcuts())

    expect(() => {
      fireEvent.keyDown(document, { key: 'y', ctrlKey: true })
    }).not.toThrow()

    expect(mockRedo).toHaveBeenCalledWith('PAGE_1')

    unmount()
  })
})
