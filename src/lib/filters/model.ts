/**
 * Canonical filter model — Issue #1646, foundational slice (scoped down by #2258).
 *
 * ## Why this exists
 *
 * The same user concept ("filter blocks/pages by tag / status / priority /
 * property / date / block-type / …") is implemented across FOUR independent
 * type vocabularies:
 *
 *   1. `BacklinkFilter` (`src/lib/bindings.ts`) — backlink builder wire.
 *   2. `FilterPrimitive` (`src/lib/bindings.ts`) — Pages-browser /
 *      advanced-query / search-compound wire.
 *   3. `GraphFilter` (`src/lib/graph-filters.ts`) — client-side graph
 *      predicate, persisted to localStorage.
 *   4. `AstFilterProjection` / `SearchFilterParams`
 *      (`src/lib/search-query/`, `SearchPanel/`) — search query-string → IPC
 *      projection.
 *
 * `FilterPredicate` is the surface-agnostic vocabulary those wires can project
 * onto so a filter can be recognised regardless of the wire shape it maps to.
 *
 * ## Current scope (#2258)
 *
 * Only the **Graph** surface consumes this model at runtime today: it
 * canonicalises its `GraphFilter[]` and stores the result (the graph
 * round-trip below is load-bearing). The backlink, Pages-browser, and search
 * surfaces previously round-tripped their wire shape through the canonical
 * model and back at their IPC boundary — but that round-trip was provably the
 * identity for every value those surfaces produce (deep-review #2258), so it
 * carried no behavioural payoff. Those three no-op seams and their per-surface
 * converter families were removed; the surfaces emit their wire shape directly.
 *
 * The `FilterPredicate` union is kept intact as the target vocabulary. When a
 * SECOND surface genuinely needs to consume the canonical form as working
 * state (not merely round-trip through it), its converters can be reintroduced
 * against this union alongside the consumer that benefits.
 *
 * ## The model
 *
 * `FilterPredicate` is a discriminated union keyed on `kind` (deliberately NOT
 * `type` — legacy wire shapes already use `type`; keeping the canonical
 * discriminant distinct lets a single value be recognised unambiguously
 * regardless of the wire shape it round-trips to).
 */

import type { DatePredicate, LastEditedSpec, PropertyPredicate } from '@/lib/bindings'
import type { GraphFilter } from '@/lib/graph-filters'

// ---------------------------------------------------------------------------
// Canonical discriminated union
// ---------------------------------------------------------------------------

/**
 * A canonical, surface-agnostic filter predicate.
 *
 * Each `kind` corresponds to one conceptual category. The shape of each
 * variant is chosen to be the LEAST-LOSSY superset across the four
 * vocabularies, so any existing filter can be mapped in without dropping
 * information.
 */
