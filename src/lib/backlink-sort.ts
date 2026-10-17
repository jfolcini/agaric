/**
 * The sort fields the References panels offer, and the `BacklinkSort` each
 * one sends. Built-in fields come first; the user's own properties follow,
 * limited to the definitions whose type has an order
 * (`isSortablePropertyType`) and that are neither built-in nor bookkeeping.
 */

import type { BacklinkSort, PropertyDefinition, SortDir } from '@/lib/bindings'
import { INTERNAL_PROPERTY_KEYS, isSortablePropertyType } from '@/lib/block-utils'
import { NON_DELETABLE_PROPERTIES } from '@/lib/property-save-utils'

/** The backend's order when no sort is sent: creation time, oldest first. */
export const DEFAULT_BACKLINK_SORT: BacklinkSort = { type: 'Created', dir: 'Asc' }

export interface SortField {
  /** The Select option value, unique across both groups. */
  value: string
  toSort: (dir: SortDir) => BacklinkSort
}

export interface BuiltinSortField extends SortField {
  labelKey: string
}

export interface PropertySortField extends SortField {
  /** The property key, shown as the user typed it. */
  key: string
}

/** `due_date`, `scheduled_date` and `priority` are `blocks` columns; the backend sorts them there. */
export const BUILTIN_SORT_FIELDS: readonly BuiltinSortField[] = [
  {
    value: 'created',
    labelKey: 'backlink.sortCreated',
    toSort: (dir) => ({ type: 'Created', dir }),
  },
  {
    value: 'due',
    labelKey: 'backlink.sortDue',
    toSort: (dir) => ({ type: 'PropertyDate', key: 'due_date', dir }),
  },
  {
    value: 'scheduled',
    labelKey: 'backlink.sortScheduled',
    toSort: (dir) => ({ type: 'PropertyDate', key: 'scheduled_date', dir }),
  },
  {
    value: 'priority',
    labelKey: 'backlink.sortPriority',
    toSort: (dir) => ({ type: 'PropertyText', key: 'priority', dir }),
  },
  {
    value: 'completed',
    labelKey: 'backlink.sortCompleted',
    toSort: (dir) => ({ type: 'PropertyDate', key: 'completed_at', dir }),
  },
]

/** Keeps a property named `due` apart from the built-in `due` option. */
const PROPERTY_VALUE_PREFIX = 'prop:'

/** The user's properties a sort can use, in definition order. */
export function propertySortFields(defs: readonly PropertyDefinition[]): PropertySortField[] {
  return defs
    .filter(
      (def) =>
        isSortablePropertyType(def.value_type) &&
        !INTERNAL_PROPERTY_KEYS.has(def.key) &&
        !NON_DELETABLE_PROPERTIES.has(def.key),
    )
    .map((def) => {
      const key = def.key
      return {
        value: `${PROPERTY_VALUE_PREFIX}${key}`,
        key,
        toSort: (dir: SortDir): BacklinkSort =>
          def.value_type === 'number'
            ? { type: 'PropertyNum', key, dir }
            : def.value_type === 'date'
              ? { type: 'PropertyDate', key, dir }
              : { type: 'PropertyText', key, dir },
      }
    })
}

/** The option value that names `sort`'s field. */
export function sortFieldValue(sort: BacklinkSort): string {
  if (sort.type === 'Created') return 'created'
  const builtin = BUILTIN_SORT_FIELDS.find((field) => {
    const probe = field.toSort(sort.dir)
    return probe.type !== 'Created' && probe.key === sort.key
  })
  return builtin?.value ?? `${PROPERTY_VALUE_PREFIX}${sort.key}`
}
