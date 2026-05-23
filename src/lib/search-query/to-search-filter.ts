/**
 * PEND-54 — Project a parsed `SearchQueryAST` onto IPC-side
 * `SearchFilter` fields.
 *
 * The AST is the canonical model on the frontend; this adapter is the
 * single point where it crosses into the wire shape. Keep the
 * projection small and additive — PEND-53 appends `state_filter`,
 * `priority_filter`, `due_filter`, `scheduled_filter`,
 * `property_filters`, `excluded_property_filters` to this same
 * adapter.
 *
 * Unknown / invalid tokens are intentionally dropped from the IPC
 * projection (they still render as red chips in the UI). The plan's
 * "Mixing `path:` and `not-path:`" edge case is handled by the
 * backend's SQL composition (both clauses AND-joined).
 *
 * PEND-53 — repeating `state:` / `priority:` tokens OR-fan-out (the
 * SQL emits `state IN (?, ?, ...)`); repeating `prop:` tokens
 * AND-fan-out (each becomes its own EXISTS sub-select).
 *
 * PEND-63 — `not-state:` / `not-priority:` are now wired:
 * `excluded_state_filter` / `excluded_priority_filter` populate
 * dedicated `SearchFilter` fields, and the backend emits
 * `(col IS NULL OR col NOT IN (...))` — NULL-inclusive inversion so
 * blocks with no state aren't accidentally excluded from a "not DONE"
 * query. The `not-state:none` chip flips to `col IS NOT NULL`.
 */

import type { DateFilterValue, SearchPropertyFilter, SearchQueryAST } from './types'

export interface AstFilterProjection {
  tagNames: string[]
  includePageGlobs: string[]
  excludePageGlobs: string[]
  // PEND-53 — metadata filter projection.
  stateFilter: string[]
  priorityFilter: string[]
  // PEND-63 — `not-state:` / `not-priority:` chips now project to
  // dedicated excluded fields so the backend can emit the proper
  // `(col IS NULL OR col NOT IN (...))` inversion.
  excludedStateFilter: string[]
  excludedPriorityFilter: string[]
  dueFilter: DateFilterValue | null
  scheduledFilter: DateFilterValue | null
  propertyFilters: SearchPropertyFilter[]
  excludedPropertyFilters: SearchPropertyFilter[]
}

export function astToFilterProjection(ast: SearchQueryAST): AstFilterProjection {
  const tagNames: string[] = []
  const includePageGlobs: string[] = []
  const excludePageGlobs: string[] = []
  const stateFilter: string[] = []
  const priorityFilter: string[] = []
  const excludedStateFilter: string[] = []
  const excludedPriorityFilter: string[] = []
  let dueFilter: DateFilterValue | null = null
  let scheduledFilter: DateFilterValue | null = null
  const propertyFilters: SearchPropertyFilter[] = []
  const excludedPropertyFilters: SearchPropertyFilter[] = []
  for (const f of ast.filters) {
    switch (f.kind) {
      case 'tag': {
        // DSL-A3 — NFC-normalise the tag name before it enters the
        // matching projection. The backend stores/indexes tag content
        // in NFC (see `src-tauri/src/fts/strip.rs` / `search.rs`), and
        // `useTagResolution` matches by lowercased name string, so a
        // decomposed query (e.g. `e`+U+0301) would never equal the
        // composed stored tag (U+00E9) without this. Normalise once,
        // here, so both `tag:` and bare-`#tag` tokens funnel through it.
        const tagValue = f.value.normalize('NFC')
        if (!tagNames.includes(tagValue)) tagNames.push(tagValue)
        break
      }
      case 'pathInclude':
        // Comma-separated values inside one path: token expand into
        // multiple include entries (the plan's "Multiple `path:`
        // tokens → equivalent to comma-separating them" rule).
        for (const v of splitCommas(f.value)) includePageGlobs.push(v)
        break
      case 'pathExclude':
        for (const v of splitCommas(f.value)) excludePageGlobs.push(v)
        break
      case 'state':
        if (!stateFilter.includes(f.value)) stateFilter.push(f.value)
        break
      case 'notState':
        // PEND-63 — project to `excluded_state_filter`; the backend
        // emits `(todo_state IS NULL OR todo_state NOT IN (...))`.
        if (!excludedStateFilter.includes(f.value)) excludedStateFilter.push(f.value)
        break
      case 'priority':
        if (!priorityFilter.includes(f.value)) priorityFilter.push(f.value)
        break
      case 'notPriority':
        // PEND-63 — symmetric to `notState`.
        if (!excludedPriorityFilter.includes(f.value)) excludedPriorityFilter.push(f.value)
        break
      case 'due':
        // Last `due:` token wins (a future revision can collapse to a
        // composite predicate). Documented in docs/SEARCH.md.
        dueFilter = f.value
        break
      case 'scheduled':
        scheduledFilter = f.value
        break
      case 'prop':
        propertyFilters.push({ key: f.key, value: f.value })
        break
      case 'notProp':
        excludedPropertyFilters.push({ key: f.key, value: f.value })
        break
      case 'invalid':
        // Don't ship invalid tokens to the backend.
        break
    }
  }
  return {
    tagNames,
    includePageGlobs,
    excludePageGlobs,
    stateFilter,
    priorityFilter,
    excludedStateFilter,
    excludedPriorityFilter,
    dueFilter,
    scheduledFilter,
    propertyFilters,
    excludedPropertyFilters,
  }
}

function splitCommas(value: string): string[] {
  // Top-level comma split — commas inside a `{...}` group belong to
  // brace alternatives and must not break the entry into separate
  // globs. Mirrors the Rust `split_top_level_commas` helper.
  const parts: string[] = []
  let depth = 0
  let last = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '{') depth++
    else if (ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      parts.push(value.slice(last, i))
      last = i + 1
    }
  }
  parts.push(value.slice(last))
  return parts.map((s) => s.trim()).filter((s) => s.length > 0)
}