export type FilterPredicate =
  // --- Tag -----------------------------------------------------------------
  /**
   * Block carries a tag. `by` distinguishes the two ways surfaces reference a
   * tag today: a resolved tag id (backlink `HasTag`, graph `tag`, pages
   * `Tag` when already resolved) or an unresolved tag name/text (pages `Tag`,
   * search `tag:`). The converters keep whichever form the surface uses.
   */
  | { kind: 'tag'; by: 'id'; tagId: string }
  | { kind: 'tag'; by: 'name'; name: string }
  /** Block carries a tag whose path starts with `prefix` (backlink only). */
  | { kind: 'tagPrefix'; prefix: string }
  // --- Status / state ------------------------------------------------------
  /**
   * Block's todo/task state. Multi-value membership with optional null-match
   * and negation — the superset of the single-value backlink `TodoState`,
   * the graph `status` (multi), and the search `state:` / `not-state:`.
   * `isNull` matches blocks with NO state; `exclude` negates the membership.
   */
  | { kind: 'status'; values: string[]; isNull: boolean; exclude: boolean }
  // --- Priority ------------------------------------------------------------
  /** Block's priority is one of `values`. `exclude` negates. */
  | { kind: 'priority'; values: string[]; exclude: boolean }
  // --- Property ------------------------------------------------------------
  /**
   * Block carries a property `key` satisfying `predicate`. The predicate is
   * the bindings `PropertyPredicate` (Exists / NotExists / Eq / Ne / …), which
   * already subsumes the backlink `PropertyText/Num/Date/IsSet/IsEmpty` family
   * and the pages `HasProperty`. `exclude` carries the search
   * `not-prop:` negation.
   */
  | { kind: 'property'; key: string; predicate: PropertyPredicate; exclude: boolean }
  // --- Date ----------------------------------------------------------------
  /**
   * A date-column predicate. `field` selects which column; `predicate` is the
   * bindings `DatePredicate` (IsNull / Before / After / OnOrBefore / OnOrAfter
   * / On / Between). This subsumes the pages `DueDate`/`Scheduled`, the
   * backlink `DueDate`/`CreatedInRange`, and the graph `hasDueDate` /
   * `hasScheduledDate` booleans (which map to a presence/absence predicate).
   */
  | {
      kind: 'date'
      field: 'due' | 'scheduled' | 'created' | 'lastEdited'
      predicate: DatePredicate
    }
  /** Created-at ULID range (backlink `CreatedInRange`, pages `Created`). */
  | { kind: 'createdRange'; after: string | null; before: string | null }
  /** Block's `last_modified_at` window (pages `LastEdited`). */
  | { kind: 'lastEdited'; spec: LastEditedSpec }
  // --- Block type ----------------------------------------------------------
  /** Block's `block_type` is one of `values`. `exclude` negates. */
  | { kind: 'blockType'; values: string[]; exclude: boolean }
  // --- Path / page ---------------------------------------------------------
  /** Owning page name matches a GLOB. `exclude` → NOT IN. */
  | { kind: 'pathGlob'; pattern: string; exclude: boolean }
  /** Restrict to / exclude source pages (backlink `SourcePage`). */
  | { kind: 'sourcePage'; included: string[]; excluded: string[] }
  /** Block's owning page is in this space (pages `Space`). */
  | { kind: 'space'; spaceId: string }
  // --- Content / text ------------------------------------------------------
  /** Block content contains `query` (backlink `Contains`). */
  | { kind: 'contains'; query: string }
  /** Search-only — regex over content. */
  | { kind: 'regex'; pattern: string }
  /** Search-only — case-sensitive toggle. */
  | { kind: 'caseSensitive'; enabled: boolean }
  /** Search-only — whole-word toggle. */
  | { kind: 'wholeWord'; enabled: boolean }
  // --- Relational / structural (pages advanced) ----------------------------
  /** Block links OUT to `target` (pages `LinksTo`). */
  | { kind: 'linksTo'; target: string }
  /** Block is linked FROM `source` (pages `LinkedFrom`). */
  | { kind: 'linkedFrom'; source: string }
  /** Block has a backlink count > 0 / == 0 (graph `hasBacklinks`). */
  | { kind: 'hasBacklinks'; value: boolean }
  // --- Pages-only booleans -------------------------------------------------
  | { kind: 'orphan' }
  | { kind: 'stub' }
  | { kind: 'hasNoInboundLinks' }
  /** Exclude template pages (graph `excludeTemplates`). */
  | { kind: 'excludeTemplates' }

// ---------------------------------------------------------------------------
// Graph surface conversion (lossless, both directions) — the sole live consumer.
// ---------------------------------------------------------------------------

/**
 * Sentinel `DatePredicate` shapes used to carry the graph boolean
 * has-due / has-scheduled dimensions through the canonical `date` predicate
 * without inventing a new variant. `{ field, predicate }` with these exact
 * shapes round-trips back to `{ type: 'hasDueDate'|..., value }`.
 *
 * `IsNull` ⇒ the column is unset ⇒ "has date = false".
 * `After: ''` (a never-true lower-open bound the graph never emits any other
 * way) is reserved for "has date = true". We keep this mapping internal and
 * total so the round-trip is exact.
 */
function graphHasDateToPredicate(value: boolean): DatePredicate {
  // value=true  → block HAS a date (column is not null)
  // value=false → block has NO date (column is null)
  return value ? { type: 'After', date: GRAPH_HAS_DATE_SENTINEL } : { type: 'IsNull' }
}

/** Internal marker date used only by the graph has-date round-trip. */
const GRAPH_HAS_DATE_SENTINEL = '__graph-has-date__'

function predicateToGraphHasDate(predicate: DatePredicate): boolean {
  return !(predicate.type === 'IsNull')
}

/**
 * Project a single legacy `GraphFilter` into the canonical model. Total over
 * the `GraphFilter` union, so the conversion never drops a dimension.
 */
