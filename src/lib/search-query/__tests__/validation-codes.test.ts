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
 *
 * #3686 — "by construction" was true of the TYPE side only. The runtime pin
 * was a hand-written literal compared against a hand-written const object, so
 * a variant added on the Rust side and absent from BOTH left every assertion
 * in this file green; the contract held only for whoever ran `tsc`. The first
 * test now derives the expected variant set from the generated `bindings.ts`
 * union itself, which makes the runtime pin exhaustive without a compile step,
 * while the literal table below keeps catching a rename or a changed wire
 * string (a derived set renames along with the enum; a literal does not).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ValidationCode as GeneratedValidationCode } from '@/lib/bindings'
import { parse } from '@/lib/search-query/classify'
import { validateGlob } from '@/lib/search-query/glob-validate'
import { prefixed, ValidationCode } from '@/lib/search-query/validation-codes'

const BINDINGS_PATH = path.resolve(import.meta.dirname, '..', '..', 'bindings.ts')

/**
 * #3686 — read the variant set straight out of the specta-generated
 * `ValidationCode` union in `bindings.ts`.
 *
 * The union is a TYPE, so it evaporates at runtime and vitest cannot enumerate
 * it by importing it — hence the source read. That is the same technique the
 * repo's other cross-language parity tests use (see
 * `src/lib/__tests__/page-link-re-parity.test.ts`).
 *
 * The extraction is deliberately strict rather than a lenient scan: a parser
 * that silently returned FEWER members than the generator emitted would make
 * the exhaustiveness pin below vacuous — precisely the defect class #3686 is
 * about. So it isolates the union body, strips the doc comments, and then
 * requires what is left to be exactly a `"Name" | "Name" | …` chain with
 * nothing unaccounted for. If tauri-specta ever changes its output shape this
 * throws loudly instead of quietly under-reporting.
 */
function generatedValidationCodeVariants(): string[] {
  const source = readFileSync(BINDINGS_PATH, 'utf8')
  const declaration = /^export type ValidationCode =([\s\S]*?);$/m.exec(source)
  if (!declaration?.[1]) {
    throw new Error(`no 'export type ValidationCode' declaration found in ${BINDINGS_PATH}`)
  }
  const body = declaration[1].replace(/\/\*[\s\S]*?\*\//g, '').trim()
  if (!/^"[A-Za-z0-9_]+"(\s*\|\s*"[A-Za-z0-9_]+")*$/.test(body)) {
    throw new Error(
      `unrecognised ValidationCode union shape in ${BINDINGS_PATH} — ` +
        `expected a chain of string literals, got: ${body}`,
    )
  }
  return body.split('|').map((member) => member.trim().slice(1, -1))
}

describe('ValidationCode (#1061/#2251 shared contract)', () => {
  it('mirrors EVERY variant of the generated union, by construction (#3686)', () => {
    // The exhaustiveness half of the pin. The literal table in the next test
    // documents the wire strings, but a literal cannot REQUIRE a new variant to
    // appear in it: add one on the Rust side, regenerate bindings, leave both
    // hand-written artefacts alone, and this whole vitest file stays green —
    // only `tsc` objects (via the `satisfies` clause in validation-codes.ts),
    // and vitest does not gate on tsc. That is #3674's defect verbatim, and it
    // is what #3681 fixed for `AppError` on the Rust side.
    //
    // Deriving the expected key set from `bindings.ts` closes it: the generated
    // union is the projection of the Rust enum, so a variant that reaches
    // bindings but not `ValidationCode` fails HERE, in the vitest run, with no
    // compile step required. `toEqual` over the sorted arrays is exhaustive in
    // both directions, so a variant deleted on the Rust side fails too.
    const generated = generatedValidationCodeVariants()
    expect(Object.keys(ValidationCode).toSorted()).toEqual(generated.toSorted())
    // …and each key's VALUE is its own wire string (the union members ARE the
    // serde names — serde default PascalCase, no `rename`).
    for (const variant of generated) {
      expect(ValidationCode[variant as GeneratedValidationCode]).toBe(variant)
    }
  })

  it('pins the exact code strings the Rust backend serialises', () => {
    // MUST match `src-tauri/src/error.rs::ValidationCode` (serde PascalCase
    // variant names). The `satisfies` clause in validation-codes.ts already
    // enforces this at compile time against the generated union; this runtime
    // pin documents the wire strings for frontend readers and makes a RENAME or
    // a changed value a deliberate, reviewed edit rather than something the
    // derived check above absorbs silently — rename the Rust variant and the
    // derived set renames with it, whereas this table does not.
    expect(ValidationCode).toEqual({
      InvalidGlob: 'InvalidGlob',
      InvalidRegex: 'InvalidRegex',
      InvalidDateFilter: 'InvalidDateFilter',
      InvalidFilter: 'InvalidFilter',
      RequiresRefresh: 'RequiresRefresh',
      PageNotInSpace: 'PageNotInSpace',
      InvalidRepeatRule: 'InvalidRepeatRule',
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
