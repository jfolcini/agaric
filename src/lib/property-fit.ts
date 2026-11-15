/**
 * Whether a property value fits its key's definition (#6206): the one
 * TypeScript copy of `unfit_values`' rule (`src-tauri/src/commands/property_unfit.rs`),
 * read by the marks on a value that doesn't fit and by the tauri mock's
 * counts. A value doesn't fit when it is in a slot its key's type does not
 * take, or when it is a select's text outside the options. A key that holds
 * several values (#6741) takes only a list, each item of its type; any other
 * key takes no list.
 */

import type { PropertyValueForm } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { isIsoDate } from '@/lib/search-query/is-iso-date'

type SlotName =
  | 'value_text'
  | 'value_num'
  | 'value_date'
  | 'value_ref'
  | 'value_bool'
  | 'value_list'

export type PropertySlots = Readonly<Partial<Record<SlotName, unknown>>>

export interface FitDefinition {
  value_type: string
  options: string | null
  /** The key holds a list of `value_type` items. */
  multiple?: boolean | undefined
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
  if (row.value_list != null) return 'list'
  if (row.value_num != null) return 'number'
  if (row.value_date != null) return 'date'
  if (row.value_ref != null) return 'ref'
  if (row.value_bool != null) return 'boolean'
  return row.value_text != null ? 'text' : null
}

/**
 * A value of `form` fits `def`; `text` is its text, which a select's options are checked
 * against, and `items` a list's items.
 */
export function fitsDefinition(
  form: PropertyValueForm,
  text: string | null,
  def: FitDefinition,
  items: readonly unknown[] | null = null,
): boolean {
  if (def.multiple === true) {
    // Only a list row has items.
    if (items === null || items.length === 0) return false
    const fitsItem = itemFit(def)
    return items.every(fitsItem)
  }
  if (form === 'list') return false
  const taken = FORMS_TAKEN[def.value_type]
  if (taken === undefined) return true
  if (!taken.includes(form)) return false
  // A ref fits a select whatever its options.
  if (def.value_type !== 'select' || form !== 'text' || def.options === null) return true
  return text !== null && selectOptions(def.options).includes(text)
}

/** Whether an item fits a list of `def`'s type: a number item is a number, every other a string. */
function itemFit(def: FitDefinition): (item: unknown) => boolean {
  switch (def.value_type) {
    case 'number': {
      return (item) => typeof item === 'number'
    }
    case 'date': {
      return (item) => typeof item === 'string' && isIsoDate(item)
    }
    case 'select': {
      const options = def.options === null ? null : selectOptions(def.options)
      return (item) => typeof item === 'string' && (options === null || options.includes(item))
    }
    case 'text':
    case 'url':
    case 'ref': {
      return (item) => typeof item === 'string'
    }
    // A boolean is never a list.
    case 'boolean': {
      return () => false
    }
    default: {
      return () => true
    }
  }
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

/**
 * A counted key's value that doesn't fit its definition; an undeclared key's never is. `items`
 * are a list's items.
 */
export function isUnfit(
  key: string,
  form: PropertyValueForm | null,
  text: string | null,
  def: FitDefinition | undefined,
  items: readonly unknown[] | null = null,
): boolean {
  if (def === undefined || form === null || UNCOUNTED_PROPERTY_KEYS.has(key)) return false
  return !fitsDefinition(form, text, def, items)
}
