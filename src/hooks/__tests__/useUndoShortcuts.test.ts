import { fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUndoShortcuts } from '../useUndoShortcuts'

// -- Hoisted mocks (vi.mock factories are hoisted above module scope) ---------

const {
  toastMock,
  mockUndo,
  mockRedo,
  mockLoad,
  mockReplacePage,
  mockGetBlock,
  mockPageBlockRegistry,
} = vi.hoisted(() => {
  const mock: ReturnType<typeof vi.fn> & { error: ReturnType<typeof vi.fn> } = Object.assign(
    vi.fn(),
    { error: vi.fn() },
  )

  const mockUndo = vi.fn().mockResolvedValue(null)
  const mockRedo = vi.fn().mockResolvedValue(null)
  const mockLoad = vi.fn().mockResolvedValue(undefined)
  const mockReplacePage = vi.fn()
  const mockGetBlock = vi.fn().mockResolvedValue(null)

  const mockPageBlockStoreState = {
    load: mockLoad,
    rootParentId: 'PAGE_1',
  }
  const mockPageBlockRegistry = new Map()
  mockPageBlockRegistry.set('PAGE_1', { getState: () => mockPageBlockStoreState })
  mockPageBlockRegistry.set('PAGE_3', {
    getState: () => ({ ...mockPageBlockStoreState, rootParentId: 'PAGE_3' }),
  })

  return {
    toastMock: mock,
    mockUndo,
    mockRedo,
    mockLoad,
    mockReplacePage,
    mockGetBlock,
    mockPageBlockRegistry,
  }
})

// -- vi.mock calls (hoisted to top — only reference vi.hoisted vars) ----------

vi.mock('sonner', () => ({ toast: toastMock }))

vi.mock('@/stores/navigation', () => ({
  useNavigationStore: {
    getState: vi.fn(() => ({
      currentView: 'page-editor',
      pageStack: [{ pageId: 'PAGE_1', title: 'Test Page' }],
      replacePage: mockReplacePage,
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

vi.mock('@/stores/page-blocks', () => ({
  pageBlockRegistry: mockPageBlockRegistry,
}))

vi.mock('../../lib/tauri', () => ({
  getBlock: (...args: unknown[]) => mockGetBlock(...args),
}))

import { toast } from 'sonner'
import { useNavigationStore } from '@/stores/navigation'
import { useResolveStore } from '@/stores/resolve'
import { useUndoStore } from '@/stores/undo'

const mockedToast = vi.mocked(toast)
const mockedToastError = vi.mocked(toast.error)
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
  useResolveStore.setState({ cache: new Map(), pagesList: [], version: 0, _preloaded: false })

  // Reset default mock return values
  mockedNavGetState.mockReturnValue({
    currentView: 'page-editor',
    pageStack: [{ pageId: 'PAGE_1', title: 'Test Page' }],
    replacePage: mockReplacePage,
  } as unknown as ReturnType<typeof useNavigationStore.getState>)

  mockedUndoGetState.mockReturnValue({
    undo: mockUndo,
    redo: mockRedo,
  } as unknown as ReturnType<typeof useUndoStore.getState>)

  mockLoad.mockResolvedValue(undefined)
  mockGetBlock.mockResolvedValue(null)
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
      replacePage: mockReplacePage,
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
      replacePage: mockReplacePage,
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

  it('Ctrl+Shift+Z dispatches redo (Linux/Windows convention)', () => {
    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true, shiftKey: true })

    expect(mockUndo).not.toHaveBeenCalled()
    expect(mockRedo).toHaveBeenCalledWith('PAGE_1')

    unmount()
  })

  it('Ctrl+Shift+Z (uppercase key) dispatches redo', () => {
    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'Z', ctrlKey: true, shiftKey: true })

    expect(mockUndo).not.toHaveBeenCalled()
    expect(mockRedo).toHaveBeenCalledWith('PAGE_1')

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
      replacePage: mockReplacePage,
    } as unknown as ReturnType<typeof useNavigationStore.getState>)

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
  it('shows error toast when undo rejects', async () => {
    mockUndo.mockRejectedValueOnce(new Error('undo failed'))

    const { unmount } = renderHook(() => useUndoShortcuts())

    // Should not throw synchronously
    expect(() => {
      fireEvent.keyDown(document, { key: 'z', ctrlKey: true })
    }).not.toThrow()

    expect(mockUndo).toHaveBeenCalledWith('PAGE_1')

    await vi.waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Undo failed')
    })

    unmount()
  })

  it('shows error toast when redo rejects', async () => {
    mockRedo.mockRejectedValueOnce(new Error('redo failed'))

    const { unmount } = renderHook(() => useUndoShortcuts())

    expect(() => {
      fireEvent.keyDown(document, { key: 'y', ctrlKey: true })
    }).not.toThrow()

    expect(mockRedo).toHaveBeenCalledWith('PAGE_1')

    await vi.waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Redo failed')
    })

    unmount()
  })
})

