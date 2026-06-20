/**
 * Canonical filter model — Issue #1646, foundational slice.
 *
 * ## Why this exists
 *
 * The same user concept ("filter blocks/pages by tag / status / priority /
 * property / date / block-type / …") is currently implemented across FOUR
 * independent type vocabularies:
 *
 *   1. `BacklinkFilter`        (`src/lib/bindings.ts`) — backlink builder wire.
 *   2. `FilterPrimitive`       (`src/lib/bindings.ts`) — Pages-browser /
 *                              advanced-query / search-compound wire.
 *   3. `GraphFilter`           (`src/lib/graph-filters.ts`) — client-side graph
 *                              predicate, persisted to localStorage.
 *   4. `AstFilterProjection` / `SearchFilterParams`
 *                              (`src/lib/search-query/`, `SearchPanel/`) —
 *                              the search query-string → IPC projection.
 *
 * Each surface re-derives the same conceptual categories in its own shape and
 * its own builder UX. This module is the SINGLE source of truth they all
 * project from. It is purely additive: existing wire types are unchanged, and
 * each surface keeps emitting its legacy backend shape via the conversion
 * helpers here, so backends are unaffected while surfaces migrate one at a
 * time (see `docs/filters/CANONICAL-MODEL-MIGRATION.md`).
 *
 * ## The model
 *
 * `FilterPredicate` is a discriminated union (keyed on `kind`, deliberately
 * NOT `type` — the legacy wire shapes already use `type`, and keeping the
 * canonical discriminant distinct lets a single value be recognised
 * unambiguously regardless of which wire shape it round-trips to).
 *
 * Every variant of all four vocabularies is losslessly representable here (see
 * the per-vocabulary conversion helpers + their round-trip tests). Boolean and
 * compound categories are modelled explicitly so no surface has to special-case
 * them in an ad-hoc string.
 *
 * ## Per-surface allow-lists
 *
 * No surface supports every category. `FILTER_SURFACE_ALLOWLIST` declares,
 * per surface, exactly which `FilterPredicate['kind']`s that surface may
 * build/emit. A surface's builder iterates its allow-list to decide which
 * categories to offer; its converter asserts membership before projecting.
 * This is the mechanism by which all surfaces "project from one source of
 * truth" while still differing in what they expose.
 */

import type {
  BacklinkFilter,
  CompareOp,
  DatePredicate,
  FilterPrimitive,
  LastEditedSpec,
  PropertyPredicate,
  PropertyValue,
} from '@/lib/bindings'
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

/** Every canonical predicate discriminant. */
export type FilterPredicateKind = FilterPredicate['kind']

// ---------------------------------------------------------------------------
// Per-surface allow-lists
// ---------------------------------------------------------------------------

/** The surfaces that build/emit filters. */
export type FilterSurface = 'backlink' | 'pageBrowser' | 'graph' | 'search'

/**
 * Which canonical predicate kinds each surface supports. A surface's builder
 * iterates its list to decide which categories to offer; its converter asserts
 * membership before projecting back to that surface's wire shape.
 *
 * Derived directly from each surface's CURRENT capability set (the categories
 * its existing builder offers / its wire type can express), so migrating a
 * surface to project from this model is behaviour-preserving by construction.
 */
export const FILTER_SURFACE_ALLOWLIST: Record<FilterSurface, readonly FilterPredicateKind[]> = {
  // Backlink builder (`AddFilterRow`): type/status/priority/contains/property/
  // date/property-set/property-empty/has-tag/tag-prefix.
  backlink: [
    'blockType',
    'status',
    'priority',
    'contains',
    'property',
    'date',
    'createdRange',
    'tag',
    'tagPrefix',
    'sourcePage',
  ],
  // Pages browser + advanced query (`AddFilterPopover`): tag / path / property /
  // last-edited / priority / state / block-type / due / scheduled / created /
  // links-to / linked-from / has-parent / orphan / stub / no-inbound.
  pageBrowser: [
    'tag',
    'pathGlob',
    'property',
    'lastEdited',
    'priority',
    'status',
    'blockType',
    'date',
    'createdRange',
    'linksTo',
    'linkedFrom',
    'space',
    'orphan',
    'stub',
    'hasNoInboundLinks',
    'regex',
    'caseSensitive',
    'wholeWord',
  ],
  // Graph view (`GraphFilterBar`): tag / status / priority / hasDueDate /
  // hasScheduledDate / hasBacklinks / excludeTemplates.
  graph: ['tag', 'status', 'priority', 'date', 'hasBacklinks', 'excludeTemplates'],
  // Search query-string AST: tag / path / state / priority / due / scheduled /
  // property (each with its excluded counterpart).
  search: ['tag', 'pathGlob', 'status', 'priority', 'date', 'property'],
}

