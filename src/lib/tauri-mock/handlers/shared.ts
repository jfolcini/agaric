/**
 * Shared state accessors, types, and pure helpers for the per-domain
 * tauri-mock handler modules (`src/lib/tauri-mock/handlers/*.ts`).
 *
 * This module is the SINGLE place every domain handler module imports
 * mutable mock state (`blocks`, `opLog`, `properties`, …) and cross-domain
 * helpers from. It re-exports the seed-module stores it uses directly rather
 * than owning its own copies — ES module resolution caches `seed.ts` as one
 * singleton instance, so every domain module importing state from here (or
 * from `seed.ts` directly) reads/writes the exact same in-memory maps/arrays.
 * There is no per-domain duplication of shared mutable state.
 *
 * Split out of the former monolithic `handlers.ts` (#2931) verbatim — no
 * behavior changed, only relocated. See `handlers.ts` for the barrel that
 * recombines the per-domain handler maps into the single `HANDLERS_TYPED`
 * command surface.
 */

import type { AppError, PageResponse, commands } from '@/lib/bindings'
import { asciiLowercase, pageGlobFilterMatches } from '@/lib/search-query/glob-validate'
import { applyRevertForOp } from '@/lib/tauri-mock/revert'
import {
  blocks,
  blockTagRefs,
  blockTags,
  type MockOpLogEntry,
  opLog,
  pageLastModified,
  properties,
  propertyDefs,
  pushOp,
} from '@/lib/tauri-mock/seed'

export function appErrorRejection(err: AppError): Error & AppError {
  return Object.assign(new Error(err.message), err)
}

/** Shorthand for a mock `not_found` rejection — mirrors `AppError::NotFound` (#2463 kind-parity rule). */
export function notFoundRejection(message: string): Error & AppError {
  return appErrorRejection({ kind: 'not_found', message })
}

/** Shorthand for a mock uncoded `validation` rejection — mirrors `AppError::validation(...)` (#2463 kind-parity rule). */
export function validationRejection(message: string): Error & AppError {
  return appErrorRejection({ kind: 'validation', message })
}

/** Shorthand for a mock `invalid_operation` rejection — mirrors `AppError::InvalidOperation(...)` (#2463 kind-parity rule). */
export function invalidOperationRejection(message: string): Error & AppError {
  return appErrorRejection({ kind: 'invalid_operation', message })
}

/**
 * #3091 — mirror the backend's reserved-key value VALIDATION (NOT
 * normalization: `validate_reserved_property_value` in
 * `commands/properties.rs` and `validate_set_property` in `agaric-store/op.rs`
 * only validate — they never rewrite casing or reformat dates, so the mock must
 * not either). Throws a `validation` rejection when:
 *   1. a `todo_state` value is outside its option set, matched
 *      CASE-SENSITIVELY (the backend's `defaults.contains(&value)` /
 *      `property_definitions.options` membership check — a lowercase `done`
 *      is REJECTED, never silently upper-cased);
 *   2. a reserved DATE key (`due_date` / `scheduled_date`) or `todo_state`
 *      carries an empty/whitespace-only value (`set_property.value_date.empty`
 *      / `set_property.value_text.empty`).
 *
 * `priority` is intentionally NOT membership-validated here: its option set is
 * user-configurable (`set_priority_levels`), so the valid set depends on the
 * live `property_definitions` row when one exists. The backend DOES fall back
 * to a fixed `["1","2","3"]` when no definition row is present (same shape as
 * the todo_state fallback), so the mock is knowingly PERMISSIVE for priority:
 * enforcing the fixed fallback would false-fail tests that configure custom
 * levels without seeding a definition row. The mock enforces `todo_state`
 * membership (its `TODO/DOING/DONE` defaults are stable) and non-empty values,
 * and leaves `priority` values unrestricted.
 */
const TODO_STATE_DEFAULTS: readonly string[] = ['TODO', 'DOING', 'DONE']

export function assertValidReservedPropertyValue(
  key: string,
  channel: 'value_text' | 'value_date',
  value: string | null,
): void {
  if (value === null) return
  if (channel === 'value_date') {
    // Backend rejects an empty/whitespace value_date (`set_property.value_date.empty`);
    // it does NOT reformat or otherwise normalize the date string.
    if (value.trim() === '') {
      throw validationRejection('set_property.value_date.empty')
    }
    return
  }
  if (key !== 'todo_state') return
  if (value.trim() === '') {
    throw validationRejection('set_property.value_text.empty')
  }
  // Validate against the seeded definition's options if present, else the
  // built-in TODO/DOING/DONE defaults (the `validate_reserved_property_value`
  // fallback the mock's definition-less store always lands on).
  const def = propertyDefs.get('todo_state')
  const rawOptions = def?.['value_type'] === 'select' ? (def['options'] as string | null) : null
  const options =
    rawOptions !== null && rawOptions !== undefined
      ? (JSON.parse(rawOptions) as string[])
      : TODO_STATE_DEFAULTS
  if (!options.includes(value)) {
    throw validationRejection(
      `todo_state '${value}' is not in allowed options: ${options.join(', ')}`,
    )
  }
}

/**
 * #2656 — mirror the real backend's `set_property` value validation
 * (`op.rs::validate_property_value` + the select-membership check in
 * `block_ops.rs`). Throws a `validation` rejection when:
 *   1. `value_text` is `Some` but trims to empty — text/select properties can
 *      never be created "empty" (`op.rs` → `set_property.value_text.empty`);
 *   2. a select-typed key carries a `value_text` outside its seeded options.
 * Keeps the mock honest so the empty-`value_text` picker/slash bug fails in
 * tests instead of passing silently.
 */
export function assertValidSetPropertyValue(key: string, valueText: string | null): void {
  if (typeof valueText === 'string' && valueText.trim() === '') {
    throw validationRejection('set_property.value_text.empty')
  }
  if (valueText === null) return
  const def = propertyDefs.get(key)
  if (def?.['value_type'] !== 'select') return
  const rawOptions = def['options'] as string | null
  // A NULL options column means "no restriction" — the real backend
  // (`block_ops.rs`, `if let Some(opts_json) = options_json`) skips the
  // membership check for a select definition without a declared option set,
  // so custom select keys stay flexible. Mirror that: only enforce membership
  // when options are actually declared, else the mock would be stricter than
  // the backend (a false gate).
  if (rawOptions === null) return
  const options = JSON.parse(rawOptions) as string[]
  if (!options.includes(valueText)) {
    throw validationRejection(
      `set_property.value_text.invalid_option: '${valueText}' not in [${options.join(', ')}]`,
    )
  }
}

