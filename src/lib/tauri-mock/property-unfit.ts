/**
 * Tauri mock — a key's values that don't fit its definition (#6206): counted,
 * listed, removed, converted as the user maps each, moved to another key where
 * they fit, and added to a select's options. Mirrors
 * `src-tauri/src/commands/property_unfit.rs`.
 *
 * A value doesn't fit when its row is not in a slot its key's type takes, or
 * when it is a select's text outside the options. Under a key that holds a
 * list (#6741) a value fits when it is a list `set_property` would take, and
 * under any other key a list doesn't. The built-ins count but
 * `space` and `is_space`; an undeclared key has none. The space's blocks are
 * read Trash included, as the backend reads them.
 */

import type { PropertyUnfitCounts, UnfitMoveCounts, UnfitValueReplacement } from '@/lib/bindings'
import { fitsDefinition, UNCOUNTED_PROPERTY_KEYS, valueForm } from '@/lib/property-fit'
import { splitListItems } from '@/lib/property-list'
import { BUILTIN_PROPERTY_DEFS } from '@/lib/property-save-utils'
import { compareUtf8Bytes } from '@/lib/sqlite-collation'
import { coerce, type Held, isList, RUST_TRIM, shownValue } from '@/lib/tauri-mock/coerce'
import {
  applyRewrite,
  type DefState,
  defState,
  fieldsUnder,
  heldValueOf,
  refuseBuiltinKey,
  refuseInternalKey,
  rejection,
  type RewritePayload,
  rowHolders,
  userDef,
  type ValueWrite,
} from '@/lib/tauri-mock/property-keys'
import { holderRow } from '@/lib/tauri-mock/property-type-change'
import {
  blocks,
  properties,
  pushOp,
  pushPropertyDefOp,
  spacePropertyDefs,
} from '@/lib/tauri-mock/seed'

type Row = Record<string, unknown>

/** The definition `key`'s values are held to: the built-in's, else the space's, else none. */
function countedDef(spaceId: string, key: string): DefState | null {
  if (UNCOUNTED_PROPERTY_KEYS.has(key)) return null
  const builtin = BUILTIN_PROPERTY_DEFS.find((def) => def.key === key)
  if (builtin) {
    return {
      value_type: builtin.value_type,
      options: builtin.options && JSON.stringify(builtin.options),
    }
  }
  const def = spacePropertyDefs(spaceId).get(key)
  return def ? defState(def) : null
}

/**
 * `validate_list_items` and `validate_list_value`: `list` is one a key under
 * `def`, which holds a list, takes. The mock's `assertValidListValue` throws
 * the same rules; it lives in `handlers/shared.ts`, which this module cannot
 * import (`revert.ts` → `property-type-change.ts`).
 */
function listFits(list: readonly unknown[], def: DefState): boolean {
  const options =
    def.value_type === 'select' && def.options !== null
      ? (JSON.parse(def.options) as string[])
      : null
  return (
    list.length > 0 &&
    list.every((item) => {
      if (typeof item === 'number') return def.value_type === 'number'
      if (typeof item !== 'string' || item.replace(RUST_TRIM, '') === '') return false
      if (def.value_type === 'number' || def.value_type === 'boolean') return false
      if (def.value_type === 'date' || def.value_type === 'ref') {
        return coerce(item, def.value_type) === item
      }
      return options === null || options.includes(item)
    })
  )
}

/** A row that holds no value fits no type, as no slot of it is set. */
function fits(row: Row, def: DefState): boolean {
  const list = row['value_list']
  if (def.multiple === true) return Array.isArray(list) && listFits(list, def)
  if (list != null) return false
  const form = valueForm(row)
  return (
    form !== null && fitsDefinition(form, (row['value_text'] as string | undefined) ?? null, def)
  )
}

/** The blocks of `spaceId`, Trash included, whose value of `key` doesn't fit it, by id. */
function unfitHolders(spaceId: string, key: string): string[] {
  const def = countedDef(spaceId, key)
  if (def === null) return []
  return rowHolders(spaceId, key).filter(
    (blockId) => !fits(properties.get(blockId)?.get(key) ?? {}, def),
  )
}

