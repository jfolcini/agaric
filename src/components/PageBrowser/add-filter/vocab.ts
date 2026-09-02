/**
 * AddFilterPopover — shared vocabulary, predicate-op tables and editor types.
 *
 * Extracted from `AddFilterPopover.tsx` (#1648) so the main popover, the menu
 * and the editor sub-components can all share these consts WITHOUT importing
 * back from `AddFilterPopover.tsx` (which would close an import cycle the
 * `frontend import cycles (zero)` hook forbids).
 */

import type {
  DatePredicate,
  FilterPrimitive,
  PropertyPredicate,
  PropertyValue,
} from '@/lib/bindings'

/** Which inline value-editor is open inside the popover (null = category menu). */
export type EditorKey =
  | 'tag'
  | 'path'
  | 'property'
  | 'state'
  | 'blockType'
  | 'due'
  | 'scheduled'
  | 'created'
  | 'linksTo'
  | 'linkedFrom'
  | 'hasParent'
  | null

/** The ten predicate kinds `PropertyPredicate` defines (#4553 Phase 1 — was 4). */
export type PropertyOpKind = PropertyPredicate['type']

/** The four `PropertyValue` variants a `HasProperty` predicate can carry. */
export type PropertyValueKind = PropertyValue['type']

/**
 * #4553 Phase 1 — the declared arity of each `PropertyPredicate` operator:
 * whether the emitted predicate carries a `PropertyValue` operand
 * (`Exists`/`NotExists` never do; every comparison operator always does).
 *
 * `VALUE_BEARING_OPS` below is DERIVED from this table rather than being its
 * own hand-maintained allow-list — the old `new Set(['Eq', 'Ne'])` silently
 * conflated "takes a value" with "is Eq or Ne", which was already wrong the
 * moment `Lt`/`Gt`/`Lte`/`Gte`/`Contains`/`StartsWith` became reachable from
 * the UI: each of those needs a value input exactly as much as `Eq`/`Ne` do.
 */
export const PROPERTY_OP_ARITY = {
  Exists: 'nullary',
  NotExists: 'nullary',
  Eq: 'unary',
  Ne: 'unary',
  Lt: 'unary',
  Gt: 'unary',
  Lte: 'unary',
  Gte: 'unary',
  Contains: 'unary',
  StartsWith: 'unary',
  // `as const satisfies` (not a plain type annotation): `satisfies` keeps the
  // compile-time exhaustiveness guard — a new `PropertyPredicate` variant fails
  // to type-check until it is classified here — while `as const` preserves the
  // literal `'nullary'`/`'unary'` types so {@link ValueBearingOpKind} below can
  // be DERIVED from this table instead of being a second hand-kept list.
} as const satisfies Readonly<Record<PropertyOpKind, 'nullary' | 'unary'>>

/**
 * The operators that carry a `PropertyValue` operand, as a TYPE — the
 * type-level twin of {@link VALUE_BEARING_OPS}, computed from
 * {@link PROPERTY_OP_ARITY}'s literal values.
 */
export type ValueBearingOpKind = {
  [K in PropertyOpKind]: (typeof PROPERTY_OP_ARITY)[K] extends 'unary' ? K : never
}[PropertyOpKind]

/** Predicate kinds that compare a value (the value input is required for
 * these) — computed from {@link PROPERTY_OP_ARITY}, not a fixed allow-list. */
export const VALUE_BEARING_OPS: ReadonlySet<PropertyOpKind> = new Set(
  (Object.keys(PROPERTY_OP_ARITY) as PropertyOpKind[]).filter(
    (op) => PROPERTY_OP_ARITY[op] === 'unary',
  ),
)

/**
 * How a value-bearing operator renders in the `{{op}}` slot of a
 * `HasProperty` filter CHIP (`pageBrowser.filter.summaryProperty`): either a
 * locale-independent maths `glyph`, or an i18n `labelKey` for the ops that are
 * words.
 *
 * Keyed by {@link ValueBearingOpKind}, so this is a TOTAL map over the
 * operators the chip renderer can be handed — the nullary `Exists`/`NotExists`
 * are excluded by type because they render as their own whole sentence
 * (`summaryHasProperty` / `summaryNotHasProperty`), not as an infix.
 *
 * Why a table and not a ternary: the renderer used to pick the glyph inline as
 * `predicate.type === 'Ne' ? '≠' : '='`, which was complete only while `Eq`/`Ne`
 * were the sole emittable value-bearing ops. #4553 Phase 1 made six more
 * emittable and every one of them fell into that `'='` branch, so `estimate > 3`
 * and `estimate < 3` rendered byte-identical chips. A total `Record` over the
 * derived key type cannot go stale that way: a ninth operator classified
 * `'unary'` in {@link PROPERTY_OP_ARITY} widens `ValueBearingOpKind` and this
 * object stops type-checking until it is given a rendering.
 */
