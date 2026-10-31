/**
 * Tauri mock — a key's values that don't fit its definition (#6206): counted,
 * listed, removed, converted as the user maps each, moved to another key where
 * they fit, and added to a select's options. Mirrors
 * `src-tauri/src/commands/property_unfit.rs`.
 *
 * A value doesn't fit when its row is not in a slot its key's type takes, or
 * when it is a select's text outside the options. The built-ins count but
 * `space` and `is_space`; an undeclared key has none. The space's blocks are
 * read Trash included, as the backend reads them.
 */

import type { PropertyUnfitCounts, UnfitMoveCounts, UnfitValueReplacement } from '@/lib/bindings'
import { fitsDefinition, UNCOUNTED_PROPERTY_KEYS, valueForm } from '@/lib/property-fit'
import { BUILTIN_PROPERTY_DEFS } from '@/lib/property-save-utils'
import { compareUtf8Bytes } from '@/lib/sqlite-collation'
import { coerce, type HeldValue, heldText, RUST_TRIM } from '@/lib/tauri-mock/coerce'
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

/** A row that holds no value fits no type, as no slot of it is set. */
function fits(row: Row, def: DefState): boolean {
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
  return heldText(heldValueOf(heldRow(blockId, key)) as HeldValue)
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
      form: valueForm(row) ?? 'text',
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
      prior: fieldsUnder(heldValueOf(heldRow(blockId, key)) as HeldValue, 'text'),
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
 * `fitted`: `value` as a key under `def` holds it — read by `coerce`, then
 * admitted by `check_property_value`, which refuses blank text and a select's
 * text outside the options — or null when it doesn't fit.
 */
function fitted(value: HeldValue, def: DefState): HeldValue | null {
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
): HeldValue[] {
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
    const fit = fitted(r.replacement, def)
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
  const mapped = new Map(replacements.map((r, i) => [r.value, fitReplacements[i] as HeldValue]))
  const values = unfitHolders(spaceId, key).flatMap((blockId) => {
    const fit = mapped.get(shown(blockId, key))
    if (fit === undefined) return []
    const prior = heldValueOf(heldRow(blockId, key)) as HeldValue
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
    const held = heldValueOf(heldRow(blockId, key)) as HeldValue
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
  const added = [
    ...new Set(
      unfitHolders(spaceId, key).flatMap((blockId) => {
        const text = heldRow(blockId, key)['value_text']
        return typeof text === 'string' ? [text] : []
      }),
    ),
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
