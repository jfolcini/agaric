/**
 * AddFilterPopover — shared vocabulary, predicate-op tables and editor types.
 *
 * Extracted from `AddFilterPopover.tsx` (#1648) so the main popover, the menu
 * and the editor sub-components can all share these consts WITHOUT importing
 * back from `AddFilterPopover.tsx` (which would close an import cycle the
 * `frontend import cycles (zero)` hook forbids).
 */

import type { DatePredicate, PropertyPredicate } from '@/lib/bindings'
import type { FilterPrimitive } from '@/lib/tauri'

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

/** D24 — the four property predicate kinds the popover can emit. */
export type PropertyOpKind = PropertyPredicate['type']

/** Predicate kinds that compare a value (the value input is required for these). */
export const VALUE_BEARING_OPS: ReadonlySet<PropertyOpKind> = new Set<PropertyOpKind>(['Eq', 'Ne'])

/**
 * #1280 D2 — the todo-state values offered by the State editor. Mirrors the
 * canonical states the agenda/backlink surfaces emit (TODO/DOING/DONE/CANCELLED;
 * see `agenda-sort.ts`'s `stateRank`). These match `b.todo_state` byte-for-byte
 * so the projection's `IN (...)` membership test resolves.
 */
export const TODO_STATE_VALUES: ReadonlyArray<string> = ['TODO', 'DOING', 'DONE', 'CANCELLED']

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

/** The four predicate kinds the property op selector offers, in display order. */
export const PROPERTY_OPS: ReadonlyArray<{ value: PropertyOpKind; labelKey: string }> = [
  { value: 'Eq', labelKey: 'pageBrowser.filter.propertyOpEq' },
  { value: 'Ne', labelKey: 'pageBrowser.filter.propertyOpNe' },
  { value: 'Exists', labelKey: 'pageBrowser.filter.propertyOpExists' },
  { value: 'NotExists', labelKey: 'pageBrowser.filter.propertyOpNotExists' },
]