/**
 * Ref-INCLUSIVE tag set for a block: ATTACHED tags (`block_tags`) ∪ inline tag
 * REFERENCES (`block_tag_refs`). This is the set legacy tag queries
 * (`query_by_tags`, `filtered_blocks_query`) and the rich `TagOrRef` primitive
 * match against; the attached-only `Tag` primitive uses `blockTags` directly.
 */
export function refInclusiveTags(blockId: string): Set<string> {
  const attached = blockTags.get(blockId)
  const refs = blockTagRefs.get(blockId)
  if (!refs || refs.size === 0) return attached ?? new Set()
  const union = new Set(attached ?? [])
  for (const t of refs) union.add(t)
  return union
}

export type Handler = (args: unknown) => unknown

// #1775 — distinct soft-delete cohort markers. The backend keys restore on a
// delete op's `created_at` (epoch-ms); two ops in the same ms can collide on
// the raw clock value, but total ordering (and thus cohort identity) is
// established by the composite `(created_at, seq)` key. We mirror that here by
// folding a monotonic counter into each delete op's `deleted_at`, so two
// distinct `delete_block` ops NEVER share a cohort marker even when issued in
// the same wall-clock millisecond (a real possibility under fake timers / fast
// synchronous test/e2e dispatch). The conformance snapshot normalizes any
// non-null `deleted_at` to `"DELETED"`, so the exact string is irrelevant to
// callers — only that distinct cohorts get distinct markers, which the cohort
// restore walk depends on to leave an independently-deleted descendant deleted.
let cohortSeq = 0
export function nextCohortMarker(): string {
  cohortSeq += 1
  // ISO-shaped + monotonic suffix → sortable, distinct, and still a truthy
  // string the rest of the mock treats as "deleted".
  return `${new Date().toISOString()}#${cohortSeq.toString().padStart(6, '0')}`
}

/**
 * #1472 — the adjacently-tagged `TagExpr` wire shape (`{ type, value }`,
 * matching the Rust `#[serde(tag = "type", content = "value")]` enum and the
 * specta-generated TS union in `bindings.ts`). Declared locally so the mock
 * stays self-contained, mirroring the other `Mock*` row types in this file.
 */
export type TagExprNode =
  | { type: 'Tag'; value: string }
  | { type: 'Prefix'; value: string }
  | { type: 'And'; value: TagExprNode[] }
  | { type: 'Or'; value: TagExprNode[] }
  | { type: 'Not'; value: TagExprNode }

// Stub return shapes used by handlers that don't need behaviour beyond a
// type-correct empty payload. `list_projected_agenda` is cursor-paginated
// And returns a `PageResponse<T>` shape, NOT a bare array — using
// `returnEmptyArray` for it crashes consumers that read `response.items`.
export const returnNull: Handler = () => null
export const returnUndefined: Handler = () => undefined

// In-memory system clipboard for the browser/e2e harness. The real
// `src/lib/clipboard.ts` prefers the Tauri clipboard plugin over
// `navigator.clipboard`, so block copy/cut/paste round-trips through these
// `plugin:clipboard-manager|write_text` / `read_text` IPCs — NOT navigator.
// Persisting the text here (instead of a `write_text` no-op + unhandled
// `read_text`) lets e2e drive the genuine copy→paste pipeline through the
// production clipboard lib. (#976 finding 1 testability.)
let mockClipboardText = ''
export const clipboardWriteText: Handler = (args) => {
  mockClipboardText = ((args as Record<string, unknown>)['text'] as string | undefined) ?? ''
  return null
}
export const clipboardReadText: Handler = () => mockClipboardText
// Not annotated `: Handler` — the precise inferred return types (an array /
// a full page envelope) must flow through so the `satisfies TypedHandlers`
// contract on HANDLERS can verify them for array- and page-returning commands
// (#2241). Both remain assignable to `Handler` where used for other commands.
export const returnEmptyArray = (): unknown[] => []
export const returnEmptyPage = () => ({
  items: [],
  next_cursor: null,
  has_more: false,
  total_count: null,
})

/**
 * A `[[ULID]]`-derived block-link edge — mock stand-in for `block_links`.
 * `sourcePageId` is the owning page of the source block (a page block owns
 * itself, a descendant carries its ancestor `page_id`, an orphan is `null`).
 * It is what the same-page/self/orphan-source exclusion (migration 0070)
 * reads to decide whether an edge counts toward a target page's inbound total.
 */
export interface MockLinkEdge {
  sourceId: string
  targetId: string
  sourcePageId: string | null
}

/**
 * Scan every non-deleted block's content for `[[ULID]]` tokens and return the
 * implied block-link edges. The faithful mock stand-in for the backend's
 * `block_links` table — used to evaluate the link facets (`Orphan` /
 * `HasNoInboundLinks`) and the `MostLinked` sort. Mirrors the `get_backlinks`
 * scan. Each edge captures the source block's `page_id` so `pageLinkStats`
 * can apply the same-page/self/orphan-source inbound exclusion (migration
 * 0070 + `recompute_pages_cache_counts_for_pages`).
 */
export function deriveLinkEdges(allBlocks: Map<string, Record<string, unknown>>): MockLinkEdge[] {
  const LINK_RE = /\[\[([0-9A-Z]{26})\]\]/g
  const edges: MockLinkEdge[] = []
  for (const blk of allBlocks.values()) {
    if (blk['deleted_at']) continue
    const content = (blk['content'] as string | null) ?? ''
    if (!content.includes('[[')) continue
    const sourcePageId = (blk['page_id'] as string | null) ?? null
    for (const m of content.matchAll(LINK_RE)) {
      edges.push({ sourceId: blk['id'] as string, targetId: m[1] as string, sourcePageId })
    }
  }
  return edges
}

/**
 * Inbound/outbound link facts for a page, scoped to "page block OR any
 * non-deleted descendant" (matching migration 0069 + the fixed `Orphan`
 * Outbound term, -A). `inbound` = distinct sources linking in
 * (`COUNT(DISTINCT source_id)`); `hasOutbound` = the page or a descendant
 * authors an outbound link.
 *
 * `inbound` applies the same-page/self/orphan-source exclusion that the live
 * IPC reads off `pages_cache.inbound_link_count` (migration 0070 +
 * `recompute_pages_cache_counts_for_pages`): an edge counts only when its
 * source belongs to a DIFFERENT page (`src.page_id != target page` and
 * `src.page_id IS NOT NULL`). A block linking to another block on the same
 * page, a page-block self-link, or a link from an orphan/page-block source
 * (no resolvable `page_id`) is NOT inbound. `hasOutbound` is unaffected by
 * the exclusion — it answers "does this page author any outbound link".
 */
