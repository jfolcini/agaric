/**
 * Tests for useTrashMultiSelect.
 *
 * Validates that the wrapper exposes TrashView-named outputs over
 * useListMultiSelect (toggle, select-all, clear, row-click) and that
 * pagination resets selection (forwarded from the underlying hook).
 */

import { act, renderHook } from '@testing-library/react'
import type React from 'react'
import { describe, expect, it } from 'vitest'
import { makeBlock } from '../../__tests__/fixtures'
import type { BlockRow } from '../../lib/tauri'
import { useTrashMultiSelect } from '../useTrashMultiSelect'

const blocks: BlockRow[] = [
  makeBlock({ id: 'A' }),
  makeBlock({ id: 'B' }),
  makeBlock({ id: 'C' }),
  makeBlock({ id: 'D' }),
]

/** Build a minimal MouseEvent stand-in for handleRowClick. */
function makeClick(shiftKey = false): React.MouseEvent {
  return { shiftKey, ctrlKey: false, metaKey: false } as React.MouseEvent
}

describe('useTrashMultiSelect', () => {
  it('toggleSelection adds/removes an id', () => {
    const { result } = renderHook(() => useTrashMultiSelect({ items: blocks }))

    act(() => result.current.toggleSelection('A'))
    expect(result.current.selected.has('A')).toBe(true)
    expect(result.current.selected.size).toBe(1)

    act(() => result.current.toggleSelection('A'))
    expect(result.current.selected.has('A')).toBe(false)
  })

  it('selectAll selects every block, clearSelection empties', () => {
    const { result } = renderHook(() => useTrashMultiSelect({ items: blocks }))

    act(() => result.current.selectAll())
    expect(result.current.selected.size).toBe(blocks.length)
    for (const b of blocks) expect(result.current.selected.has(b.id)).toBe(true)

    act(() => result.current.clearSelection())
    expect(result.current.selected.size).toBe(0)
  })

  it('handleRowClick toggles a single id when shift is not held', () => {
    const { result } = renderHook(() => useTrashMultiSelect({ items: blocks }))

    act(() => result.current.handleRowClick('A', makeClick(false)))
    expect(result.current.selected.has('A')).toBe(true)
    expect(result.current.selected.size).toBe(1)
  })

  it('handleRowClick + shift extends the selection to a range', () => {
    const { result } = renderHook(() => useTrashMultiSelect({ items: blocks }))

    act(() => result.current.handleRowClick('A', makeClick(false)))
    act(() => result.current.handleRowClick('C', makeClick(true)))

    expect(result.current.selected.has('A')).toBe(true)
    expect(result.current.selected.has('B')).toBe(true)
    expect(result.current.selected.has('C')).toBe(true)
    expect(result.current.selected.has('D')).toBe(false)
  })

  it('items length change resets selection (pagination guard)', () => {
    const { result, rerender } = renderHook(
      ({ items }: { items: BlockRow[] }) => useTrashMultiSelect({ items }),
      { initialProps: { items: blocks } },
    )

    act(() => result.current.toggleSelection('A'))
    expect(result.current.selected.size).toBe(1)

    rerender({ items: [makeBlock({ id: 'X' }), makeBlock({ id: 'Y' })] })
    expect(result.current.selected.size).toBe(0)
  })
})
