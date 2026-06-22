/**
 * Translate a parsed legacy `{{query …}}` expression into the rich engine's
 * `FilterExpr`, so inline query blocks execute through `run_advanced_query`
 * instead of the legacy per-type IPCs (P2 — full inline-query unification).
 *
 * This is a back-compat-CRITICAL bridge: existing blocks must render the SAME
 * results after the reroute. The translation is therefore CONSERVATIVE — it
 * returns `filterExpr: null` (with structured `reasons`) for any shape it cannot
 * faithfully express, and the caller keeps the legacy dispatch path for those.
 * The legacy↔rich equivalence is pinned by
 * `hooks/__tests__/inline-query-equivalence.test.ts`, which runs a battery of
 * queries through BOTH paths over the same mock seed and asserts identical
 * result sets.
 *
 * Faithful mappings (mirroring the legacy IPC marshalling in `useQueryExecution`
 * and the mock handlers):
 *   - `tag:` / `type:tag expr:` — NAME-prefix match. Resolved ASYNC via
 *     `resolveTagPrefix` (the `list_tags_by_prefix` IPC, the same resolver
 *     `query_by_tags` uses) → a SINGLE `Or` over the union of all prefixes'
 *     resolved tag ids (legacy marshals tags as one `mode:'or'` set), using the
 *     ref-inclusive `TagOrRef` primitive (block_tags ∪ block_tag_refs) so it
 *     matches the same blocks the legacy paths do (NOT attached-only `Tag`).
 *   - reserved keys route to the row-column primitives the legacy path falls back
 *     to: `todo_state → State`, `priority → Priority`, `due_date → DueDate`,
 *     `scheduled_date → Scheduled`. State/Priority are pure set membership, so
 *     only `eq` is faithful (a non-`eq` operator → legacy fallback).
 *   - custom keys → `HasProperty`, date-inferred for the `filtered` shorthand
 *     (`parseDate(value)` ⇒ `Date` column, else `Text`) exactly as
 *     `filtered_blocks_query` marshals them; explicit `type:property` is an exact
 *     text match (no date inference), mirroring `query_by_property`.
 *
 *   - `type:backlinks target:X` → `ChildOf { parent: X }` (`b.parent_id = X`),
 *     the direct children the legacy `list_blocks(parent_id=…)` path returns.
 *   - custom-key `!=` → `And[HasProperty{Exists}, HasProperty{Ne}]` (presence +
 *     inequality), matching legacy `EXISTS(value != ?)`.
 *
 * Not translatable (→ legacy fallback): non-`eq` comparisons on the reserved
 * membership columns (`priority`/`todo_state`), `!=` on reserved DATE columns
 * (no `NotOn` predicate), key-only reserved filters, and any unrecognised shape.
 */

import type { DatePredicate, PropertyPredicate, PropertyValue } from './bindings'
import { parseDate } from './parse-date'
import type { PropertyFilter, parseQueryExpression } from './query-utils'
import type { FilterExpr, FilterPrimitive } from './tauri'

/** Reserved property keys that live on the block ROW (not `block_properties`). */
const RESERVED_ROW_KEYS = new Set(['todo_state', 'priority', 'due_date', 'scheduled_date'])

/** Dependencies injected so the translator stays IPC-free (and unit-testable). */
export interface InlineQueryResolveDeps {
  /**
   * Resolve a tag NAME prefix to the matching tag ids — the same resolution
   * `query_by_tags` performs (`list_tags_by_prefix`). An empty result means the
   * prefix matches no tag, which compiles to an empty `Or` (FALSE), exactly the
   * legacy "no matching tags ⇒ no results" behaviour.
   */
  resolveTagPrefix: (prefix: string) => Promise<string[]>
}

/** Outcome of {@link resolveLegacyQueryToFilterExpr}. */
export interface ResolvedLegacyQuery {
  /** The compiled `FilterExpr`, or `null` when the query must stay on legacy. */
  filterExpr: FilterExpr | null
  /** Per-shape reasons the query was not faithfully translatable (empty ⇒ ok). */
  reasons: string[]
}

type ParsedQuery = ReturnType<typeof parseQueryExpression>

