/**
 * searchFilterParams — the IPC filter-param bundle SearchPanel hands to
 * `searchBlocks`.
 *
 * PEND-58g FE-A18 — extracted from `SearchPanel.tsx` so the AST→IPC
 * projection lives next to the other search-query plumbing instead of
 * inline in the orchestrator. Pure (no React).
 *
 * PEND-53 — `astFilterParams(projection, tagIds)` returns the
 * AST-projected bundle used in BOTH search modes (DSL-A8 / UX-A4). The
 * shape is accepted by `searchBlocks` as `Partial<…>` extension fields
 * (each entry is `T | undefined`).
 */
import type { AstFilterProjection } from '@/lib/search-query'

export type SearchFilterParams = {
  tagIds?: string[] | undefined
  includePageGlobs?: string[] | undefined
  excludePageGlobs?: string[] | undefined
  stateFilter?: string[] | undefined
  priorityFilter?: string[] | undefined
  excludedStateFilter?: string[] | undefined
  excludedPriorityFilter?: string[] | undefined
  dueFilter?:
    | { kind: 'named'; name: string }
    | { kind: 'op'; op: '<' | '<=' | '=' | '>=' | '>'; date: string }
    | null
  scheduledFilter?:
    | { kind: 'named'; name: string }
    | { kind: 'op'; op: '<' | '<=' | '=' | '>=' | '>'; date: string }
    | null
  propertyFilters?: { key: string; value: string }[] | undefined
  excludedPropertyFilters?: { key: string; value: string }[] | undefined
}

export function astFilterParams(
  projection: AstFilterProjection,
  tagIds: string[],
): SearchFilterParams {
  return {
    tagIds: tagIds.length === 0 ? undefined : tagIds,
    includePageGlobs:
      projection.includePageGlobs.length === 0 ? undefined : projection.includePageGlobs,
    excludePageGlobs:
      projection.excludePageGlobs.length === 0 ? undefined : projection.excludePageGlobs,
    stateFilter: projection.stateFilter.length === 0 ? undefined : projection.stateFilter,
    priorityFilter: projection.priorityFilter.length === 0 ? undefined : projection.priorityFilter,
    excludedStateFilter:
      projection.excludedStateFilter.length === 0 ? undefined : projection.excludedStateFilter,
    excludedPriorityFilter:
      projection.excludedPriorityFilter.length === 0
        ? undefined
        : projection.excludedPriorityFilter,
    dueFilter: projection.dueFilter,
    scheduledFilter: projection.scheduledFilter,
    propertyFilters:
      projection.propertyFilters.length === 0 ? undefined : projection.propertyFilters,
    excludedPropertyFilters:
      projection.excludedPropertyFilters.length === 0
        ? undefined
        : projection.excludedPropertyFilters,
  }
}
