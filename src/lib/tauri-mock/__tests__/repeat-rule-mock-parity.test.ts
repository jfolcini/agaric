/**
 * #3647 — parity between the tauri-mock's `repeat` grammar gate and the
 * backend's.
 *
 * Both gates run their stack's interval parser and read its verdict
 * (`agaric_store::recurrence_math::validate_repeat_rule_shape`, and its port
 * `isValidRepeatRuleMock` in `src/lib/tauri-mock/recurrence.ts`), so the table
 * below pins the port against the backend's.
 *
 * The accept/reject rows below are the SAME corpus the Rust tests use
 * (`repeat_rule_validation_tests_3647::CORPUS` in
 * `src-tauri/agaric-engine/src/recurrence/parser.rs`, whose
 * `validator_accepts_exactly_what_recurrence_honours_3647` asserts each row
 * against both the completion-time shifter and the read-time projector). Keep
 * the two lists in step: if you add a form to one, add it to the other.
 */

import { describe, expect, it } from 'vitest'

import { assertValidSetPropertyValue } from '@/lib/tauri-mock/handlers/shared'
import { isValidRepeatRuleMock } from '@/lib/tauri-mock/recurrence'

/** Rules the recurrence engine honours — the mock must accept every one. */
const VALID = [
  'daily',
  'weekly',
  'monthly',
  'yearly',
  '+1d',
  '+3d',
  '+2w',
  '+6m',
  '+1y',
  '1d',
  '3w',
  '2m',
  '1y',
  '.+daily',
  '.+weekly',
  '.+monthly',
  '.+yearly',
  '.+1d',
  '.+3w',
  '.+2m',
  '++daily',
  '++weekly',
  '++monthly',
  '++yearly',
  '++1d',
  '++2w',
  '++6m',
  // normalization: trimmed and lowercased before parsing
  '  daily  ',
  'DAILY',
  '++2W',
]

/** Rules the recurrence engine ignores — the mock must reject every one. */
const INVALID = [
  '',
  '   ',
  '+',
  '++',
  '.+',
  // the keyword arms match the BARE keyword only
  '+daily',
  '+weekly',
  '+yearly',
  // a space anywhere in the interval breaks the count parse
  '++ 1d',
  '.+ 1w',
  '2 w',
  // Org-mode recurrence never stands still or goes backwards
  '+0d',
  '0w',
  '-1d',
  '+-3w',
  // malformed counts / units
  '3.5d',
  '5x',
  '12q',
  'w',
  '+d',
  'invalid',
  '++2weeks',
  'FREQ=DAILY',
  'every day',
]

describe('isValidRepeatRuleMock (#3647)', () => {
  it.each(VALID)('accepts %j', (rule) => {
    expect(isValidRepeatRuleMock(rule)).toBe(true)
  })

  it.each(INVALID)('rejects %j', (rule) => {
    expect(isValidRepeatRuleMock(rule)).toBe(false)
  })

  it('rejects a count that overflows i64 like the Rust parser does', () => {
    expect(isValidRepeatRuleMock('99999999999999999999999d')).toBe(false)
  })
})

describe('set_property mock gate (#3647)', () => {
  it('rejects a malformed repeat rule with the coded validation error', () => {
    let caught: unknown
    try {
      assertValidSetPropertyValue(null, 'repeat', '++ 1d')
    } catch (err) {
      caught = err
    }
    expect(caught).toMatchObject({
      kind: 'validation',
      code: 'InvalidRepeatRule',
    })
  })

  it('accepts a valid repeat rule', () => {
    expect(() => assertValidSetPropertyValue(null, 'repeat', '++1d')).not.toThrow()
  })

  it('leaves other keys alone', () => {
    expect(() => assertValidSetPropertyValue(null, 'assignee', '++ 1d')).not.toThrow()
  })
})
