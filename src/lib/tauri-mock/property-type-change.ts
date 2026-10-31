/**
 * Tauri mock — changing a property key's type (#5841 S3). Mirrors
 * `src-tauri/src/commands/property_types.rs` (the preview, the value list and
 * the change, with their refusals) and the undo of an earlier value into a key
 * retyped since (`fit_reverse_to_declared_type`, `commands/history.rs`); what
 * a value becomes under a type is `coerce.ts`. A value the new type does not
 * take is unfit: kept as it is, not written (#6206).
 *
 * The commands read the space's `block_properties` rows, Trash included, as
 * the backend does. `revert.ts` imports this module, so like `property-keys.ts`
 * it does not import `handlers/shared.ts`.
 */

import type { PropertyTypeChangeCounts } from '@/lib/bindings'
import { BUILTIN_PROPERTY_DEFS } from '@/lib/property-save-utils'
import { isIsoDate } from '@/lib/search-query/is-iso-date'
import { coerce, type HeldValue, heldText } from '@/lib/tauri-mock/coerce'
import {
  applyRewrite,
  type DefState,
  defState,
  fieldsUnder,
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
  const unfit = held.filter((h) => h.converted === null).length
  return { converted: held.length - unfit, unfit }
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
    .filter((h) => (h.converted === null) === (kind === 'unfit'))
    .map((h) =>
      Object.assign(holderRow(h.blockId), {
        value: heldText(h.value),
        converted: h.converted === null ? null : heldText(h.converted),
      }),
    )
}

/** The block holding a listed value: its page, its content and whether it is trashed. */
export function holderRow(blockId: string): Row {
  const b = blocks.get(blockId) ?? {}
  const pageId = (b['page_id'] as string | null | undefined) ?? null
  return {
    block_id: blockId,
    page_id: pageId,
    page_title: pageId === null ? null : (blocks.get(pageId)?.['content'] ?? null),
    content: b['content'] ?? null,
    deleted: b['deleted_at'] != null,
  }
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
  if (counts.converted !== acknowledged.converted || counts.unfit !== acknowledged.unfit) {
    throw rejection({
      kind: 'validation',
      code: 'UnacknowledgedPropertyLoss',
      message:
        `changing '${key}' to ${valueType} now converts ${counts.converted} value(s) and ` +
        `leaves ${counts.unfit} that do not fit; preview it again`,
    })
  }
  // A value whose form stays, or that does not fit, is not written; the apply moves its slot.
  const values: ValueWrite[] = held.flatMap((h) =>
    h.converted === null || h.converted === h.value
      ? []
      : [
          {
            block_id: h.blockId,
            key,
            value: fieldsUnder(h.converted, 'text'),
            prior: fieldsUnder(h.value, 'text'),
          },
        ],
  )
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

/** The type `property_declaration` declares: the built-in's, else the space's definition's. */
function declaredTypeOf(spaceId: string | null, key: string): string | null {
  const builtin = BUILTIN_PROPERTY_DEFS.find((def) => def.key === key)
  if (builtin) return builtin.value_type
  const def = spaceId === null ? undefined : spacePropertyDefs(spaceId).get(key)
  return def ? defState(def).value_type : null
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

/**
 * `check_property_value` over a write's slots and a declaration without
 * options: its type and its date. An undo that puts back a select value an
 * options edit has left out since keeps working.
 */
function fitsDeclaredType(fields: Row, valueType: string): boolean {
  if (!admitsShape(fields, valueType)) return false
  return fields['value_date'] == null || isIsoDate(fields['value_date'] as string)
}

/** `declared_type_admits_shape`: `fields` are in a slot `valueType` takes. */
function admitsShape(fields: Row, valueType: string): boolean {
  const slots = DECLARED_SLOTS[valueType]
  return slots === undefined || slots.some((slot) => fields[slot] != null)
}

/**
 * `fit_reverse_to_declared_type`: an undo that puts `fields` back under
 * `blockId`'s `key` puts them in the slot the key's type now uses, converted;
 * a value the type does not take goes back in the slot of its own kind, a
 * string as text (#6206).
 */
export function fitToDeclaredType(blockId: string, key: string, fields: Row): Row {
  const b = blocks.get(blockId)
  // `COALESCE(space_id, id)`: a space's own block is in its space.
  const valueType = declaredTypeOf(b ? (spaceOf(b) ?? blockId) : null, key)
  if (valueType === null || fitsDeclaredType(fields, valueType)) return fields
  const value = heldValueOf(fields)
  if (value === null) return fields
  const converted = coerce(value, valueType)
  return converted === null ? fieldsUnder(value, 'text') : fieldsUnder(converted, valueType)
}