/** Map a legacy operator to an ordered/equality `DatePredicate` over `date`. */
function toDatePredicate(op: PropertyFilter['operator'], date: string): DatePredicate {
  switch (op) {
    case 'lt': {
      return { type: 'Before', date }
    }
    case 'gt': {
      return { type: 'After', date }
    }
    case 'lte': {
      return { type: 'OnOrBefore', date }
    }
    case 'gte': {
      return { type: 'OnOrAfter', date }
    }
    default: {
      // `eq` / undefined → exact day (matches legacy `value_date = X`).
      return { type: 'On', date }
    }
  }
}

/** Map a legacy operator + value to a comparison `PropertyPredicate`. */
function toPropertyPredicate(
  op: PropertyFilter['operator'],
  value: PropertyValue,
): PropertyPredicate {
  switch (op) {
    case 'neq': {
      return { type: 'Ne', value }
    }
    case 'lt': {
      return { type: 'Lt', value }
    }
    case 'gt': {
      return { type: 'Gt', value }
    }
    case 'lte': {
      return { type: 'Lte', value }
    }
    case 'gte': {
      return { type: 'Gte', value }
    }
    default: {
      return { type: 'Eq', value }
    }
  }
}

/** Wrap a primitive as a `Leaf` expression. */
function leaf(primitive: FilterPrimitive): FilterExpr {
  return { type: 'Leaf', primitive }
}

/**
 * Translate one property filter to a `FilterExpr`, or `null` when not faithfully
 * expressible. `dateInfer` controls whether a non-reserved value is parsed as a
 * date (`filtered` shorthand) or treated as exact text (explicit
 * `type:property`).
 */
function propertyFilterToExpr(pf: PropertyFilter, dateInfer: boolean): FilterExpr | null {
  const op = pf.operator ?? 'eq'
  const isEq = op === 'eq'

  if (pf.key === 'todo_state') {
    // Membership only — no comparison/`!=` on the row column.
    if (!isEq) return null
    return leaf({ type: 'State', values: [pf.value], is_null: false, exclude: false })
  }
  if (pf.key === 'priority') {
    if (!isEq) return null
    return leaf({ type: 'Priority', values: [pf.value], is_null: false, exclude: false })
  }
  if (pf.key === 'due_date' || pf.key === 'scheduled_date') {
    // No `NotOn` date predicate exists, and `!=` on a nullable date column has
    // NULL-handling that the engine's predicates don't reproduce → keep legacy.
    if (op === 'neq') return null
    const date = parseDate(pf.value)
    if (date == null) return null // legacy text-compares the row field; keep legacy
    const predicate = toDatePredicate(op, date)
    return leaf(
      pf.key === 'due_date' ? { type: 'DueDate', predicate } : { type: 'Scheduled', predicate },
    )
  }

  // Custom key → block_properties. `filtered` date-infers the value; explicit
  // `type:property` uses an exact text match.
  const date = dateInfer ? parseDate(pf.value) : null
  const value: PropertyValue = date
    ? { type: 'Date', value: date }
    : { type: 'Text', value: pf.value }

  // `!=` needs PRESENCE: legacy `filtered_blocks_query` compiles it as
  // `EXISTS(value != ?)` (the property must exist), but the bare rich
  // `HasProperty { Ne }` is `NOT EXISTS(value = ?)` — which also matches blocks
  // that LACK the property. Compose presence + inequality: `Exists AND Ne`
  // (properties are single-valued per key, so this is exact).
  if (op === 'neq') {
    return {
      type: 'And',
      children: [
        leaf({ type: 'HasProperty', key: pf.key, predicate: { type: 'Exists' } }),
        leaf({ type: 'HasProperty', key: pf.key, predicate: { type: 'Ne', value } }),
      ],
    }
  }

  return leaf({ type: 'HasProperty', key: pf.key, predicate: toPropertyPredicate(op, value) })
}

/**
 * An `Or` of ref-inclusive `TagOrRef { id }` leaves over the union of resolved
 * tag ids. Legacy marshals all tag prefixes as a single `mode:'or'` set
 * (`query_by_tags` / `filtered_blocks_query`), so ALL prefixes' ids go into ONE
 * `Or` — and `TagOrRef` (block_tags ∪ block_tag_refs) matches the same blocks the
 * legacy paths do (NOT the attached-only `Tag` primitive).
 */