export function pageLinkStats(
  pageId: string,
  pageScopeIds: Set<string>,
  edges: ReadonlyArray<MockLinkEdge>,
): { inbound: number; hasOutbound: boolean } {
  const inboundSources = new Set<string>()
  let hasOutbound = false
  for (const e of edges) {
    if (pageScopeIds.has(e.targetId) && e.sourcePageId !== null && e.sourcePageId !== pageId) {
      inboundSources.add(e.sourceId)
    }
    if (pageScopeIds.has(e.sourceId)) hasOutbound = true
  }
  return { inbound: inboundSources.size, hasOutbound }
}

/**
 * Metadata-rich page row mirroring the camelCase `PageWithMetadataRow` wire
 * shape, plus the mock-internal `hasOutboundLink` used to evaluate `Orphan`.
 */
export interface PageMetaRow {
  id: string
  blockType: string
  content: string | null
  parentId: string | null
  position: number | null
  deletedAt: string | null
  todoState: string | null
  priority: string | null
  dueDate: string | null
  scheduledDate: string | null
  pageId: string | null
  lastModifiedAt: string | null
  inboundLinkCount: number
  childBlockCount: number
  hasOutboundLink: boolean
  flags: { hasTags: boolean; hasTodo: boolean; hasScheduled: boolean; hasDue: boolean }
}

/**
 * Does a page row satisfy one compound-filter primitive? The mock evaluates
 * `Stub` / `HasNoInboundLinks` / `Orphan` / `Tag` / `Priority` / `PathGlob` /
 * `HasProperty` / `LastEdited` faithfully (mirroring the REAL backend
 * semantics in `src-tauri/agaric-store/src/filters/primitive.rs`); any other primitive is
 * a permissive no-op (the backend owns those, and FE tests that need them
 * mock at the IPC boundary directly).
 */
export function metaRowMatchesFilter(r: PageMetaRow, f: Record<string, unknown>): boolean {
  switch (f['type'] as string) {
    case 'Stub': {
      return r.childBlockCount === 0
    }
    case 'HasNoInboundLinks': {
      return r.inboundLinkCount === 0
    }
    case 'Orphan': {
      return r.inboundLinkCount === 0 && !r.hasOutboundLink
    }
    case 'Tag': {
      return blockTags.get(r.id)?.has(f['tag'] as string) ?? false
    }
    case 'TagOrRef': {
      // Ref-inclusive: attached `block_tags` ∪ inline `block_tag_refs`.
      return refInclusiveTags(r.id).has(f['tag'] as string)
    }
    case 'ChildOf': {
      // Direct children of a block (`b.parent_id = ?`) — the legacy backlinks set.
      return r.parentId === (f['parent'] as string)
    }
    case 'Priority': {
      // Multi-value membership over `blocks.priority`, mirroring the REAL
      // backend's `in_or_null("b.priority", values, is_null, exclude)`
      // (src-tauri/agaric-store/src/filters/primitive.rs). INCLUDE: row matches if its
      // priority is in `values` OR (is_null AND priority IS NULL). EXCLUDE:
      // NULL-inclusive inversion — a NULL priority counts as "not in the
      // excluded set", and `is_null` ADDS "priority IS NOT NULL". An empty,
      // null-less set is a no-op (matches every row), mirroring the legacy
      // helper's early return.
      const values = (f['values'] as string[] | undefined) ?? []
      const isNull = (f['is_null'] as boolean | undefined) ?? false
      const exclude = (f['exclude'] as boolean | undefined) ?? false
      if (values.length === 0 && !isNull) {
        return true
      }
      const inValues = r.priority != null && values.includes(r.priority)
      if (exclude) {
        const notIn = r.priority == null || !inValues
        return isNull ? notIn || r.priority != null : notIn
      }
      return inValues || (isNull && r.priority == null)
    }
    case 'PathGlob': {
      // SQLite-`GLOB` dialect parity (#1910): brace expansion, `[class]`
      // ranges, validation and ASCII-only folding — see `pageGlobFilterMatches`.
      return pageGlobFilterMatches(
        (f['pattern'] as string) ?? '',
        r.content ?? '',
        (f['exclude'] as boolean) ?? false,
      )
    }
    case 'HasProperty': {
      return hasPropertyMatches(r, f)
    }
    case 'LastEdited': {
      return lastEditedMatches(r, f['spec'] as Record<string, unknown> | undefined)
    }
    case 'State': {
      // Multi-value membership over `blocks.todo_state`, identical shape to
      // `Priority` (mirrors the backend's `in_or_null("b.todo_state", …)`).
      const values = (f['values'] as string[] | undefined) ?? []
      const isNull = (f['is_null'] as boolean | undefined) ?? false
      const exclude = (f['exclude'] as boolean | undefined) ?? false
      if (values.length === 0 && !isNull) return true
      const inValues = r.todoState != null && values.includes(r.todoState)
      if (exclude) {
        const notIn = r.todoState == null || !inValues
        return isNull ? notIn || r.todoState != null : notIn
      }
      return inValues || (isNull && r.todoState == null)
    }
    case 'BlockType': {
      // Membership over `blocks.block_type`; `exclude` negates. Empty set is a
      // no-op (matches every row), mirroring the backend's early return.
      const values = (f['values'] as string[] | undefined) ?? []
      const exclude = (f['exclude'] as boolean | undefined) ?? false
      if (values.length === 0) return true
      const inValues = values.includes(r.blockType)
      return exclude ? !inValues : inValues
    }
    case 'DueDate': {
      return datePredicateMatches(r.dueDate, f['predicate'] as Record<string, unknown> | undefined)
    }
    case 'Scheduled': {
      return datePredicateMatches(
        r.scheduledDate,
        f['predicate'] as Record<string, unknown> | undefined,
      )
    }
    default: {
      return true
    }
  }
}

/**
 * Evaluate a wire `DatePredicate` against a stored `YYYY-MM-DD` date string,
 * mirroring the backend's date-column comparison (`DueDate` / `Scheduled`). ISO
 * day strings sort lexically, so string comparison is date comparison. `On` is
 * exact-day equality (day-granular columns), matching the legacy `value_date =`
 * semantics; `Between` is half-open `[from, to)`.
 */
