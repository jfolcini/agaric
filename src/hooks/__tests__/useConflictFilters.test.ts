/**
 * Tests for useConflictFilters.
 *
 * Validates the type/device/date filter state, derivations
 * (uniqueDeviceNames), and the filteredBlocks memo extracted from
 * ConflictList.tsx (MAINT-128).
 */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { makeConflict } from '../../__tests__/fixtures'
import type { BlockRow } from '../../lib/tauri'
import { useConflictFilters } from '../useConflictFilters'

/** Generate a valid ULID for the given timestamp (ms since epoch). */
function makeUlid(timestampMs: number): string {
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let ts = timestampMs
  const chars: string[] = []
  for (let i = 0; i < 10; i++) {
    chars.unshift(CROCKFORD[ts % 32] as string)
    ts = Math.floor(ts / 32)
  }
  return `${chars.join('')}AAAAAAAAAAAAAAAA`
}

describe('useConflictFilters', () => {
  it('returns full list when every filter is "all"', () => {
    const blocks: BlockRow[] = [
      makeConflict({ id: 'A', conflict_type: null }),
      makeConflict({ id: 'B', conflict_type: 'Property' }),
      makeConflict({ id: 'C', conflict_type: 'Move' }),
    ]
    const { result } = renderHook(() => useConflictFilters({ blocks, deviceNames: new Map() }))

    expect(result.current.filteredBlocks).toHaveLength(3)
    expect(result.current.typeFilter).toBe('all')
    expect(result.current.deviceFilter).toBe('all')
    expect(result.current.dateFilter).toBe('all')
  })

  it('typeFilter narrows to matching conflict type', () => {
    const blocks: BlockRow[] = [
      makeConflict({ id: 'A', conflict_type: null }), // Text
      makeConflict({ id: 'B', conflict_type: 'Property' }),
      makeConflict({ id: 'C', conflict_type: 'Move' }),
    ]
    const { result } = renderHook(() => useConflictFilters({ blocks, deviceNames: new Map() }))

    act(() => result.current.setTypeFilter('Move'))
    expect(result.current.filteredBlocks).toHaveLength(1)
    expect(result.current.filteredBlocks[0]?.id).toBe('C')

    act(() => result.current.setTypeFilter('Text'))
    expect(result.current.filteredBlocks).toHaveLength(1)
    expect(result.current.filteredBlocks[0]?.id).toBe('A')
  })

  it('deviceFilter narrows to matching device name', () => {
    const blocks: BlockRow[] = [
      makeConflict({ id: 'A' }),
      makeConflict({ id: 'B' }),
      makeConflict({ id: 'C' }),
    ]
    const deviceNames = new Map<string, string>([
      ['A', 'Phone'],
      ['B', 'Laptop'],
      ['C', 'Phone'],
    ])
    const { result } = renderHook(() => useConflictFilters({ blocks, deviceNames }))

    act(() => result.current.setDeviceFilter('Phone'))
    expect(result.current.filteredBlocks.map((b) => b.id)).toEqual(['A', 'C'])
  })

  it('dateFilter "last7Days" excludes ULIDs older than 7 days', () => {
    const now = Date.now()
    const recent = makeUlid(now - 24 * 60 * 60 * 1000) // 1 day ago
    const old = makeUlid(now - 30 * 24 * 60 * 60 * 1000) // 30 days ago
    const blocks: BlockRow[] = [
      makeConflict({ id: recent, content: 'recent' }),
      makeConflict({ id: old, content: 'old' }),
    ]
    const { result } = renderHook(() => useConflictFilters({ blocks, deviceNames: new Map() }))

    act(() => result.current.setDateFilter('last7Days'))
    expect(result.current.filteredBlocks).toHaveLength(1)
    expect(result.current.filteredBlocks[0]?.content).toBe('recent')
  })

  it('uniqueDeviceNames returns sorted distinct names', () => {
    const deviceNames = new Map<string, string>([
      ['A', 'Phone'],
      ['B', 'Laptop'],
      ['C', 'Phone'],
      ['D', 'Tablet'],
    ])
    const { result } = renderHook(() => useConflictFilters({ blocks: [], deviceNames }))

    expect(result.current.uniqueDeviceNames).toEqual(['Laptop', 'Phone', 'Tablet'])
  })

  it('combines type + device filters', () => {
    const blocks: BlockRow[] = [
      makeConflict({ id: 'A', conflict_type: null }), // Text/Phone
      makeConflict({ id: 'B', conflict_type: 'Move' }), // Move/Phone
      makeConflict({ id: 'C', conflict_type: 'Move' }), // Move/Laptop
    ]
    const deviceNames = new Map<string, string>([
      ['A', 'Phone'],
      ['B', 'Phone'],
      ['C', 'Laptop'],
    ])
    const { result } = renderHook(() => useConflictFilters({ blocks, deviceNames }))

    act(() => {
      result.current.setTypeFilter('Move')
      result.current.setDeviceFilter('Phone')
    })

    expect(result.current.filteredBlocks).toHaveLength(1)
    expect(result.current.filteredBlocks[0]?.id).toBe('B')
  })
})
