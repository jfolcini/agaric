/**
 * Tauri mock — changing a property key's type (#5841 S3). Mirrors
 * `src-tauri/src/commands/property_types.rs` (the preview, the value list and
 * the change, with their refusals), `agaric-engine/src/loro/coerce.rs` (what
 * a value becomes under a type) and the undo of an earlier value into a key
 * retyped since (`fit_reverse_to_declared_type`, `commands/history.rs`).
 *
 * The commands read the space's `block_properties` rows, Trash included, as
 * the backend does. `revert.ts` imports this module, so like `property-keys.ts`
 * it does not import `handlers/shared.ts`.
 */

import type { PropertyTypeChangeCounts } from '@/lib/bindings'
import { BUILTIN_PROPERTY_DEFS } from '@/lib/property-save-utils'
import { isIsoDate } from '@/lib/search-query/is-iso-date'
import {
  applyRewrite,
  type DefState,
  defState,
  fieldsUnder,
  type HeldValue,
  heldValueOf,
  refuseBuiltinKey,
  refuseInternalKey,
  rejection,
  rowHolders,
  spaceOf,
  userDef,
  validatePropertyDefShape,
  type ValueWrite,
} from '@/lib/tauri-mock/property-keys'
import { blocks, properties, pushOp, spacePropertyDefs } from '@/lib/tauri-mock/seed'

type Row = Record<string, unknown>

/** Rust's `f64` grammar: a sign, digits with an optional point, an optional exponent. */
const RUST_F64 = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
/** `canonical_ulid`: Crockford base32, any case, no overflow. */
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i

/** What a string becomes under each type that does not take any string, or null. */
const STRING_COERCIONS: Readonly<Record<string, (s: string) => HeldValue | null>> = {
  number: (s) => {
    const trimmed = s.trim()
    const n = Number(trimmed)
    return RUST_F64.test(trimmed) && Number.isFinite(n) ? n : null
  },
  date: (s) => (isIsoDate(s) ? s : null),
  boolean: (s) => (s === 'true' ? true : s === 'false' ? false : null),
  ref: (s) => (ULID.test(s) ? s.toUpperCase() : null),
}

/** The types whose values are strings the engine takes as they are. */
function takesAnyString(to: string): boolean {
  return !Object.hasOwn(STRING_COERCIONS, to)
}

/**
 * `coerce`: the value `value` becomes under a definition of `to`, or null when
 * it does not fit. Select membership is the caller's.
 */