export function datePredicateMatches(
  v: string | null,
  pred: Record<string, unknown> | undefined,
): boolean {
  const t = pred?.['type'] as string | undefined
  if (t === 'IsNull') return v == null
  if (v == null) return false
  switch (t) {
    case 'Before': {
      return v < (pred?.['date'] as string)
    }
    case 'After': {
      return v > (pred?.['date'] as string)
    }
    case 'OnOrBefore': {
      return v <= (pred?.['date'] as string)
    }
    case 'OnOrAfter': {
      return v >= (pred?.['date'] as string)
    }
    case 'On': {
      return v === (pred?.['date'] as string)
    }
    case 'Between': {
      return v >= (pred?.['from'] as string) && v < (pred?.['to'] as string)
    }
    default: {
      return true
    }
  }
}

/**
 * Recursively evaluate a wire `FilterExpr` tree against one row, mirroring the
 * backend engine's boolean composition over the shared per-primitive predicate
 * matrix (`compile_filter_expr` → And/Or/Not/Leaf):
 *   - `Leaf` → the single-primitive predicate (`metaRowMatchesFilter`)
 *   - `And`  → EVERY child matches; an empty `And` is TRUE (the engine's `1=1`)
 *   - `Or`   → AT LEAST ONE child matches; an empty `Or` is FALSE (`1=0`)
 *   - `Not`  → set complement (the backend's 3-valued `NOT COALESCE(...,0)`
 *     collapses to boolean here because the mock's per-row predicate is already
 *     2-valued)
 *
 * Leaves delegate to the conformance-guarded `metaRowMatchesFilter`, so the
 * tree-walk inherits the same per-primitive faithfulness AND the same
 * documented permissive no-op for engine-only primitives the mock does not
 * model (those leaves return `true`, so a tree that references them over-matches
 * rather than silently dropping rows). The combinators themselves are the
 * engine's exact boolean identities, so this layer adds no new drift surface
 * beyond the already-pinned per-primitive matrix.
 */
export function metaRowMatchesExpr(r: PageMetaRow, expr: Record<string, unknown>): boolean {
  switch (expr['type'] as string) {
    case 'Leaf': {
      return metaRowMatchesFilter(
        r,
        (expr['primitive'] as Record<string, unknown> | undefined) ?? {},
      )
    }
    case 'And': {
      const children = (expr['children'] as Array<Record<string, unknown>> | undefined) ?? []
      return children.every((c) => metaRowMatchesExpr(r, c))
    }
    case 'Or': {
      const children = (expr['children'] as Array<Record<string, unknown>> | undefined) ?? []
      return children.some((c) => metaRowMatchesExpr(r, c))
    }
    case 'Not': {
      return !metaRowMatchesExpr(r, (expr['child'] as Record<string, unknown> | undefined) ?? {})
    }
    default: {
      // Unknown node kind: permissive, matching the per-primitive no-op default.
      return true
    }
  }
}

/**
 * Map a wire `PropertyValue` (`{ type, value }`) to the `block_properties`
 * column it compares against plus its comparand, mirroring the backend's
 * `property_value_column` 4-way mapping (D26 / #1280):
 *   - `Text` → `value_text`, `Ref` → `value_ref` (string comparands),
 *   - `Num`  → `value_num` (numeric), `Date` → `value_date` (ISO string).
 */
export function propertyValueColumn(
  value: Record<string, unknown> | undefined,
): { col: string; wanted: string | number } | null {
  if (!value) return null
  const raw = value['value']
  switch (value['type'] as string) {
    case 'Text': {
      return { col: 'value_text', wanted: raw as string }
    }
    case 'Ref': {
      return { col: 'value_ref', wanted: raw as string }
    }
    case 'Num': {
      return { col: 'value_num', wanted: raw as number }
    }
    case 'Date': {
      return { col: 'value_date', wanted: raw as string }
    }
    default: {
      return null
    }
  }
}

/** Ordered comparison for `Lt`/`Gt`/`Lte`/`Gte` — numeric for a `value_num`
 * comparand, lexical (SQLite BINARY collation, ASCII-equivalent) otherwise. */
export function compareProperty(op: string, a: string | number, b: string | number): boolean {
  switch (op) {
    case 'Lt': {
      return a < b
    }
    case 'Gt': {
      return a > b
    }
    case 'Lte': {
      return a <= b
    }
    case 'Gte': {
      return a >= b
    }
    default: {
      return false
    }
  }
}

export type StoredProp = Record<string, unknown> | null

/** `Eq` (EXISTS col = ?): the value column is present AND equals the comparand. */
export function propertyEqMatches(
  prop: StoredProp,
  value: Record<string, unknown> | undefined,
): boolean {
  const vc = propertyValueColumn(value)
  const stored = prop && vc ? (prop[vc.col] ?? null) : null
  return vc != null && stored != null && stored === vc.wanted
}

/** `Lt`/`Gt`/`Lte`/`Gte`: ordered compare, value column guarded `IS NOT NULL`. */
export function propertyCompareMatches(
  prop: StoredProp,
  op: string,
  value: Record<string, unknown> | undefined,
): boolean {
  const vc = propertyValueColumn(value)
  if (!prop || !vc) return false
  const stored = prop[vc.col] ?? null
  if (stored == null) return false
  return compareProperty(op, stored as string | number, vc.wanted)
}

/**
 * `Contains`/`StartsWith`: `LIKE ? ESCAPE '\'` over a text column; a `Num`
 * comparand short-circuits to no match (a numeric column has no substring).
 * SQLite `LIKE` is ASCII-case-insensitive and `escape_like` makes the needle
 * literal, so this is an ASCII-case-insensitive literal substring/prefix test.
 */
export function propertyLikeMatches(
  prop: StoredProp,
  contains: boolean,
  value: Record<string, unknown> | undefined,
): boolean {
  const vc = propertyValueColumn(value)
  if (!prop || !vc || vc.col === 'value_num') return false
  const stored = prop[vc.col] ?? null
  if (stored == null) return false
  const hay = asciiLowercase(String(stored))
  const needle = asciiLowercase(String(vc.wanted))
  return contains ? hay.includes(needle) : hay.startsWith(needle)
}

/**
 * Evaluate a `HasProperty` primitive against a page's seeded `block_properties`
 * (`properties` map, keyed on the page block id), mirroring the backend's
 * `compile_has_property` predicate matrix over the full 4-column value mapping
 * (`property_value_column`). The wire shape is the nested
 * `predicate: PropertyPredicate` (D8 — invalid op/value combos are
 * unrepresentable): `Exists` / `NotExists`, `Eq` / `Ne`, the `Lt`/`Gt`/`Lte`/
 * `Gte` ordered compares (#1280), and `Contains`/`StartsWith` LIKE matches
 * (#1913).
 */