function heldRow(blockId: string, key: string): Row {
  return properties.get(blockId)?.get(key) ?? {}
}

/** `shown`: a held value as text, as the list shows it and the distinct read groups it. */
function shown(blockId: string, key: string): string {
  return shownValue(heldValueOf(heldRow(blockId, key)) as Held)
}

function countsOf(held: string[]): PropertyUnfitCounts {
  const inTrash = held.filter((blockId) => blocks.get(blockId)?.['deleted_at'] != null).length
  return { unfit: held.length - inTrash, unfit_in_trash: inTrash }
}

/** The `unfit` / `unfit_in_trash` half of `count_property_usage`'s row for `key`. */
export function unfitCounts(spaceId: string, key: string): PropertyUnfitCounts {
  return countsOf(unfitHolders(spaceId, key))
}

/** Every value `list_unfit_property_values` pages through, by block id. */
export function unfitValues(spaceId: string, key: string): Row[] {
  return unfitHolders(spaceId, key).map((blockId) => {
    const row = heldRow(blockId, key)
    return Object.assign(holderRow(blockId), {
      value: shown(blockId, key),
      form: row['value_list'] == null ? (valueForm(row) ?? 'text') : 'list',
    })
  })
}

/** `remove_unfit_property_values_inner`: what it removed, and the op. */
export function removeUnfitPropertyValues(
  spaceId: string,
  key: string,
  acknowledged: PropertyUnfitCounts,
): Row {
  const held = unfitHolders(spaceId, key)
  const counts = countsOf(held)
  if (
    counts.unfit !== acknowledged.unfit ||
    counts.unfit_in_trash !== acknowledged.unfit_in_trash
  ) {
    throw rejection({
      kind: 'validation',
      code: 'UnacknowledgedPropertyLoss',
      message:
        `'${key}' now has ${counts.unfit} value(s) that don't fit and ` +
        `${counts.unfit_in_trash} in the Trash; look again`,
    })
  }
  if (held.length === 0) return { ...counts, op_refs: [] }
  const payload: RewritePayload = {
    space_id: spaceId,
    reason: 'remove_unfit',
    defs: [],
    values: held.map((blockId) => ({
      block_id: blockId,
      key,
      value: null,
      prior: fieldsUnder(heldValueOf(heldRow(blockId, key)) as Held, 'text'),
    })),
  }
  const op = pushOp('rewrite_properties', { ...payload })
  applyRewrite(payload)
  return { ...counts, op_refs: [{ device_id: op.device_id, seq: op.seq }] }
}

/** `unfitHolders` grouped by each value as {@link shown}. */
function holdersByShown(spaceId: string, key: string): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const blockId of unfitHolders(spaceId, key)) {
    const value = shown(blockId, key)
    const held = groups.get(value) ?? []
    held.push(blockId)
    groups.set(value, held)
  }
  return groups
}

/** Every row `list_distinct_unfit_property_values` pages through. */
export function distinctUnfitValues(spaceId: string, key: string): Row[] {
  return [...holdersByShown(spaceId, key)].map(([value, held]) =>
    Object.assign({ value }, countsOf(held)),
  )
}

/**
 * `fitted`: `value` as a key under `def` holds it — read by `coerce`, under a
 * key that holds a list each item of one, then admitted by
 * `check_property_fields`, which refuses blank text and a select's text
 * outside the options — or null when it doesn't fit: a list fits only a key
 * that holds one, and a single value only a key that doesn't.
 */
function fitted(value: Held, def: DefState): Held | null {
  if (def.multiple === true) {
    if (!isList(value)) return null
    const items = value.map((item) => coerce(item, def.value_type))
    const list = items.filter((item) => typeof item === 'string' || typeof item === 'number')
    return list.length === items.length && listFits(list, def) ? list : null
  }
  if (isList(value)) return null
  const held = coerce(value, def.value_type)
  if (held === null) return null
  if (typeof held === 'string' && held.replace(RUST_TRIM, '') === '') return null
  if (def.value_type === 'select' && !fitsDefinition('text', String(held), def)) return null
  return held
}

