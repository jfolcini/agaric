/**
 * Tauri mock — renaming and merging a property key (#5841 S2). Mirrors
 * `src-tauri/src/commands/property_keys.rs` (the commands and their
 * refusals), `reverse/property_ops.rs` (their reverses and
 * `forward_property_key`) and the engine's rename / rewrite apply.
 *
 * A space's blocks are its pages and their blocks, Trash included, and the
 * space block itself. `revert.ts` imports this module and `handlers/shared.ts`
 * imports `revert.ts`, so the refusals are built here rather than through
 * `appErrorRejection`.
 */

import type { AppError, PropertyMergeCounts } from '@/lib/bindings'
import { INTERNAL_PROPERTY_KEYS } from '@/lib/block-utils'
import { NON_DELETABLE_PROPERTIES } from '@/lib/property-save-utils'
import { compareUtf8Bytes } from '@/lib/sqlite-collation'
import { coerce, type HeldValue } from '@/lib/tauri-mock/coerce'
import {
  blocks,
  type MockOpLogEntry,
  opLog,
  properties,
  pushOp,
  spacePropertyDefs,
} from '@/lib/tauri-mock/seed'

type Row = Record<string, unknown>
/** `PropertyValueFields` (`agaric-store/src/op.rs`). */
type ValueFields = Row
/** `PropertyDefState`: what a definition write sets or replaces. */
export interface DefState {
  value_type: string
  options: string | null
}

export interface DefWrite {
  key: string
  def: DefState | null
  prior: DefState | null
}

export interface ValueWrite {
  block_id: string
  key: string
  value: ValueFields | null
  prior: ValueFields | null
}

export interface RewritePayload {
  space_id: string
  reason: string
  defs: DefWrite[]
  values: ValueWrite[]
}

export function rejection(err: AppError): Error & AppError {
  return Object.assign(new Error(err.message), err)
}

function validation(message: string): Error & AppError {
  return rejection({ kind: 'validation', message })
}

/** `refuse_builtin_definition_write` (`commands/properties.rs`). */
export function refuseBuiltinKey(key: string): void {
  if (NON_DELETABLE_PROPERTIES.has(key)) {
    throw rejection({
      kind: 'validation',
      code: 'BuiltinPropertyLocked',
      message: `property '${key}' is built in and cannot be changed`,
    })
  }
}

/** The key half of `validate_property_def_shape`. */
export function refusePropertyKeyShape(key: string): void {
  refuseBuiltinKey(key)
  if (key.length === 0 || key.length > 64) {
    throw validation('property definition key must be 1-64 characters')
  }
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw validation(
      'property definition key must contain only alphanumeric, underscore, or hyphen characters',
    )
  }
}

/**
 * App bookkeeping (`INTERNAL_PROPERTY_KEYS`) is never renamed, merged (from or
 * onto) or retyped.
 */
export function refuseInternalKey(key: string): void {
  if (INTERNAL_PROPERTY_KEYS.has(key)) {
    throw validation(`property '${key}' is the app's own and cannot be changed`)
  }
}

/** The `value_type` vocabulary `validate_property_def_shape` matches on. */
const PROPERTY_DEF_VALUE_TYPES = new Set([
  'text',
  'number',
  'date',
  'select',
  'ref',
  'boolean',
  'url',
])

/** `serde_json::from_str::<Vec<String>>`: anything but an array of strings is refused. */
export function parsePropertyDefOptions(options: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(options)
  } catch {
    parsed = undefined
  }
  if (!Array.isArray(parsed) || parsed.some((o) => typeof o !== 'string')) {
    throw validation('options must be a JSON array of strings')
  }
  return parsed as string[]
}

/**
 * Mock twin of `validate_property_def_shape` (`commands/properties.rs`). The
 * mock used to accept every key, every value_type and every options blob, so a
 * conformance op could not tell a refusal from a write (#3830).
 */
