/**
 * Tauri mock — changing a property key's type (#5841 S3). Mirrors
 * `src-tauri/src/commands/property_types.rs` (the preview, the value list and
 * the change, with their refusals) and the undo of an earlier value into a key
 * retyped since (`fit_reverse_to_declared_type`, `commands/history.rs`); what
 * a value becomes under a type is `coerce.ts`. A value the new type does not
 * take is unfit: kept as it is, not written (#6206). A change may also make
 * the key hold a list, or stop it holding one (#6741).
 *
 * The commands read the space's `block_properties` rows, Trash included, as
 * the backend does. `revert.ts` imports this module, so like `property-keys.ts`
 * it does not import `handlers/shared.ts`.
 */

import type { ListSeparator, PropertyTypeChangeCounts } from '@/lib/bindings'
import { BUILTIN_PROPERTY_DEFS } from '@/lib/property-save-utils'
import { isIsoDate } from '@/lib/search-query/is-iso-date'
import {
  coerce,
  type Held,
  type HeldValue,
  heldText,
  isList,
  RUST_TRIM,
  shownValue,
} from '@/lib/tauri-mock/coerce'
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

/** The type a change takes a key to (`PropertyTypeTarget`), and where it splits or joins. */
export interface TypeTarget {
  valueType: string
  options: string | null
  /** Whether the key holds a list afterwards; null keeps what it holds now. */
  multiple: boolean | null
  separator: ListSeparator | null
}

/** `ConversionRule::item`: `coerce`, then a select's options. */
function convertItem(value: HeldValue, to: DefState): HeldValue | null {
  const converted = coerce(value, to.value_type)
  if (to.value_type !== 'select' || converted === null) return converted
  const options = JSON.parse(to.options ?? '[]') as string[]
  return typeof converted === 'string' && options.includes(converted) ? converted : null
}

/** `ConversionRule::list`: every item converted, and at least one, or null. */
function convertList(items: readonly HeldValue[], to: DefState): Held | null {
  const converted = items.map((item) => convertItem(item, to))
  const fits = converted.length > 0 && converted.every((item) => typeof item !== 'boolean')
  return fits && !converted.includes(null) ? (converted as (string | number)[]) : null
}

/**
 * `ConversionRule::convert`: what a held `value` becomes under `to`, or null
 * when it does not fit. A single value becomes a list of one item, or of the
 * parts its text splits into at the separator; a list of one item becomes that
 * item, and a longer one only a text or URL, joined by the separator.
 */
function convert(value: Held, to: DefState, separator: ListSeparator | null): Held | null {
  if (isList(value)) {
    if (to.multiple === true) return convertList(value, to)
    if (value.length === 1) return convertItem(value[0] as HeldValue, to)
    const joins = separator !== null && (to.value_type === 'text' || to.value_type === 'url')
    return joins ? value.map(heldText).join(separator === 'comma' ? ', ' : '; ') : null
  }
  if (to.multiple !== true) return convertItem(value, to)
  if (typeof value !== 'string' || separator === null) return convertList([value], to)
  const parts = value
    .split(separator === 'comma' ? ',' : ';')
    .map((part) => part.replace(RUST_TRIM, ''))
  return convertList(
    parts.filter((part) => part !== ''),
    to,
  )
}

/**
 * `type_change_defs`: the key's definition now and after the change, past
 * the refusals in the backend's order.
 */
function typeChangeTarget(spaceId: string, key: string, target: TypeTarget): [DefState, DefState] {
  const { valueType, options } = target
  refuseBuiltinKey(key)
  refuseInternalKey(key)
  validatePropertyDefShape(key, valueType, options)
  const from = defState(userDef(spaceId, key))
  const multiple = target.multiple ?? from.multiple === true
  if (from.value_type === valueType && (from.multiple === true) === multiple) {
    throw rejection({ kind: 'validation', message: `'${key}' is already a ${valueType} property` })
  }
  if (multiple && valueType === 'boolean') {
    throw rejection({
      kind: 'validation',
      message: `property '${key}' cannot hold a list of booleans`,
    })
  }
  return [from, { value_type: valueType, options, ...(multiple ? { multiple: true } : {}) }]
}

interface HeldRow {
  blockId: string
  value: Held
  converted: Held | null
}

/** Every value of `key` SQL shows in the space, by block, with what it becomes under `to`. */
function heldValues(
  spaceId: string,
  key: string,
  to: DefState,
  separator: ListSeparator | null,
): HeldRow[] {
  return rowHolders(spaceId, key).map((blockId) => {
    const value = heldValueOf(properties.get(blockId)?.get(key) ?? {}) as Held
    return { blockId, value, converted: convert(value, to, separator) }
  })
}

/** `PropertyValue`'s equality: a list item for item. */
function sameHeld(a: Held, b: Held): boolean {
  if (!isList(a) || !isList(b)) return a === b
  return a.length === b.length && a.every((item, i) => item === b[i])
}

function countsOf(held: HeldRow[]): PropertyTypeChangeCounts {
  const unfit = held.filter((h) => h.converted === null).length
  return { converted: held.length - unfit, unfit }
}

/** `preview_property_type_change_inner`. */
export function previewPropertyTypeChange(
  spaceId: string,
  key: string,
  target: TypeTarget,
): PropertyTypeChangeCounts {
  const [, to] = typeChangeTarget(spaceId, key, target)
  return countsOf(heldValues(spaceId, key, to, target.separator))
}

/**
 * Every value `list_property_type_change_values` pages through, by block id:
 * the values of `kind`, each as text, with the block and its page.
 */
export function propertyTypeChangeValues(
  spaceId: string,
  key: string,
  target: TypeTarget,
  kind: string,
): Row[] {
  const [, to] = typeChangeTarget(spaceId, key, target)
  return heldValues(spaceId, key, to, target.separator)
    .filter((h) => (h.converted === null) === (kind === 'unfit'))
    .map((h) =>
      Object.assign(holderRow(h.blockId), {
        value: shownValue(h.value),
        converted: h.converted === null ? null : shownValue(h.converted),
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
  target: TypeTarget,
  acknowledged: PropertyTypeChangeCounts,
): Row {
  const { valueType } = target
  const [from, to] = typeChangeTarget(spaceId, key, target)
  const held = heldValues(spaceId, key, to, target.separator)
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
    h.converted === null || sameHeld(h.converted, h.value)
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
 * string as text (#6206). A list goes back as it was: no type converts one.
 */
export function fitToDeclaredType(blockId: string, key: string, fields: Row): Row {
  const b = blocks.get(blockId)
  // `COALESCE(space_id, id)`: a space's own block is in its space.
  const valueType = declaredTypeOf(b ? (spaceOf(b) ?? blockId) : null, key)
  if (valueType === null || fitsDeclaredType(fields, valueType)) return fields
  const value = heldValueOf(fields)
  if (value === null || isList(value)) return fields
  const converted = coerce(value, valueType)
  return converted === null ? fieldsUnder(value, 'text') : fieldsUnder(converted, valueType)
}
