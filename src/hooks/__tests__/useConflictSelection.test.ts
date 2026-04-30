/**
 * Tests for useConflictSelection.
 *
 * Validates that the wrapper exposes ConflictList-named outputs over
 * useListMultiSelect (toggle, range, select-all, clear) and that
 * pagination resets selection (forwarded from the underlying hook).
 */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { makeConflict } from '../../__tests__/fixtures'
import type { BlockRow } from '../../lib/tauri'
import { useConflictSelection } from '../useConflictSelection'

const blocks: BlockRow[] = [
  makeConflict({ id: 'A' }),
  makeConflict({ id: 'B' }),
  makeConflict({ id: 'C' }),
  makeConflict({ id: 'D' }),
]

describe('useConflictSelection', () => {
  it('toggleSelected adds/removes an id', () => {
    const { result } = renderHook(() => useConflictSelection({ blocks }))

    act(() => result.current.toggleSelected('A'))
    expect(result.current.selectedIds.has('A')).toBe(true)
    expect(result.current.selectedIds.size).toBe(1)

    act(() => result.current.toggleSelected('A'))
    expect(result.current.selectedIds.has('A')).toBe(false)
  })

  it('selectAll selects every block', () => {
    const { result } = renderHook(() => useConflictSelection({ blocks }))

    act(() => result.current.selectAll())
    expect(result.current.selectedIds.size).toBe(blocks.length)
    for (const b of blocks) expect(result.current.selectedIds.has(b.id)).toBe(true)
  })

  it('clearSelection empties the set', () => {
    const { result } = renderHook(() => useConflictSelection({ blocks }))

    act(() => result.current.selectAll())
    expect(result.current.selectedIds.size).toBe(blocks.length)

    act(() => result.current.clearSelection())
    expect(result.current.selectedIds.size).toBe(0)
  })

  it('selectRange with targetState=true adds the inclusive range', () => {
    const { result } = renderHook(() => useConflictSelection({ blocks }))

    // Anchor by toggling 'A'
    act(() => result.current.toggleSelected('A'))
    act(() => result.current.selectRange('C', true))

    expect(result.current.selectedIds.has('A')).toBe(true)
    expect(result.current.selectedIds.has('B')).toBe(true)
    expect(result.current.selectedIds.has('C')).toBe(true)
    expect(result.current.selectedIds.has('D')).toBe(false)
  })

  it('blocks length change resets selection (pagination guard)', () => {
    const { result, rerender } = renderHook(
      ({ items }: { items: BlockRow[] }) => useConflictSelection({ blocks: items }),
      { initialProps: { items: blocks } },
    )

    act(() => result.current.toggleSelected('A'))
    expect(result.current.selectedIds.size).toBe(1)

    rerender({ items: [makeConflict({ id: 'X' }), makeConflict({ id: 'Y' })] })
    expect(result.current.selectedIds.size).toBe(0)
  })
})
