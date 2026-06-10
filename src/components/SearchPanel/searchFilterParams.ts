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

/**
 * Issue #717 — matches-nothing sentinel for unresolvable tag names.
 *
 * When the query names tags but resolution settled with fewer ids than
 * names (typo'd / nonexistent tag), the tag constraint must NOT be
 * silently dropped — `tagIds: undefined` would mean "no tag filter" and
 * return every FTS match while the tag chip renders as active. Instead
 * the bundle carries this sentinel id: real tag ids are ULIDs, so it can
 * never collide, and the backend tag filter (ALL semantics — see
 * `add_tags_all` in `src-tauri/src/fts/search.rs`) matches no rows for
 * an unknown id, yielding the correct empty result.
 */
export const UNRESOLVED_TAG_SENTINEL = '__unresolved-tag__'

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
  // #717 — `useTagResolution` yields exactly one settled entry per input
  // name, so fewer ids than names means at least one name is definitively
  // unresolved (callers hold the search while resolution is pending).
  // Project the matches-nothing sentinel instead of dropping the filter.
  const hasUnresolvedTag = projection.tagNames.length > tagIds.length
  return {
    tagIds: hasUnresolvedTag ? [UNRESOLVED_TAG_SENTINEL] : tagIds.length === 0 ? undefined : tagIds,
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