/** `fitted_replacements`: each replacement fitted under `key`'s definition, in order. */
function fittedReplacements(
  spaceId: string,
  key: string,
  replacements: UnfitValueReplacement[],
): Held[] {
  const def = countedDef(spaceId, key)
  if (def === null) {
    throw rejection({ kind: 'not_found', message: `property definition '${key}'` })
  }
  if (def.value_type === 'ref') {
    throw rejection({
      kind: 'validation',
      message: `'${key}' is a ref property; its values can't be converted`,
    })
  }
  return replacements.map((r) => {
    // `replacement_value`: under a key that holds a list, the items of the text.
    const fit = fitted(def.multiple === true ? splitListItems(r.replacement) : r.replacement, def)
    if (fit === null) {
      throw rejection({
        kind: 'validation',
        message: `'${r.replacement}' doesn't fit '${key}' (${def.value_type})`,
      })
    }
    return fit
  })
}

/** `convert_unfit_property_values_inner`: how many it converted, and the op. */
export function convertUnfitPropertyValues(
  spaceId: string,
  key: string,
  replacements: UnfitValueReplacement[],
): Row {
  if (replacements.length === 0) {
    throw rejection({ kind: 'validation', message: 'no value to convert' })
  }
  const twice = replacements.find((r, i) => replacements.findIndex((o) => o.value === r.value) < i)
  if (twice) throw rejection({ kind: 'validation', message: `'${twice.value}' is mapped twice` })
  const fitReplacements = fittedReplacements(spaceId, key, replacements)
  const groups = holdersByShown(spaceId, key)
  const converted: PropertyUnfitCounts = { unfit: 0, unfit_in_trash: 0 }
  for (const r of replacements) {
    const counts = countsOf(groups.get(r.value) ?? [])
    if (
      counts.unfit !== r.acknowledged.unfit ||
      counts.unfit_in_trash !== r.acknowledged.unfit_in_trash
    ) {
      throw rejection({
        kind: 'validation',
        code: 'UnacknowledgedPropertyLoss',
        message:
          `'${r.value}' of '${key}' is now on ${counts.unfit} block(s) and ` +
          `${counts.unfit_in_trash} in the Trash; look again`,
      })
    }
    converted.unfit += counts.unfit
    converted.unfit_in_trash += counts.unfit_in_trash
  }
  const mapped = new Map(replacements.map((r, i) => [r.value, fitReplacements[i] as Held]))
  const values = unfitHolders(spaceId, key).flatMap((blockId) => {
    const fit = mapped.get(shown(blockId, key))
    if (fit === undefined) return []
    const prior = heldValueOf(heldRow(blockId, key)) as Held
    return [
      {
        block_id: blockId,
        key,
        value: fieldsUnder(fit, 'text'),
        prior: fieldsUnder(prior, 'text'),
      },
    ]
  })
  if (values.length === 0) return { ...converted, op_refs: [] }
  const payload: RewritePayload = { space_id: spaceId, reason: 'convert_unfit', defs: [], values }
  const op = pushOp('rewrite_properties', { ...payload })
  applyRewrite(payload)
  return { ...converted, op_refs: [{ device_id: op.device_id, seq: op.seq }] }
}

/** `move_target`: `intoKey`'s definition, refused as the backend refuses it. */
function moveTarget(spaceId: string, key: string, intoKey: string): DefState {
  if (intoKey === key) {
    throw rejection({
      kind: 'validation',
      message: `the values of '${key}' cannot move to '${key}' itself`,
    })
  }
  refuseBuiltinKey(intoKey)
  refuseInternalKey(intoKey)
  const def = defState(userDef(spaceId, intoKey))
  if (def.value_type === 'ref') {
    throw rejection({
      kind: 'validation',
      message: `'${intoKey}' is a ref property; its values are blocks`,
    })
  }
  return def
}

/**
 * `plan_move`: what moving `key`'s values that don't fit to `intoKey` does,
 * and per value moved its two writes, by block. A block holding `intoKey`
 * keeps its value, whether or not it would fit.
 */