export const PROPERTY_OP_CHIP: Readonly<
  Record<ValueBearingOpKind, { glyph: string } | { labelKey: string }>
> = {
  Eq: { glyph: '=' },
  Ne: { glyph: '≠' },
  Lt: { glyph: '<' },
  Lte: { glyph: '≤' },
  Gt: { glyph: '>' },
  Gte: { glyph: '≥' },
  Contains: { labelKey: 'pageBrowser.filter.summaryPropertyOpContains' },
  StartsWith: { labelKey: 'pageBrowser.filter.summaryPropertyOpStartsWith' },
}

/**
 * #1280 D2 — the todo-state values offered by the State editor. Mirrors the
 * canonical states the agenda/backlink surfaces emit (TODO/DOING/DONE/CANCELLED;
 * see `task-states.ts`'s `taskStateRank`). These match `b.todo_state` byte-for-byte
 * so the projection's `IN (...)` membership test resolves.
 */
export { TASK_STATES as TODO_STATE_VALUES } from '@/lib/task-states'

/**
 * #1280 D2 — the block-type values offered by the Block type editor. Mirrors the
 * `b.block_type` vocabulary (content/page/tag/todo; see the backlink
 * `TypeFilterForm`). `todo` is included so the advanced query can filter the
 * task rows specifically.
 */
export const BLOCK_TYPE_VALUES: ReadonlyArray<string> = ['content', 'page', 'tag', 'todo']

/** #1280 D2 — the date predicate operators the Due/Scheduled editors offer, in display order. */
export type DateOpKind = DatePredicate['type']
export const DATE_OPS: ReadonlyArray<{ value: DateOpKind; labelKey: string }> = [
  { value: 'IsNull', labelKey: 'pageBrowser.filter.dateOpIsNull' },
  { value: 'Before', labelKey: 'pageBrowser.filter.dateOpBefore' },
  { value: 'After', labelKey: 'pageBrowser.filter.dateOpAfter' },
  { value: 'OnOrBefore', labelKey: 'pageBrowser.filter.dateOpOnOrBefore' },
  { value: 'OnOrAfter', labelKey: 'pageBrowser.filter.dateOpOnOrAfter' },
  { value: 'On', labelKey: 'pageBrowser.filter.dateOpOn' },
  { value: 'Between', labelKey: 'pageBrowser.filter.dateOpBetween' },
]

export const LAST_EDITED_BUCKETS: ReadonlyArray<{ key: string; spec: FilterPrimitive }> = [
  { key: 'today', spec: { type: 'LastEdited', spec: { type: 'Rolling', days: 1 } } },
  { key: 'thisWeek', spec: { type: 'LastEdited', spec: { type: 'Rolling', days: 7 } } },
  { key: 'thisMonth', spec: { type: 'LastEdited', spec: { type: 'Rolling', days: 30 } } },
  { key: 'older', spec: { type: 'LastEdited', spec: { type: 'OlderThan', days: 30 } } },
]

/**
 * All ten `PropertyPredicate` operators the engine supports (#4553 Phase 1 —
 * `src-tauri/agaric-store/src/filters/primitive.rs`), in a single fixed
 * display order. Both {@link PROPERTY_OPS} (the Pages browser's classic
 * 4-operator subset) and {@link propertyOpsForValueType} (the advanced
 * surface's type-driven subset, via {@link propertyOpsForValueKind}) filter
 * this list rather than each maintaining their own copy, so a label never
 * drifts between the two.
 */
export const ALL_PROPERTY_OPS: ReadonlyArray<{ value: PropertyOpKind; labelKey: string }> = [
  { value: 'Eq', labelKey: 'pageBrowser.filter.propertyOpEq' },
  { value: 'Ne', labelKey: 'pageBrowser.filter.propertyOpNe' },
  { value: 'Lt', labelKey: 'pageBrowser.filter.propertyOpLt' },
  { value: 'Lte', labelKey: 'pageBrowser.filter.propertyOpLte' },
  { value: 'Gt', labelKey: 'pageBrowser.filter.propertyOpGt' },
  { value: 'Gte', labelKey: 'pageBrowser.filter.propertyOpGte' },
  { value: 'Contains', labelKey: 'pageBrowser.filter.propertyOpContains' },
  { value: 'StartsWith', labelKey: 'pageBrowser.filter.propertyOpStartsWith' },
  { value: 'Exists', labelKey: 'pageBrowser.filter.propertyOpExists' },
  { value: 'NotExists', labelKey: 'pageBrowser.filter.propertyOpNotExists' },
]

/**
 * The classic four predicate kinds the Pages browser's `+ Filter` popover
 * offers (`showAdvancedFacets` unset/false) — UNCHANGED since #1648/D24.
 * Kept as its own filter over {@link ALL_PROPERTY_OPS} (order: Eq, Ne, Exists,
 * NotExists) so the Pages surface cannot silently widen if the advanced
 * surface's operator table grows again; see `AddFilterPopover`'s
 * `showAdvancedFacets` gate, which is exactly the boundary #4553's
 * acceptance criteria require this list to stay behind.
 */