export function hasPropertyMatches(r: PageMetaRow, f: Record<string, unknown>): boolean {
  const key = f['key'] as string
  const predicate = f['predicate'] as Record<string, unknown> | undefined
  const ptype = predicate?.['type'] as string | undefined
  const prop = properties.get(r.id)?.get(key) ?? null
  const value = predicate?.['value'] as Record<string, unknown> | undefined
  switch (ptype) {
    case 'Exists': {
      return prop != null
    }
    case 'NotExists': {
      return prop == null
    }
    case 'Eq': {
      return propertyEqMatches(prop, value)
    }
    case 'Ne': {
      // NOT EXISTS — true when the key is absent OR present-but-different.
      return !propertyEqMatches(prop, value)
    }
    case 'Lt':
    case 'Gt':
    case 'Lte':
    case 'Gte': {
      return propertyCompareMatches(prop, ptype, value)
    }
    case 'Contains':
    case 'StartsWith': {
      return propertyLikeMatches(prop, ptype === 'Contains', value)
    }
    default: {
      return true
    }
  }
}

/**
 * Evaluate a `LastEdited` primitive against the page's `lastModifiedAt`,
 * mirroring the backend's `compile_last_edited` buckets (rolling window
 * ending "now"):
 *   - `Rolling{days}`   — modified within the last N days,
 *   - `OlderThan{days}` — modified before the last-N-days cutoff (NULL counts
 *     as older, matching the backend's `COALESCE(..., '0001-01-01')`),
 *   - `Range{start,end}` — modified within `[start, end]` (inclusive).
 */
export function lastEditedMatches(
  r: PageMetaRow,
  spec: Record<string, unknown> | undefined,
): boolean {
  if (!spec) return true
  const lm = r.lastModifiedAt
  const cutoff = (days: number): string => {
    const d = new Date()
    d.setDate(d.getDate() - days)
    return d.toISOString()
  }
  switch (spec['type'] as string) {
    case 'Rolling': {
      if (lm == null) return false
      return lm >= cutoff(spec['days'] as number)
    }
    case 'OlderThan': {
      // NULL last-modified sorts as the oldest possible → counts as older.
      return lm == null || lm < cutoff(spec['days'] as number)
    }
    case 'Range': {
      if (lm == null) return false
      const start = spec['start'] as string
      const end = spec['end'] as string
      return lm >= start && lm <= end
    }
    default: {
      return true
    }
  }
}

/** Comparator mirroring the backend's per-sort keyset (id is the tiebreaker). */
export function compareMetaRows(x: PageMetaRow, y: PageMetaRow, sort: string): number {
  let primary = 0
  switch (sort) {
    case 'alphabetical': {
      primary = (x.content ?? '').toLowerCase().localeCompare((y.content ?? '').toLowerCase())
      break
    }
    case 'recently-modified': {
      primary = (y.lastModifiedAt ?? '').localeCompare(x.lastModifiedAt ?? '')
      break
    }
    case 'most-linked': {
      primary = y.inboundLinkCount - x.inboundLinkCount
      break
    }
    case 'most-content': {
      primary = y.childBlockCount - x.childBlockCount
      break
    }
    default: {
      primary = x.id.localeCompare(y.id)
      break
    }
  }
  return primary !== 0 ? primary : x.id.localeCompare(y.id)
}

/**
 * Map a sort mode to the cursor `position` discriminator the backend stamps
 * into the keyset cursor (mirrors `sort_discriminator` in
 * `src-tauri/src/commands/pages.rs`). The frontend ships the wire sort enum
 * (`default` / `recently-modified` / `most-linked` / `most-content`); the
 * frontend-only `alphabetical` value resolves to the same discriminator as
 * `default` because both ride the `default` wire keyset. The discriminator is
 * what `validate_pages_metadata_cursor` compares to reject a cursor reused
 * across a sort change (the `RequiresRefresh:` recovery path).
 */
export function sortDiscriminator(sort: string): number {
  switch (sort) {
    case 'recently-modified': {
      return 2
    }
    case 'most-linked': {
      return 3
    }
    case 'most-content': {
      return 4
    }
    // `alphabetical` and `default` both ride the default-wire keyset.
    default: {
      return 5
    }
  }
}

/**
 * Encode a next-page cursor matching the backend's per-sort shape so cursor
 * round-trips hit the same validation path. The `position` slot carries the
 * sort discriminator (see `sortDiscriminator`).
 */
export function encodeNextCursor(last: PageMetaRow, sort: string): string {
  const disc = sortDiscriminator(sort)
  const cursorObj: Record<string, unknown> = { id: last.id, version: 1, position: disc }
  switch (sort) {
    case 'alphabetical': {
      cursorObj['deleted_at'] = last.content
      break
    }
    case 'recently-modified': {
      cursorObj['deleted_at'] = last.lastModifiedAt
      break
    }
    case 'most-linked': {
      cursorObj['seq'] = last.inboundLinkCount
      break
    }
    case 'most-content': {
      cursorObj['seq'] = last.childBlockCount
      break
    }
  }
  return btoa(JSON.stringify(cursorObj))
}

/**
 * Resolve a page's `last_modified_at`, mirroring the backend's
 * `MAX(op_log.created_at) WHERE block_id = b.id`: scan `opLog` for the latest
 * entry whose payload `block_id` is this page, then fall back to the
 * deterministic seeded `last_modified_at` stamp (set in `seed.ts`), and
 * finally `null` for a page with neither.
 */
export function pageLastModifiedAt(b: Record<string, unknown>): string | null {
  const pageId = b['id'] as string
  let maxOp: string | null = null
  for (const o of opLog) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(o.payload) as Record<string, unknown>
    } catch {
      continue
    }
    if (payload['block_id'] !== pageId) continue
    if (maxOp === null || o.created_at > maxOp) maxOp = o.created_at
  }
  const seeded = pageLastModified.get(pageId) ?? null
  if (maxOp !== null && seeded !== null) return maxOp > seeded ? maxOp : seeded
  return maxOp ?? seeded
}

