/**
 * useConflictFilters — UX-265 filter-bar state for ConflictList.
 *
 * Owns the three filter dropdowns (type / device / date) plus the
 * `filteredBlocks` memo and the `uniqueDeviceNames` derivation that the
 * filter dropdown options depend on. Extracted from ConflictList.tsx
 * (MAINT-128) so the orchestrator stays focused on data fetching and
 * dialog wiring.
 *
 * PEND-35 Tier 1.4 — the type-filter and the `last7Days` date filter
 * now flow back to ConflictList as `conflictType` / `idMin`, which it
 * forwards to `getConflicts(...)`. The backend applies them in SQL so
 * cursor pagination and `total_count` track the visible set. Device
 * filter stays FE-side per the audit (device name is not persisted on
 * the row yet).
 */

import { useMemo, useState } from 'react'
import type { BlockRow } from '../lib/tauri'

/** Available conflict-type filter values, mapped to ConflictListItem's inferred types. */
export type TypeFilter = 'all' | 'Text' | 'Property' | 'Move'
/** Available date-range filter values. UX-265 keeps the range coarse to stay in scope. */
export type DateFilter = 'all' | 'last7Days'
/** 7 days in milliseconds — used for the "last 7 days" cutoff. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
/** Crockford base32 alphabet used by ULIDs. */
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Encode a JS timestamp (ms since epoch) as the lower-bound ULID for
 * that instant — i.e. the 10-char Crockford base32 timestamp portion
 * followed by 16 `0`s. Because ULIDs are time-ordered lexicographically,
 * `id >= ulidMinForTimestamp(ts)` is equivalent to "id was created at
 * or after `ts`". Backend uses this directly as the SQL `id_min`
 * parameter.
 *
 * Defined locally rather than in `src/lib/format.ts`: this is the only
 * caller in the codebase, and `ulidToDate` (the inverse) already lives
 * in format.ts — keeping the encode side here avoids broadening that
 * module's surface for a single use.
 */
export function ulidMinForTimestamp(ts: number): string {
  let value = ts
  const chars: string[] = []
  for (let i = 0; i < 10; i++) {
    chars.unshift(CROCKFORD_BASE32[value % 32] as string)
    value = Math.floor(value / 32)
  }
  return `${chars.join('')}0000000000000000`
}

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
  /** FE-side filtered list — only the device filter still narrows here
   *  (PEND-35 Tier 1.4). Type + date are pushed into SQL via
   *  `conflictType` / `idMin` instead. */
  filteredBlocks: BlockRow[]
  /** SQL `conflict_type` parameter for `getConflicts`, or `undefined`
   *  when the type filter is "all". */
  conflictType: string | undefined
  /** SQL `id_min` (ULID lower bound) parameter for `getConflicts`, or
   *  `undefined` when the date filter is "all". */
  idMin: string | undefined
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

  // PEND-35 Tier 1.4 — translate the type / date dropdowns into the
  // SQL parameters ConflictList forwards to `getConflicts(...)`. The
  // hook recomputes `idMin` from `Date.now()` whenever the date
  // filter changes so the cutoff stays fresh as the user re-opens the
  // view (memoised so identity is stable across unrelated re-renders).
  const conflictType = typeFilter === 'all' ? undefined : typeFilter
  const idMin = useMemo(
    () =>
      dateFilter === 'last7Days' ? ulidMinForTimestamp(Date.now() - SEVEN_DAYS_MS) : undefined,
    [dateFilter],
  )

  // Apply the only remaining FE-side filter (device name — not yet
  // persisted on the row per the PEND-35 audit). Falls back to the
  // full backend list when the device filter is "all".
  const filteredBlocks = useMemo(() => {
    if (deviceFilter === 'all') return blocks
    return blocks.filter((block) => deviceNames.get(block.id) === deviceFilter)
  }, [blocks, deviceFilter, deviceNames])

  return {
    typeFilter,
    setTypeFilter,
    deviceFilter,
    setDeviceFilter,
    dateFilter,
    setDateFilter,
    uniqueDeviceNames,
    filteredBlocks,
    conflictType,
    idMin,
  }
}
