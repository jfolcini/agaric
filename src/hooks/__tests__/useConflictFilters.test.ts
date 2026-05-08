/**
 * Tests for useConflictFilters.
 *
 * Validates the type/device/date filter state, derivations
 * (uniqueDeviceNames), and the filteredBlocks memo extracted from
 * ConflictList.tsx (MAINT-128).
 *
 * PEND-35 Tier 1.4 — type + date filters no longer narrow
 * `filteredBlocks` in memory; the hook now exposes them as the
 * `conflictType` / `idMin` SQL parameters that ConflictList forwards
 * to `getConflicts`. Only the device filter still runs FE-side. The
 * tests below cover both the new SQL-param contract and the surviving
 * device-filter / dropdown-options logic.
 */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { makeConflict } from '../../__tests__/fixtures'
import { ulidToDate } from '../../lib/format'
import type { BlockRow } from '../../lib/tauri'
import { useConflictFilters } from '../useConflictFilters'

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
    // PEND-35 Tier 1.4: SQL params are undefined by default.
    expect(result.current.conflictType).toBeUndefined()
    expect(result.current.idMin).toBeUndefined()
  })

  it('typeFilter exposes conflictType for the SQL backend (no FE filtering)', () => {
    // PEND-35 Tier 1.4 — selecting a type sets `conflictType` so
    // ConflictList can refetch from the backend with the filter
    // applied; the hook no longer narrows the in-memory list.
    const blocks: BlockRow[] = [
      makeConflict({ id: 'A', conflict_type: null }),
      makeConflict({ id: 'B', conflict_type: 'Property' }),
      makeConflict({ id: 'C', conflict_type: 'Move' }),
    ]
    const { result } = renderHook(() => useConflictFilters({ blocks, deviceNames: new Map() }))

    act(() => result.current.setTypeFilter('Move'))
    expect(result.current.conflictType).toBe('Move')
    // FE-side list is unchanged — backend will filter on the next refetch.
    expect(result.current.filteredBlocks).toHaveLength(3)

    act(() => result.current.setTypeFilter('Property'))
    expect(result.current.conflictType).toBe('Property')

    act(() => result.current.setTypeFilter('all'))
    expect(result.current.conflictType).toBeUndefined()
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

  it('dateFilter "last7Days" exposes idMin (a ULID 7d ago) for the backend', () => {
    // PEND-35 Tier 1.4 — selecting "last7Days" produces a ULID lower
    // bound; the backend uses it as `id_min` so cursor pagination
    // narrows correctly. The hook no longer drops "old" rows in
    // memory.
    const blocks: BlockRow[] = [
      makeConflict({ id: 'AAAAAAAAAAAAAAAAAAAAAAAAAA' }),
      makeConflict({ id: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ' }),
    ]
    const { result } = renderHook(() => useConflictFilters({ blocks, deviceNames: new Map() }))

    expect(result.current.idMin).toBeUndefined()

    act(() => result.current.setDateFilter('last7Days'))
    const idMin = result.current.idMin
    expect(idMin).toBeDefined()
    expect(idMin).toMatch(/^[0-9A-Z]{10}0{16}$/)
    // The cutoff must decode to roughly 7 days before now (allow ±1d
    // for clock drift + test runtime). We decode via the existing
    // `ulidToDate` helper to avoid duplicating the codec inline.
    const decoded = ulidToDate(idMin as string)
    expect(decoded).not.toBeNull()
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    expect(Math.abs((decoded as Date).getTime() - sevenDaysAgo)).toBeLessThan(24 * 60 * 60 * 1000)

    // FE-side `filteredBlocks` stays full; the backend handles the cut.
    expect(result.current.filteredBlocks).toHaveLength(2)

    act(() => result.current.setDateFilter('all'))
    expect(result.current.idMin).toBeUndefined()
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

  it('combining type + device filter only narrows by device FE-side', () => {
    // PEND-35 Tier 1.4 — type narrows on the backend; device still
    // narrows in memory. So `filteredBlocks` reflects only the
    // device cut, while `conflictType` carries the SQL-side request.
    const blocks: BlockRow[] = [
      makeConflict({ id: 'A', conflict_type: null }), // Phone (Text)
      makeConflict({ id: 'B', conflict_type: 'Move' }), // Phone (Move)
      makeConflict({ id: 'C', conflict_type: 'Move' }), // Laptop (Move)
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

    expect(result.current.conflictType).toBe('Move')
    expect(result.current.filteredBlocks.map((b) => b.id)).toEqual(['A', 'B'])
  })
})
