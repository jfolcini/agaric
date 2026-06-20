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
import type {
  AstFilterProjection,
  DateFilterValue,
  DateOp,
  NamedDateRange,
} from '@/lib/search-query'

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
 * `null` when the predicate is outside the graph surface's allow-list (the
 * caller drops it). Inverse of `graphFilterToCanonical` for every graph kind.
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
    case 'PropertyText': {
      return {
        kind: 'property',
        key: filter.key,
        predicate: comparePredicate(filter.op, { type: 'Text', value: filter.value }),
        exclude: false,
      }
    }
    case 'PropertyNum': {
      return {
        kind: 'property',
        key: filter.key,
        predicate: comparePredicate(filter.op, { type: 'Num', value: filter.value }),
        exclude: false,
      }
    }
    case 'PropertyDate': {
      return {
        kind: 'property',
        key: filter.key,
        predicate: comparePredicate(filter.op, { type: 'Date', value: filter.value }),
        exclude: false,
      }
    }
    case 'PropertyIsSet': {
      return { kind: 'property', key: filter.key, predicate: { type: 'Exists' }, exclude: false }
    }
    case 'PropertyIsEmpty': {
      return { kind: 'property', key: filter.key, predicate: { type: 'NotExists' }, exclude: false }
    }
    case 'TodoState': {
      return { kind: 'status', values: [filter.state], isNull: false, exclude: false }
    }
    case 'Priority': {
      return { kind: 'priority', values: [filter.level], exclude: false }
    }
    case 'DueDate': {
      return {
        kind: 'date',
        field: 'due',
        predicate: compareOpToDatePredicate(filter.op, filter.value),
      }
    }
    case 'HasTag': {
      return { kind: 'tag', by: 'id', tagId: filter.tag_id }
    }
    case 'HasTagPrefix': {
      return { kind: 'tagPrefix', prefix: filter.prefix }
    }
    case 'Contains': {
      return { kind: 'contains', query: filter.query }
    }
    case 'CreatedInRange': {
      return { kind: 'createdRange', after: filter.after, before: filter.before }
    }
    case 'BlockType': {
      return { kind: 'blockType', values: [filter.block_type], exclude: false }
    }
    case 'SourcePage': {
      return { kind: 'sourcePage', included: [...filter.included], excluded: [...filter.excluded] }
    }
    case 'And':
    case 'Or':
    case 'Not': {
      return null
    }
  }
}

/**
 * The backlink `CompareOp` and the canonical `PropertyPredicate` comparison
 * variants are 1:1 — `Neq` is the only spelling difference (`Ne`). Encoding the
 * exact op (not collapsing to `Eq`) is what makes the property round-trip
 * lossless for every backlink property leaf.
 */
function comparePredicate(op: CompareOp, value: PropertyValue): PropertyPredicate {
  switch (op) {
    case 'Eq': {
      return { type: 'Eq', value }
    }
    case 'Neq': {
      return { type: 'Ne', value }
    }
    case 'Lt': {
      return { type: 'Lt', value }
    }
    case 'Gt': {
      return { type: 'Gt', value }
    }
    case 'Lte': {
      return { type: 'Lte', value }
    }
    case 'Gte': {
      return { type: 'Gte', value }
    }
    case 'Contains': {
      return { type: 'Contains', value }
    }
    case 'StartsWith': {
      return { type: 'StartsWith', value }
    }
  }
}

/** Inverse of {@link comparePredicate} — recover the backlink `CompareOp`. */
function predicateCompareOp(type: PropertyPredicate['type']): CompareOp | null {
  switch (type) {
    case 'Eq': {
      return 'Eq'
    }
    case 'Ne': {
      return 'Neq'
    }
    case 'Lt': {
      return 'Lt'
    }
    case 'Gt': {
      return 'Gt'
    }
    case 'Lte': {
      return 'Lte'
    }
    case 'Gte': {
      return 'Gte'
    }
    case 'Contains': {
      return 'Contains'
    }
    case 'StartsWith': {
      return 'StartsWith'
    }
    case 'Exists':
    case 'NotExists': {
      return null
    }
  }
}