export function coerce(value: HeldValue, to: string): HeldValue | null {
  if (typeof value === 'string') {
    const coerceString = STRING_COERCIONS[to]
    return coerceString ? coerceString(value) : value
  }
  if (typeof value === 'number' && to === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' && to === 'boolean') return value
  return takesAnyString(to) ? String(value) : null
}

/** `coerce`, then a select's options: what `value` becomes under `to`, or null. */
function convert(value: HeldValue, to: DefState): HeldValue | null {
  const converted = coerce(value, to.value_type)
  if (to.value_type !== 'select' || converted === null) return converted
  const options = JSON.parse(to.options ?? '[]') as string[]
  return typeof converted === 'string' && options.includes(converted) ? converted : null
}

/**
 * `type_change_target`: the key's definition now and after the change, past
 * the refusals in the backend's order.
 */
function typeChangeTarget(
  spaceId: string,
  key: string,
  valueType: string,
  options: string | null,
): [DefState, DefState] {
  refuseBuiltinKey(key)
  refuseInternalKey(key)
  validatePropertyDefShape(key, valueType, options)
  const from = defState(userDef(spaceId, key))
  if (from.value_type === valueType) {
    throw rejection({ kind: 'validation', message: `'${key}' is already a ${valueType} property` })
  }
  return [from, { value_type: valueType, options }]
}

interface Held {
  blockId: string
  value: HeldValue
  converted: HeldValue | null
}

/** Every value of `key` SQL shows in the space, by block, with what it becomes under `to`. */
function heldValues(spaceId: string, key: string, to: DefState): Held[] {
  return rowHolders(spaceId, key).map((blockId) => {
    const value = heldValueOf(properties.get(blockId)?.get(key) ?? {}) as HeldValue
    return { blockId, value, converted: convert(value, to) }
  })
}

function countsOf(held: Held[]): PropertyTypeChangeCounts {
  const removed = held.filter((h) => h.converted === null).length
  return { converted: held.length - removed, removed }
}

/** `preview_property_type_change_inner`. */
export function previewPropertyTypeChange(
  spaceId: string,
  key: string,
  valueType: string,
  options: string | null,
): PropertyTypeChangeCounts {
  const [, to] = typeChangeTarget(spaceId, key, valueType, options)
  return countsOf(heldValues(spaceId, key, to))
}

/**
 * Every value `list_property_type_change_values` pages through, by block id:
 * the values of `kind`, each as text, with the block and its page.
 */
export function propertyTypeChangeValues(
  spaceId: string,
  key: string,
  valueType: string,
  options: string | null,
  kind: string,
): Row[] {
  const [, to] = typeChangeTarget(spaceId, key, valueType, options)
  return heldValues(spaceId, key, to)
    .filter((h) => (h.converted === null) === (kind === 'removed'))
    .map((h) => {
      const b = blocks.get(h.blockId) ?? {}
      const pageId = (b['page_id'] as string | null | undefined) ?? null
      return {
        block_id: h.blockId,
        page_id: pageId,
        page_title: pageId === null ? null : (blocks.get(pageId)?.['content'] ?? null),
        content: b['content'] ?? null,
        deleted: b['deleted_at'] != null,
        value: String(h.value),
        converted: h.converted === null ? null : String(h.converted),
      }
    })
}

/** `change_property_type_inner`: the definition after the change, and the op. */
export function changePropertyType(
  spaceId: string,
  key: string,
  valueType: string,
  options: string | null,
  acknowledged: PropertyTypeChangeCounts,
): Row {
  const [from, to] = typeChangeTarget(spaceId, key, valueType, options)
  const held = heldValues(spaceId, key, to)
  const counts = countsOf(held)
  if (counts.converted !== acknowledged.converted || counts.removed !== acknowledged.removed) {
    throw rejection({
      kind: 'validation',
      code: 'UnacknowledgedPropertyLoss',
      message:
        `changing '${key}' to ${valueType} now converts ${counts.converted} and removes ` +
        `${counts.removed} value(s); preview it again`,
    })
  }
  // A value whose converted form is the same is not written; the apply moves its slot.
  const values: ValueWrite[] = held
    .filter((h) => h.converted !== h.value)
    .map((h) => ({
      block_id: h.blockId,
      key,
      value: h.converted === null ? null : fieldsUnder(h.converted, 'text'),
      prior: fieldsUnder(h.value, 'text'),
    }))
  const payload = {
    space_id: spaceId,
    reason: 'change_type',
    defs: [{ key, def: to, prior: from }],
    values,
  }
  const op = pushOp('rewrite_properties', { ...payload })
  applyRewrite(payload)
  return {
    ...userDef(spaceId, key),
    builtin: false,
    op_refs: [{ device_id: op.device_id, seq: op.seq }],
  }
}

/** `property_declaration`: the built-in, else the space's definition. */
function declarationOf(spaceId: string | null, key: string): DefState | null {
  const builtin = BUILTIN_PROPERTY_DEFS.find((def) => def.key === key)
  if (builtin) {
    return {
      value_type: builtin.value_type,
      options: builtin.options && JSON.stringify(builtin.options),
    }
  }
  const def = spaceId === null ? undefined : spacePropertyDefs(spaceId).get(key)
  return def ? defState(def) : null
}

/** The slot `validate_declared_type` takes under each type; text and select take a ref too. */
const DECLARED_SLOTS: Readonly<Record<string, readonly string[]>> = {
  text: ['value_text', 'value_ref'],
  select: ['value_text', 'value_ref'],
  ref: ['value_ref'],
  number: ['value_num'],
  date: ['value_date'],
  boolean: ['value_bool'],
  url: ['value_text'],
}

/** `check_property_value` over a write's slots: its type, its date and its option. */
function fitsDeclaration(fields: Row, decl: DefState): boolean {
  const slots = DECLARED_SLOTS[decl.value_type]
  if (slots && !slots.some((slot) => fields[slot] != null)) return false
  if (fields['value_date'] != null && !isIsoDate(fields['value_date'] as string)) return false
  const text = fields['value_text']
  if (decl.value_type !== 'select' || decl.options === null || text == null) return true
  return (JSON.parse(decl.options) as string[]).includes(text as string)
}

/**
 * `fit_reverse_to_declared_type`: an undo that puts `fields` back under
 * `blockId`'s `key` puts them in the slot the key's type now uses, converted;
 * a value the type does not take is refused, as the backend refuses it.
 */
export function fitToDeclaredType(blockId: string, key: string, fields: Row): Row {
  const b = blocks.get(blockId)
  const decl = declarationOf(b ? spaceOf(b) : null, key)
  if (decl === null || fitsDeclaration(fields, decl)) return fields
  const value = heldValueOf(fields)
  const converted = value === null ? null : convert(value, decl)
  if (converted === null) {
    throw rejection({
      kind: 'validation',
      message:
        `undoing this would put '${String(value)}' under '${key}', now a ${decl.value_type} ` +
        'property; change its type back first',
    })
  }
  return fieldsUnder(converted, decl.value_type)
}
