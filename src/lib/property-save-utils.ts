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
 * in `task-states.ts`, and the DB-side `options` are kept in sync via
 * migrations 0029 and 0031. Editing them from the UI would let the DB drift
 * from the canonical vocabulary, silently breaking the status filter
 * dimension in AgendaFilterBuilder.
 *
 * `priority` is NOT locked here even though its cycle is also fixed today
 * (`null → 1 → 2 → 3 → null`); unlocking priority is scope.
 */
export const LOCKED_PROPERTY_OPTIONS = new Set(['todo_state'])

/**
 * Keys that live in a dedicated column on `blocks` and can therefore never be
 * a `block_properties` row. Mirrors `COLUMN_BACKED_PROPERTY_KEYS` in
 * `src-tauri/agaric-store/src/op.rs` (the four reserved keys plus `space`).
 *
 * Distinct from {@link NON_DELETABLE_PROPERTIES}, which mirrors
 * `is_builtin_property_key` (the reserved keys plus the `created_at` /
 * `completed_at` / `repeat-*` lifecycle keys) — the two sets overlap but mean
 * different things, and `delete_property` explicitly ALLOWS the reserved keys
 * while refusing the lifecycle ones.
 */
export const COLUMN_BACKED_PROPERTY_KEYS = new Set([
  'todo_state',
  'priority',
  'due_date',
  'scheduled_date',
  'space',
])

/** The six `value_type`s `create_property_def_inner` accepts. */
const DEFINABLE_VALUE_TYPES = new Set(['text', 'number', 'date', 'select', 'ref', 'boolean'])

/**
 * The `property_definitions` row a KEY RENAME should carry over to the new
 * key, or `null` when there is nothing safe to carry (#4010).
 *
 * `set_property` never inserts a definition row, so renaming `estimate` →
 * `effortPoints` left the new key undeclared: `getPropertyDef` missed, the
 * chip editor's `valueType` fell back to `'text'`, and the NEXT inline edit
 * re-flattened the `value_num` the rename had just carried across. The
 * rename therefore carries the DEFINITION alongside the value — it copies a
 * declaration the user already made, rather than inventing one, so a key that
 * was genuinely untyped stays untyped (`null` here).
 *
 * The declared type is only copied when it AGREES with the column actually
 * being carried, mirroring `validate_property_value`'s step-4 matrix in
 * `agaric-engine/src/block_ops.rs`. On drift (a `number` declaration over a
 * row holding `value_text`) copying the declaration would make the engine
 * reject the rename's own write, turning a working rename into a failure; the
 * copy is skipped instead and the rename proceeds exactly as before.
 *
 * `options` are copied for `select` only — `create_property_def_inner`
 * rejects them for every other type, and rejects a `select` without them (or
 * with an empty one). A `select` declaration is additionally checked against
 * step 5 of the same engine function: an options array that no longer contains
 * the value being carried (or that will not parse) would make the engine reject
 * the rename's write just as surely as a type mismatch, so it is not copied.
 */
export function carriedRenameDefinition(
  oldDef: { value_type: string; options: string | null } | null | undefined,
  oldRow: PropertyRow,
): { valueType: string; options: string | null } | null {
  if (!oldDef || !DEFINABLE_VALUE_TYPES.has(oldDef.value_type)) return null
  const hasText = oldRow.value_text != null
  const hasRef = oldRow.value_ref != null
  // Same shape as the engine's `type_matches`: `text`/`select` accept a ref
  // too (a text-declared key may legitimately hold a block reference).
  const agrees = ((): boolean => {
    switch (oldDef.value_type) {
      case 'text':
      case 'select': {
        return hasText || hasRef
      }
      case 'ref': {
        return hasRef
      }
      case 'number': {
        return oldRow.value_num != null
      }
      case 'date': {
        return oldRow.value_date != null
      }
      case 'boolean': {
        return oldRow.value_bool != null
      }
      default: {
        return false
      }
    }
  })()
  if (!agrees) return null
  if (oldDef.value_type === 'select') {
    // A select definition without an options array is not creatable.
    if (oldDef.options == null) return null
    // Step 5 of `validate_property_value`, not just step 4: a `select`
    // declaration with an options array ALSO constrains `value_text` to be one
    // of the listed options, and malformed options JSON is itself a rejection
    // ("has malformed options JSON"). The options list can drift away from a
    // stored value after the fact (the Properties tab edits options in place,
    // and import/MCP writes can predate the declaration), so copying such a
    // declaration would make the engine reject the rename's own write — the
    // exact failure the step-4 check above exists to avoid. Skip the copy.
    let allowed: unknown
    try {
      allowed = JSON.parse(oldDef.options)
    } catch {
      return null
    }
    if (!Array.isArray(allowed) || allowed.length === 0) return null
    if (!allowed.every((o) => typeof o === 'string')) return null
    if (oldRow.value_text != null && !allowed.includes(oldRow.value_text)) return null
    return { valueType: 'select', options: oldDef.options }
  }
  return { valueType: oldDef.value_type, options: null }
}

