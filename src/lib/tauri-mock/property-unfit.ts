/**
 * Tauri mock — a key's values that don't fit its definition (#6206): counted,
 * listed, removed, and added to a select's options. Mirrors
 * `src-tauri/src/commands/property_unfit.rs`.
 *
 * A value doesn't fit when its row is not in a slot its key's type takes, or
 * when it is a select's text outside the options. The built-ins count but
 * `space` and `is_space`; an undeclared key has none. The space's blocks are
 * read Trash included, as the backend reads them.
 */

import type { PropertyUnfitCounts } from '@/lib/bindings'
import { BUILTIN_PROPERTY_DEFS } from '@/lib/property-save-utils'
import { compareUtf8Bytes } from '@/lib/sqlite-collation'
import { type HeldValue, heldText } from '@/lib/tauri-mock/coerce'
import {
  applyRewrite,
  type DefState,
  defState,
  fieldsUnder,
  heldValueOf,
  refuseBuiltinKey,
  rejection,
  type RewritePayload,
  rowHolders,
  userDef,
} from '@/lib/tauri-mock/property-keys'
import { admitsShape, holderRow } from '@/lib/tauri-mock/property-type-change'
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
  if (key === 'space' || key === 'is_space') return null
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

/** A ref fits a select whatever its options; a text must be one of them. */
function fits(row: Row, def: DefState): boolean {
  if (!admitsShape(row, def.value_type)) return false
  if (def.value_type !== 'select' || row['value_ref'] != null || def.options === null) return true
  return (JSON.parse(def.options) as string[]).includes(row['value_text'] as string)
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

function countsOf(held: string[]): PropertyUnfitCounts {
  const inTrash = held.filter((blockId) => blocks.get(blockId)?.['deleted_at'] != null).length
  return { unfit: held.length - inTrash, unfit_in_trash: inTrash }
}

/** `PropertyValueForm::of`: the slot a value sits in. */
function formOf(row: Row): string {
  if (row['value_num'] != null) return 'number'
  if (row['value_date'] != null) return 'date'
  if (row['value_ref'] != null) return 'ref'
  return row['value_bool'] != null ? 'boolean' : 'text'
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
      value: heldText(heldValueOf(row) as HeldValue),
      form: formOf(row),
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
