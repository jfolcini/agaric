/**
 * property-save-utils — shared save / delete logic for property editors.
 *
 * Used by both PagePropertyTable and BlockPropertyDrawer to eliminate
 * duplicated type-based dispatch and validation when saving properties.
 */

import { unwrap } from '@/lib/app-error'
import type { PropertyDefinition, PropertyRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { getTodayString } from '@/lib/date-utils'

/** Ergonomic single-value-field param shape produced by
 *  {@link buildPropertyParams} and reshaped at the call site into
 *  `commands.setProperty`'s positional `(blockId, key, values)` form.
 *
 *  Structural copy of the `@/lib/tauri` `setProperty` param type (that wrapper
 *  still exists for not-yet-migrated callers, so the two must stay in sync
 *  while both are live) — kept local so this module stays free of
 *  `@/lib/tauri` imports, mirroring the same pattern already used by
 *  `InlineSetPropertyParams` in `inline-property-parse.ts`. */
interface SetPropertyParams {
  blockId: string
  key: string
  valueText?: string | null | undefined
  valueNum?: number | null | undefined
  valueDate?: string | null | undefined
  valueRef?: string | null | undefined
  valueBool?: boolean | null | undefined
}

export type BuildResult =
  | { ok: true; params: SetPropertyParams }
  | { ok: false; error: 'invalidNumber' }

/**
 * Properties that the backend considers non-deletable (system-managed).
 * Mirrors `is_builtin_property_key` in `src-tauri/agaric-store/src/op.rs`.
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
 * (`none → TODO → DOING → DONE → CANCELLED → none`) is intentionally fixed
 * (reordered by), and the DB-side `options` are kept in
 * sync with the in-code cycle via migrations 0029 and 0031. Editing them
 * from the UI would let the DB drift out of sync with `TASK_CYCLE` in
 * `useBlockProperties.ts`, silently breaking the status filter dimension
 * in AgendaFilterBuilder.
 *
 * `priority` is NOT locked here even though its cycle is also fixed today
 * (`null → 1 → 2 → 3 → null`); unlocking priority is scope.
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
    case 'number': {
      return { blockId, key: def.key, valueNum: 0 }
    }
    case 'date': {
      // Local calendar day (matches getTodayString / formatDate used
      // everywhere else); `toISOString()` would be UTC → off-by-one for
      // users in negative-offset timezones.
      return { blockId, key: def.key, valueDate: getTodayString() }
    }
    case 'text':
    case 'select': {
      return { blockId, key: def.key, valueText: '' }
    }
    case 'ref': {
      return { blockId, key: def.key, valueRef: null }
    }
    case 'boolean': {
      // A freshly-added boolean property defaults to false.
      return { blockId, key: def.key, valueBool: false }
    }
    default: {
      return null
    }
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
  if (valueType === 'boolean') {
    // Boolean values are passed in as 'true'/'false' (or '' to clear).
    if (value === '') {
      return { ok: true, params: { blockId, key, valueBool: null } }
    }
    return { ok: true, params: { blockId, key, valueBool: value === 'true' } }
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
  unwrap(
    await commands.setProperty(result.params.blockId, result.params.key, {
      value_text: result.params.valueText ?? null,
      value_num: result.params.valueNum ?? null,
      value_date: result.params.valueDate ?? null,
      value_ref: result.params.valueRef ?? null,
      value_bool: result.params.valueBool ?? null,
    }),
  )
  const updated = unwrap(await commands.getProperties(blockId))
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
  unwrap(await commands.deleteProperty(blockId, key))
  onRefresh()
}
