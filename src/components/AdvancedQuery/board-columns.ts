/**
 * The columns of a query board (#6542): one per value the group key can take,
 * each with the filter leaf that selects its cards.
 *
 * A board exists for task state and for a `select` property, the two keys with
 * a closed, ordered value set. Columns follow that order (the definition's
 * options, so reordering the options reorders the board), then the blocks with
 * no value. A select value that is not among the options gets one more column.
 */

import { parseSelectOptions } from '@/components/properties/PropertyRowEditor/shared'
import type { FilterExpr, FilterPrimitive, GroupSpec, PropertyDefinition } from '@/lib/bindings'
import { TASK_STATES } from '@/lib/task-states'

export interface BoardColumn {
  /** Unique within one board. */
  id: string
  /**
   * `value` shows `value` as its header; `none` holds the blocks without a
   * value, `other` the ones whose value is not an option.
   */
  kind: 'value' | 'none' | 'other'
  /** The group value, for a `value` column. */
  value?: string
  /** Selects this column's blocks; AND-ed with the query's own filter. */
  filter: FilterExpr
}

const leaf = (primitive: FilterPrimitive): FilterExpr => ({ type: 'Leaf', primitive })

function stateColumns(): BoardColumn[] {
  return [
    ...TASK_STATES.map((state): BoardColumn => ({
      id: `value:${state}`,
      kind: 'value',
      value: state,
      filter: leaf({ type: 'State', values: [state] }),
    })),
    { id: 'none', kind: 'none', filter: leaf({ type: 'State', values: [], is_null: true }) },
  ]
}

function selectColumns(key: string, options: string[]): BoardColumn[] {
  const has = (predicate: Extract<FilterPrimitive, { type: 'HasProperty' }>['predicate']) =>
    leaf({ type: 'HasProperty', key, predicate })
  return [
    ...options.map((option): BoardColumn => ({
      id: `value:${option}`,
      kind: 'value',
      value: option,
      filter: has({ type: 'Eq', value: { type: 'Text', value: option } }),
    })),
    { id: 'none', kind: 'none', filter: has({ type: 'NotExists' }) },
    {
      id: 'other',
      kind: 'other',
      filter: {
        type: 'And',
        children: [
          has({ type: 'Exists' }),
          ...options.map((option) => has({ type: 'Ne', value: { type: 'Text', value: option } })),
        ],
      },
    },
  ]
}

/** The board's columns, or `null` when the group key has no board. */
export function boardColumns(
  groupBy: GroupSpec | null,
  defs: ReadonlyMap<string, PropertyDefinition> | undefined,
): BoardColumn[] | null {
  const key = groupBy?.key
  if (key?.type === 'State') return stateColumns()
  if (key?.type !== 'Property') return null
  const def = defs?.get(key.key)
  if (def?.value_type !== 'select') return null
  return selectColumns(key.key, parseSelectOptions(def))
}
