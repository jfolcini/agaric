/**
 * #2702 — cross-language parity for the builtin (non-deletable) property
 * key set.
 *
 * `NON_DELETABLE_PROPERTIES` in `../property-save-utils` is a hand-maintained
 * TS mirror of the Rust source of truth, `is_builtin_property_key` in
 * `src-tauri/agaric-store/src/op.rs` (the four `RESERVED_PROPERTY_KEYS`
 * column-backed keys, plus the enumerated system-lifecycle keys). Before
 * this test, the two sides were kept in sync only by convention (a doc
 * comment on each side) — a key added to one side without the other would
 * go unnoticed until a user hit a delete the backend rejects, or the UI
 * over-conservatively hid a legitimately deletable property.
 *
 * This test parses the Rust source text directly (same "read the
 * source-of-truth text and extract the list" approach as the DB-side
 * `reserved_key_set_matches_db_check_constraint_589` test in
 * `src-tauri/src/db/tests.rs`, which parses the `key_not_reserved` CHECK
 * constraint DDL rather than re-hardcoding it) and asserts the two sets are
 * equal. If `op.rs` changes shape enough that the anchors below no longer
 * match, this test fails loudly rather than silently parsing 0 keys.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { NON_DELETABLE_PROPERTIES } from '../property-save-utils'

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

/** Parse the `RESERVED_PROPERTY_KEYS` const array (the four column-backed keys). */
function parseReservedPropertyKeys(src: string): string[] {
  const m = src.match(/pub const RESERVED_PROPERTY_KEYS: \[&str; \d+\] =\s*\[([\s\S]*?)\];/)
  if (!m?.[1]) {
    throw new Error(
      'Could not locate `RESERVED_PROPERTY_KEYS` const in op.rs — has it been renamed or reshaped?',
    )
  }
  const keys = extractQuotedStrings(m[1])
  if (keys.length === 0) {
    throw new Error('Parsed 0 keys from RESERVED_PROPERTY_KEYS — parser is broken.')
  }
  return keys
}

/** Parse the `matches!(key, "a" | "b" | ...)` lifecycle-key list inside `is_builtin_property_key`. */
function parseLifecyclePropertyKeys(src: string): string[] {
  const fnMatch = src.match(/pub fn is_builtin_property_key\(key: &str\) -> bool \{([\s\S]*?)\n\}/)
  if (!fnMatch?.[1]) {
    throw new Error(
      'Could not locate `is_builtin_property_key` fn body in op.rs — has it been renamed or reshaped?',
    )
  }
  const matchesBlock = fnMatch[1].match(/matches!\(\s*key,([\s\S]*?)\)/)
  if (!matchesBlock?.[1]) {
    throw new Error(
      'Could not locate the `matches!(key, ...)` lifecycle-key list inside `is_builtin_property_key` — has it been reshaped?',
    )
  }
  const keys = extractQuotedStrings(matchesBlock[1])
  if (keys.length === 0) {
    throw new Error(
      'Parsed 0 keys from the `is_builtin_property_key` matches! block — parser is broken.',
    )
  }
  return keys
}

describe('NON_DELETABLE_PROPERTIES cross-language parity (#2702)', () => {
  const opRsSrc = readFileSync(OP_RS_PATH, 'utf8')
  const reservedKeys = parseReservedPropertyKeys(opRsSrc)
  const lifecycleKeys = parseLifecyclePropertyKeys(opRsSrc)
  const rustBuiltinKeys = new Set([...reservedKeys, ...lifecycleKeys])

  it('matches the Rust `is_builtin_property_key` key set exactly', () => {
    expect([...NON_DELETABLE_PROPERTIES].toSorted()).toEqual([...rustBuiltinKeys].toSorted())
  })
})
