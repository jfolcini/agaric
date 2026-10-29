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
interface DefState {
  value_type: string
  options: string | null
}

interface DefWrite {
  key: string
  def: DefState | null
  prior: DefState | null
}

interface ValueWrite {
  block_id: string
  key: string
  value: ValueFields | null
  prior: ValueFields | null
}

interface RewritePayload {
  space_id: string
  reason: string
  defs: DefWrite[]
  values: ValueWrite[]
}

function rejection(err: AppError): Error & AppError {
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

/** App bookkeeping (`INTERNAL_PROPERTY_KEYS`) is never renamed or merged, from or onto. */
function refuseInternalKey(key: string): void {
  if (INTERNAL_PROPERTY_KEYS.has(key)) {
    throw validation(`property '${key}' is used by the app and cannot be renamed or merged`)
  }
}

function spaceOf(b: Row): string | null {
  const own = b['space_id'] as string | null | undefined
  if (own != null) return own
  const owner = (b['page_id'] as string | null | undefined) ?? (b['id'] as string)
  return (blocks.get(owner)?.['space_id'] as string | null | undefined) ?? null
}

/** The blocks of `spaceId`, Trash included, that hold `key`, by id. */
function holders(spaceId: string, key: string): string[] {
  return [...properties.entries()]
    .filter(([blockId, held]) => {
      const b = blocks.get(blockId)
      return held.has(key) && b !== undefined && (blockId === spaceId || spaceOf(b) === spaceId)
    })
    .map(([blockId]) => blockId)
    .toSorted(compareUtf8Bytes)
}

/** `refuse_taken_key`: `key` is free to become a user property of `spaceId`. */
export function refuseTakenKey(spaceId: string, key: string): void {
  refusePropertyKeyShape(key)
  refuseInternalKey(key)
  if (spacePropertyDefs(spaceId).has(key)) {
    throw validation(`property '${key}' is already defined in this space`)
  }
  const used = holders(spaceId, key).length
  if (used > 0) {
    throw validation(`property '${key}' is already used by ${used} block(s) in this space`)
  }
}

function userDef(spaceId: string, key: string): Row {
  const def = spacePropertyDefs(spaceId).get(key)
  if (!def) throw rejection({ kind: 'not_found', message: `property definition '${key}'` })
  return def
}

function defState(row: Row): DefState {
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

function rowOf(key: string, fields: ValueFields): Row {
  const bool = fields['value_bool'] as boolean | null | undefined
  return { ...fields, key, value_bool: bool == null ? null : bool ? 1 : 0 }
}

/**
 * The engine's rename apply: every block of the space holding `oldKey` and
 * not `newKey` moves its value, and the definition moves when `newKey` has
 * none. Where `newKey` is already present nothing moves, so a replayed
 * rename never overwrites a later write.
 */
function moveKey(spaceId: string, oldKey: string, newKey: string): void {
  for (const blockId of holders(spaceId, oldKey)) {
    const held = properties.get(blockId)
    const row = held?.get(oldKey)
    if (!held || !row || held.has(newKey)) continue
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
  const from = holders(spaceId, fromKey)
  const dropped = from.filter((blockId) => properties.get(blockId)?.has(intoKey)).length
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
    const value = fieldsOf(held?.get(fromKey) ?? {})
    values.push({ block_id: blockId, key: fromKey, value: null, prior: value })
    if (!held?.has(intoKey)) values.push({ block_id: blockId, key: intoKey, value, prior: null })
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

/** The engine's rewrite apply: each definition, then each value, set or removed. */
function applyRewrite(p: RewritePayload): void {
  const defs = spacePropertyDefs(p.space_id)
  for (const write of p.defs) {
    if (write.def === null) {
      defs.delete(write.key)
      continue
    }
    const createdAt = defs.get(write.key)?.['created_at'] ?? new Date().toISOString()
    defs.set(write.key, { key: write.key, ...write.def, created_at: createdAt })
  }
  for (const write of p.values) {
    if (write.value === null) {
      properties.get(write.block_id)?.delete(write.key)
      continue
    }
    if (!properties.has(write.block_id)) properties.set(write.block_id, new Map())
    properties.get(write.block_id)?.set(write.key, rowOf(write.key, write.value))
  }
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

/** A rewrite moved `blockId`'s `key` when it removed it and wrote the same value under another key. */
function rewriteTarget(p: RewritePayload, blockId: string, key: string): string {
  const removed = p.values.find(
    (v) => v.block_id === blockId && v.key === key && v.value === null && v.prior !== null,
  )
  if (!removed) return key
  const same = JSON.stringify(removed.prior)
  const written = p.values.find(
    (v) =>
      v.block_id === blockId &&
      v.key !== key &&
      v.value !== null &&
      JSON.stringify(v.value) === same,
  )
  return written?.key ?? key
}

/**
 * `forward_property_key`: the key `blockId`'s value of `key` lives under now,
 * followed through every rename and merge of the block's space after
 * `target`, reverses included.
 */
export function forwardPropertyKey(target: MockOpLogEntry, blockId: string, key: string): string {
  const b = blocks.get(blockId)
  const spaceId = b ? spaceOf(b) : null
  if (spaceId === null) return key
  const start = opLog.findIndex((o) => o.device_id === target.device_id && o.seq === target.seq)
  let current = key
  for (const op of opLog.slice(start + 1)) {
    if (op.op_type !== 'rename_property_key' && op.op_type !== 'rewrite_properties') continue
    const p = JSON.parse(op.payload) as Record<string, unknown>
    if (p['space_id'] !== spaceId) continue
    if (op.op_type === 'rename_property_key') {
      if (p['old_key'] === current) current = p['new_key'] as string
    } else {
      current = rewriteTarget(p as unknown as RewritePayload, blockId, current)
    }
  }
  return current
}