export function validatePropertyDefShape(
  key: string,
  valueType: string,
  options: string | null,
): void {
  refusePropertyKeyShape(key)
  if (!PROPERTY_DEF_VALUE_TYPES.has(valueType)) {
    throw validation(
      `invalid value_type '${valueType}': must be text, number, date, select, ref, boolean, or url`,
    )
  }
  if (valueType === 'select') {
    if (options === null) {
      throw validation('select-type definitions require an options array')
    }
    if (parsePropertyDefOptions(options).length === 0) {
      throw validation('select-type options must not be empty')
    }
  } else if (options !== null) {
    throw validation(`options are only allowed for select-type definitions, not '${valueType}'`)
  }
}

export function spaceOf(b: Row): string | null {
  const own = b['space_id'] as string | null | undefined
  if (own != null) return own
  const owner = (b['page_id'] as string | null | undefined) ?? (b['id'] as string)
  return (blocks.get(owner)?.['space_id'] as string | null | undefined) ?? null
}

const VALUE_SLOTS = ['value_text', 'value_num', 'value_date', 'value_ref', 'value_bool']

/** A row with no value: the mock's engine Null, a clear SQL holds no row for. */
function isNullRow(row: Row): boolean {
  return VALUE_SLOTS.every((slot) => row[slot] == null)
}

/** The block holds a value under `key`; an engine Null counts as none. */
function holdsValue(held: Map<string, Row> | undefined, key: string): boolean {
  const row = held?.get(key)
  return row !== undefined && !isNullRow(row)
}

/** The blocks of `spaceId`, Trash included, whose doc holds `key`, by id. */
function holders(spaceId: string, key: string): string[] {
  return [...properties.entries()]
    .filter(([blockId, held]) => {
      const b = blocks.get(blockId)
      return held.has(key) && b !== undefined && (blockId === spaceId || spaceOf(b) === spaceId)
    })
    .map(([blockId]) => blockId)
    .toSorted(compareUtf8Bytes)
}

/** The {@link holders} SQL shows: a block's engine Null is no row there. */
export function rowHolders(spaceId: string, key: string): string[] {
  return holders(spaceId, key).filter((blockId) => holdsValue(properties.get(blockId), key))
}

/** `refuse_taken_key`: `key` is free to become a user property of `spaceId`. */
export function refuseTakenKey(spaceId: string, key: string): void {
  refusePropertyKeyShape(key)
  refuseInternalKey(key)
  if (spacePropertyDefs(spaceId).has(key)) {
    throw validation(`property '${key}' is already defined in this space`)
  }
  const used = rowHolders(spaceId, key).length
  if (used > 0) {
    throw validation(`property '${key}' is already used by ${used} block(s) in this space`)
  }
}

export function userDef(spaceId: string, key: string): Row {
  const def = spacePropertyDefs(spaceId).get(key)
  if (!def) throw rejection({ kind: 'not_found', message: `property definition '${key}'` })
  return def
}

export function defState(row: Row): DefState {
  return { value_type: row['value_type'] as string, options: (row['options'] as string) ?? null }
}

/** A `block_properties` row's value as `PropertyValueFields`: a bool slot is a bool there. */
function fieldsOf(row: Row): ValueFields {
  const bool = row['value_bool'] as number | boolean | null | undefined
  return {
    value_text: row['value_text'] ?? null,
    value_num: row['value_num'] ?? null,
    value_date: row['value_date'] ?? null,
    value_ref: row['value_ref'] ?? null,
    value_bool: bool == null ? null : Boolean(bool),
  }
}

/** A `block_properties` row of `fields`: a bool slot is 1 or 0 there. */
export function rowOf(key: string, fields: ValueFields): Row {
  const bool = fields['value_bool'] as boolean | null | undefined
  return { ...fields, key, value_bool: bool == null ? null : bool ? 1 : 0 }
}

/**
 * The engine's rename apply: every block of the space holding `oldKey` and
 * no value under `newKey` (an engine Null counts as none) moves its value, and the definition moves when `newKey` has
 * none. Where `newKey` is already present nothing moves, so a replayed
 * rename never overwrites a later write.
 */
function moveKey(spaceId: string, oldKey: string, newKey: string): void {
  for (const blockId of holders(spaceId, oldKey)) {
    const held = properties.get(blockId)
    const row = held?.get(oldKey)
    if (!held || !row || holdsValue(held, newKey)) continue
    held.set(newKey, { ...row, key: newKey })
    held.delete(oldKey)
  }
  const defs = spacePropertyDefs(spaceId)
  const def = defs.get(oldKey)
  if (def && !defs.has(newKey)) {
    defs.set(newKey, { ...def, key: newKey })
    defs.delete(oldKey)
  }
}