describe('toast feedback', () => {
  it('shows "Undone" toast after successful undo', async () => {
    mockUndo.mockResolvedValueOnce({ type: 'undo' })

    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })

    // Wait for the promise .then() to resolve
    await vi.waitFor(() => {
      expect(mockedToast).toHaveBeenCalledWith('Undone', { duration: 1500 })
    })

    unmount()
  })

  it('does NOT show toast when undo returns null (nothing to undo)', async () => {
    mockUndo.mockResolvedValueOnce(null)

    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })

    // Give the promise time to settle
    await new Promise((r) => setTimeout(r, 10))

    expect(mockedToast).not.toHaveBeenCalled()

    unmount()
  })

  it('shows "Redone" toast after successful redo', async () => {
    mockRedo.mockResolvedValueOnce({ type: 'redo' })

    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'y', ctrlKey: true })

    await vi.waitFor(() => {
      expect(mockedToast).toHaveBeenCalledWith('Redone', { duration: 1500 })
    })

    unmount()
  })

  it('does NOT show toast when redo returns null (nothing to redo)', async () => {
    mockRedo.mockResolvedValueOnce(null)

    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'y', ctrlKey: true })

    await new Promise((r) => setTimeout(r, 10))

    expect(mockedToast).not.toHaveBeenCalled()

    unmount()
  })
})

describe('refresh after undo/redo', () => {
  it('reloads block store after successful undo', async () => {
    mockUndo.mockResolvedValueOnce({ type: 'undo' })
    mockGetBlock.mockResolvedValueOnce({ id: 'PAGE_1', content: 'Reverted Title' })

    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })

    await vi.waitFor(() => {
      expect(mockLoad).toHaveBeenCalled()
    })

    unmount()
  })

  it('updates nav store page title after successful undo', async () => {
    mockUndo.mockResolvedValueOnce({ type: 'undo' })
    mockGetBlock.mockResolvedValueOnce({ id: 'PAGE_1', content: 'Reverted Title' })

    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })

    await vi.waitFor(() => {
      expect(mockReplacePage).toHaveBeenCalledWith('PAGE_1', 'Reverted Title')
    })

    unmount()
  })

  it('reloads block store after successful redo', async () => {
    mockRedo.mockResolvedValueOnce({ type: 'redo' })
    mockGetBlock.mockResolvedValueOnce({ id: 'PAGE_1', content: 'Re-applied Title' })

    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'y', ctrlKey: true })

    await vi.waitFor(() => {
      expect(mockLoad).toHaveBeenCalled()
    })

    unmount()
  })

  it('does not reload when undo returns null', async () => {
    mockUndo.mockResolvedValueOnce(null)

    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })

    await new Promise((r) => setTimeout(r, 10))

    expect(mockLoad).not.toHaveBeenCalled()

    unmount()
  })

  it('handles getBlock failure gracefully (best-effort title refresh)', async () => {
    mockUndo.mockResolvedValueOnce({ type: 'undo' })
    mockGetBlock.mockRejectedValueOnce(new Error('not found'))

    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })

    await vi.waitFor(() => {
      expect(mockLoad).toHaveBeenCalled()
    })

    // replacePage should NOT have been called since getBlock failed
    expect(mockReplacePage).not.toHaveBeenCalled()

    unmount()
  })

  it('updates resolve cache after successful undo', async () => {
    mockUndo.mockResolvedValueOnce({ type: 'undo' })
    mockGetBlock.mockResolvedValueOnce({ id: 'PAGE_1', content: 'Reverted Title' })

    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })

    await vi.waitFor(() => {
      const entry = useResolveStore.getState().cache.get('PAGE_1')
      expect(entry).toEqual({ title: 'Reverted Title', deleted: false })
    })

    unmount()
  })

  it('does not update resolve cache when getBlock fails', async () => {
    mockUndo.mockResolvedValueOnce({ type: 'undo' })
    mockGetBlock.mockRejectedValueOnce(new Error('not found'))

    const { unmount } = renderHook(() => useUndoShortcuts())

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })

    await vi.waitFor(() => {
      expect(mockLoad).toHaveBeenCalled()
    })

    // Resolve cache should remain empty (getBlock failed, so set() was never called)
    expect(useResolveStore.getState().cache.size).toBe(0)

    unmount()
  })
})
