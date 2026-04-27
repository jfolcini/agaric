import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useJournalAutoCreate } from '../useJournalAutoCreate'

beforeEach(() => {
  vi.clearAllMocks()
})

function makeOptions(overrides: Partial<Parameters<typeof useJournalAutoCreate>[0]> = {}) {
  return {
    loading: false,
    mode: 'daily',
    currentDate: new Date(2025, 5, 15),
    pageMap: new Map<string, string>(),
    createdPages: new Map<string, string>(),
    handleAddBlock: vi.fn(),
    ...overrides,
  }
}

describe('useJournalAutoCreate', () => {
  it('auto-creates page on mount in daily mode when no page exists', () => {
    const opts = makeOptions()
    renderHook(() => useJournalAutoCreate(opts))
    expect(opts.handleAddBlock).toHaveBeenCalledWith('2025-06-15')
  })

  it('does not auto-create when loading is true', () => {
    const opts = makeOptions({ loading: true })
    renderHook(() => useJournalAutoCreate(opts))
    expect(opts.handleAddBlock).not.toHaveBeenCalled()
  })

  it('does not auto-create when mode is not daily', () => {
    const opts = makeOptions({ mode: 'weekly' })
    renderHook(() => useJournalAutoCreate(opts))
    expect(opts.handleAddBlock).not.toHaveBeenCalled()
  })

  it('does not auto-create when page already exists in pageMap', () => {
    const opts = makeOptions({
      pageMap: new Map([['2025-06-15', 'existing-page-id']]),
    })
    renderHook(() => useJournalAutoCreate(opts))
    expect(opts.handleAddBlock).not.toHaveBeenCalled()
  })

  it('does not auto-create when page already exists in createdPages', () => {
    const opts = makeOptions({
      createdPages: new Map([['2025-06-15', 'created-page-id']]),
    })
    renderHook(() => useJournalAutoCreate(opts))
    expect(opts.handleAddBlock).not.toHaveBeenCalled()
  })

  it('does not auto-create the same date twice', () => {
    const opts = makeOptions()
    const { rerender } = renderHook(() => useJournalAutoCreate(opts))

    expect(opts.handleAddBlock).toHaveBeenCalledTimes(1)

    rerender()

    expect(opts.handleAddBlock).toHaveBeenCalledTimes(1)
  })

  it('auto-creates when date changes', () => {
    const handleAddBlock = vi.fn()
    const opts1 = makeOptions({ handleAddBlock, currentDate: new Date(2025, 5, 15) })

    const { rerender } = renderHook(({ opts }) => useJournalAutoCreate(opts), {
      initialProps: { opts: opts1 },
    })

    expect(handleAddBlock).toHaveBeenCalledWith('2025-06-15')

    const opts2 = makeOptions({ handleAddBlock, currentDate: new Date(2025, 5, 16) })
    rerender({ opts: opts2 })

    expect(handleAddBlock).toHaveBeenCalledWith('2025-06-16')
    expect(handleAddBlock).toHaveBeenCalledTimes(2)
  })

  it('registers Enter keyboard shortcut in daily mode when no page exists', () => {
    const opts = makeOptions()
    renderHook(() => useJournalAutoCreate(opts))

    vi.mocked(opts.handleAddBlock).mockClear()

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      document.dispatchEvent(event)
    })

    expect(opts.handleAddBlock).toHaveBeenCalledWith('2025-06-15')
  })

  it('registers n keyboard shortcut in daily mode when no page exists', () => {
    const opts = makeOptions()
    renderHook(() => useJournalAutoCreate(opts))

    vi.mocked(opts.handleAddBlock).mockClear()

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'n', bubbles: true })
      document.dispatchEvent(event)
    })

    expect(opts.handleAddBlock).toHaveBeenCalledWith('2025-06-15')
  })

  it('does not trigger shortcut when mode is not daily', () => {
    const opts = makeOptions({ mode: 'weekly' })
    renderHook(() => useJournalAutoCreate(opts))

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'n', bubbles: true })
      document.dispatchEvent(event)
    })

    expect(opts.handleAddBlock).not.toHaveBeenCalled()
  })

  it('does not trigger shortcut when page already exists', () => {
    const opts = makeOptions({
      pageMap: new Map([['2025-06-15', 'p1']]),
    })
    renderHook(() => useJournalAutoCreate(opts))

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'n', bubbles: true })
      document.dispatchEvent(event)
    })

    expect(opts.handleAddBlock).not.toHaveBeenCalled()
  })

  it('does not trigger shortcut when target is a contenteditable', () => {
    const opts = makeOptions()
    renderHook(() => useJournalAutoCreate(opts))

    vi.mocked(opts.handleAddBlock).mockClear()

    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    Object.defineProperty(editable, 'isContentEditable', {
      value: true,
      configurable: true,
    })
    document.body.appendChild(editable)

    act(() => {
      editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }))
    })

    expect(opts.handleAddBlock).not.toHaveBeenCalled()
    document.body.removeChild(editable)
  })

  it('does not trigger shortcut when target is an input', () => {
    const opts = makeOptions()
    renderHook(() => useJournalAutoCreate(opts))

    vi.mocked(opts.handleAddBlock).mockClear()

    const input = document.createElement('input')
    document.body.appendChild(input)

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }))
    })

    expect(opts.handleAddBlock).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  it('cleans up keyboard listener on unmount', () => {
    const spy = vi.fn()
    const opts = makeOptions({ pageMap: new Map(), handleAddBlock: spy })
    const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener')
    const { unmount } = renderHook(() => useJournalAutoCreate(opts))

    // Hook auto-creates on mount; clear so we only observe post-unmount calls.
    spy.mockClear()

    unmount()

    expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function))

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'n', bubbles: true })
      document.dispatchEvent(event)
    })

    expect(spy).not.toHaveBeenCalled()
    removeEventListenerSpy.mockRestore()
  })
})