/**
 * Whether a KEY RENAME may create a `property_definitions` row for `newKey`
 * (#4041 review notes 3 + 4).
 *
 * The declaration has to be written BEFORE the value — the engine validates
 * the payload shape against it (`validate_property_value` step 4) — so
 * "create it afterwards" is not on the table, and the value write can still
 * fail after the declaration lands: the block soft-deleted concurrently, a
 * `ref` whose target sits in another space, a `repeat` rule the command
 * boundary rejects, a plain IPC failure. Whatever the reason, the rename did
 * not happen and the declaration must not survive it.
 *
 * A compensating delete alone cannot deliver that.
 * `delete_property_def_inner` (`src-tauri/src/commands/properties.rs`)
 * refuses to remove a definition while ANY `block_properties` row references
 * the key ("Clear them first via set_property(value=None) on each affected
 * block"), and refuses every `is_builtin_property_key` outright. The case
 * where the leftover hurts most — a key other blocks already use — is
 * precisely the case the delete refuses, so the cleanup would be missing
 * exactly where it is needed. Worse, that state is not reachable only on
 * failure: declaring an in-use free-text key as `number` on a SUCCESSFUL
 * rename makes every other block's value un-writable and cannot be undone
 * from the UI.
 *
 * Hence the rule is narrower than "clean up afterwards": only declare what
 * could be taken back, established BEFORE anything is written.
 *
 * - Builtin (`NON_DELETABLE_PROPERTIES`) and column-backed keys —
 *   `create_property_def` has no reserved-key guard of its own, and the
 *   delete refuses every builtin, so such a row is un-removable the instant
 *   it lands. (Column-backed keys were already skipped; their shape is fixed
 *   by the `blocks` column.)
 * - A key that is ALREADY declared — `create_property_def` is INSERT OR
 *   IGNORE, so nothing would be created anyway, and the existing row is the
 *   user's, never this rename's to withdraw.
 * - A key any block already holds a value for — `list_property_keys` is the
 *   distinct `block_properties` key list, the same predicate the delete's
 *   refusal counts.
 *
 * Skipping the copy costs only what #4010 added: the renamed key stays
 * undeclared, exactly as before that fix, and the VALUE still carries over
 * untouched. `list_property_keys` truncates at the 1000 most-used keys, so a
 * vault past that cap can still slip a rarely-used key through — that
 * remainder is what the caller's compensating delete is for.
 *
 * #4399 — since `create_property_def` grew an in-use probe of its own, this
 * is no longer the only thing between a rename and a declaration over
 * someone else's values. The backend probe runs inside the insert's
 * `BEGIN IMMEDIATE`, so it closes both gaps this one has by construction:
 * the TOCTOU between the read pool and the write pool, and the keys past the
 * 1000-key cap. This check stays because it is strictly broader — it also
 * declines builtin and already-declared keys, which the backend accepts by
 * design — and because declining locally saves a round-trip whose only
 * possible outcome is a rejection.
 *
 * Throws whatever the two lookups throw; the caller treats a failed
 * pre-flight like a failed copy (best-effort, rename proceeds).
 */
export async function renameMayDeclareKey(newKey: string): Promise<boolean> {
  if (NON_DELETABLE_PROPERTIES.has(newKey) || COLUMN_BACKED_PROPERTY_KEYS.has(newKey)) return false
  if (unwrap(await commands.getPropertyDef(newKey)) != null) return false
  return !unwrap(await commands.listPropertyKeys()).includes(newKey)
}

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
