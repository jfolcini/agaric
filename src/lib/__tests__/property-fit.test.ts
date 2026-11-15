/**
 * #6206 — the TypeScript copy of `unfit_values`' rule against the backend's.
 *
 * The rows below are the SAME tables the Rust tests use
 * (`each_type_takes_only_its_own_forms_6206` and
 * `a_builtin_select_takes_only_its_options_6206` in
 * `src-tauri/tests/commands/property_unfit_cmd_tests.rs`). Keep the two in
 * step: if you add a row to one, add it to the other.
 */

import { describe, expect, it, vi } from 'vitest'

import type { PropertyValueForm } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { type FitDefinition, fitsDefinition, isUnfit, valueForm } from '@/lib/property-fit'
import { BUILTIN_PROPERTY_DEFS } from '@/lib/property-save-utils'

const FORMS: readonly PropertyValueForm[] = ['text', 'number', 'date', 'ref', 'boolean']

/** The Rust table's text value, `Slot::Text("a")`. */
const TEXT = 'a'

const TYPES: ReadonlyArray<[string, FitDefinition, readonly PropertyValueForm[]]> = [
  ['k-text', { value_type: 'text', options: null }, ['number', 'date', 'boolean']],
  ['k-url', { value_type: 'url', options: null }, ['number', 'date', 'ref', 'boolean']],
  ['k-select', { value_type: 'select', options: '["a"]' }, ['number', 'date', 'boolean']],
  ['k-open', { value_type: 'select', options: null }, ['number', 'date', 'boolean']],
  ['k-number', { value_type: 'number', options: null }, ['text', 'date', 'ref', 'boolean']],
  ['k-date', { value_type: 'date', options: null }, ['text', 'number', 'ref', 'boolean']],
  ['k-boolean', { value_type: 'boolean', options: null }, ['text', 'number', 'date', 'ref']],
  ['k-ref', { value_type: 'ref', options: null }, ['text', 'number', 'date', 'boolean']],
]

function builtin(key: string): FitDefinition {
  const def = BUILTIN_PROPERTY_DEFS.find((d) => d.key === key)
  if (def === undefined) throw new Error(`no built-in ${key}`)
  return { value_type: def.value_type, options: def.options && JSON.stringify(def.options) }
}

describe('isUnfit (#6206)', () => {
  for (const [key, def, unfit] of TYPES) {
    it(`${key} takes only its own forms`, () => {
      const marked = FORMS.filter((form) => isUnfit(key, form, form === 'text' ? TEXT : null, def))
      expect(marked).toEqual(unfit)
    })
  }

  it('a select with options takes a text among them, one without takes any text', () => {
    expect(isUnfit('k-select', 'text', 'z', { value_type: 'select', options: '["a"]' })).toBe(true)
    expect(isUnfit('k-open', 'text', 'z', { value_type: 'select', options: null })).toBe(false)
  })

  it('a built-in holds its values to its own type', () => {
    expect(isUnfit('repeat-count', 'text', 'lots', builtin('repeat-count'))).toBe(true)
    expect(isUnfit('repeat-count', 'number', null, builtin('repeat-count'))).toBe(false)
  })

  it('a built-in select takes only its options', () => {
    const def = builtin('listStyle')
    expect(isUnfit('listStyle', 'text', 'ordered', def)).toBe(false)
    expect(isUnfit('listStyle', 'text', 'zigzag', def)).toBe(true)
    expect(isUnfit('listStyle', 'number', null, def)).toBe(true)
  })

  it('an uncounted key, an undeclared key and a row with no value are never marked', () => {
    expect(isUnfit('is_space', 'text', 'yes', { value_type: 'boolean', options: null })).toBe(false)
    expect(isUnfit('loose', 'number', null, undefined)).toBe(false)
    expect(isUnfit('k-number', null, null, { value_type: 'number', options: null })).toBe(false)
  })

  it('a select whose options are not a JSON array takes no text, and says so', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(isUnfit('k-select', 'text', 'a', { value_type: 'select', options: '{"a":1}' })).toBe(
      true,
    )
    expect(isUnfit('k-select', 'text', 'a', { value_type: 'select', options: 'not json' })).toBe(
      true,
    )
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('an unknown type takes every form', () => {
    const def = { value_type: 'future', options: null }
    expect(FORMS.filter((form) => isUnfit('k', form, null, def))).toEqual([])
  })

  it('a key that holds one value takes no list, whatever its items (#6741)', () => {
    expect(isUnfit('k-text', 'list', null, { value_type: 'text', options: null }, ['a'])).toBe(true)
    expect(isUnfit('k', 'list', null, { value_type: 'future', options: null }, ['a'])).toBe(true)
  })
})

// #6741 D3 — the same table as the backend's list rows (`property_unfit_cmd_tests.rs`).
describe('fitsDefinition under a key that holds several values (#6741)', () => {
  const several = (value_type: string, options: string | null = null): FitDefinition => ({
    value_type,
    options,
    multiple: true,
  })

  it('takes a list, never one value', () => {
    expect(fitsDefinition('list', null, several('text'), ['a', 'b'])).toBe(true)
    expect(FORMS.filter((form) => fitsDefinition(form, 'a', several('text')))).toEqual([])
  })

  it('takes a list only when every item is of the item type', () => {
    const fit = (def: FitDefinition, items: unknown[]) => fitsDefinition('list', null, def, items)
    expect(fit(several('number'), [1, 2.5])).toBe(true)
    expect(fit(several('number'), [1, '2'])).toBe(false)
    for (const type of ['text', 'url', 'ref']) {
      expect(fit(several(type), ['a', 'b'])).toBe(true)
      expect(fit(several(type), ['a', 3])).toBe(false)
    }
    expect(fit(several('date'), ['2026-01-05', '2026-02-28'])).toBe(true)
    expect(fit(several('date'), ['2026-01-05', '2026-02-30'])).toBe(false)
    expect(fit(several('select', '["a","b"]'), ['b', 'a'])).toBe(true)
    expect(fit(several('select', '["a","b"]'), ['a', 'z'])).toBe(false)
    expect(fit(several('select'), ['z'])).toBe(true)
    expect(fit(several('boolean'), ['true'])).toBe(false)
  })

  it('takes no list without items', () => {
    expect(fitsDefinition('list', null, several('text'), [])).toBe(false)
    expect(fitsDefinition('list', null, several('text'))).toBe(false)
  })

  it('marks a list whose item does not fit, and no undeclared key', () => {
    expect(isUnfit('k', 'list', null, several('number'), ['x'])).toBe(true)
    expect(isUnfit('k', 'list', null, several('number'), [1])).toBe(false)
    expect(isUnfit('k', 'list', null, undefined, ['x'])).toBe(false)
  })
})

describe('valueForm (#6206)', () => {
  it('names the slot a value sits in, as `PropertyValueForm::of` does', () => {
    expect(valueForm({ value_text: 'a' })).toBe('text')
    expect(valueForm({ value_num: 0 })).toBe('number')
    expect(valueForm({ value_date: '2026-01-05' })).toBe('date')
    expect(valueForm({ value_ref: 'BLOCK' })).toBe('ref')
    expect(valueForm({ value_bool: 0 })).toBe('boolean')
    expect(valueForm({ value_list: ['a'] })).toBe('list')
  })

  it('is null for a row that holds no value', () => {
    expect(
      valueForm({
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      }),
    ).toBeNull()
  })
})
