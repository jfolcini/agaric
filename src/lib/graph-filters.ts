/**
 * Graph view filter types and pure filtering function (UX-205).
 *
 * Filters are applied client-side to the loaded graph node list. For the tag
 * dimension, filtering is usually driven server-side (the GraphView refetches
 * via `queryByTags` / `listBlocks({tagId})` when tag selection changes). The
 * pure `applyGraphFilters` function will still filter by `tag_ids` when that
 * field is populated on the node, which keeps the function self-contained and
 * testable.
 *
 * Design notes:
 * - All dimensions are optional. An empty filter array is a no-op (returns
 *   the input list unchanged).
 * - Boolean dimensions (`hasDueDate`, `hasScheduledDate`, `hasBacklinks`) use
 *   a literal `true` / `false` value. Omit the filter to express "either".
 * - `excludeTemplates` with `value: true` removes nodes where
 *   `is_template === true`. `value: false` is a no-op by design — users who
 *   want only templates should add an `isTemplate` filter instead (not
 *   implemented; out of scope for UX-205).
 * - `tag` with an empty `tagIds` array is treated as a no-op.
 */

/**
 * Minimum set of node fields needed to evaluate every filter dimension.
 *
 * Fields are optional so that callers (e.g. GraphView) can populate a subset
 * when others are not available. Missing fields produce "pass-through"
 * behaviour for the corresponding filter — for example, if `tag_ids` is
 * undefined on a node, a tag filter will NOT exclude that node. This keeps
 * the function robust in partial-data scenarios.
 */
export interface GraphFilterableNode {
  id: string
  todo_state?: string | null | undefined
  priority?: string | null | undefined
  due_date?: string | null | undefined
  scheduled_date?: string | null | undefined
  tag_ids?: string[] | undefined
  is_template?: boolean | undefined
  backlink_count?: number | undefined
}

export type GraphFilter =
  | { type: 'tag'; tagIds: string[] }
  | { type: 'status'; values: string[] }
  | { type: 'priority'; values: string[] }
  | { type: 'hasDueDate'; value: boolean }
  | { type: 'hasScheduledDate'; value: boolean }
  | { type: 'hasBacklinks'; value: boolean }
  | { type: 'excludeTemplates'; value: boolean }

/**
 * Returns `true` when the node passes the filter, `false` otherwise.
 *
 * Exported for test convenience — consumers should normally use
 * `applyGraphFilters`.
 */
export function nodeMatchesFilter<N extends GraphFilterableNode>(
  node: N,
  filter: GraphFilter,
): boolean {
  switch (filter.type) {
    case 'tag': {
      // No-op when no tags selected.
      if (filter.tagIds.length === 0) return true
      // Pass through when tag_ids is not available on the node.
      if (node.tag_ids === undefined) return true
      // Otherwise: node must have at least one of the selected tag IDs (OR).
      const nodeTags = new Set(node.tag_ids)
      return filter.tagIds.some((id) => nodeTags.has(id))
    }

    case 'status': {
      if (filter.values.length === 0) return true
      const state = node.todo_state ?? null
      if (state === null) return false
      return filter.values.includes(state)
    }

    case 'priority': {
      if (filter.values.length === 0) return true
      const prio = node.priority ?? null
      if (prio === null) return false
      return filter.values.includes(prio)
    }

    case 'hasDueDate': {
      const has = node.due_date !== undefined && node.due_date !== null && node.due_date !== ''
      return has === filter.value
    }

    case 'hasScheduledDate': {
      const has =
        node.scheduled_date !== undefined &&
        node.scheduled_date !== null &&
        node.scheduled_date !== ''
      return has === filter.value
    }

    case 'hasBacklinks': {
      // Pass-through when backlink_count is not populated.
      if (node.backlink_count === undefined) return true
      const has = node.backlink_count > 0
      return has === filter.value
    }

    case 'excludeTemplates': {
      if (!filter.value) return true
      // Exclude only when is_template is *explicitly* true; unknown → keep.
      return node.is_template !== true
    }
  }
}

/**
 * Apply a list of filters to a node array, returning the subset of nodes that
 * match all filters (AND semantics across filter entries).
 *
 * Filters of the same type are treated as independent (last one wins in the
 * UI, but here we AND them all). Empty filter list → input returned unchanged.
 */
export function applyGraphFilters<N extends GraphFilterableNode>(
  nodes: readonly N[],
  filters: readonly GraphFilter[],
): N[] {
  if (filters.length === 0) return [...nodes]
  return nodes.filter((node) => filters.every((f) => nodeMatchesFilter(node, f)))
}

/**
 * Structural equality key for a filter — used to prevent duplicate filter
 * entries of the same type + value. The UI will typically *replace* an
 * existing filter of the same type, but this helper is exposed for tests
 * and any consumer that wants to de-duplicate.
 */
export function getGraphFilterKey(filter: GraphFilter): string {
  switch (filter.type) {
    case 'tag':
      return `tag:${[...filter.tagIds].sort().join(',')}`
    case 'status':
      return `status:${[...filter.values].sort().join(',')}`
    case 'priority':
      return `priority:${[...filter.values].sort().join(',')}`
    case 'hasDueDate':
      return `hasDueDate:${filter.value}`
    case 'hasScheduledDate':
      return `hasScheduledDate:${filter.value}`
    case 'hasBacklinks':
      return `hasBacklinks:${filter.value}`
    case 'excludeTemplates':
      return `excludeTemplates:${filter.value}`
  }
}

/** All filter-type discriminants (useful for UI iteration). */
export const GRAPH_FILTER_TYPES = [
  'tag',
  'status',
  'priority',
  'hasDueDate',
  'hasScheduledDate',
  'hasBacklinks',
  'excludeTemplates',
] as const satisfies readonly GraphFilter['type'][]

export type GraphFilterType = (typeof GRAPH_FILTER_TYPES)[number]

/** Allowed todo-state values (matches the locked cycle in useBlockProperties). */
export const GRAPH_STATUS_VALUES = ['TODO', 'DOING', 'DONE', 'CANCELLED'] as const

/** Allowed priority values. */
export const GRAPH_PRIORITY_VALUES = ['1', '2', '3'] as const
