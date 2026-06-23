import type { DatePredicate, PropertyPredicate } from './bindings'
import type { BacklinkFilter, CompareOp, FilterExpr, FilterPrimitive } from './tauri'

/** Parsed property filter from shorthand syntax (property:key=value). */
export interface PropertyFilter {
  key: string
  value: string
  operator?: 'eq' | 'neq' | 'lt' | 'gt' | 'lte' | 'gte' | undefined // default: 'eq'
}

/** Map operator symbol to PropertyFilter operator name. */
const OPERATOR_MAP: Record<string, PropertyFilter['operator']> = {
  '>=': 'gte',
  '<=': 'lte',
  '!=': 'neq',
  '>': 'gt',
  '<': 'lt',
  '=': 'eq',
}

/** Map PropertyFilter operator name to display symbol. */
export const OPERATOR_SYMBOLS: Record<string, string> = {
  eq: '=',
  neq: '≠',
  lt: '<',
  gt: '>',
  lte: '≤',
  gte: '≥',
}

/**
 * Canonical comparison operators recognised inside `property:key{op}value`
 * shorthand. Kept in the same multi-char-first order the parser matches them
 * (`>=`, `<=`, `!=` before the single-char `>`, `<`, `=`) so an autocomplete
 * hint never offers a single-char operator that would shadow a two-char one.
 *
 * Single source of truth: `parseQueryExpression`'s opMatch regex
 * (`^(\w+)(>=|<=|!=|>|<|=)(.+)$`). Update both together.
 */
export const QUERY_OPERATORS = ['>=', '<=', '!=', '>', '<', '='] as const

/**
 * Canonical token *prefixes* (the part before the first `:`) that
 * `parseQueryExpression` understands. `tag` and `property` are the modern
 * shorthand; `type`, `expr`, `key`, `value`, `target` are the legacy explicit
 * form. An autocomplete hint sources its key vocabulary from here so it can
 * never diverge from what the parser actually accepts.
 */
export const QUERY_KEYS = ['tag', 'property', 'type', 'expr', 'key', 'value', 'target'] as const

/**
 * Values the legacy `type:` key accepts (`type:tag`, `type:property`,
 * `type:backlinks`). Mirrors the `explicitType` cast in
 * `parseQueryExpression`.
 */
export const QUERY_TYPE_VALUES = ['tag', 'property', 'backlinks'] as const

/**
 * Well-known property keys that `buildFilters` maps to specialised filter
 * variants (everything else falls through to `PropertyText`). Offered as
 * completions for the `property:` shorthand's key segment.
 */
export const QUERY_PROPERTY_KEYS = ['todo_state', 'priority', 'due_date'] as const

/** Parse a query expression string into structured params.
 *
 * Supports both the legacy explicit-type syntax and the new shorthand:
 * - Legacy: `type:tag expr:project` or `type:property key:X value:Y`
 * - Shorthand: `property:key=value` and `tag:prefix`
 *
 * Multiple shorthand tokens are collected and produce a `'filtered'` type
 * with AND semantics.
 */
