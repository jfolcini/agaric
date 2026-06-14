/**
 * #1061 — pin the shared validation sub-kind contract.
 *
 * These tests assert that:
 *   1. the canonical code strings are spelled exactly as the Rust backend
 *      emits them (cross-language pin — a rename on either side breaks here),
 *   2. the TS re-emitters and the IPC-error parser all route through the
 *      shared `ValidationCode` constants rather than raw literals.
 */
import { describe, expect, it } from 'vitest'

import { parse } from '../classify'
import { validateGlob } from '../glob-validate'
import { parseValidationReason, prefixed, prefixToken, ValidationCode } from '../validation-codes'

describe('ValidationCode (#1061 shared contract)', () => {
  it('pins the exact code strings the Rust backend emits', () => {
    // MUST match `src-tauri/src/error.rs::validation_code`. A drift here is a
    // broken cross-language contract — the inline validation UX silently
    // degrades to the generic-error toast.
    expect(ValidationCode.InvalidGlob).toBe('InvalidGlob')
    expect(ValidationCode.InvalidRegex).toBe('InvalidRegex')
    expect(ValidationCode.InvalidDateFilter).toBe('InvalidDateFilter')
  })

  it('prefixed() / prefixToken() mirror the backend "<code>: <reason>" layout', () => {
    expect(prefixed(ValidationCode.InvalidRegex, 'unclosed group')).toBe(
      'InvalidRegex: unclosed group',
    )
    expect(prefixToken(ValidationCode.InvalidGlob)).toBe('InvalidGlob:')
  })

  it('parseValidationReason() extracts the reason and rejects mismatches', () => {
    // Mirrors a raw IPC `message` carrying the prefix.
    expect(
      parseValidationReason('InvalidRegex: pattern too large', ValidationCode.InvalidRegex),
    ).toBe('pattern too large')
    // Wrong sub-kind → no match (the inline regex alert must NOT fire on a
    // glob/date error).
    expect(
      parseValidationReason('InvalidGlob: unbalanced bracket', ValidationCode.InvalidRegex),
    ).toBeNull()
    // No prefix → no match.
    expect(
      parseValidationReason('something generic failed', ValidationCode.InvalidRegex),
    ).toBeNull()
  })
})

describe('TS re-emitters route through the shared constant (#1061)', () => {
  it('validateGlob() emits messages prefixed with the shared InvalidGlob code', () => {
    const expect_ = prefixToken(ValidationCode.InvalidGlob)
    for (const bad of ['', '[abc', '{a,{b}}', '\\{']) {
      const err = validateGlob(bad)
      expect(err).not.toBeNull()
      expect(err?.message.startsWith(expect_)).toBe(true)
    }
  })

  it('date-token parsing emits InvalidDateFilter via the shared constant', () => {
    const tok = parse('due:tomorrowish').filters[0]
    expect(tok?.kind).toBe('invalid')
    if (tok && tok.kind === 'invalid') {
      expect(tok.error.startsWith(prefixToken(ValidationCode.InvalidDateFilter))).toBe(true)
    }
  })
})
