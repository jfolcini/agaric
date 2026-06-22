/**
 * Data-driven column derivation for inline-query table mode.
 *
 * The four reserved block fields (`todo_state`, `priority`, `due_date`,
 * `scheduled_date`) are read straight off `BlockRow` and shown as the fixed
 * `KNOWN_PROPERTY_KEYS` columns. Arbitrary *custom* properties live in the
 * separate `block_props` table and are not carried on `BlockRow`, so they are
 * fetched per result block via `getBatchProperties` and folded in here as
 * additional columns — the union of non-reserved keys present across the
 * displayed rows.
 */

import { INTERNAL_PROPERTY_KEYS } from '@/lib/block-utils'
import { NON_DELETABLE_PROPERTIES } from '@/lib/property-save-utils'
import type { BlockRow, PropertyRow } from '@/lib/tauri'

/** Prefix that marks a custom-property column key, keeping it distinct from
 * `BlockRow` field keys (so a custom property literally named `content` or
 * `priority` cannot collide with a structural / reserved column). */
export const CUSTOM_COLUMN_PREFIX = 'prop:'

/** Keys never surfaced as a custom column: the reserved block fields (already
 * shown as `KNOWN_PROPERTY_KEYS`), materializer-internal bookkeeping keys, and
 * the space marker. */
const EXCLUDED_COLUMN_KEYS: ReadonlySet<string> = new Set<string>([
  ...NON_DELETABLE_PROPERTIES,
  ...INTERNAL_PROPERTY_KEYS,
  'space',
  'image_width',
])

/** Render a property row to a display string, or `null` when it carries no
 * value. Mirrors the typed-column precedence used elsewhere (text → num →
 * date → ref → bool). */
export function propertyRowDisplay(row: PropertyRow): string | null {
  if (row.value_text != null && row.value_text !== '') return row.value_text
  if (row.value_num != null) return String(row.value_num)
  if (row.value_date != null && row.value_date !== '') return row.value_date
  if (row.value_ref != null && row.value_ref !== '') return row.value_ref
  if (row.value_bool != null) return row.value_bool ? 'true' : 'false'
  return null
}

/** Build a per-block map of custom-property key → display value from a
 * `getBatchProperties` result, dropping reserved/internal keys and rows with
 * no displayable value. */
export function buildCustomPropsMap(
  batch: Record<string, PropertyRow[]>,
): Map<string, Map<string, string>> {
  const byBlock = new Map<string, Map<string, string>>()
  for (const [blockId, rows] of Object.entries(batch)) {
    const props = new Map<string, string>()
    for (const row of rows) {
      if (EXCLUDED_COLUMN_KEYS.has(row.key)) continue
      const display = propertyRowDisplay(row)
      if (display == null) continue
      props.set(row.key, display)
    }
    if (props.size > 0) byBlock.set(blockId, props)
  }
  return byBlock
}

export interface CustomColumn {
  key: string
  label: string
  propKey: string
}

/** Derive custom-property columns from the union of property keys present
 * across the displayed result blocks, sorted alphabetically for a stable
 * column order. */
export function deriveCustomColumns(
  results: BlockRow[],
  customProps: Map<string, Map<string, string>>,
): CustomColumn[] {
  const keys = new Set<string>()
  for (const block of results) {
    const props = customProps.get(block.id)
    if (!props) continue
    for (const key of props.keys()) keys.add(key)
  }
  return [...keys]
    .toSorted((a, b) => a.localeCompare(b))
    .map((key) => ({ key: `${CUSTOM_COLUMN_PREFIX}${key}`, label: key, propKey: key }))
}

/** Resolve the sort/display value for any column key against a block. Custom
 * columns (prefixed) read from the side map; everything else reads the block
 * field. */
export function columnValue(
  block: BlockRow,
  columnKey: string,
  customProps: Map<string, Map<string, string>>,
): string | null {
  if (columnKey === 'content') return block.content
  if (columnKey.startsWith(CUSTOM_COLUMN_PREFIX)) {
    const propKey = columnKey.slice(CUSTOM_COLUMN_PREFIX.length)
    return customProps.get(block.id)?.get(propKey) ?? null
  }
  return (block[columnKey as keyof BlockRow] as string | null) ?? null
}