export const PROPERTY_OPS: ReadonlyArray<{ value: PropertyOpKind; labelKey: string }> =
  ALL_PROPERTY_OPS.filter(
    (op) =>
      op.value === 'Eq' || op.value === 'Ne' || op.value === 'Exists' || op.value === 'NotExists',
  )

/**
 * #4553 Phase 1 — the operators offered per `PropertyValue` variant, per the
 * issue's tiered-exposure table. Ordered comparisons (`Lt`/`Lte`/`Gt`/`Gte`)
 * are offered only for `Num`/`Date`, where the compared column
 * (`property_value_column`, `src-tauri/agaric-store/src/filters/primitive.rs`)
 * sorts correctly — never for `Text`, where `>`/`<` would be a silent lexical
 * footgun (`"10" < "9"`). `Contains`/`StartsWith` are offered only for `Text`
 * (substring ops on a number/date/ref are meaningless — the engine compiles
 * them to `1=0`, see `PropertyPredicate::Contains`'s doc comment). `Ref` gets
 * only equality + existence, matching the backlink filter row's behaviour for
 * `PropertyRef`.
 */
export const PROPERTY_OPS_BY_VALUE_KIND: Readonly<
  Record<PropertyValueKind, ReadonlyArray<PropertyOpKind>>
> = {
  Num: ['Eq', 'Ne', 'Lt', 'Lte', 'Gt', 'Gte', 'Exists', 'NotExists'],
  Date: ['Eq', 'Ne', 'Lt', 'Lte', 'Gt', 'Gte', 'Exists', 'NotExists'],
  Text: ['Eq', 'Ne', 'Contains', 'StartsWith', 'Exists', 'NotExists'],
  Ref: ['Eq', 'Ne', 'Exists', 'NotExists'],
}

/**
 * The ops-select options for a given `PropertyValue` kind: {@link ALL_PROPERTY_OPS}
 * filtered down to {@link PROPERTY_OPS_BY_VALUE_KIND}`[kind]`, preserving
 * `ALL_PROPERTY_OPS`'s display order.
 */
export function propertyOpsForValueKind(
  kind: PropertyValueKind,
): ReadonlyArray<{ value: PropertyOpKind; labelKey: string }> {
  const allowed = PROPERTY_OPS_BY_VALUE_KIND[kind]
  return ALL_PROPERTY_OPS.filter((op) => allowed.includes(op.value))
}

/**
 * The operators offered for a property key from its DECLARED `value_type`,
 * rather than from the `PropertyValue` variant that type maps to.
 *
 * The two are the same question for every type but one. A `boolean` property
 * is stored in `value_bool` and has no `PropertyValue::Bool` variant to
 * compare against ({@link propertyValueKindForType} maps it to `Text` only so
 * the emit path has something to name), so every `Text` comparison the
 * operator list used to offer it — `Eq`, `Ne`, `Contains`, `StartsWith` —
 * compiled against a `value_text` that is NULL for that row and silently
 * matched nothing (#4571 item 2). Offer existence only until a `Bool` variant
 * exists: `Exists`/`NotExists` test the property ROW, the one thing that is
 * true of a boolean property regardless of which column holds its value.
 */
export function propertyOpsForValueType(
  valueType: string | null | undefined,
): ReadonlyArray<{ value: PropertyOpKind; labelKey: string }> {
  if (valueType === 'boolean') {
    return ALL_PROPERTY_OPS.filter((op) => PROPERTY_OP_ARITY[op.value] === 'nullary')
  }
  return propertyOpsForValueKind(propertyValueKindForType(valueType))
}

/**
 * #4553 Phase 1 — map a property's declared `value_type` (from
 * `PropertyDefinition.value_type`, the schema registry surfaced by
 * `commands.listPropertyDefs()`) to the `PropertyValue` variant an emitted
 * `HasProperty` predicate should carry.
 *
 * `text` and `select` both compare `value_text` — there is no separate
 * `Select` variant, matching how `select` properties are stored
 * (`src/lib/property-save-utils.ts`). An UNDECLARED key (no registry entry —
 * `value_type` is `null`/`undefined`) also falls back to `Text`, which is the
 * bare-text-box behaviour the popover has always had for a key nobody has
 * typed a definition for yet.
 *
 * `boolean` also returns `Text` as a placeholder; the value is never read
 * because {@link propertyOpsForValueType} offers a boolean key
 * existence-only (#4571 item 2); give it its own variant the day
 * `PropertyValue::Bool` exists.
 */
export function propertyValueKindForType(valueType: string | null | undefined): PropertyValueKind {
  switch (valueType) {
    case 'number': {
      return 'Num'
    }
    case 'date': {
      return 'Date'
    }
    case 'ref': {
      return 'Ref'
    }
    default: {
      return 'Text'
    }
  }
}