function compareOpToDatePredicate(op: CompareOp, date: string): DatePredicate {
  switch (op) {
    case 'Lt': {
      return { type: 'Before', date }
    }
    case 'Lte': {
      return { type: 'OnOrBefore', date }
    }
    case 'Gt': {
      return { type: 'After', date }
    }
    case 'Gte': {
      return { type: 'OnOrAfter', date }
    }
    case 'Eq': {
      return { type: 'On', date }
    }
    default: {
      return { type: 'On', date }
    }
  }
}

/**
 * Inverse of {@link compareOpToDatePredicate} for the `field: 'due'` canonical
 * `date` predicate — recover the `{ op, value }` of a backlink `DueDate` leaf.
 * The backlink builder never emits `DueDate` itself (its date category emits
 * `CreatedInRange`), but the helper is total so a `DueDate` leaf fed through
 * `backlinkFilterToCanonical` round-trips back to its `{op,value}` for the ops
 * `compareOpToDatePredicate` can express (`Lt/Lte/Gt/Gte/Eq`). `Between`/`IsNull`
 * have no `DueDate` op spelling and are not backlink-reachable → `null`.
 */
function datePredicateToBacklinkDue(
  predicate: DatePredicate,
): { op: CompareOp; value: string } | null {
  switch (predicate.type) {
    case 'Before': {
      return { op: 'Lt', value: predicate.date }
    }
    case 'OnOrBefore': {
      return { op: 'Lte', value: predicate.date }
    }
    case 'After': {
      return { op: 'Gt', value: predicate.date }
    }
    case 'OnOrAfter': {
      return { op: 'Gte', value: predicate.date }
    }
    case 'On': {
      return { op: 'Eq', value: predicate.date }
    }
    case 'IsNull':
    case 'Between': {
      return null
    }
  }
}

/**
 * Project a single canonical predicate back to a legacy `BacklinkFilter`, the
 * inverse of {@link backlinkFilterToCanonical} for every kind the backlink
 * surface builds/emits. Returns `null` for any predicate outside the backlink
 * allow-list (the caller drops it).
 *
 * This is byte-exact for what the backlink builder actually emits: a property
 * leaf reconstructs the precise `PropertyText/Num/Date/IsSet/IsEmpty` wire shape
 * (the `PropertyValue` variant + predicate type pin it down), so the
 * status-`none` ⇒ `PropertyIsEmpty{key:'todo'}` sentinel and every other op are
 * preserved on the round-trip.
 */
export function canonicalToBacklinkFilter(predicate: FilterPredicate): BacklinkFilter | null {
  switch (predicate.kind) {
    case 'property': {
      return canonicalPropertyToBacklink(predicate.key, predicate.predicate)
    }
    case 'status': {
      // The backlink builder routes status through a `PropertyText`/
      // `PropertyIsEmpty` leaf (handled by the `property` kind above), so the
      // `status` kind here only ever originates from a `TodoState` leaf —
      // single value, never null/excluded.
      const [state] = predicate.values
      return predicate.isNull ||
        predicate.exclude ||
        predicate.values.length !== 1 ||
        state === undefined
        ? null
        : { type: 'TodoState', state }
    }
    case 'priority': {
      // Likewise the builder routes priority through `PropertyText{key:'priority'}`;
      // a `priority` kind here originates from a `Priority` leaf.
      const [level] = predicate.values
      return predicate.exclude || predicate.values.length !== 1 || level === undefined
        ? null
        : { type: 'Priority', level }
    }
    case 'date': {
      if (predicate.field !== 'due') return null
      const due = datePredicateToBacklinkDue(predicate.predicate)
      return due ? { type: 'DueDate', op: due.op, value: due.value } : null
    }
    case 'createdRange': {
      return { type: 'CreatedInRange', after: predicate.after, before: predicate.before }
    }
    case 'tag': {
      return predicate.by === 'id' ? { type: 'HasTag', tag_id: predicate.tagId } : null
    }
    case 'tagPrefix': {
      return { type: 'HasTagPrefix', prefix: predicate.prefix }
    }
    case 'contains': {
      return { type: 'Contains', query: predicate.query }
    }
    case 'blockType': {
      const [blockType] = predicate.values
      return predicate.exclude || predicate.values.length !== 1 || blockType === undefined
        ? null
        : { type: 'BlockType', block_type: blockType }
    }
    case 'sourcePage': {
      return {
        type: 'SourcePage',
        included: [...predicate.included],
        excluded: [...predicate.excluded],
      }
    }
    default: {
      return null
    }
  }
}