/** Assemble one `PageMetaRow` from a page block + its (already-filtered) descendants. */
export function buildPageMetaRow(
  b: Record<string, unknown>,
  descendants: Array<Record<string, unknown>>,
  edges: ReadonlyArray<MockLinkEdge>,
): PageMetaRow {
  const pageId = b['id'] as string
  const pageScopeIds = new Set<string>([pageId, ...descendants.map((d) => d['id'] as string)])
  const { inbound, hasOutbound } = pageLinkStats(pageId, pageScopeIds, edges)
  return {
    id: b['id'] as string,
    blockType: 'page',
    content: (b['content'] as string | null) ?? null,
    parentId: (b['parent_id'] as string | null) ?? null,
    position: (b['position'] as number | null) ?? null,
    deletedAt: null,
    todoState: (b['todo_state'] as string | null) ?? null,
    priority: (b['priority'] as string | null) ?? null,
    dueDate: (b['due_date'] as string | null) ?? null,
    scheduledDate: (b['scheduled_date'] as string | null) ?? null,
    pageId: (b['page_id'] as string | null) ?? null,
    // last_modified_at mirrors the backend's `MAX(op_log.created_at)` over
    // the page block: take the latest op_log entry targeting this page,
    // falling back to the deterministic seeded `last_modified_at` stamp (and
    // finally null). This gives the `last-edited:` compound filter and the
    // recently-modified sort real, comparable ISO timestamps.
    lastModifiedAt: pageLastModifiedAt(b),
    inboundLinkCount: inbound,
    childBlockCount: descendants.length,
    hasOutboundLink: hasOutbound,
    flags: {
      hasTags: (blockTags.get(b['id'] as string)?.size ?? 0) > 0,
      hasTodo: descendants.some((d) => d['todo_state'] != null),
      hasScheduled: descendants.some((d) => d['scheduled_date'] != null),
      hasDue: descendants.some((d) => d['due_date'] != null),
    },
  }
}

/**
 * #400 — assign dense 1-based `position` to every live child of `parentId`,
 * in their current sort order, so the mock mirrors the backend's dense-rank
 * semantics (`position ASC, id ASC`, no gaps, no collisions).
 */
