/**
 * useConflictFilters — UX-265 filter-bar state for ConflictList.
 *
 * Owns the three filter dropdowns (type / device / date) plus the
 * `filteredBlocks` memo and the `uniqueDeviceNames` derivation that the
 * filter dropdown options depend on. Extracted from ConflictList.tsx
 * (MAINT-128) so the orchestrator stays focused on data fetching and
 * dialog wiring.
 */

import { useMemo, useState } from 'react'
import { inferConflictType } from '../components/ConflictListItem'
import { ulidToDate } from '../lib/format'
import type { BlockRow } from '../lib/tauri'

/** Available conflict-type filter values, mapped to ConflictListItem's inferred types. */
export type TypeFilter = 'all' | 'Text' | 'Property' | 'Move'
/** Available date-range filter values. UX-265 keeps the range coarse to stay in scope. */
export type DateFilter = 'all' | 'last7Days'
/** 7 days in milliseconds — used for the "last 7 days" cutoff. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export interface UseConflictFiltersOptions {
  blocks: BlockRow[]
  deviceNames: Map<string, string>
}

export interface UseConflictFiltersReturn {
  typeFilter: TypeFilter
  setTypeFilter: (v: TypeFilter) => void
  deviceFilter: string
  setDeviceFilter: (v: string) => void
  dateFilter: DateFilter
  setDateFilter: (v: DateFilter) => void
  uniqueDeviceNames: string[]
  filteredBlocks: BlockRow[]
}

export function useConflictFilters({
  blocks,
  deviceNames,
}: UseConflictFiltersOptions): UseConflictFiltersReturn {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [deviceFilter, setDeviceFilter] = useState<string>('all')
  const [dateFilter, setDateFilter] = useState<DateFilter>('all')

  // Unique device names available for the device filter dropdown.
  const uniqueDeviceNames = useMemo(() => {
    const set = new Set<string>()
    for (const name of deviceNames.values()) set.add(name)
    return [...set].sort()
  }, [deviceNames])

  // Apply filters to the conflict list. Falls back to full list when every
  // filter is "all" (the default), so existing behaviour is preserved.
  const filteredBlocks = useMemo(() => {
    if (typeFilter === 'all' && deviceFilter === 'all' && dateFilter === 'all') return blocks
    const cutoff = dateFilter === 'last7Days' ? Date.now() - SEVEN_DAYS_MS : null
    return blocks.filter((block) => {
      if (typeFilter !== 'all' && inferConflictType(block) !== typeFilter) return false
      if (deviceFilter !== 'all') {
        const name = deviceNames.get(block.id)
        if (name !== deviceFilter) return false
      }
      if (cutoff != null) {
        const ts = ulidToDate(block.id)
        // ULIDs that don't decode to a valid date are kept (we cannot prove
        // they are old, and dropping them would silently hide data).
        if (ts && ts.getTime() < cutoff) return false
      }
      return true
    })
  }, [blocks, typeFilter, deviceFilter, dateFilter, deviceNames])

  return {
    typeFilter,
    setTypeFilter,
    deviceFilter,
    setDeviceFilter,
    dateFilter,
    setDateFilter,
    uniqueDeviceNames,
    filteredBlocks,
  }
}