function planMove(
  spaceId: string,
  key: string,
  intoKey: string,
): { counts: UnfitMoveCounts; values: ValueWrite[] } {
  const def = moveTarget(spaceId, key, intoKey)
  const occupied = new Set(rowHolders(spaceId, intoKey))
  const counts: UnfitMoveCounts = { moved: 0, occupied: 0, unfit_there: 0 }
  const values: ValueWrite[] = []
  for (const blockId of unfitHolders(spaceId, key)) {
    if (occupied.has(blockId)) {
      counts.occupied += 1
      continue
    }
    const held = heldValueOf(heldRow(blockId, key)) as Held
    const fit = fitted(held, def)
    if (fit === null) {
      counts.unfit_there += 1
      continue
    }
    counts.moved += 1
    values.push(
      { block_id: blockId, key, value: null, prior: fieldsUnder(held, 'text') },
      { block_id: blockId, key: intoKey, value: fieldsUnder(fit, 'text'), prior: null },
    )
  }
  return { counts, values }
}

/** `preview_unfit_property_move_inner`. */
export function previewUnfitPropertyMove(
  spaceId: string,
  key: string,
  intoKey: string,
): UnfitMoveCounts {
  return planMove(spaceId, key, intoKey).counts
}

/** `move_unfit_property_values_inner`: what it moved and left, and the op. */
export function moveUnfitPropertyValues(
  spaceId: string,
  key: string,
  intoKey: string,
  acknowledged: UnfitMoveCounts,
): Row {
  const { counts, values } = planMove(spaceId, key, intoKey)
  if (
    counts.moved !== acknowledged.moved ||
    counts.occupied !== acknowledged.occupied ||
    counts.unfit_there !== acknowledged.unfit_there
  ) {
    throw rejection({
      kind: 'validation',
      code: 'UnacknowledgedPropertyLoss',
      message:
        `moving '${key}' to '${intoKey}' now moves ${counts.moved}, and leaves ` +
        `${counts.occupied} already set there and ${counts.unfit_there} that don't fit; look again`,
    })
  }
  if (values.length === 0) return { ...counts, op_refs: [] }
  const payload: RewritePayload = { space_id: spaceId, reason: 'move_unfit', defs: [], values }
  const op = pushOp('rewrite_properties', { ...payload })
  applyRewrite(payload)
  return { ...counts, op_refs: [{ device_id: op.device_id, seq: op.seq }] }
}

/** `add_unfit_values_to_options_inner`: the definition after, and the op. */
export function addUnfitValuesToOptions(spaceId: string, key: string): Row {
  refuseBuiltinKey(key)
  const def = userDef(spaceId, key)
  const valueType = def['value_type'] as string
  if (valueType !== 'select') {
    throw rejection({
      kind: 'validation',
      message: `'${key}' is a ${valueType} property; only a select has options`,
    })
  }
  const options = (def['options'] as string | null) ?? null
  const listed = new Set(options === null ? [] : (JSON.parse(options) as string[]))
  // `with_unfit_texts`: each text that doesn't fit, or under a select that
  // holds a list each such item of the lists that don't.
  const texts = unfitHolders(spaceId, key).flatMap((blockId): unknown[] => {
    const row = heldRow(blockId, key)
    const list = row['value_list']
    if (def['multiple'] === true) return Array.isArray(list) ? list : []
    return list == null ? [row['value_text']] : []
  })
  const added = [
    ...new Set(texts.filter((text) => typeof text === 'string' && !listed.has(text)) as string[]),
  ].toSorted(compareUtf8Bytes)
  if (options === null || added.length === 0) return { ...def, builtin: false, op_refs: [] }
  const updated = {
    ...def,
    options: JSON.stringify([...(JSON.parse(options) as string[]), ...added]),
  }
  const op = pushPropertyDefOp(spaceId, key, updated, def)
  spacePropertyDefs(spaceId).set(key, updated)
  return { ...updated, builtin: false, op_refs: [op] }
}
