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
 * AND-fan-out (each becomes its own EXISTS sub-select). `not-state:`
 * and `not-priority:` simply add their values to the same `IN`
 * disjunction — there is no separate "excluded state" backend field,
 * because the SQL is a single `state IN (...)` so a `not-state:X` is
 * naturally expressed as "include everything else". v1 keeps the
 * projection simple by treating `not-state:X` as a chip with no IPC
 * effect *yet*; the plan deliberately leaves that semantic open
 * pending real demand (documented in `docs/SEARCH.md`).
 *
 * Wait — re-read the plan: PEND-53 does not currently call for a
 * `state_filter` exclusion. The token is reserved for symmetry with
 * `not-tag:` and `not-path:` so the syntax matches; v1 wires it as a
 * no-op IPC projection (the chip is purely visual). Same for
 * `not-priority:`. Both behaviours are documented.
 */

import type { DateFilterValue, SearchPropertyFilter, SearchQueryAST } from './types'

export interface AstFilterProjection {
  tagNames: string[]
  includePageGlobs: string[]
  excludePageGlobs: string[]
  // PEND-53 — metadata filter projection.
  stateFilter: string[]
  priorityFilter: string[]
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
  let dueFilter: DateFilterValue | null = null
  let scheduledFilter: DateFilterValue | null = null
  const propertyFilters: SearchPropertyFilter[] = []
  const excludedPropertyFilters: SearchPropertyFilter[] = []
  for (const f of ast.filters) {
    switch (f.kind) {
      case 'tag':
        if (!tagNames.includes(f.value)) tagNames.push(f.value)
        break
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
        // Reserved for symmetry; no IPC projection in v1.
        // Documented in docs/SEARCH.md.
        break
      case 'priority':
        if (!priorityFilter.includes(f.value)) priorityFilter.push(f.value)
        break
      case 'notPriority':
        // Reserved for symmetry; no IPC projection in v1.
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
