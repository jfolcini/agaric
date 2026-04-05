/**
 * property-save-utils — shared save / delete logic for property editors.
 *
 * Used by both PagePropertyTable and BlockPropertyDrawer to eliminate
 * duplicated type-based dispatch and validation when saving properties.
 */

import type { PropertyRow } from './tauri'
import { deleteProperty, getProperties, setProperty } from './tauri'

type SetPropertyParams = Parameters<typeof setProperty>[0]

export type BuildResult =
  | { ok: true; params: SetPropertyParams }
  | { ok: false; error: 'invalidNumber' }

/**
 * Build setProperty params based on the property value type.
 *
 * Handles number validation and type-appropriate field mapping.
 * Returns `{ ok: false, error: 'invalidNumber' }` when the raw value
 * looks non-empty but cannot be parsed as a number.
 */
export function buildPropertyParams(
  blockId: string,
  key: string,
  value: string,
  valueType: string,
): BuildResult {
  if (valueType === 'number') {
    const num = Number(value)
    if (value.trim() && !Number.isNaN(num)) {
      return { ok: true, params: { blockId, key, valueNum: num } }
    }
    if (value.trim()) {
      return { ok: false, error: 'invalidNumber' }
    }
    // Empty number field — clear the value
    return { ok: true, params: { blockId, key, valueText: '' } }
  }
  if (valueType === 'date') {
    return { ok: true, params: { blockId, key, valueDate: value || null } }
  }
  // Text and other types
  return { ok: true, params: { blockId, key, valueText: value } }
}

/**
 * Save a property value: validates type, calls setProperty, then
 * refreshes the property list via `onRefresh`.
 *
 * Returns `false` when validation fails (e.g. invalid number) so the
 * caller can show an appropriate error toast.
 */
export async function handleSaveProperty(
  blockId: string,
  key: string,
  value: string,
  valueType: string,
  onRefresh: (props: PropertyRow[]) => void,
): Promise<boolean> {
  const result = buildPropertyParams(blockId, key, value, valueType)
  if (!result.ok) return false
  await setProperty(result.params)
  const updated = await getProperties(blockId)
  onRefresh(updated)
  return true
}

/**
 * Delete a property from a block and invoke the refresh callback.
 */
export async function handleDeleteProperty(
  blockId: string,
  key: string,
  onRefresh: () => void,
): Promise<void> {
  await deleteProperty(blockId, key)
  onRefresh()
}
