/**
 * Tests for useHistorySelection — wraps useListMultiSelect with
 * HistoryEntry-specific keying, non-reversible filtering, and the
 * `getSelectedEntries()` helper that materialises the selected
 * HistoryEntry[] sorted newest-first for the revert IPC.
 */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../../lib/tauri'
import { entryKey, useHistorySelection } from '../useHistorySelection'

function makeEntry(
  seq: number,
  opType: string,
  createdAt: string,
  deviceId = 'DEVICE01',
): HistoryEntry {
  return {
    device_id: deviceId,
    seq,
    op_type: opType,
    payload: '{}',
    created_at: createdAt,
  }
}

describe('useHistorySelection', () => {
  it('starts with an empty selection', () => {
    const e0 = makeEntry(1, 'edit_block', '2025-01-15T12:00:00Z')
    const { result } = renderHook(() => useHistorySelection([e0]))
    expect(result.current.selectedIds.size).toBe(0)
    expect(result.current.getSelectedEntries()).toEqual([])
  })

  it('toggleSelectedIndex selects then deselects the entry at the given row', () => {
    const e0 = makeEntry(1, 'edit_block', '2025-01-15T12:00:00Z')
    const e1 = makeEntry(2, 'create_block', '2025-01-15T11:00:00Z')
    const { result } = renderHook(() => useHistorySelection([e0, e1]))

    act(() => {
      result.current.toggleSelectedIndex(1)
    })
    expect(result.current.selectedIds.has(entryKey(e1))).toBe(true)

    act(() => {
      result.current.toggleSelectedIndex(1)
    })
    expect(result.current.selectedIds.has(entryKey(e1))).toBe(false)
  })

  it('selectAll selects every reversible entry but skips non-reversible ones', () => {
    const e0 = makeEntry(1, 'edit_block', '2025-01-15T12:00:00Z')
    const e1 = makeEntry(2, 'purge_block', '2025-01-15T11:00:00Z')
    const e2 = makeEntry(3, 'delete_attachment', '2025-01-15T10:00:00Z')
    const e3 = makeEntry(4, 'create_block', '2025-01-15T09:00:00Z')
    const { result } = renderHook(() => useHistorySelection([e0, e1, e2, e3]))

    act(() => {
      result.current.selectAll()
    })

    expect(result.current.selectedIds.size).toBe(2)
    expect(result.current.selectedIds.has(entryKey(e0))).toBe(true)
    expect(result.current.selectedIds.has(entryKey(e1))).toBe(false)
    expect(result.current.selectedIds.has(entryKey(e2))).toBe(false)
    expect(result.current.selectedIds.has(entryKey(e3))).toBe(true)
  })

  it('clearSelection empties the selection', () => {
    const e0 = makeEntry(1, 'edit_block', '2025-01-15T12:00:00Z')
    const e1 = makeEntry(2, 'create_block', '2025-01-15T11:00:00Z')
    const e2 = makeEntry(3, 'edit_block', '2025-01-15T10:00:00Z')
    const { result } = renderHook(() => useHistorySelection([e0, e1, e2]))

    act(() => {
      result.current.selectAll()
    })
    expect(result.current.selectedIds.size).toBe(3)

    act(() => {
      result.current.clearSelection()
    })
    expect(result.current.selectedIds.size).toBe(0)
  })

  it('getSelectedEntries returns selected entries sorted newest-first', () => {
    const newest = makeEntry(1, 'edit_block', '2025-01-15T12:00:00Z')
    const middle = makeEntry(2, 'create_block', '2025-01-15T11:00:00Z')
    const oldest = makeEntry(3, 'edit_block', '2025-01-15T10:00:00Z')
    const { result } = renderHook(() => useHistorySelection([newest, middle, oldest]))

    act(() => {
      // Select oldest first, then newest — order of selection should
      // not affect the returned order.
      result.current.toggleSelectedIndex(2)
      result.current.toggleSelectedIndex(0)
    })

    const selected = result.current.getSelectedEntries()
    expect(selected).toHaveLength(2)
    expect(selected[0]?.seq).toBe(newest.seq)
    expect(selected[1]?.seq).toBe(oldest.seq)
  })

  it('handleRowClick with shift extends the selection range, skipping non-reversible rows', () => {
    const e0 = makeEntry(1, 'edit_block', '2025-01-15T12:00:00Z')
    const e1 = makeEntry(2, 'purge_block', '2025-01-15T11:00:00Z') // skipped
    const e2 = makeEntry(3, 'edit_block', '2025-01-15T10:00:00Z')
    const { result } = renderHook(() => useHistorySelection([e0, e1, e2]))

    act(() => {
      // First click anchors at row 0 (no shift = simple toggle).
      result.current.handleRowClick(0, { shiftKey: false } as unknown as React.MouseEvent)
    })
    expect(result.current.selectedIds.size).toBe(1)

    act(() => {
      // Shift-click row 2 — selects 0..2, skipping the non-reversible row 1.
      result.current.handleRowClick(2, { shiftKey: true } as unknown as React.MouseEvent)
    })

    expect(result.current.selectedIds.size).toBe(2)
    expect(result.current.selectedIds.has(entryKey(e0))).toBe(true)
    expect(result.current.selectedIds.has(entryKey(e1))).toBe(false)
    expect(result.current.selectedIds.has(entryKey(e2))).toBe(true)
  })

  it('toggleSelectedIndex on a non-reversible row is a no-op', () => {
    const e0 = makeEntry(1, 'purge_block', '2025-01-15T12:00:00Z')
    const e1 = makeEntry(2, 'delete_attachment', '2025-01-15T11:00:00Z')
    const { result } = renderHook(() => useHistorySelection([e0, e1]))

    act(() => {
      result.current.toggleSelectedIndex(0)
      result.current.toggleSelectedIndex(1)
    })

    expect(result.current.selectedIds.size).toBe(0)
  })
})

describe('entryKey', () => {
  it('encodes device_id and seq', () => {
    expect(entryKey(makeEntry(42, 'edit_block', '2025-01-15T12:00:00Z', 'DEV2'))).toBe('DEV2:42')
  })
})
