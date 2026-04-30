/**
 * Tests for useTrashListShortcuts — UX-275 keyboard shortcuts
 * (Shift+R restore, Shift+Delete purge, Space toggle, Ctrl+A
 * select-all, Escape clear-selection) installed at the document level.
 */

import { fireEvent, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBlock } from '../../__tests__/fixtures'
import type { BlockRow } from '../../lib/tauri'
import { useTrashListShortcuts } from '../useTrashListShortcuts'

interface Opts {
  filteredBlocks: BlockRow[]
  focusedIndex: number
  selectedSize: number
  navHandleKeyDown: (e: KeyboardEvent) => boolean
  toggleSelection: (id: string) => void
  selectAll: () => void
  clearSelection: () => void
  requestBatchRestore: () => void
  requestBatchPurge: () => void
}

const blocks: BlockRow[] = [makeBlock({ id: 'A' }), makeBlock({ id: 'B' }), makeBlock({ id: 'C' })]

function makeOpts(overrides: Partial<Opts> = {}): Opts {
  return {
    filteredBlocks: blocks,
    focusedIndex: 0,
    selectedSize: 0,
    navHandleKeyDown: vi.fn(() => false),
    toggleSelection: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    requestBatchRestore: vi.fn(),
    requestBatchPurge: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useTrashListShortcuts', () => {
  it('Shift+R fires requestBatchRestore only when selectedSize > 0', () => {
    const noSel = makeOpts({ selectedSize: 0 })
    const { rerender } = renderHook((p: Opts) => useTrashListShortcuts(p), {
      initialProps: noSel,
    })

    fireEvent.keyDown(document, { key: 'R', shiftKey: true })
    expect(noSel.requestBatchRestore).not.toHaveBeenCalled()

    const withSel = makeOpts({ selectedSize: 2 })
    rerender(withSel)

    fireEvent.keyDown(document, { key: 'R', shiftKey: true })
    expect(withSel.requestBatchRestore).toHaveBeenCalledTimes(1)
  })

  it('Shift+Delete fires requestBatchPurge only when selectedSize > 0', () => {
    const noSel = makeOpts({ selectedSize: 0 })
    const { rerender } = renderHook((p: Opts) => useTrashListShortcuts(p), {
      initialProps: noSel,
    })

    fireEvent.keyDown(document, { key: 'Delete', shiftKey: true })
    expect(noSel.requestBatchPurge).not.toHaveBeenCalled()

    const withSel = makeOpts({ selectedSize: 1 })
    rerender(withSel)

    fireEvent.keyDown(document, { key: 'Delete', shiftKey: true })
    expect(withSel.requestBatchPurge).toHaveBeenCalledTimes(1)
  })

  it('Space toggles the focused block via toggleSelection', () => {
    const opts = makeOpts({ focusedIndex: 1 })
    renderHook(() => useTrashListShortcuts(opts))

    fireEvent.keyDown(document, { key: ' ' })

    expect(opts.toggleSelection).toHaveBeenCalledTimes(1)
    expect(opts.toggleSelection).toHaveBeenCalledWith('B')
  })

  it('Ctrl+A fires selectAll', () => {
    const opts = makeOpts()
    renderHook(() => useTrashListShortcuts(opts))

    fireEvent.keyDown(document, { key: 'a', ctrlKey: true })

    expect(opts.selectAll).toHaveBeenCalledTimes(1)
  })

  it('Escape fires clearSelection only when selection is non-empty', () => {
    const noSel = makeOpts({ selectedSize: 0 })
    const { rerender } = renderHook((p: Opts) => useTrashListShortcuts(p), {
      initialProps: noSel,
    })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(noSel.clearSelection).not.toHaveBeenCalled()

    const withSel = makeOpts({ selectedSize: 3 })
    rerender(withSel)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(withSel.clearSelection).toHaveBeenCalledTimes(1)
  })
})
