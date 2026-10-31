/**
 * Whether a property value fits its key's definition (#6206): the one
 * TypeScript copy of `unfit_values`' rule (`src-tauri/src/commands/property_unfit.rs`),
 * read by the marks on a value that doesn't fit and by the tauri mock's
 * counts. A value doesn't fit when it is in a slot its key's type does not
 * take, or when it is a select's text outside the options.
 */

import type { PropertyValueForm } from '@/lib/bindings'
import { logger } from '@/lib/logger'

type SlotName = 'value_text' | 'value_num' | 'value_date' | 'value_ref' | 'value_bool'

export type PropertySlots = Readonly<Partial<Record<SlotName, unknown>>>

export interface FitDefinition {
  value_type: string
  options: string | null
}

/** Mirrors `UNCOUNTED_PROPERTY_KEYS` (`src-tauri/src/commands/properties.rs`). */
export const UNCOUNTED_PROPERTY_KEYS: ReadonlySet<string> = new Set(['space', 'is_space'])

/** `declared_type_admits_shape`; a type it does not name takes every form. */
const FORMS_TAKEN: Readonly<Record<string, readonly PropertyValueForm[]>> = {
  text: ['text', 'ref'],
  select: ['text', 'ref'],
  url: ['text'],
  number: ['number'],
  date: ['date'],
  boolean: ['boolean'],
  ref: ['ref'],
}

/** `PropertyValueForm::of`: the slot a value sits in, or null when the row holds none. */
export function valueForm(row: PropertySlots): PropertyValueForm | null {
  if (row.value_num != null) return 'number'
  if (row.value_date != null) return 'date'
  if (row.value_ref != null) return 'ref'
  if (row.value_bool != null) return 'boolean'
  return row.value_text != null ? 'text' : null
}

/** A value of `form` fits `def`; `text` is its text, which a select's options are checked against. */
export function fitsDefinition(
  form: PropertyValueForm,
  text: string | null,
  def: FitDefinition,
): boolean {
  const taken = FORMS_TAKEN[def.value_type]
  if (taken === undefined) return true
  if (!taken.includes(form)) return false
  // A ref fits a select whatever its options.
  if (def.value_type !== 'select' || form !== 'text' || def.options === null) return true
  return text !== null && selectOptions(def.options).includes(text)
}

/** A select's options; none when the stored JSON is not an array. */
function selectOptions(options: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(options)
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    logger.warn('property-fit', 'failed to parse select options JSON', { options }, err)
    return []
  }
}

/** A counted key's value that doesn't fit its definition; an undeclared key's never is. */
export function isUnfit(
  key: string,
  form: PropertyValueForm | null,
  text: string | null,
  def: FitDefinition | undefined,
): boolean {
  if (def === undefined || form === null || UNCOUNTED_PROPERTY_KEYS.has(key)) return false
  return !fitsDefinition(form, text, def)
}
