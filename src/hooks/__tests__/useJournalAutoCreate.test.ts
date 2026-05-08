import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useJournalAutoCreate } from '../useJournalAutoCreate'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  // BUG-48: the hook now probes `get_journal_page_by_date` instead of
  // checking an in-memory pageMap. Default to "no page exists" so the
  // existing auto-create assertions still hold without per-test setup.
  mockedInvoke.mockResolvedValue(null)
})

function makeOptions(overrides: Partial<Parameters<typeof useJournalAutoCreate>[0]> = {}) {
  return {
    loading: false,
    mode: 'daily',
    currentDate: new Date(2025, 5, 15),
    spaceId: 'SPACE_TEST',
    createdPages: new Map<string, string>(),
    handleAddBlock: vi.fn(),
    ...overrides,
  }
}

describe('useJournalAutoCreate', () => {
  it('auto-creates page on mount in daily mode when no page exists', async () => {
    const opts = makeOptions()
    renderHook(() => useJournalAutoCreate(opts))
    await waitFor(() => {
      expect(opts.handleAddBlock).toHaveBeenCalledWith('2025-06-15')
    })
  })

  it('does not auto-create when loading is true', async () => {
    const opts = makeOptions({ loading: true })
    renderHook(() => useJournalAutoCreate(opts))
    await Promise.resolve()
    expect(opts.handleAddBlock).not.toHaveBeenCalled()
  })

  it('does not auto-create when mode is not daily', async () => {
    const opts = makeOptions({ mode: 'weekly' })
    renderHook(() => useJournalAutoCreate(opts))
    await Promise.resolve()
    expect(opts.handleAddBlock).not.toHaveBeenCalled()
  })

  it('does not auto-create when get_journal_page_by_date returns an existing page', async () => {
    mockedInvoke.mockResolvedValue({ id: 'EXISTING', block_type: 'page', content: '2025-06-15' })
    const opts = makeOptions()
    renderHook(() => useJournalAutoCreate(opts))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'get_journal_page_by_date',
        expect.objectContaining({ date: '2025-06-15', spaceId: 'SPACE_TEST' }),
      )
    })

    // The probe resolved synchronously after the microtask flush above;
    // give the .then() callback a chance to run before asserting absence.
    await Promise.resolve()
    expect(opts.handleAddBlock).not.toHaveBeenCalled()
  })

  it('does not auto-create when page already exists in createdPages (skips probe)', async () => {
    const opts = makeOptions({
      createdPages: new Map([['2025-06-15', 'created-page-id']]),
    })
    renderHook(() => useJournalAutoCreate(opts))
    await Promise.resolve()
    expect(opts.handleAddBlock).not.toHaveBeenCalled()
    // The createdPages short-circuit fires before the IPC probe.
    const probes = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_journal_page_by_date')
    expect(probes).toHaveLength(0)
  })

  it('does not auto-create the same date twice', async () => {
    const opts = makeOptions()
    const { rerender } = renderHook(() => useJournalAutoCreate(opts))

    await waitFor(() => {
      expect(opts.handleAddBlock).toHaveBeenCalledTimes(1)
    })

    rerender()
    await Promise.resolve()

    expect(opts.handleAddBlock).toHaveBeenCalledTimes(1)
  })

  it('auto-creates when date changes', async () => {
    const handleAddBlock = vi.fn()
    const opts1 = makeOptions({ handleAddBlock, currentDate: new Date(2025, 5, 15) })

    const { rerender } = renderHook(({ opts }) => useJournalAutoCreate(opts), {
      initialProps: { opts: opts1 },
    })

    await waitFor(() => {
      expect(handleAddBlock).toHaveBeenCalledWith('2025-06-15')
    })

    const opts2 = makeOptions({ handleAddBlock, currentDate: new Date(2025, 5, 16) })
    rerender({ opts: opts2 })

    await waitFor(() => {
      expect(handleAddBlock).toHaveBeenCalledWith('2025-06-16')
    })
    expect(handleAddBlock).toHaveBeenCalledTimes(2)
  })

  it('registers Enter keyboard shortcut in daily mode when no page exists', async () => {
    const opts = makeOptions()
    renderHook(() => useJournalAutoCreate(opts))

    await waitFor(() => {
      expect(opts.handleAddBlock).toHaveBeenCalledWith('2025-06-15')
    })
    vi.mocked(opts.handleAddBlock).mockClear()

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      document.dispatchEvent(event)
    })

    await waitFor(() => {
      expect(opts.handleAddBlock).toHaveBeenCalledWith('2025-06-15')
    })
  })

  it('registers n keyboard shortcut in daily mode when no page exists', async () => {
    const opts = makeOptions()
    renderHook(() => useJournalAutoCreate(opts))

    await waitFor(() => {
      expect(opts.handleAddBlock).toHaveBeenCalledWith('2025-06-15')
    })
    vi.mocked(opts.handleAddBlock).mockClear()

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'n', bubbles: true })
      document.dispatchEvent(event)
    })

    await waitFor(() => {
      expect(opts.handleAddBlock).toHaveBeenCalledWith('2025-06-15')
    })
  })

  it('does not trigger shortcut when mode is not daily', async () => {
    const opts = makeOptions({ mode: 'weekly' })
    renderHook(() => useJournalAutoCreate(opts))

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'n', bubbles: true })
      document.dispatchEvent(event)
    })

    await Promise.resolve()
    expect(opts.handleAddBlock).not.toHaveBeenCalled()
  })

  it('does not trigger shortcut when probe reports an existing page', async () => {
    // Existing-page probe response — both the mount-effect probe and the
    // shortcut-driven probe see this answer.
    mockedInvoke.mockResolvedValue({ id: 'EXISTING', block_type: 'page', content: '2025-06-15' })
    const opts = makeOptions()
    renderHook(() => useJournalAutoCreate(opts))

    // Wait for mount probe to settle so we know the existing-page branch
    // is in effect before dispatching the keypress.
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalled()
    })
    await Promise.resolve()

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'n', bubbles: true })
      document.dispatchEvent(event)
    })

    // Allow the shortcut probe's .then() to run.
    await Promise.resolve()
    await Promise.resolve()
    expect(opts.handleAddBlock).not.toHaveBeenCalled()
  })

  it('does not trigger shortcut when target is a contenteditable', async () => {
    const opts = makeOptions()
    renderHook(() => useJournalAutoCreate(opts))

    await waitFor(() => {
      expect(opts.handleAddBlock).toHaveBeenCalledWith('2025-06-15')
    })
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

    await Promise.resolve()
    expect(opts.handleAddBlock).not.toHaveBeenCalled()
    document.body.removeChild(editable)
  })

  it('does not trigger shortcut when target is an input', async () => {
    const opts = makeOptions()
    renderHook(() => useJournalAutoCreate(opts))

    await waitFor(() => {
      expect(opts.handleAddBlock).toHaveBeenCalledWith('2025-06-15')
    })
    vi.mocked(opts.handleAddBlock).mockClear()

    const input = document.createElement('input')
    document.body.appendChild(input)

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }))
    })

    await Promise.resolve()
    expect(opts.handleAddBlock).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  it('cleans up keyboard listener on unmount', async () => {
    const spy = vi.fn()
    const opts = makeOptions({ handleAddBlock: spy })
    const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener')
    const { unmount } = renderHook(() => useJournalAutoCreate(opts))

    // Hook auto-creates on mount; wait, then clear so we only observe
    // post-unmount calls.
    await waitFor(() => {
      expect(spy).toHaveBeenCalled()
    })
    spy.mockClear()

    unmount()

    expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function))

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'n', bubbles: true })
      document.dispatchEvent(event)
    })

    await Promise.resolve()
    expect(spy).not.toHaveBeenCalled()
    removeEventListenerSpy.mockRestore()
  })
})