function tagIdsToExpr(ids: string[]): FilterExpr {
  return {
    type: 'Or',
    children: ids.map((id) => ({ type: 'Leaf', primitive: { type: 'TagOrRef', tag: id } })),
  }
}

/**
 * Translate a parsed legacy query to a `FilterExpr` for `run_advanced_query`, or
 * `{ filterExpr: null, reasons }` when any part is not faithfully expressible (so
 * the caller keeps the legacy dispatch for that block). See the module doc.
 */
export async function resolveLegacyQueryToFilterExpr(
  parsed: ParsedQuery,
  deps: InlineQueryResolveDeps,
): Promise<ResolvedLegacyQuery> {
  const reasons: string[] = []
  const children: FilterExpr[] = []

  // Backlinks = the DIRECT CHILDREN of the target block (legacy
  // `list_blocks(parent_id=target)`), expressed by the `ChildOf` primitive.
  if (parsed.type === 'backlinks') {
    const target = parsed.params['target']
    if (target != null && target !== '') {
      children.push(leaf({ type: 'ChildOf', parent: target }))
    } else {
      reasons.push('backlinks-missing-target')
    }
  }
  if (parsed.type === 'unknown') reasons.push('unknown-query-shape')

  // Shorthand property filters (the `filtered` path) — date-inferred.
  for (const pf of parsed.propertyFilters) {
    const expr = propertyFilterToExpr(pf, true)
    if (expr == null) {
      reasons.push(`property-not-expressible:${pf.key}:${pf.operator ?? 'eq'}`)
      continue
    }
    children.push(expr)
  }

  // Explicit `type:property key:X value:Y operator:op` lands in `params` — exact
  // text match (no date inference), mirroring `query_by_property`.
  if (parsed.type === 'property') {
    const key = parsed.params['key']
    const value = parsed.params['value']
    if (key == null || key === '') {
      reasons.push('explicit-property-missing-key')
    } else if (value == null || value === '') {
      // Key-only existence: a reserved row key has no faithful "exists" primitive
      // (an empty membership set is a no-op, not "is not null"), so keep legacy.
      if (RESERVED_ROW_KEYS.has(key)) {
        reasons.push(`explicit-property-key-only-reserved:${key}`)
      } else {
        children.push({
          type: 'Leaf',
          primitive: { type: 'HasProperty', key, predicate: { type: 'Exists' } },
        })
      }
    } else {
      const operator = (parsed.params['operator'] as PropertyFilter['operator']) ?? 'eq'
      const date = parsed.params['date']
      const pf: PropertyFilter = { key, value: date ?? value, operator }
      // Explicit form: only date-infer when an explicit `date:` param was given.
      const expr = propertyFilterToExpr(pf, date != null)
      if (expr == null) {
        reasons.push(`explicit-property-not-expressible:${key}:${operator}`)
      } else {
        children.push(expr)
      }
    }
  }

  // Tag prefixes: shorthand `tag:` filters plus an explicit `type:tag expr:`.
  // Legacy marshals them as a single `mode:'or'` set, so the union of all
  // resolved ids becomes ONE `Or` group (NOT one `Or` per prefix `And`-ed).
  const tagPrefixes = [...parsed.tagFilters]
  if (parsed.type === 'tag') {
    const expr = parsed.params['expr']
    if (expr != null && expr !== '') tagPrefixes.push(expr)
    else reasons.push('explicit-tag-missing-expr')
  }
  if (tagPrefixes.length > 0) {
    const ids = new Set<string>()
    for (const prefix of tagPrefixes) {
      for (const id of await deps.resolveTagPrefix(prefix)) ids.add(id)
    }
    // An empty union compiles to an empty `Or` (FALSE) ⇒ no results — the
    // correct answer for a prefix that matches no tag.
    children.push(tagIdsToExpr([...ids]))
  }

  // No translatable content (e.g. `type:invalid`, or an empty expression) must
  // NOT compile to `And { [] }` (which matches every block). Keep it on the
  // legacy path, where it errors / handles the empty case as before.
  if (children.length === 0) reasons.push('no-translatable-content')

  if (reasons.length > 0) return { filterExpr: null, reasons }
  return { filterExpr: { type: 'And', children }, reasons: [] }
}