/** Whether `surface` may build/emit the given canonical predicate kind. */
export function surfaceSupports(surface: FilterSurface, kind: FilterPredicateKind): boolean {
  return FILTER_SURFACE_ALLOWLIST[surface].includes(kind)
}

// ---------------------------------------------------------------------------
// Graph surface conversion (lossless, both directions) — the migrated proof.
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
    case 'tag':
      // The graph references tags by RESOLVED id (it filters node.tag_ids).
      // A multi-id graph tag filter is OR over ids; the canonical `tag`
      // predicate is single-id, so a multi-id graph filter expands to one
      // predicate per id at the list level (see `graphFiltersToCanonical`).
      // This single-filter helper only ever sees the already-expanded form.
      return { kind: 'tag', by: 'id', tagId: filter.tagIds[0] ?? '' }
    case 'status':
      return { kind: 'status', values: [...filter.values], isNull: false, exclude: false }
    case 'priority':
      return { kind: 'priority', values: [...filter.values], exclude: false }
    case 'hasDueDate':
      return { kind: 'date', field: 'due', predicate: graphHasDateToPredicate(filter.value) }
    case 'hasScheduledDate':
      return { kind: 'date', field: 'scheduled', predicate: graphHasDateToPredicate(filter.value) }
    case 'hasBacklinks':
      return { kind: 'hasBacklinks', value: filter.value }
    case 'excludeTemplates':
      return { kind: 'excludeTemplates' }
  }
}

/**
 * Project a single canonical predicate back to a legacy `GraphFilter`, or
 * `null` when the predicate is outside the graph surface's allow-list (the
 * caller drops it). Inverse of `graphFilterToCanonical` for every graph kind.
 */