/** `rename_property_key_inner`: the definition under its new key, and the op. */
export function renamePropertyKey(spaceId: string, oldKey: string, newKey: string): Row {
  if (oldKey === newKey) throw validation('the new key is the same as the old one')
  refuseBuiltinKey(oldKey)
  refuseInternalKey(oldKey)
  userDef(spaceId, oldKey)
  refuseTakenKey(spaceId, newKey)
  const op = pushOp('rename_property_key', {
    space_id: spaceId,
    old_key: oldKey,
    new_key: newKey,
  })
  moveKey(spaceId, oldKey, newKey)
  return {
    ...userDef(spaceId, newKey),
    builtin: false,
    op_refs: [{ device_id: op.device_id, seq: op.seq }],
  }
}

/** The refusals a merge preview and a merge share; answers both definitions. */
function refuseMerge(spaceId: string, fromKey: string, intoKey: string): [Row, Row] {
  if (fromKey === intoKey) throw validation('a property cannot be merged into itself')
  refuseBuiltinKey(fromKey)
  refuseBuiltinKey(intoKey)
  refuseInternalKey(fromKey)
  refuseInternalKey(intoKey)
  const from = userDef(spaceId, fromKey)
  const into = userDef(spaceId, intoKey)
  if (from['value_type'] !== into['value_type']) {
    throw validation(
      `'${fromKey}' is ${from['value_type'] as string} and '${intoKey}' is ` +
        `${into['value_type'] as string}: change one type first`,
    )
  }
  return [from, into]
}

function mergeCounts(spaceId: string, fromKey: string, intoKey: string): PropertyMergeCounts {
  const from = rowHolders(spaceId, fromKey)
  const dropped = from.filter((blockId) => holdsValue(properties.get(blockId), intoKey)).length
  return { moved: from.length - dropped, dropped }
}

/** `preview_property_merge_inner`. */
export function previewPropertyMerge(
  spaceId: string,
  fromKey: string,
  intoKey: string,
): PropertyMergeCounts {
  refuseMerge(spaceId, fromKey, intoKey)
  return mergeCounts(spaceId, fromKey, intoKey)
}

/** A select's options after a merge: `into`'s in order, then `from`'s it lacks. */
function unionOptions(into: string | null, from: string | null): string | null {
  if (into === null || from === null) return into
  const intoOptions = JSON.parse(into) as string[]
  const added = (JSON.parse(from) as string[]).filter((o) => !intoOptions.includes(o))
  return added.length === 0 ? into : JSON.stringify([...intoOptions, ...added])
}

/** `merge_property_key_inner`: `intoKey`'s definition after the merge, and the op. */
export function mergePropertyKey(
  spaceId: string,
  fromKey: string,
  intoKey: string,
  acknowledged: PropertyMergeCounts,
): Row {
  const [from, into] = refuseMerge(spaceId, fromKey, intoKey)
  const counts = mergeCounts(spaceId, fromKey, intoKey)
  if (counts.moved !== acknowledged.moved || counts.dropped !== acknowledged.dropped) {
    throw rejection({
      kind: 'validation',
      code: 'UnacknowledgedPropertyLoss',
      message:
        `merging '${fromKey}' into '${intoKey}' now moves ${counts.moved} value(s) and ` +
        `removes ${counts.dropped}`,
    })
  }
  const values: ValueWrite[] = []
  for (const blockId of holders(spaceId, fromKey)) {
    const held = properties.get(blockId)
    const row = held?.get(fromKey) ?? {}
    // An engine Null is removed and moves nowhere.
    const value = isNullRow(row) ? null : fieldsOf(row)
    values.push({ block_id: blockId, key: fromKey, value: null, prior: value })
    if (value !== null && !holdsValue(held, intoKey)) {
      values.push({ block_id: blockId, key: intoKey, value, prior: null })
    }
  }
  const intoState = defState(into)
  const payload: RewritePayload = {
    space_id: spaceId,
    reason: 'merge',
    defs: [
      { key: fromKey, def: null, prior: defState(from) },
      {
        key: intoKey,
        def: { ...intoState, options: unionOptions(intoState.options, defState(from).options) },
        prior: intoState,
      },
    ],
    values,
  }
  const op = pushOp('rewrite_properties', { ...payload })
  applyRewrite(payload)
  return {
    ...userDef(spaceId, intoKey),
    builtin: false,
    op_refs: [{ device_id: op.device_id, seq: op.seq }],
  }
}