export function renumberSiblings(parentId: string | null): void {
  const siblings = [...blocks.values()].filter(
    (b) => (b['parent_id'] ?? null) === parentId && !b['deleted_at'],
  )
  siblings.sort((x, y) => {
    const px = (x['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
    const py = (y['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
    if (px !== py) return px - py
    return (x['id'] as string).localeCompare(y['id'] as string)
  })
  siblings.forEach((b, i) => {
    b['position'] = i + 1
  })
}

/**
 * #400 — place `blockId` at the 0-based `slot` among `parentId`'s OTHER live
 * children, then renumber the whole group to dense 1-based positions. `slot`
 * is clamped to `[0, otherCount]`; a value >= otherCount (e.g.
 * `Number.MAX_SAFE_INTEGER` for "append") lands the block last.
 */
export function insertAtSlotAndRenumber(
  parentId: string | null,
  blockId: string,
  slot: number,
): void {
  const moved = blocks.get(blockId)
  if (!moved) return
  const others = [...blocks.values()].filter(
    (b) => (b['parent_id'] ?? null) === parentId && !b['deleted_at'] && b['id'] !== blockId,
  )
  others.sort((x, y) => {
    const px = (x['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
    const py = (y['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
    if (px !== py) return px - py
    return (x['id'] as string).localeCompare(y['id'] as string)
  })
  const clamped = Math.max(0, Math.min(slot, others.length))
  // Pre-rank the OTHER siblings 1..N, then give the moved block a fractional
  // key that sits just after the (clamped)-th other sibling. `renumberSiblings`
  // then collapses everything back to dense integers in that order.
  others.forEach((b, i) => {
    b['position'] = i + 1
  })
  moved['position'] = clamped + 0.5
  renumberSiblings(parentId)
}

/**
 * #957 — after a cross-parent move, the moved block's `page_id` is recomputed
 * from its new parent (the page root, or `null` when orphaned). The Rust
 * backend (#664) ALSO refreshes every transitive descendant's `page_id` so the
 * whole subtree carries the new page root. Mirror that here: walk descendants
 * via `parent_id` chains over the `blocks` map and set each one's `page_id` to
 * the moved block's (already-updated) `page_id`. Without this, a moved subtree's
 * descendants keep a stale `page_id`, diverging from the backend (and breaking
 * `load_page_subtree`, which keys on `page_id`).
 */
export function refreshDescendantPageIds(rootBlockId: string): void {
  const root = blocks.get(rootBlockId)
  if (!root) return
  const newPageId = (root['page_id'] as string | null) ?? null
  const all = Array.from(blocks.values())
  // BFS over parent_id edges from the moved block down through its subtree.
  const queue: string[] = [rootBlockId]
  while (queue.length > 0) {
    const parentId = queue.shift() as string
    const children = all.filter((b) => ((b['parent_id'] as string | null) ?? null) === parentId)
    for (const child of children) {
      child['page_id'] = newPageId
      queue.push(child['id'] as string)
    }
  }
}

// -- filtered_blocks_query helpers (extracted to keep the handler flat) -------

/** Reserved row-level columns and the value column they compare against. */
export const FBQ_ROW_FIELD_KEYS: Record<string, 'text' | 'date'> = {
  todo_state: 'text',
  priority: 'text',
  due_date: 'date',
  scheduled_date: 'date',
}

/** Compare `lhs`/`rhs` under the named PropertyFilter operator. */
export function fbqCompare(operator: string, lhs: string, rhs: string): boolean {
  switch (operator) {
    case 'neq': {
      return lhs !== rhs
    }
    case 'lt': {
      return lhs < rhs
    }
    case 'gt': {
      return lhs > rhs
    }
    case 'lte': {
      return lhs <= rhs
    }
    case 'gte': {
      return lhs >= rhs
    }
    default: {
      return lhs === rhs
    }
  }
}

/** Resolve a block's candidate text/date for `key` from block_properties or
 *  the row-level reserved column. `null` text+date both null ⇒ key absent. */
export function fbqResolveValues(
  b: Record<string, unknown>,
  key: string,
): { pText: string | null; pDate: string | null } | null {
  const prop = properties.get(b['id'] as string)?.get(key)
  if (prop) {
    return {
      pText: (prop['value_text'] as string | null) ?? null,
      pDate: (prop['value_date'] as string | null) ?? null,
    }
  }
  const rowKind = FBQ_ROW_FIELD_KEYS[key]
  if (rowKind === undefined) return null // key absent
  const v = (b[key] as string | null | undefined) ?? null
  return rowKind === 'text' ? { pText: v, pDate: null } : { pText: null, pDate: v }
}

/**
 * Evaluate one PropertyFilter against a block — mirrors the EXISTS-subquery
 * semantics the backend emits per filter (or, for reserved keys, the direct
 * column predicate routing).
 */
export function fbqPropertyFilterMatches(
  b: Record<string, unknown>,
  pf: Record<string, unknown>,
): boolean {
  const resolved = fbqResolveValues(b, pf['key'] as string)
  if (resolved === null) return false
  const { pText, pDate } = resolved
  const operator = ((pf['operator'] as string | null) ?? 'eq').toLowerCase()

  const valueTextIn = (pf['valueTextIn'] as string[] | null) ?? null
  if (valueTextIn && valueTextIn.length > 0 && (pText == null || !valueTextIn.includes(pText))) {
    return false
  }
  const valueDateRange = (pf['valueDateRange'] as [string, string] | null) ?? null
  if (valueDateRange) {
    const [from, to] = valueDateRange
    if (pDate == null || !(pDate >= from && pDate < to)) return false
  }
  const valueText = (pf['valueText'] as string | null) ?? null
  if (valueText !== null && (pText == null || !fbqCompare(operator, pText, valueText))) return false
  const valueDate = (pf['valueDate'] as string | null) ?? null
  if (valueDate !== null && (pDate == null || !fbqCompare(operator, pDate, valueDate))) return false
  return true
}

/** Resolve prefix strings to tag-block ids by content prefix-match (mirrors the
 *  backend's `tags_cache.name LIKE ?`; the mock walks tag blocks instead). */
export function fbqResolvePrefixTagIds(prefixes: string[]): string[] {
  const out: string[] = []
  for (const prefix of prefixes) {
    const lp = prefix.toLowerCase()
    for (const [, blk] of blocks) {
      if (
        blk['block_type'] === 'tag' &&
        !blk['deleted_at'] &&
        ((blk['content'] as string) ?? '').toLowerCase().startsWith(lp)
      ) {
        out.push(blk['id'] as string)
      }
    }
  }
  return out
}

/** Evaluate the (optional) tag filter against a block. */
export function fbqTagFilterMatches(
  b: Record<string, unknown>,
  tagFilters: Record<string, unknown> | null,
): boolean {
  if (!tagFilters) return true
  const tagIds = (tagFilters['tagIds'] as string[] | null) ?? []
  const prefixes = (tagFilters['prefixes'] as string[] | null) ?? []
  const mode = ((tagFilters['mode'] as string | null) ?? 'or').toLowerCase()
  if (tagIds.length === 0 && prefixes.length === 0) return true

  const allIds = [...tagIds, ...fbqResolvePrefixTagIds(prefixes)]
  // Ref-inclusive (`block_tags` ∪ `block_tag_refs`), mirroring the backend's
  // `filtered_blocks_query_inner` tag clause.
  const tags = refInclusiveTags(b['id'] as string)
  if (tags.size === 0) return false
  return mode === 'and' ? allIds.every((tid) => tags.has(tid)) : allIds.some((tid) => tags.has(tid))
}

/** Space-scope gate (mirrors `filtered_blocks_query_inner`). */
export function fbqInSpace(b: Record<string, unknown>, spaceId: string | null): boolean {
  if (spaceId === null) return true
  const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
  const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
  return ownerSpace === spaceId
}

// ─── Compile-time contract linkage to the generated bindings (#2241) ─────────
//
// `commands` in `bindings.ts` is the auto-generated tauri-specta surface: each
// key is a camelCase wrapper whose body calls `__TAURI_INVOKE("snake_name", …)`
// and resolves `Promise<{status:'ok';data:T} | {status:'error';error}>`. The raw
// value the mock must return for that command is therefore `T` (the ok-branch
// `data`). The types below derive, purely at compile time, the exact snake_case
// key set the mock must implement plus a structural return contract per command,
// so `HANDLERS` is type-checked against the REAL command surface by tsc — not
// just the name-only regex parity script (which it complements, not replaces:
// the script still guards the KNOWN_UNMOCKED allowlist + generated-code drift).
//
// What this catches that the untyped `Record<string, Handler>` did not:
//   (a) a handler whose return is the wrong top-level SHAPE — e.g. a bare array
//       where the command returns a `PageResponse` envelope (or vice-versa), the
//       exact drift class that renders fine in unit tests but breaks E2E;
//   (b) a handler keyed on a command that no longer exists in `bindings.ts`
//       (excess key → type error);
//   (c) a generated command with no handler (missing key → type error; the mock
//       is contractually exhaustive — KNOWN_UNMOCKED is empty).
//
// NOT enforced (deliberate, tracked as follow-up): full field-level parity of
// row payloads and the argument side. Handlers build rows as
// `Record<string, unknown>` (see `makeBlock`) and read `args` as `unknown`;
// tightening either would require rewriting every handler body. The return
// contract widens object/primitive leaves to `unknown` so today's handlers stay
// green while the higher-value structural (envelope/array) drift is locked down.

/** camelCase → snake_case, matching tauri-specta's IPC invoke-name convention. */
export type SnakeCase<S extends string> = S extends `${infer H}${infer T}`
  ? H extends Uppercase<H>
    ? // Uppercase letters → `_<lower>`; non-letters (a digit equals its own
      // upper- AND lower-case) are kept verbatim. No command name has a digit
      // or consecutive-capital acronym today, so this reproduces every name.
      H extends Lowercase<H>
      ? `${H}${SnakeCase<T>}`
      : `_${Lowercase<H>}${SnakeCase<T>}`
    : `${H}${SnakeCase<T>}`
  : S

/**
 * The ok-branch payload `T` a command's IPC call resolves to. The wrapper
 * resolves the union `{status:'ok';data:T} | {status:'error';error}`, so
 * `Extract` selects the ok member before reading `data` (a bare `extends` on
 * the whole union fails — the union is not assignable to the ok-only shape —
 * and would collapse every command to `never`).
 */
export type CommandData<K extends keyof typeof commands> =
  Extract<Awaited<ReturnType<(typeof commands)[K]>>, { status: 'ok' }> extends { data: infer D }
    ? D
    : never

/**
 * Structural return contract enforced on a handler for command data `T`.
 * Preserves the top-level container shape (the drift that silently breaks E2E)
 * while widening contents to `unknown`:
 *   - `PageResponse<…>` → the paginated envelope with loosened `items`;
 *   - array command      → must return an array;
 *   - anything else       → unconstrained (`unknown`) — object/primitive
 *                           field-level parity is out of scope (follow-up).
 * `[T]` tuple-wraps to prevent distribution over union return types.
 */
export type ReturnContract<T> = [T] extends [PageResponse<unknown>]
  ? { items: unknown[]; next_cursor: string | null; has_more: boolean; total_count: number | null }
  : [T] extends [readonly unknown[]]
    ? unknown[]
    : unknown

/**
 * The exact handler map the mock must implement: one entry per generated
 * command, keyed by its snake_case IPC name, each a handler whose return is
 * checked against {@link ReturnContract}. Applied to `HANDLERS` via `satisfies`
 * so tsc fails on excess (a), missing (c), or wrong-shape (b) handlers.
 */
export type TypedHandlers = {
  [K in keyof typeof commands as SnakeCase<K & string>]: (
    args: unknown,
  ) => ReturnContract<CommandData<K>> | Promise<ReturnContract<CommandData<K>>>
}

// ─── #2468 — ref-addressed undo core (`undo_op` / `undo_ops`) ────────────────
//
// The FE undo store now addresses undo targets by the exact `OpRef` each
// mutating command returned (`WithOps.op_refs`) instead of a positional depth.
// These helpers resolve + validate a ref against the in-memory `opLog`
// (mirroring `undo_op_inner`'s reject rules) and delegate the actual state
// reversal to the mock op-log's existing reversal core (`applyRevertForOp`,
// the same core `revert_ops` uses — it covers the property/tag op types the
// positional `undo_page_op` core never needed).

/** The device id `pushOp` stamps on every locally-appended op. */
export const MOCK_LOCAL_DEVICE = 'mock-device'

/**
 * Reverse op_type stamped on the appended `undo_*` op. Mirrors the per-type
 * mapping in `undo_page_op` (block-row ops), extended to the property/tag ops
 * the #2468 migration makes undoable by ref.
 */
export function reverseOpTypeFor(opType: string): string {
  switch (opType) {
    case 'create_block': {
      return 'delete_block'
    }
    case 'delete_block': {
      return 'restore_block'
    }
    case 'restore_block': {
      return 'delete_block'
    }
    case 'delete_property': {
      return 'set_property'
    }
    case 'add_tag': {
      return 'remove_tag'
    }
    case 'remove_tag': {
      return 'add_tag'
    }
    default: {
      // edit_block / move_block / set_property / the task-column setters all
      // reverse to an op of their own type.
      return opType
    }
  }
}

/**
 * Net reversal count for a forward op: +1 per `undo_*` op whose stashed
 * `reversed` payload references it, -1 per `redo_*` op that re-applied it.
 * `> 0` ⇒ the op is currently reversed (an `undo_op` against it must be
 * rejected as already-reversed; a redo makes it undoable again).
 */
export function timesReversedNet(target: MockOpLogEntry): number {
  let net = 0
  for (const o of opLog) {
    if (o.op_type.startsWith('undo_')) {
      const reversed = (JSON.parse(o.payload) as { reversed?: MockOpLogEntry }).reversed
      if (reversed && reversed.device_id === target.device_id && reversed.seq === target.seq) {
        net += 1
      }
    } else if (o.op_type.startsWith('redo_')) {
      const reApplied = (JSON.parse(o.payload) as { re_applied?: MockOpLogEntry }).re_applied
      if (reApplied && reApplied.device_id === target.device_id && reApplied.seq === target.seq) {
        net -= 1
      }
    }
  }
  return net
}

/**
 * Resolve an `OpRef` to the EFFECTIVE op to revert, enforcing `undo_op`'s
 * reject rules (#2463 error-shape parity — mirror `undo_op_inner`):
 *   - unknown ref                     → `not_found`;
 *   - foreign / replicated op         → `validation` (only ops this device
 *     authored are undoable — a test models a replicated op by pushing a
 *     foreign-device entry onto `opLog` directly);
 *   - ref to an `undo_*` op           → `validation` (undoing an undo is
 *     redo's job — `redo_page_op` takes those refs);
 *   - already-reversed op             → `validation` (net of undos/redos);
 *   - `delete_property` with no prior value → `not_found` (backend parity:
 *     `build_reverse_delete_property` cannot compute an inverse without a
 *     prior `set_property`, so the revert phase rejects the whole batch).
 * A `redo_*` ref is ACCEPTED — redo appends a new op that re-applies the
 * original, and the FE pushes the redo's `new_op_ref` as the next undo
 * target; its effective revert target is the stashed original op.
 */
export function resolveUndoTarget(opRef: { device_id: string; seq: number }): MockOpLogEntry {
  const entry = opLog.find((o) => o.device_id === opRef.device_id && o.seq === opRef.seq)
  if (!entry) throw notFoundRejection(`op_log (${opRef.device_id}, ${opRef.seq})`)
  if (entry.device_id !== MOCK_LOCAL_DEVICE) {
    throw validationRejection(
      `op (${entry.device_id}, ${entry.seq}) was replicated from another device — ` +
        'refusing to undo a foreign op',
    )
  }
  if (entry.op_type.startsWith('undo_')) {
    throw validationRejection(
      `op (${entry.device_id}, ${entry.seq}) is a '${entry.op_type}' undo op — ` +
        'refusing to undo an undo (use redo_page_op)',
    )
  }
  const effective = entry.op_type.startsWith('redo_')
    ? (JSON.parse(entry.payload) as { re_applied?: MockOpLogEntry }).re_applied
    : entry
  // mock-internal invariant (#2463) — the mock stashes the re-applied op
  // inline on its own `redo_*` entry (see `redo_page_op`); a missing payload
  // means the mock corrupted its own bookkeeping.
  if (!effective) throw new Error('redo op carries no re_applied payload')
  if (timesReversedNet(effective) > 0) {
    throw validationRejection(
      `op (${effective.device_id}, ${effective.seq}) is already reversed — ` +
        'refusing to undo it twice',
    )
  }
  // Backend parity: the real command appends a `delete_property` op even when
  // the property never existed, but reversing that op is impossible — there
  // is no prior `set_property` to restore. `build_reverse_delete_property`
  // surfaces that as NotFound during the (pre-apply, batch-aborting) reverse
  // computation; mirror it here so the FE sees the same failure shape.
  if (effective.op_type === 'delete_property') {
    const payload = JSON.parse(effective.payload) as { from_value?: unknown; key?: string }
    if (payload.from_value == null) {
      throw notFoundRejection(
        `no prior set_property found for key '${payload.key ?? ''}' — ` +
          'cannot reverse delete_property',
      )
    }
  }
  return effective
}

/**
 * Apply the reverse of a validated target via the shared reversal core and
 * append the bookkeeping `undo_*` op (same `{ reversed }` stash the
 * positional `undo_page_op` writes, so `redo_page_op` accepts the returned
 * `new_op_ref`). Returns the `UndoResult` wire shape.
 */
export function applyUndoForTarget(effective: MockOpLogEntry): Record<string, unknown> {
  applyRevertForOp(effective, blocks, { properties, blockTags })
  const reverseOpType = reverseOpTypeFor(effective.op_type)
  const newOp = pushOp(`undo_${reverseOpType}`, { reversed: effective })
  return {
    reversed_op: { device_id: effective.device_id, seq: effective.seq },
    reversed_op_type: effective.op_type,
    new_op_ref: { device_id: newOp.device_id, seq: newOp.seq },
    new_op_type: reverseOpType,
    is_redo: false,
  }
}
