/**
 * The columns of an inline query table (#6544): the ones its query names, in
 * that order, or else the ones derived from the rows; and the picker's props,
 * which write the choice into the query.
 */

import type { TFunction } from 'i18next'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { QueryColumnPickerProps } from '@/components/query/QueryColumnPicker'
import type { TableColumn } from '@/components/query/QueryResultTable'
import type { BlockRow } from '@/lib/bindings'
import {
  CUSTOM_COLUMN_PREFIX,
  deriveCustomColumns,
  readQueryColumns,
  writeQueryColumns,
} from '@/lib/query-result-columns'

/**
 * Known block property keys that can become table columns. Holds i18n KEYS,
 * not literal text — the display label is resolved inside `detectColumns()`
 * from the `t` the CALLER passes in, not a module-scope import (#4555).
 */
const KNOWN_PROPERTY_KEYS: { key: keyof BlockRow; labelKey: string }[] = [
  { key: 'todo_state', labelKey: 'query.column.status' },
  { key: 'priority', labelKey: 'query.column.priority' },
  { key: 'due_date', labelKey: 'query.column.dueDate' },
  { key: 'scheduled_date', labelKey: 'query.column.scheduled' },
]

/**
 * Build the table column set: the fixed Content + known-property columns,
 * followed by data-driven columns for any custom properties present on the
 * result blocks (sorted alphabetically).
 *
 * #4555 — `t` is a PARAMETER, not a module-scope import, and deliberately
 * so: the only caller (`useQueryTableColumns`, below) reads it from
 * `useTranslation()` and lists it in the `useMemo` dependency array.
 * `useTranslation()`'s `t`
 * changes IDENTITY on `changeLanguage`, so that's what makes the memo
 * recompute and the column headers actually follow a language change — a
 * module-scope `t` import has a stable identity forever, so nothing would
 * ever invalidate the memo and the headers would freeze at whatever
 * language was active on first render.
 */
export function detectColumns(
  results: BlockRow[],
  customProps: Map<string, Map<string, string>>,
  t: TFunction,
  chosen: string[] | null = null,
): TableColumn[] {
  const content = { key: 'content', label: t('query.column.content') }
  // #6544 — a query that names its columns shows exactly those, in its order.
  if (chosen) return [content, ...chosen.map((key) => namedColumn(key, t))]
  return [
    content,
    ...KNOWN_PROPERTY_KEYS.map(({ key, labelKey }) => ({ key, label: t(labelKey) })),
    ...deriveCustomColumns(results, customProps),
  ]
}

/** The column for a property key a query names: a known field, or a custom property. */
function namedColumn(key: string, t: TFunction): TableColumn {
  const known = KNOWN_PROPERTY_KEYS.find((k) => k.key === key)
  if (known) return { key, label: t(known.labelKey) }
  return { key: `${CUSTOM_COLUMN_PREFIX}${key}`, label: key, propKey: key }
}

export function useQueryTableColumns({
  expression,
  results,
  customProps,
  writeExpression,
}: {
  expression: string
  results: BlockRow[]
  customProps: Map<string, Map<string, string>>
  /** Writes the block's new query; resolves whether it did. */
  writeExpression: (next: string) => Promise<boolean>
}): { columns: TableColumn[]; picker: QueryColumnPickerProps } {
  const { t } = useTranslation()
  const chosen = useMemo(() => readQueryColumns(expression), [expression])
  const columns = useMemo(
    () => detectColumns(results, customProps, t, chosen),
    [results, customProps, t, chosen],
  )
  // The picker offers the derived columns plus any named one no loaded row carries.
  const pickable = useMemo(() => {
    const derived = detectColumns(results, customProps, t)
    const named = columns.filter((col) => !derived.some((d) => d.key === col.key))
    return [...derived, ...named].filter((col) => col.key !== 'content')
  }, [results, customProps, t, columns])
  const onChange = useCallback(
    (keys: string[] | null) => {
      void writeExpression(writeQueryColumns(expression, keys))
    },
    [expression, writeExpression],
  )
  return {
    columns,
    picker: {
      columns: columns.filter((col) => col.key !== 'content'),
      pickable,
      named: chosen !== null,
      onChange,
    },
  }
}