/** The value `fields` holds as the engine holds it, or null for none (an engine Null). */
export function heldValueOf(fields: Row): HeldValue | null {
  const str = fields['value_text'] ?? fields['value_date'] ?? fields['value_ref']
  if (str != null) return str as string
  if (fields['value_num'] != null) return fields['value_num'] as number
  return fields['value_bool'] == null ? null : Boolean(fields['value_bool'])
}

/** `str_column_for`: the slot a string under `valueType` projects into. */
function strColumnFor(valueType: unknown): string {
  const typed: Record<string, string> = {
    number: 'value_num',
    boolean: 'value_bool',
    date: 'value_date',
    ref: 'value_ref',
  }
  return (typeof valueType === 'string' && typed[valueType]) || 'value_text'
}

/**
 * `value_fields_under`: `value` in the slot a write under `valueType` uses. A
 * string's slot is the type's; under no type, or text, it is `value_text`, the
 * engine's own kind of it, as a rewrite's payload records it.
 */
export function fieldsUnder(value: HeldValue, valueType: unknown): ValueFields {
  const fields: ValueFields = Object.fromEntries(VALUE_SLOTS.map((slot) => [slot, null]))
  const slot =
    typeof value === 'string'
      ? strColumnFor(valueType)
      : typeof value === 'number'
        ? 'value_num'
        : 'value_bool'
  fields[slot] = value
  return fields
}

function declaredType(spaceId: string, key: string): unknown {
  return spacePropertyDefs(spaceId).get(key)?.['value_type']
}

function applyDefWrites(spaceId: string, writes: DefWrite[]): void {
  const defs = spacePropertyDefs(spaceId)
  for (const write of writes) {
    if (write.def === null) {
      defs.delete(write.key)
      continue
    }
    const createdAt = defs.get(write.key)?.['created_at'] ?? new Date().toISOString()
    defs.set(write.key, { key: write.key, ...write.def, created_at: createdAt })
  }
}

/** One value write, in the slot its key's type uses. */
function applyValueWrite(spaceId: string, write: ValueWrite): void {
  const value = write.value === null ? null : heldValueOf(write.value)
  if (value === null) {
    properties.get(write.block_id)?.delete(write.key)
    return
  }
  if (!properties.has(write.block_id)) properties.set(write.block_id, new Map())
  const fields = fieldsUnder(value, declaredType(spaceId, write.key))
  properties.get(write.block_id)?.set(write.key, rowOf(write.key, fields))
}

/**
 * A retyped key's other strings are projected under its new type, as
 * `reproject_property_row_from_engine` does through `coerce`: moved to its
 * slot, or, when the type does not take them, dropped; numbers and booleans
 * stay. KNOWN GAP: the mock has no engine to keep a dropped string, so a
 * change back does not show it again as the backend's does.
 */
function reprojectKey(spaceId: string, key: string): void {
  const valueType = declaredType(spaceId, key)
  const projectedType = typeof valueType === 'string' ? valueType : 'text'
  for (const blockId of holders(spaceId, key)) {
    const held = properties.get(blockId)
    const value = heldValueOf(held?.get(key) ?? {})
    if (typeof value !== 'string') continue
    const fit = coerce(value, projectedType)
    if (fit === null) held?.delete(key)
    else held?.set(key, rowOf(key, fieldsUnder(fit, valueType)))
  }
}

/**
 * The engine's rewrite apply: each definition, then each value, set or
 * removed, in the slot its key's type uses; then the other values of a key
 * whose type's slot changed move with it. A value of a block purged since the
 * op was written is dropped.
 */
