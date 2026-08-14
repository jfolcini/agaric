/**
 * Runtime validation for `FilterPredicate` — Issue #3791.
 *
 * `FilterPredicate[]` is round-tripped through `JSON.stringify` /
 * `JSON.parse` at the graph surface's persistence boundary
 * (`GraphFilterBar.readPersistedFilters`, `src/components/graph/GraphFilterBar.tsx`).
 * `JSON.parse` returns `unknown`; TypeScript's structural typing only
 * enforces the shape of values the program itself constructs — it does not,
 * and cannot, re-check a value that came back out of storage. A stale entry
 * from an older schema, a hand-edited devtools value, or a future migration
 * can carry a `kind` that matches a union member's tag while its other
 * fields are absent, wrong-typed, or borrowed from a different variant.
 *
 * This module is the boundary validator: a per-`kind` narrowing function for
 * every `FilterPredicate` variant (`isFilterPredicate`), plus
 * `parseFilterPredicates` to run a whole `unknown[]` through it and drop
 * anything that fails to validate — including an unrecognised `kind`, which
 * is rejected outright rather than passed through.
 */

import type {
  DatePredicate,
  LastEditedSpec,
  PropertyPredicate,
  PropertyValue,
} from '@/lib/bindings'
import type { FilterPredicate } from '@/lib/filters/model'

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || isString(value)
}

// ---------------------------------------------------------------------------
// Nested wire-type guards (bindings.ts unions embedded in FilterPredicate)
// ---------------------------------------------------------------------------

function isPropertyValue(value: unknown): value is PropertyValue {
  if (!isRecord(value) || !isString(value['type'])) return false
  switch (value['type']) {
    case 'Text':
    case 'Ref':
    case 'Date': {
      return isString(value['value'])
    }
    case 'Num': {
      return value['value'] === null || isNumber(value['value'])
    }
    default: {
      return false
    }
  }
}

function isPropertyPredicate(value: unknown): value is PropertyPredicate {
  if (!isRecord(value) || !isString(value['type'])) return false
  switch (value['type']) {
    case 'Exists':
    case 'NotExists': {
      return true
    }
    case 'Eq':
    case 'Ne':
    case 'Lt':
    case 'Gt':
    case 'Lte':
    case 'Gte':
    case 'Contains':
    case 'StartsWith': {
      return isPropertyValue(value['value'])
    }
    default: {
      return false
    }
  }
}

function isDatePredicate(value: unknown): value is DatePredicate {
  if (!isRecord(value) || !isString(value['type'])) return false
  switch (value['type']) {
    case 'IsNull': {
      return true
    }
    case 'Before':
    case 'After':
    case 'OnOrBefore':
    case 'OnOrAfter':
    case 'On': {
      return isString(value['date'])
    }
    case 'Between': {
      return isString(value['from']) && isString(value['to'])
    }
    default: {
      return false
    }
  }
}

function isLastEditedSpec(value: unknown): value is LastEditedSpec {
  if (!isRecord(value) || !isString(value['type'])) return false
  switch (value['type']) {
    case 'Rolling':
    case 'OlderThan': {
      return isNumber(value['days'])
    }
    case 'Range': {
      return isString(value['start']) && isString(value['end'])
    }
    default: {
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// FilterPredicate — per-kind narrowing validator
// ---------------------------------------------------------------------------

/**
 * Narrow an `unknown` value to `FilterPredicate`, validating every field of
 * the variant its `kind` claims — not just the discriminant. Returns `false`
 * for an unrecognised `kind` (rejected outright, per #3791) and for any
 * recognised `kind` whose other fields don't match that variant's shape.
 */
export function isFilterPredicate(value: unknown): value is FilterPredicate {
  if (!isRecord(value) || !isString(value['kind'])) return false
  switch (value['kind']) {
    case 'tag': {
      if (value['by'] === 'id') return isString(value['tagId'])
      if (value['by'] === 'name') return isString(value['name'])
      return false
    }
    case 'tagPrefix': {
      return isString(value['prefix'])
    }
    case 'status': {
      return (
        isStringArray(value['values']) && isBoolean(value['isNull']) && isBoolean(value['exclude'])
      )
    }
    case 'priority': {
      return isStringArray(value['values']) && isBoolean(value['exclude'])
    }
    case 'property': {
      return (
        isString(value['key']) &&
        isPropertyPredicate(value['predicate']) &&
        isBoolean(value['exclude'])
      )
    }
    case 'date': {
      return (
        (value['field'] === 'due' ||
          value['field'] === 'scheduled' ||
          value['field'] === 'created' ||
          value['field'] === 'lastEdited') &&
        isDatePredicate(value['predicate'])
      )
    }
    case 'createdRange': {
      return isStringOrNull(value['after']) && isStringOrNull(value['before'])
    }
    case 'lastEdited': {
      return isLastEditedSpec(value['spec'])
    }
    case 'blockType': {
      return isStringArray(value['values']) && isBoolean(value['exclude'])
    }
    case 'pathGlob': {
      return isString(value['pattern']) && isBoolean(value['exclude'])
    }
    case 'sourcePage': {
      return isStringArray(value['included']) && isStringArray(value['excluded'])
    }
    case 'space': {
      return isString(value['spaceId'])
    }
    case 'contains': {
      return isString(value['query'])
    }
    case 'regex': {
      return isString(value['pattern'])
    }
    case 'caseSensitive':
    case 'wholeWord': {
      return isBoolean(value['enabled'])
    }
    case 'linksTo': {
      return isString(value['target'])
    }
    case 'linkedFrom': {
      return isString(value['source'])
    }
    case 'hasBacklinks': {
      return isBoolean(value['value'])
    }
    case 'orphan':
    case 'stub':
    case 'hasNoInboundLinks':
    case 'excludeTemplates': {
      return true
    }
    default: {
      // Unknown `kind` — rejected outright rather than passed through (#3791).
      return false
    }
  }
}

/** Result of validating a persisted predicate array. */
export interface ParseFilterPredicatesResult {
  /** The entries that passed validation, in their original order. */
  predicates: FilterPredicate[]
  /** How many entries were dropped for failing validation. */
  droppedCount: number
}

/**
 * Validate an `unknown` value (typically fresh out of `JSON.parse`) as a
 * `FilterPredicate[]`, dropping any entry that fails to validate — including
 * one whose `kind` isn't in the union at all. Returns an empty result (with
 * `droppedCount: 0`) when `value` is not an array at all, so a caller can
 * distinguish "not an array" from "array of all-invalid entries" if needed.
 */
export function parseFilterPredicates(value: unknown): ParseFilterPredicatesResult {
  if (!Array.isArray(value)) return { predicates: [], droppedCount: 0 }
  const predicates: FilterPredicate[] = []
  let droppedCount = 0
  for (const entry of value) {
    if (isFilterPredicate(entry)) predicates.push(entry)
    else droppedCount++
  }
  return { predicates, droppedCount }
}
