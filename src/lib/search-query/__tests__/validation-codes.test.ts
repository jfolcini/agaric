/**
 * #1061 / #2251 — pin the shared validation sub-kind contract.
 *
 * Since #2251 the primary cross-language pin is **by construction**: the
 * `ValidationCode` const object is `satisfies`-checked against the
 * specta-generated string-literal union in `bindings.ts`, so a rename/typo
 * on either side fails `tsc -b` after bindings regeneration (the Rust
 * `validation_code_wire_strings_pinned` test pins the same strings against
 * the serde output). The runtime tests below cover what the type system
 * cannot: that the const values round-trip as the union's own literals, and
 * that the frontend-side validators still route their **display copy**
 * through the shared constants rather than raw literals.
 */
import { describe, expect, it } from 'vitest'

import type { ValidationCode as GeneratedValidationCode } from '@/lib/bindings'
import { parse } from '@/lib/search-query/classify'
import { validateGlob } from '@/lib/search-query/glob-validate'
import { prefixed, ValidationCode } from '@/lib/search-query/validation-codes'

describe('ValidationCode (#1061/#2251 shared contract)', () => {
  it('pins the exact code strings the Rust backend serialises', () => {
    // MUST match `src-tauri/src/error.rs::ValidationCode` (serde PascalCase
    // variant names). The `satisfies` clause in validation-codes.ts already
    // enforces this at compile time against the generated union; this runtime
    // pin documents the wire strings and guards the vitest path, which does
    // not gate on tsc.
    expect(ValidationCode).toEqual({
      InvalidGlob: 'InvalidGlob',
      InvalidRegex: 'InvalidRegex',
      InvalidDateFilter: 'InvalidDateFilter',
      InvalidFilter: 'InvalidFilter',
      RequiresRefresh: 'RequiresRefresh',
      PageNotInSpace: 'PageNotInSpace',
    })
  })

  it('const values are assignable to the generated union (roundtrip)', () => {
    // Type-level roundtrip: every const value IS a member of the generated
    // union, so a structured `err.code` off the wire compares directly
    // against `ValidationCode.*` with no parsing.
    const codes: GeneratedValidationCode[] = Object.values(ValidationCode)
    for (const code of codes) {
      expect(ValidationCode[code]).toBe(code)
    }
  })

  it('prefixed() builds the "<code>: <reason>" display copy', () => {
    expect(prefixed(ValidationCode.InvalidRegex, 'unclosed group')).toBe(
      'InvalidRegex: unclosed group',
    )
  })
})

describe('frontend validators route display copy through the shared constant (#1061)', () => {
  it('validateGlob() emits messages labelled with the shared InvalidGlob code', () => {
    for (const bad of ['', '[abc', '{a,{b}}', '\\{']) {
      const err = validateGlob(bad)
      expect(err).not.toBeNull()
      expect(err?.message.startsWith(`${ValidationCode.InvalidGlob}: `)).toBe(true)
    }
  })

  it('date-token parsing labels invalid chips with InvalidDateFilter', () => {
    const tok = parse('due:tomorrowish').filters[0]
    expect(tok?.kind).toBe('invalid')
    if (tok && tok.kind === 'invalid') {
      expect(tok.error.startsWith(`${ValidationCode.InvalidDateFilter}: `)).toBe(true)
    }
  })
})
