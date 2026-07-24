/**
 * List-ness as a block attribute (#3000).
 *
 * A block's list style is stored as a generic `block_properties` row under the
 * key {@link LIST_STYLE_KEY} with a `value_text` of `'bullet'` or `'ordered'`.
 * The **absence** of the row means {@link ListStyle} `'none'` — a plain block —
 * so `'none'` is never written; it is represented by clearing the property.
 *
 * This module is the single source of truth for the key string, the value
 * vocabulary, and the read/write helpers, so no consumer spells the raw key or
 * value literals. See `docs/architecture/list-ergonomics.md` for the model.
 */

import type { PropertyRow } from '@/lib/tauri/properties'
import { deleteProperty, setProperty } from '@/lib/tauri/properties'

/** The block-property key under which list-ness is stored. */
export const LIST_STYLE_KEY = 'listStyle'

/**
 * A block's list style. `'none'` is the default and is represented by the
 * absence of a {@link LIST_STYLE_KEY} property row (never stored explicitly).
 */
export type ListStyle = 'none' | 'bullet' | 'ordered'

/** The two styles that are actually persisted (`'none'` clears the row). */
export const STORED_LIST_STYLES = ['bullet', 'ordered'] as const

/** `options` JSON for the `select`-type property definition (seed migration). */
export const LIST_STYLE_OPTIONS_JSON = JSON.stringify(STORED_LIST_STYLES)

/** Narrow an arbitrary string to a stored {@link ListStyle}, or `'none'`. */
export function asListStyle(value: string | null | undefined): ListStyle {
  return value === 'bullet' || value === 'ordered' ? value : 'none'
}

/**
 * Project a block's property rows to its {@link ListStyle}. Returns `'none'`
 * when no `listStyle` row is present (or its value is unrecognised).
 */
export function listStyleFromRows(rows: readonly PropertyRow[] | undefined): ListStyle {
  const row = rows?.find((r) => r.key === LIST_STYLE_KEY)
  return asListStyle(row?.value_text)
}

/**
 * Set a block's list style. Writing `'none'` clears the property (delete)
 * rather than storing a sentinel, keeping the "absent = none" invariant.
 */
export async function setListStyle(blockId: string, style: ListStyle): Promise<void> {
  if (style === 'none') {
    await deleteProperty(blockId, LIST_STYLE_KEY)
    return
  }
  await setProperty({ blockId, key: LIST_STYLE_KEY, valueText: style })
}

/** Clear a block's list style (equivalent to `setListStyle(id, 'none')`). */
export async function clearListStyle(blockId: string): Promise<void> {
  await deleteProperty(blockId, LIST_STYLE_KEY)
}
