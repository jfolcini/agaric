/**
 * #2702 / #5841 — cross-language parity for the built-in property
 * definitions.
 *
 * `BUILTIN_PROPERTY_DEFS` in `../property-save-utils` is a hand-maintained
 * TS mirror of the Rust source of truth, `BUILTIN_PROPERTY_DEFS` in
 * `src-tauri/agaric-store/src/op.rs`; `NON_DELETABLE_PROPERTIES` is its key
 * set. `INTERNAL_PROPERTY_KEYS` (`../block-utils`) mirrors the op.rs const of
 * that name, which the backend refuses to rename or merge. A definition added to one side without the other would go unnoticed
 * until a user hit a write the backend rejects, or the mock served a
 * definition the backend does not have.
 *
 * This test parses the Rust source text directly (same "read the
 * source-of-truth text and extract the list" approach as the DB-side
 * `reserved_key_set_matches_db_check_constraint_589` test in
 * `src-tauri/src/db/tests.rs`) and asserts the two lists are equal. If
 * `op.rs` changes shape enough that the anchors below no longer match, this
 * test fails loudly rather than silently parsing 0 definitions.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { INTERNAL_PROPERTY_KEYS } from '../block-utils'
import {
  BUILTIN_PROPERTY_DEFS,
  type BuiltinPropertyDef,
  NON_DELETABLE_PROPERTIES,
} from '../property-save-utils'

const OP_RS_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'src-tauri',
  'agaric-store',
  'src',
  'op.rs',
)

function extractQuotedStrings(source: string): string[] {
  return [...source.matchAll(/"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((s): s is string => s !== undefined)
}

/** The strings of `src`'s `pub const <name>: [&str; N] = [...];`. */
function parseStrArrayConst(src: string, name: string): string[] {
  const array = src.match(new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\];`))
  if (!array?.[1]) {
    throw new Error(`Could not locate \`${name}\` in op.rs — has it been renamed or reshaped?`)
  }
  return extractQuotedStrings(array[1])
}

/**
 * Parse the `BUILTIN_PROPERTY_DEFS` const array, one constructor call per
 * entry; a `select`'s options are a literal or `&NAME` of an op.rs const.
 */
function parseBuiltinPropertyDefs(src: string): BuiltinPropertyDef[] {
  const array = src.match(
    /pub const BUILTIN_PROPERTY_DEFS: \[BuiltinPropertyDef; \d+\] = \[([\s\S]*?)\n\];/,
  )
  if (!array?.[1]) {
    throw new Error(
      'Could not locate `BUILTIN_PROPERTY_DEFS` in op.rs — has it been renamed or reshaped?',
    )
  }
  const defs = [
    ...array[1].matchAll(/BuiltinPropertyDef::(of|select)\(\s*"([^"]+)",\s*([^)]*?)\s*\),/g),
  ].map((m): BuiltinPropertyDef => {
    const [, ctor, key, rest] = m
    if (ctor === undefined || key === undefined || rest === undefined) {
      throw new Error(`Unparseable BUILTIN_PROPERTY_DEFS entry: ${m[0]}`)
    }
    const named = rest.match(/^&([A-Z_]+)$/)?.[1]
    const options =
      named === undefined ? extractQuotedStrings(rest) : parseStrArrayConst(src, named)
    return ctor === 'select'
      ? { key, value_type: 'select', options }
      : { key, value_type: extractQuotedStrings(rest)[0] ?? '', options: null }
  })
  if (defs.length === 0) {
    throw new Error('Parsed 0 entries from BUILTIN_PROPERTY_DEFS — parser is broken.')
  }
  return defs
}

describe('BUILTIN_PROPERTY_DEFS cross-language parity (#2702, #5841)', () => {
  const rustDefs = parseBuiltinPropertyDefs(readFileSync(OP_RS_PATH, 'utf8'))

  it('matches the Rust `BUILTIN_PROPERTY_DEFS` entry for entry', () => {
    expect(BUILTIN_PROPERTY_DEFS).toEqual(rustDefs)
  })

  it('NON_DELETABLE_PROPERTIES is exactly the built-in keys', () => {
    expect([...NON_DELETABLE_PROPERTIES].toSorted()).toEqual(
      rustDefs.map((def) => def.key).toSorted(),
    )
  })
})

describe('INTERNAL_PROPERTY_KEYS cross-language parity (#5841)', () => {
  it('matches the Rust `INTERNAL_PROPERTY_KEYS`', () => {
    const rust = parseStrArrayConst(readFileSync(OP_RS_PATH, 'utf8'), 'INTERNAL_PROPERTY_KEYS')
    expect([...INTERNAL_PROPERTY_KEYS].toSorted()).toEqual(rust.toSorted())
  })
})