export function applyRewrite(p: RewritePayload): void {
  const retyped = p.defs
    .filter(
      (w) => strColumnFor(declaredType(p.space_id, w.key)) !== strColumnFor(w.def?.value_type),
    )
    .map((w) => w.key)
  applyDefWrites(p.space_id, p.defs)
  for (const write of p.values) {
    if (blocks.has(write.block_id)) applyValueWrite(p.space_id, write)
  }
  for (const key of retyped) reprojectKey(p.space_id, key)
}

/** `reverse_rewrite_properties`: every write swaps what it set and what it replaced. */
function swapRewrite(p: RewritePayload): RewritePayload {
  return {
    space_id: p.space_id,
    reason: p.reason,
    defs: p.defs.map((d) => ({ key: d.key, def: d.prior, prior: d.def })),
    values: p.values.map((v) => ({
      block_id: v.block_id,
      key: v.key,
      value: v.prior,
      prior: v.value,
    })),
  }
}

/** The forward payload of a rename's or a rewrite's reverse, or null for any other op. */
export function propertyKeyReversePayload(
  opType: string,
  p: Record<string, unknown>,
): Record<string, unknown> | null {
  if (opType === 'rename_property_key') {
    return { space_id: p['space_id'], old_key: p['new_key'], new_key: p['old_key'] }
  }
  if (opType === 'rewrite_properties') return { ...swapRewrite(p as unknown as RewritePayload) }
  return null
}

/**
 * Apply the reverse of a rename or a rewrite; false for any other op. The
 * reverse of a rename is refused when the old key has been declared or used
 * since, as `apply_reverse_in_tx` refuses it.
 */
export function revertPropertyKeyOp(opType: string, p: Record<string, unknown>): boolean {
  const reverse = propertyKeyReversePayload(opType, p)
  if (reverse === null) return false
  if (opType === 'rename_property_key') {
    const spaceId = reverse['space_id'] as string
    refuseTakenKey(spaceId, reverse['new_key'] as string)
    moveKey(spaceId, reverse['old_key'] as string, reverse['new_key'] as string)
  } else {
    applyRewrite(reverse as unknown as RewritePayload)
  }
  return true
}

/**
 * `value_move`: how a rewrite moved `blockId`'s value of `key` — out of it to
 * another key (`{ out }`) when it removed the value there and wrote the block
 * a value elsewhere, `'in'` when it wrote there and removed another key, or
 * null.
 */
function valueMove(p: RewritePayload, blockId: string, key: string): { out: string } | 'in' | null {
  const mine = p.values.filter((v) => v.block_id === blockId)
  const here = mine.find((v) => v.key === key)
  if (!here) return null
  const other = mine.find((v) => v.key !== key && (v.value === null) !== (here.value === null))
  if (!other) return null
  return here.value === null ? { out: other.key } : 'in'
}

/**
 * `forward_property_key`: the key `blockId`'s value of `key` lives under now,
 * followed through every rename and merge of the block's space after
 * `target`, reverses included. A value moved into the key is another key's,
 * so its moving out again (the merge's undo) leaves the key where it is.
 */
export function forwardPropertyKey(target: MockOpLogEntry, blockId: string, key: string): string {
  const b = blocks.get(blockId)
  if (!b) return key
  // `COALESCE(space_id, id)`: a space's own block names no space.
  const spaceId = spaceOf(b) ?? blockId
  const start = opLog.findIndex((o) => o.device_id === target.device_id && o.seq === target.seq)
  let current = key
  let movedIn = false
  for (const op of opLog.slice(start + 1)) {
    if (op.op_type !== 'rename_property_key' && op.op_type !== 'rewrite_properties') continue
    const p = JSON.parse(op.payload) as Record<string, unknown>
    if (p['space_id'] !== spaceId) continue
    if (op.op_type === 'rename_property_key') {
      // A rename is its own inverse on its two names: a walk on the new name,
      // whose value was gone before the rename, takes the name it vacated.
      if (p['old_key'] === current) current = p['new_key'] as string
      else if (p['new_key'] === current) current = p['old_key'] as string
      continue
    }
    const move = valueMove(p as unknown as RewritePayload, blockId, current)
    if (move === 'in') {
      movedIn = true
    } else if (move !== null) {
      if (!movedIn) current = move.out
      movedIn = false
    }
  }
  return current
}