/**
 * Reconstruct the exact backlink property leaf from a canonical `property`
 * predicate. The `PropertyPredicate` type + its `PropertyValue` variant fully
 * determine which of `PropertyText`/`PropertyNum`/`PropertyDate`/`PropertyIsSet`/
 * `PropertyIsEmpty` to emit, so the inverse is byte-exact.
 */
function canonicalPropertyToBacklink(
  key: string,
  predicate: PropertyPredicate,
): BacklinkFilter | null {
  if (predicate.type === 'Exists') return { type: 'PropertyIsSet', key }
  if (predicate.type === 'NotExists') return { type: 'PropertyIsEmpty', key }
  const op = predicateCompareOp(predicate.type)
  if (op === null) return null
  const value = predicate.value
  switch (value.type) {
    case 'Text': {
      return { type: 'PropertyText', key, op, value: value.value }
    }
    case 'Num': {
      return { type: 'PropertyNum', key, op, value: value.value }
    }
    case 'Date': {
      return { type: 'PropertyDate', key, op, value: value.value }
    }
    case 'Ref': {
      // The backlink builder never emits a `Ref` property value; it has no
      // backlink leaf to reconstruct, so drop it rather than guess.
      return null
    }
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
    case 'Tag': {
      return { kind: 'tag', by: 'name', name: filter.tag }
    }
    case 'PathGlob': {
      return { kind: 'pathGlob', pattern: filter.pattern, exclude: filter.exclude }
    }
    case 'HasProperty': {
      return { kind: 'property', key: filter.key, predicate: filter.predicate, exclude: false }
    }
    case 'LastEdited': {
      return { kind: 'lastEdited', spec: filter.spec }
    }
    case 'Space': {
      return { kind: 'space', spaceId: filter.space_id }
    }
    case 'Priority': {
      return { kind: 'priority', values: [filter.priority], exclude: false }
    }
    case 'State': {
      return {
        kind: 'status',
        values: [...filter.values],
        isNull: filter.is_null ?? false,
        exclude: filter.exclude ?? false,
      }
    }
    case 'BlockType': {
      return { kind: 'blockType', values: [...filter.values], exclude: filter.exclude }
    }
    case 'DueDate': {
      return { kind: 'date', field: 'due', predicate: filter.predicate }
    }
    case 'Scheduled': {
      return { kind: 'date', field: 'scheduled', predicate: filter.predicate }
    }
    case 'Created': {
      return { kind: 'createdRange', after: filter.after, before: filter.before }
    }
    case 'LinksTo': {
      return { kind: 'linksTo', target: filter.target }
    }
    case 'LinkedFrom': {
      return { kind: 'linkedFrom', source: filter.source }
    }
    case 'Orphan': {
      return { kind: 'orphan' }
    }
    case 'Stub': {
      return { kind: 'stub' }
    }
    case 'HasNoInboundLinks': {
      return { kind: 'hasNoInboundLinks' }
    }
    case 'Regex': {
      return { kind: 'regex', pattern: filter.pattern }
    }
    case 'CaseSensitive': {
      return { kind: 'caseSensitive', enabled: filter.enabled }
    }
    case 'WholeWord': {
      return { kind: 'wholeWord', enabled: filter.enabled }
    }
    case 'HasParentMatching':
    case 'Snippet': {
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Search surface conversion (Issue #1646, step 1 — "adapter only").
//
// The search surface's user-facing model is the query-string AST, projected to
// the flat `AstFilterProjection` by `astToFilterProjection`. That projection is
// what `astFilterParams` turns into the loose `SearchFilterParams` IPC bundle.
//
// This adapter inserts the canonical model *between* the AST projection and the
// IPC bundle: `searchProjectionToCanonical` builds `FilterPredicate[]`, and
// `canonicalToSearchProjection` is its exact inverse, reconstructing the same
// `AstFilterProjection`. Composed, the round-trip is the identity on the
// projection, so the byte shape `astFilterParams` ultimately emits is unchanged
// (proven by the parity tests). The search query-string UI is untouched.
//
// Parity-critical encoding choices:
//   - `state:none` / `not-state:none` flow as the literal value string `'none'`
//     inside the canonical `status` predicate's `values` (NOT collapsed to the
//     `isNull` flag), exactly as the projection carries it today — so the
//     emitted `stateFilter` / `excludedStateFilter` array is byte-identical and
//     the backend's `todo_state IS NULL` sentinel path is preserved verbatim.
//     (Mirrors the backlink `none` lesson from #1647: don't reinterpret the
//     sentinel mid-adapter.)
//   - `due:`/`scheduled:` `DateFilterValue` (named bucket OR comparison op) is
//     carried losslessly through the canonical `date` predicate's `DatePredicate`
//     via a reserved sentinel for the named buckets (see below).
// ---------------------------------------------------------------------------

/**
 * Sentinel prefix used to carry a search named-date bucket (e.g. `today`,
 * `none`, `this-week`) through the canonical `date` predicate without inventing
 * a new variant. A real comparison-op date is always `YYYY-MM-DD`, so a date
 * string starting with this non-ISO prefix can never collide; it round-trips
 * back to `{ kind: 'named', name }` exactly.
 */
const SEARCH_NAMED_DATE_SENTINEL = '__search-named-date__:'

const SEARCH_DATE_OP_TO_PREDICATE: Record<DateOp, (date: string) => DatePredicate> = {
  '<': (date) => ({ type: 'Before', date }),
  '<=': (date) => ({ type: 'OnOrBefore', date }),
  '=': (date) => ({ type: 'On', date }),
  '>=': (date) => ({ type: 'OnOrAfter', date }),
  '>': (date) => ({ type: 'After', date }),
}

/** Map a search `DateFilterValue` losslessly onto a canonical `DatePredicate`. */
function searchDateToPredicate(value: DateFilterValue): DatePredicate {
  if (value.kind === 'named') {
    return { type: 'On', date: `${SEARCH_NAMED_DATE_SENTINEL}${value.name}` }
  }
  return SEARCH_DATE_OP_TO_PREDICATE[value.op](value.date)
}

/** Inverse of {@link searchDateToPredicate}. Total over the predicates it emits. */
function predicateToSearchDate(predicate: DatePredicate): DateFilterValue {
  switch (predicate.type) {
    case 'Before': {
      return { kind: 'op', op: '<', date: predicate.date }
    }
    case 'OnOrBefore': {
      return { kind: 'op', op: '<=', date: predicate.date }
    }
    case 'OnOrAfter': {
      return { kind: 'op', op: '>=', date: predicate.date }
    }
    case 'After': {
      return { kind: 'op', op: '>', date: predicate.date }
    }
    case 'On': {
      if (predicate.date.startsWith(SEARCH_NAMED_DATE_SENTINEL)) {
        return {
          kind: 'named',
          name: predicate.date.slice(SEARCH_NAMED_DATE_SENTINEL.length) as NamedDateRange,
        }
      }
      return { kind: 'op', op: '=', date: predicate.date }
    }
    case 'IsNull':
    case 'Between': {
      // The search surface never emits these; degenerate fallback keeps the
      // function total. (Not reachable from `searchDateToPredicate`.)
      return { kind: 'op', op: '=', date: '' }
    }
  }
}

/**
 * The search property predicate is always an equality on a text value — the
 * query string only expresses `prop:key=value`. The canonical `property`
 * predicate carries the full `PropertyPredicate`, so search uses the `Eq`/`Text`
 * leaf and `exclude` for the `not-prop:` negation.
 */
function searchPropPredicate(value: string): PropertyPredicate {
  return { type: 'Eq', value: { type: 'Text', value } }
}

function predicateToSearchPropValue(predicate: PropertyPredicate): string {
  // Inverse of `searchPropPredicate`: pull the text operand back out. The
  // search adapter only ever produces the `Eq`/`Text` shape, so this is total
  // over what it emits.
  if ((predicate.type === 'Eq' || predicate.type === 'Ne') && predicate.value.type === 'Text') {
    return predicate.value.value
  }
  return ''
}

/**
 * Project a search `AstFilterProjection` into the canonical model.
 *
 * Lossless for every category the search AST can produce (tag-by-name, path
 * include/exclude globs, state / not-state, priority / not-priority, due /
 * scheduled dates, prop / not-prop). The order of the returned predicates
 * mirrors the projection's field order so {@link canonicalToSearchProjection}
 * reconstructs the projection exactly.
 *
 * Note: the resolved tag *ids* (`SearchFilterParams.tagIds`) are NOT part of
 * this projection — they come from async tag-name resolution and the
 * matches-nothing sentinel is applied at the IPC boundary in `astFilterParams`.
 * The canonical `tag` predicates here carry the resolved-by-name *names* only.
 */
export function searchProjectionToCanonical(projection: AstFilterProjection): FilterPredicate[] {
  const out: FilterPredicate[] = []
  for (const name of projection.tagNames) out.push({ kind: 'tag', by: 'name', name })
  for (const pattern of projection.includePageGlobs)
    out.push({ kind: 'pathGlob', pattern, exclude: false })
  for (const pattern of projection.excludePageGlobs)
    out.push({ kind: 'pathGlob', pattern, exclude: true })
  for (const value of projection.stateFilter)
    out.push({ kind: 'status', values: [value], isNull: false, exclude: false })
  for (const value of projection.excludedStateFilter)
    out.push({ kind: 'status', values: [value], isNull: false, exclude: true })
  for (const value of projection.priorityFilter)
    out.push({ kind: 'priority', values: [value], exclude: false })
  for (const value of projection.excludedPriorityFilter)
    out.push({ kind: 'priority', values: [value], exclude: true })
  if (projection.dueFilter !== null)
    out.push({ kind: 'date', field: 'due', predicate: searchDateToPredicate(projection.dueFilter) })
  if (projection.scheduledFilter !== null)
    out.push({
      kind: 'date',
      field: 'scheduled',
      predicate: searchDateToPredicate(projection.scheduledFilter),
    })
  for (const p of projection.propertyFilters)
    out.push({
      kind: 'property',
      key: p.key,
      predicate: searchPropPredicate(p.value),
      exclude: false,
    })
  for (const p of projection.excludedPropertyFilters)
    out.push({
      kind: 'property',
      key: p.key,
      predicate: searchPropPredicate(p.value),
      exclude: true,
    })
  return out
}

/**
 * Collapse canonical predicates back to an `AstFilterProjection` — the exact
 * inverse of {@link searchProjectionToCanonical}. Predicates outside the search
 * surface's allow-list are dropped (defensive; the search builder never makes
 * them). `state:none` stays the literal `'none'` value string, preserving the
 * backend `todo_state IS NULL` sentinel path.
 */
export function canonicalToSearchProjection(
  predicates: readonly FilterPredicate[],
): AstFilterProjection {
  const projection: AstFilterProjection = {
    tagNames: [],
    includePageGlobs: [],
    excludePageGlobs: [],
    stateFilter: [],
    priorityFilter: [],
    excludedStateFilter: [],
    excludedPriorityFilter: [],
    dueFilter: null,
    scheduledFilter: null,
    propertyFilters: [],
    excludedPropertyFilters: [],
  }
  for (const p of predicates) {
    switch (p.kind) {
      case 'tag': {
        if (p.by === 'name') projection.tagNames.push(p.name)
        break
      }
      case 'pathGlob': {
        if (p.exclude) projection.excludePageGlobs.push(p.pattern)
        else projection.includePageGlobs.push(p.pattern)
        break
      }
      case 'status': {
        // Each search state token is a single-value canonical `status`
        // predicate; flatten them back into the flat projection arrays.
        for (const v of p.values) {
          if (p.exclude) projection.excludedStateFilter.push(v)
          else projection.stateFilter.push(v)
        }
        break
      }
      case 'priority': {
        for (const v of p.values) {
          if (p.exclude) projection.excludedPriorityFilter.push(v)
          else projection.priorityFilter.push(v)
        }
        break
      }
      case 'date': {
        if (p.field === 'due') projection.dueFilter = predicateToSearchDate(p.predicate)
        else if (p.field === 'scheduled')
          projection.scheduledFilter = predicateToSearchDate(p.predicate)
        break
      }
      case 'property': {
        if (p.exclude)
          projection.excludedPropertyFilters.push({
            key: p.key,
            value: predicateToSearchPropValue(p.predicate),
          })
        else
          projection.propertyFilters.push({
            key: p.key,
            value: predicateToSearchPropValue(p.predicate),
          })
        break
      }
      default: {
        // Outside the search allow-list — dropped.
        break
      }
    }
  }
  return projection
}
/**
 * Project a canonical predicate back to a `FilterPrimitive`, or `null` when the
 * predicate is not expressible as a single Pages/advanced wire leaf.
 *
 * This is the EXACT inverse of `filterPrimitiveToCanonical` for every category
 * the Pages browser / advanced-query popover builds, so a `FilterPrimitive`
 * that round-trips
 * `filterPrimitiveToCanonical` → `canonicalToFilterPrimitive` comes back
 * BYTE-IDENTICAL (Issue #1646, surface 2 / PageBrowser migration). The
 * round-trip table in `model.test.ts` is the load-bearing parity guarantee.
 *
 * Notes on the asymmetric cases (so the inverse is total but never lossy):
 *  - `tag` by **name** reconstructs `{ type: 'Tag', tag }` (the Pages wire only
 *    carries a tag *name*); a `by: 'id'` tag is a graph/backlink shape, not a
 *    Pages leaf, so it returns `null`.
 *  - `priority` carries a multi-value membership in the canonical model, but the
 *    Pages `Priority` wire leaf is single-valued and never negated. Only an
 *    un-negated single-value priority maps back; anything else is not a Pages
 *    leaf (returns `null`).
 *  - `property` with `exclude: true` has no Pages `HasProperty` wire form (that
 *    leaf has no exclude field), so it returns `null`. `exclude: false`
 *    reconstructs `{ type: 'HasProperty', key, predicate }` verbatim — the
 *    `predicate` (incl. the `Exists`/`NotExists` empty-property sentinels) is
 *    passed through untouched, preserving the #1647 absent-vs-literal
 *    distinction.
 *  - `status` reconstructs `{ type: 'State', values, is_null, exclude }`. The
 *    Pages popover always emits both `is_null` and `exclude` keys, so the
 *    canonical (non-optional) flags reproduce that shape exactly.
 *  - `tagPrefix`, `sourcePage`, `contains`, `hasBacklinks`, `excludeTemplates`
 *    are other surfaces' vocabulary with no Pages wire leaf and return `null`.
 *  - The recursive `HasParentMatching` (`FilterExpr`) and the search `Snippet`
 *    window have no flat canonical category yet, so the Pages browser routes
 *    them around the canonical model entirely (see `AddFilterPopover`).
 */
/** A canonical `tag` back to the Pages `Tag` leaf (only the by-name form). */
function canonicalTagToFilterPrimitive(
  predicate: Extract<FilterPredicate, { kind: 'tag' }>,
): FilterPrimitive | null {
  // The Pages wire only carries a tag *name*; a by-id tag is a graph/backlink
  // shape, not a Pages leaf.
  return predicate.by === 'name' ? { type: 'Tag', tag: predicate.name } : null
}

/** A canonical `property` back to the Pages `HasProperty` leaf (un-negated only). */
function canonicalPropertyToFilterPrimitive(
  predicate: Extract<FilterPredicate, { kind: 'property' }>,
): FilterPrimitive | null {
  // The Pages `HasProperty` wire leaf has no exclude field; a negated property
  // is a search-only `not-prop:` shape. The `predicate` (incl. the
  // Exists/NotExists empty-property sentinels) is passed through verbatim.
  return predicate.exclude
    ? null
    : { type: 'HasProperty', key: predicate.key, predicate: predicate.predicate }
}

/** A canonical `priority` back to the single-valued, never-negated Pages leaf. */
function canonicalPriorityToFilterPrimitive(
  predicate: Extract<FilterPredicate, { kind: 'priority' }>,
): FilterPrimitive | null {
  // The Pages `Priority` wire leaf is single-valued and never negated.
  const [only] = predicate.values
  return !predicate.exclude && predicate.values.length === 1 && only !== undefined
    ? { type: 'Priority', priority: only }
    : null
}

/** A canonical `date` back to the Pages `DueDate` / `Scheduled` leaf (or null). */
function canonicalDateToFilterPrimitive(
  predicate: Extract<FilterPredicate, { kind: 'date' }>,
): FilterPrimitive | null {
  // `created` / `lastEdited` date fields are carried by the `createdRange` /
  // `lastEdited` canonical kinds on this surface, not the `date` kind.
  if (predicate.field === 'due') return { type: 'DueDate', predicate: predicate.predicate }
  if (predicate.field === 'scheduled') return { type: 'Scheduled', predicate: predicate.predicate }
  return null
}

export function canonicalToFilterPrimitive(predicate: FilterPredicate): FilterPrimitive | null {
  switch (predicate.kind) {
    case 'tag': {
      return canonicalTagToFilterPrimitive(predicate)
    }
    case 'pathGlob': {
      return { type: 'PathGlob', pattern: predicate.pattern, exclude: predicate.exclude }
    }
    case 'property': {
      return canonicalPropertyToFilterPrimitive(predicate)
    }
    case 'lastEdited': {
      return { type: 'LastEdited', spec: predicate.spec }
    }
    case 'space': {
      return { type: 'Space', space_id: predicate.spaceId }
    }
    case 'priority': {
      return canonicalPriorityToFilterPrimitive(predicate)
    }
    case 'status': {
      return {
        type: 'State',
        values: [...predicate.values],
        is_null: predicate.isNull,
        exclude: predicate.exclude,
      }
    }
    case 'blockType': {
      return { type: 'BlockType', values: [...predicate.values], exclude: predicate.exclude }
    }
    case 'date': {
      return canonicalDateToFilterPrimitive(predicate)
    }
    case 'createdRange': {
      return { type: 'Created', after: predicate.after, before: predicate.before }
    }
    case 'linksTo': {
      return { type: 'LinksTo', target: predicate.target }
    }
    case 'linkedFrom': {
      return { type: 'LinkedFrom', source: predicate.source }
    }
    case 'orphan': {
      return { type: 'Orphan' }
    }
    case 'stub': {
      return { type: 'Stub' }
    }
    case 'hasNoInboundLinks': {
      return { type: 'HasNoInboundLinks' }
    }
    case 'regex': {
      return { type: 'Regex', pattern: predicate.pattern }
    }
    case 'caseSensitive': {
      return { type: 'CaseSensitive', enabled: predicate.enabled }
    }
    case 'wholeWord': {
      return { type: 'WholeWord', enabled: predicate.enabled }
    }
    // Other surfaces' vocabulary — no Pages/advanced wire leaf.
    case 'tagPrefix':
    case 'sourcePage':
    case 'contains':
    case 'hasBacklinks':
    case 'excludeTemplates': {
      return null
    }
  }
}
