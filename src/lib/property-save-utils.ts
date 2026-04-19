/**
 * property-save-utils — shared save / delete logic for property editors.
 *
 * Used by both PagePropertyTable and BlockPropertyDrawer to eliminate
 * duplicated type-based dispatch and validation when saving properties.
 */

import type { PropertyDefinition, PropertyRow } from './tauri'
import { deleteProperty, getProperties, setProperty } from './tauri'

type SetPropertyParams = Parameters<typeof setProperty>[0]

export type BuildResult =
  | { ok: true; params: SetPropertyParams }
  | { ok: false; error: 'invalidNumber' }

/**
 * Properties that the backend considers non-deletable (system-managed).
 * Mirrors `is_builtin_property_key` in `src-tauri/src/op.rs`.
 */
export const NON_DELETABLE_PROPERTIES = new Set([
  'todo_state',
  'priority',
  'due_date',
  'scheduled_date',
  'created_at',
  'completed_at',
  'repeat',
  'repeat-until',
  'repeat-count',
  'repeat-seq',
  'repeat-origin',
])

/**
 * Properties whose `options` list is locked — users cannot edit them from
 * the Properties tab. Currently only `todo_state`: the task cycle
 * (`none → TODO → DOING → CANCELLED → DONE → none`) is intentionally fixed
 * per UX-202, and the DB-side `options` are kept in sync with the in-code
 * cycle via migration 0029. Editing them from the UI would let the DB
 * drift out of sync with `TASK_CYCLE` in `useBlockProperties.ts`, silently
 * breaking the status filter dimension in AgendaFilterBuilder.
 *
 * `priority` is NOT locked here even though its cycle is also fixed today
 * (`null → 1 → 2 → 3 → null`); unlocking priority is UX-201b's scope.
 */
export const LOCKED_PROPERTY_OPTIONS = new Set(['todo_state'])

/**
 * Build the type-appropriate `setProperty` params for initializing a
 * newly-added property.  Ref properties are initialized with a null
 * ref — the UI shows the page picker immediately so the user can
 * select a target.
 */
export function buildInitParams(
  blockId: string,
  def: PropertyDefinition,
): SetPropertyParams | null {
  switch (def.value_type) {
    case 'number':
      return { blockId, key: def.key, valueNum: 0 }
    case 'date':
      return { blockId, key: def.key, valueDate: new Date().toISOString().slice(0, 10) }
    case 'text':
    case 'select':
      return { blockId, key: def.key, valueText: '' }
    case 'ref':
      return { blockId, key: def.key, valueRef: null }
    default:
      return null
  }
}

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
    // Empty number field — clear the value using the correct typed field
    return { ok: true, params: { blockId, key, valueNum: null } }
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