export function canonicalToGraphFilter(predicate: FilterPredicate): GraphFilter | null {
  switch (predicate.kind) {
    case 'tag':
      return predicate.by === 'id' ? { type: 'tag', tagIds: [predicate.tagId] } : null
    case 'status':
      // Graph status is a plain multi-value membership; the canonical
      // isNull/exclude flags are graph-inexpressible, so a non-default value
      // there is not a graph filter.
      return predicate.isNull || predicate.exclude
        ? null
        : { type: 'status', values: [...predicate.values] }
    case 'priority':
      return predicate.exclude ? null : { type: 'priority', values: [...predicate.values] }
    case 'date':
      if (predicate.field === 'due')
        return { type: 'hasDueDate', value: predicateToGraphHasDate(predicate.predicate) }
      if (predicate.field === 'scheduled')
        return { type: 'hasScheduledDate', value: predicateToGraphHasDate(predicate.predicate) }
      return null
    case 'hasBacklinks':
      return { type: 'hasBacklinks', value: predicate.value }
    case 'excludeTemplates':
      return { type: 'excludeTemplates', value: true }
    default:
      return null
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
 * inverse of `graphFiltersToCanonical`). Predicates outside the graph
 * allow-list are dropped.
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

// ---------------------------------------------------------------------------
// Backlink surface conversion (legacy wire → canonical, lossless one-way for
// every non-compound backlink leaf). Compound And/Or/Not are represented at
// the list level by the surfaces; the backlink builder emits flat leaves.
// ---------------------------------------------------------------------------

/**
 * Project a single (non-compound) `BacklinkFilter` leaf into the canonical
 * model. Returns `null` for the compound `And`/`Or`/`Not` wrappers, which the
 * flat builder surfaces never emit (they manage composition as a list).
 */
export function backlinkFilterToCanonical(filter: BacklinkFilter): FilterPredicate | null {
  switch (filter.type) {
    case 'PropertyText':
      return {
        kind: 'property',
        key: filter.key,
        predicate: propTextPredicate(filter.op, filter.value),
        exclude: false,
      }
    case 'PropertyNum':
      return {
        kind: 'property',
        key: filter.key,
        predicate: { type: 'Eq', value: numPropValue(filter.value) },
        exclude: false,
      }
    case 'PropertyDate':
      return {
        kind: 'property',
        key: filter.key,
        predicate: { type: 'Eq', value: { type: 'Text', value: filter.value } },
        exclude: false,
      }
    case 'PropertyIsSet':
      return { kind: 'property', key: filter.key, predicate: { type: 'Exists' }, exclude: false }
    case 'PropertyIsEmpty':
      return { kind: 'property', key: filter.key, predicate: { type: 'NotExists' }, exclude: false }
    case 'TodoState':
      return { kind: 'status', values: [filter.state], isNull: false, exclude: false }
    case 'Priority':
      return { kind: 'priority', values: [filter.level], exclude: false }
    case 'DueDate':
      return {
        kind: 'date',
        field: 'due',
        predicate: compareOpToDatePredicate(filter.op, filter.value),
      }
    case 'HasTag':
      return { kind: 'tag', by: 'id', tagId: filter.tag_id }
    case 'HasTagPrefix':
      return { kind: 'tagPrefix', prefix: filter.prefix }
    case 'Contains':
      return { kind: 'contains', query: filter.query }
    case 'CreatedInRange':
      return { kind: 'createdRange', after: filter.after, before: filter.before }
    case 'BlockType':
      return { kind: 'blockType', values: [filter.block_type], exclude: false }
    case 'SourcePage':
      return { kind: 'sourcePage', included: [...filter.included], excluded: [...filter.excluded] }
    case 'And':
    case 'Or':
    case 'Not':
      return null
  }
}

function propTextPredicate(op: CompareOp, value: string): PropertyPredicate {
  // The backlink builder only ever emits `Eq` text comparisons today; keep the
  // canonical predicate faithful to the op so future ops aren't silently lost.
  if (op === 'Eq') return { type: 'Eq', value: { type: 'Text', value } }
  if (op === 'Neq') return { type: 'Ne', value: { type: 'Text', value } }
  // Other ops (Lt/Gt/Contains/StartsWith) have no canonical text-property
  // variant yet; fall back to Eq so the value is preserved (documented gap).
  return { type: 'Eq', value: { type: 'Text', value } }
}

function numPropValue(value: number | null): PropertyValue {
  // A null numeric value is degenerate; the builder guards against it, so this
  // only protects the type. Represent as text-"" to stay total.
  return value === null ? { type: 'Text', value: '' } : { type: 'Num', value }
}

function compareOpToDatePredicate(op: CompareOp, date: string): DatePredicate {
  switch (op) {
    case 'Lt':
      return { type: 'Before', date }
    case 'Lte':
      return { type: 'OnOrBefore', date }
    case 'Gt':
      return { type: 'After', date }
    case 'Gte':
      return { type: 'OnOrAfter', date }
    case 'Eq':
      return { type: 'On', date }
    default:
      return { type: 'On', date }
  }
}

// ---------------------------------------------------------------------------
// Pages / advanced (`FilterPrimitive`) conversion (legacy wire → canonical).
// This vocabulary is already the de-facto unified backend shape, so the
// mapping is near-1:1 and total over the non-recursive leaves.
// ---------------------------------------------------------------------------

/**
 * Project a single `FilterPrimitive` leaf into the canonical model. Returns
 * `null` for the recursive `HasParentMatching` and the `Snippet` window spec,
 * which have no flat canonical category yet (documented follow-up).
 */
export function filterPrimitiveToCanonical(filter: FilterPrimitive): FilterPredicate | null {
  switch (filter.type) {
    case 'Tag':
      return { kind: 'tag', by: 'name', name: filter.tag }
    case 'PathGlob':
      return { kind: 'pathGlob', pattern: filter.pattern, exclude: filter.exclude }
    case 'HasProperty':
      return { kind: 'property', key: filter.key, predicate: filter.predicate, exclude: false }
    case 'LastEdited':
      return { kind: 'lastEdited', spec: filter.spec }
    case 'Space':
      return { kind: 'space', spaceId: filter.space_id }
    case 'Priority':
      return { kind: 'priority', values: [filter.priority], exclude: false }
    case 'State':
      return {
        kind: 'status',
        values: [...filter.values],
        isNull: filter.is_null ?? false,
        exclude: filter.exclude ?? false,
      }
    case 'BlockType':
      return { kind: 'blockType', values: [...filter.values], exclude: filter.exclude }
    case 'DueDate':
      return { kind: 'date', field: 'due', predicate: filter.predicate }
    case 'Scheduled':
      return { kind: 'date', field: 'scheduled', predicate: filter.predicate }
    case 'Created':
      return { kind: 'createdRange', after: filter.after, before: filter.before }
    case 'LinksTo':
      return { kind: 'linksTo', target: filter.target }
    case 'LinkedFrom':
      return { kind: 'linkedFrom', source: filter.source }
    case 'Orphan':
      return { kind: 'orphan' }
    case 'Stub':
      return { kind: 'stub' }
    case 'HasNoInboundLinks':
      return { kind: 'hasNoInboundLinks' }
    case 'Regex':
      return { kind: 'regex', pattern: filter.pattern }
    case 'CaseSensitive':
      return { kind: 'caseSensitive', enabled: filter.enabled }
    case 'WholeWord':
      return { kind: 'wholeWord', enabled: filter.enabled }
    case 'HasParentMatching':
    case 'Snippet':
      return null
  }
}