export function parseQueryExpression(expr: string): {
  type: 'tag' | 'property' | 'backlinks' | 'filtered' | 'unknown'
  params: Record<string, string>
  propertyFilters: PropertyFilter[]
  tagFilters: string[]
} {
  // The markdown serializer escapes parser-significant characters (`\`,
  // `*`, `` ` ``, `~`, `=`, `[`, `]`, `#[`) in block content. Round-tripped
  // `{{query ...}}` blocks therefore arrive here with escaped `=`, which
  // breaks property-shorthand parsing (`property:key=value`). Unescape the
  // Common single-char escapes before tokenising.
  const unescaped = expr.replace(/\\([\\*`~=[\]#])/g, '$1')
  const parts = unescaped.trim().split(/\s+/)
  const params: Record<string, string> = {}
  const propertyFilters: PropertyFilter[] = []
  const tagFilters: string[] = []

  for (const part of parts) {
    const colonIdx = part.indexOf(':')
    if (colonIdx > 0) {
      const prefix = part.slice(0, colonIdx)
      const rest = part.slice(colonIdx + 1)

      if (prefix === 'property' && /[><=!]/.test(rest)) {
        // Shorthand: property:key{op}value  (>=, <=, != matched before >, <, =)
        const opMatch = rest.match(/^(\w+)(>=|<=|!=|>|<|=)(.+)$/)
        if (opMatch) {
          propertyFilters.push({
            key: opMatch[1] as string,
            value: opMatch[3] as string,
            operator: OPERATOR_MAP[opMatch[2] as string],
          })
        }
      } else if (prefix === 'tag' && rest !== '') {
        // Shorthand: tag:prefix
        tagFilters.push(rest)
      } else {
        params[prefix] = rest
      }
    }
  }

  // If shorthand filters were found, treat as a 'filtered' query
  if (propertyFilters.length > 0 || tagFilters.length > 0) {
    return { type: 'filtered', params, propertyFilters, tagFilters }
  }

  const explicitType = params['type'] as 'tag' | 'property' | 'backlinks' | undefined
  return { type: explicitType ?? 'unknown', params, propertyFilters, tagFilters }
}

/** Map PropertyFilter operator to Rust CompareOp variant. */
function toCompareOp(op: PropertyFilter['operator']): CompareOp {
  switch (op) {
    case 'neq': {
      return 'Neq'
    }
    case 'lt': {
      return 'Lt'
    }
    case 'gt': {
      return 'Gt'
    }
    case 'lte': {
      return 'Lte'
    }
    case 'gte': {
      return 'Gte'
    }
    default: {
      return 'Eq'
    }
  }
}

/** Build BacklinkFilter objects from parsed shorthand filters.
 *
 * Maps known fixed-field keys (todo_state, priority, due_date) to their
 * specialised filter variants, and falls back to PropertyText for custom
 * property keys.  Tag filters become HasTagPrefix filters.
 */
export function buildFilters(
  propertyFilters: PropertyFilter[],
  tagFilters: string[],
): BacklinkFilter[] {
  const filters: BacklinkFilter[] = []

  for (const pf of propertyFilters) {
    const op = toCompareOp(pf.operator)
    if (pf.key === 'todo_state') {
      filters.push({ type: 'TodoState', state: pf.value })
    } else if (pf.key === 'priority') {
      filters.push({ type: 'Priority', level: pf.value })
    } else if (pf.key === 'due_date') {
      filters.push({ type: 'DueDate', op, value: pf.value })
    } else {
      filters.push({ type: 'PropertyText', key: pf.key, op, value: pf.value })
    }
  }

  for (const tf of tagFilters) {
    filters.push({ type: 'HasTagPrefix', prefix: tf })
  }

  return filters
}

/**
 * Map a {@link PropertyFilter} operator to the engine's nested
 * {@link DatePredicate} (used by the `DueDate` `FilterPrimitive`).
 *
 * The legacy shorthand only carries the six comparison operators; the engine's
 * richer date predicates (`IsNull`, `Between`) have no shorthand spelling, so
 * they are unreachable from a legacy block and intentionally not produced here.
 * Mirrors `AddFilterPopover.applyDate`'s predicate construction.
 *
 * `neq` has no faithful date predicate and is rejected by the only caller
 * ({@link propertyFilterToLeaves}); this throws rather than silently mapping it
 * to `On` (its semantic opposite) so a future caller cannot reintroduce that
 * footgun.
 */
function toDatePredicate(pf: PropertyFilter): DatePredicate {
  switch (pf.operator) {
    case 'lt': {
      return { type: 'Before', date: pf.value }
    }
    case 'gt': {
      return { type: 'After', date: pf.value }
    }
    case 'lte': {
      return { type: 'OnOrBefore', date: pf.value }
    }
    case 'gte': {
      return { type: 'OnOrAfter', date: pf.value }
    }
    case 'eq':
    case undefined: {
      // The exact calendar day (the engine expands `On` to a day window),
      // matching the legacy `value_date = X` semantics.
      return { type: 'On', date: pf.value }
    }
    case 'neq': {
      throw new Error('due_date != has no engine date predicate; reject upstream')
    }
  }
}

/**
 * Map a {@link PropertyFilter} operator to the engine's nested
 * {@link PropertyPredicate} (used by `HasProperty`). All six shorthand
 * operators have a faithful 1:1 predicate; `eq`/undefined → `Eq`.
 */
function toPropertyPredicate(pf: PropertyFilter): PropertyPredicate {
  const value = { type: 'Text', value: pf.value } as const
  switch (pf.operator) {
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

/** Wrap a {@link FilterPrimitive} in a `Leaf` {@link FilterExpr} node. */
function leaf(primitive: FilterPrimitive): FilterExpr {
  return { type: 'Leaf', primitive }
}

/**
 * Translate a single parsed {@link PropertyFilter} to the engine
 * {@link FilterExpr} leaves that reproduce its match semantics, mirroring the
 * fixed-field routing in {@link buildFilters} but onto the advanced-engine
 * vocabulary (`State`/`Priority`/`DueDate`/`HasProperty`) used by
 * `run_advanced_query`.
 *
 * Returns an array because a single legacy filter can need more than one leaf:
 * custom `!=` becomes `Exists` + `Ne` (see below). The caller spreads them into
 * its top-level `And`.
 *
 * Routing (matches `AddFilterPopover`'s chip construction):
 *   - `todo_state` → `State { values:[v], is_null:false, exclude:false }`
 *                    (only `eq` is faithful — `State` has no per-value operator)
 *   - `priority`   → `Priority { values:[v], is_null:false, exclude:false }`
 *                    (same `eq`-only constraint)
 *   - `due_date`   → `DueDate { predicate }` (`eq`/`lt`/`gt`/`lte`/`gte` map;
 *                    `neq` has no date predicate, see {@link toDatePredicate})
 *   - custom `!=`  → `Exists` + `Ne` (legacy `!=` requires the property to be
 *                    present; bare `HasProperty{Ne}` would also match absent)
 *   - other keys   → `HasProperty { key, predicate }`
 *
 * Returns `null` when the filter is NOT faithfully expressible on the engine
 * vocabulary, so the caller can refuse to silently change a legacy block's
 * results: a non-`eq` operator on the membership-only `todo_state` / `priority`
 * fields, or `due_date != X` (no engine `!=` date predicate).
 */
function propertyFilterToLeaves(pf: PropertyFilter): FilterExpr[] | null {
  const isEq = pf.operator == null || pf.operator === 'eq'
  if (pf.key === 'todo_state') {
    if (!isEq) return null
    return [leaf({ type: 'State', values: [pf.value], is_null: false, exclude: false })]
  }
  if (pf.key === 'priority') {
    if (!isEq) return null
    return [leaf({ type: 'Priority', values: [pf.value], is_null: false, exclude: false })]
  }
  if (pf.key === 'due_date') {
    // The engine has no `!=` date predicate; `due_date!=X` would otherwise be
    // mistranslated to an exact-day `On` match (the semantic opposite), so we
    // refuse it and the caller keeps the legacy path.
    if (pf.operator === 'neq') return null
    return [leaf({ type: 'DueDate', predicate: toDatePredicate(pf) })]
  }
  if (pf.operator === 'neq') {
    // Legacy custom `!=` is `EXISTS(SELECT … WHERE key=? AND value<>?)`, which
    // requires the property to be PRESENT. The engine's `HasProperty{Ne}`
    // compiles to `NOT EXISTS(… key=? AND value=?)`, which ALSO matches blocks
    // that lack the property entirely — a wider set. Pair it with an explicit
    // `Exists` leaf so the `And` reproduces the legacy "present and not equal".
    return [
      leaf({ type: 'HasProperty', key: pf.key, predicate: { type: 'Exists' } }),
      leaf({ type: 'HasProperty', key: pf.key, predicate: toPropertyPredicate(pf) }),
    ]
  }
  return [leaf({ type: 'HasProperty', key: pf.key, predicate: toPropertyPredicate(pf) })]
}

/** Outcome of {@link legacyQueryToFilterExpr}. */
export interface LegacyToFilterExprResult {
  /**
   * The compiled engine `FilterExpr` (an `And` of the translated leaves),
   * or `null` when the query is not faithfully translatable (see `reasons`).
   * An empty/`unknown` query compiles to `And { children: [] }` (TRUE) — the
   * same "match everything" the empty advanced builder produces.
   */
  filterExpr: FilterExpr | null
  /**
   * Per-shape reasons the query could NOT be translated to the engine
   * vocabulary. Empty ⇒ a faithful `filterExpr` was produced. Non-empty ⇒
   * `filterExpr` is `null` and the LEGACY execution path must be kept for this
   * block (the back-compat-safe fallback).
   */
  reasons: string[]
}

/**
 * #1280 / inline-query execution-unification — translate a parsed legacy
 * `{{query …}}` expression to the advanced engine's `FilterExpr`, the input
 * `run_advanced_query` consumes.
 *
 * This is the back-compat BRIDGE: the on-disk `{{query <text>}}` format and the
 * `parseQueryExpression` reader are untouched; only the EXECUTION target is
 * (eventually) re-pointed at the rich engine. To keep that switch provably
 * behaviour-preserving, the translator is CONSERVATIVE — it returns
 * `filterExpr: null` (and the caller keeps the legacy IPC path) whenever a shape
 * has no faithful engine spelling. Today those shapes are:
 *
 *   1. `tag:` / `type:tag` — the legacy path matches a tag-NAME PREFIX
 *      (`tags_cache.name LIKE 'work%'`, via `query_by_tags` `prefixes`). The
 *      engine's only tag leaf is `Tag { tag: <exact tag id> }`; there is NO
 *      name-prefix `FilterPrimitive`. A faithful translation would have to
 *      `listTagsByPrefix` (an async IPC) and OR the resolved ids — which the
 *      engine could express but this synchronous text→expr translator cannot,
 *      and whose match set would also drift from the legacy block whenever tags
 *      are added/renamed. So tag shapes are reported untranslatable.
 *   2. `type:backlinks` (`target:`) — descendants-of-a-block; no equivalent
 *      structural `FilterPrimitive` (it is a parent/descendant relation, not a
 *      block predicate).
 *   3. A non-`eq` operator on `todo_state` / `priority` — the engine's
 *      `State`/`Priority` leaves are membership-only (see
 *      {@link propertyFilterToLeaves}).
 *
 * Everything else (single/multi property shorthand with any operator, including
 * `due_date` ranges and custom-key comparisons) translates faithfully to an
 * `And` of engine leaves with the SAME match semantics the legacy
 * `filteredBlocksQuery` produced.
 */
export function legacyQueryToFilterExpr(
  parsed: ReturnType<typeof parseQueryExpression>,
): LegacyToFilterExprResult {
  const reasons: string[] = []

  // Tag shapes (shorthand `tag:` OR explicit `type:tag`): no faithful engine
  // spelling (name-prefix is not a `FilterPrimitive`). See the doc-comment.
  if (parsed.tagFilters.length > 0 || parsed.type === 'tag') {
    reasons.push('tag-prefix-match-has-no-engine-primitive')
  }
  // Backlinks: a parent/descendant relation, not a block predicate.
  if (parsed.type === 'backlinks') {
    reasons.push('backlinks-target-has-no-engine-primitive')
  }
  // Legacy explicit `type:property key:X value:Y` lands in `params`, not
  // `propertyFilters`, so it is not yet translatable via this path either.
  if (parsed.type === 'property') {
    reasons.push('explicit-type-property-uses-params-not-shorthand')
  }
  // `unknown` (no recognised shape) cannot be faithfully executed by the engine.
  if (parsed.type === 'unknown') {
    reasons.push('unknown-query-shape')
  }

  const children: FilterExpr[] = []
  for (const pf of parsed.propertyFilters) {
    const leaves = propertyFilterToLeaves(pf)
    if (leaves == null) {
      reasons.push(`property-operator-not-expressible:${pf.key}:${pf.operator ?? 'eq'}`)
      continue
    }
    // `And` is associative, so a multi-leaf translation (custom `!=` →
    // `Exists` + `Ne`) flattens into the top-level `And` rather than nesting.
    children.push(...leaves)
  }

  if (reasons.length > 0) {
    return { filterExpr: null, reasons }
  }
  return { filterExpr: { type: 'And', children }, reasons: [] }
}