export function graphFilterToCanonical(filter: GraphFilter): FilterPredicate {
  switch (filter.type) {
    case 'tag': {
      // The graph references tags by RESOLVED id (it filters node.tag_ids).
      // A multi-id graph tag filter is OR over ids; the canonical `tag`
      // predicate is single-id, so a multi-id graph filter expands to one
      // predicate per id at the list level (see `graphFiltersToCanonical`).
      // This single-filter helper only ever sees the already-expanded form.
      return { kind: 'tag', by: 'id', tagId: filter.tagIds[0] ?? '' }
    }
    case 'status': {
      return { kind: 'status', values: [...filter.values], isNull: false, exclude: false }
    }
    case 'priority': {
      return { kind: 'priority', values: [...filter.values], exclude: false }
    }
    case 'hasDueDate': {
      return { kind: 'date', field: 'due', predicate: graphHasDateToPredicate(filter.value) }
    }
    case 'hasScheduledDate': {
      return { kind: 'date', field: 'scheduled', predicate: graphHasDateToPredicate(filter.value) }
    }
    case 'hasBacklinks': {
      return { kind: 'hasBacklinks', value: filter.value }
    }
    case 'excludeTemplates': {
      return { kind: 'excludeTemplates' }
    }
  }
}

/**
 * Project a single canonical predicate back to a legacy `GraphFilter`, or
 * `null` when the predicate is not a graph dimension (the caller drops it).
 * Inverse of `graphFilterToCanonical` for every graph kind.
 */
export function canonicalToGraphFilter(predicate: FilterPredicate): GraphFilter | null {
  switch (predicate.kind) {
    case 'tag': {
      return predicate.by === 'id' ? { type: 'tag', tagIds: [predicate.tagId] } : null
    }
    case 'status': {
      // Graph status is a plain multi-value membership; the canonical
      // isNull/exclude flags are graph-inexpressible, so a non-default value
      // there is not a graph filter.
      return predicate.isNull || predicate.exclude
        ? null
        : { type: 'status', values: [...predicate.values] }
    }
    case 'priority': {
      return predicate.exclude ? null : { type: 'priority', values: [...predicate.values] }
    }
    case 'date': {
      if (predicate.field === 'due')
        return { type: 'hasDueDate', value: predicateToGraphHasDate(predicate.predicate) }
      if (predicate.field === 'scheduled')
        return { type: 'hasScheduledDate', value: predicateToGraphHasDate(predicate.predicate) }
      return null
    }
    case 'hasBacklinks': {
      return { type: 'hasBacklinks', value: predicate.value }
    }
    case 'excludeTemplates': {
      return { type: 'excludeTemplates', value: true }
    }
    default: {
      return null
    }
  }
}

/**
 * Expand a legacy `GraphFilter[]` into canonical predicates. A multi-id graph
 * tag filter (OR over ids) becomes one canonical `tag` predicate per id, so the
 * single-predicate model stays simple while remaining lossless across the list.
 */
export function graphFiltersToCanonical(filters: readonly GraphFilter[]): FilterPredicate[] {
  const out: FilterPredicate[] = []
  for (const f of filters) {
    if (f.type === 'tag') {
      for (const id of f.tagIds) out.push({ kind: 'tag', by: 'id', tagId: id })
      // An empty-id graph tag filter is a no-op; preserve it as an empty-id
      // canonical tag so the round-trip can reconstruct the (no-op) filter.
      if (f.tagIds.length === 0) out.push({ kind: 'tag', by: 'id', tagId: '' })
      continue
    }
    out.push(graphFilterToCanonical(f))
  }
  return out
}

/**
 * Collapse canonical predicates back to a legacy `GraphFilter[]`, re-merging
 * the per-id `tag` predicates into a single multi-id graph tag filter (the
 * inverse of `graphFiltersToCanonical`). Predicates that are not graph
 * dimensions are dropped.
 */
export function canonicalToGraphFilters(predicates: readonly FilterPredicate[]): GraphFilter[] {
  const out: GraphFilter[] = []
  const tagIds: string[] = []
  let sawTag = false
  for (const p of predicates) {
    if (p.kind === 'tag' && p.by === 'id') {
      sawTag = true
      if (p.tagId !== '') tagIds.push(p.tagId)
      continue
    }
    const gf = canonicalToGraphFilter(p)
    if (gf) out.push(gf)
  }
  if (sawTag) out.unshift({ type: 'tag', tagIds })
  return out
}
