import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { parse } from '@/lib/search-query/classify'
import {
  addFilter,
  quoteValueIfNeeded,
  removeFilterAt,
  serialize,
  tokenSource,
} from '@/lib/search-query/serialize'

describe('serialize round-trip', () => {
  const canonicalInputs = [
    'tag:#urgent',
    'tag:#urgent tag:#followup',
    'path:Journal/* tag:#urgent',
    'not-path:Archive/** path:Journal/*',
    'tag:#urgent hello world',
    'path:{Journal,Archive}/* tag:#meeting',
    'tag:#日本語',
    // New token kinds round-trip cleanly.
    'state:TODO',
    'not-state:DONE',
    'priority:1 priority:2',
    'not-priority:none',
    'due:today',
    'due:this-week',
    'due:>=2026-01-01',
    'scheduled:none',
    'scheduled:2026-05-17',
    'prop:status=done',
    'not-prop:archived=true',
    'prop:tag=',
    'state:TODO priority:1 due:today prop:status=blocked hello world',
    // #152 — prop values with whitespace round-trip via "..." quoting.
    'prop:status="in progress"',
    'not-prop:owner="Jane Doe"',
    'tag:#urgent prop:status="in progress" leftover',
    // #718 — path globs with whitespace round-trip via "..." quoting.
    'path:"Meeting Notes/*"',
    'not-path:"Old Archive/**"',
    'path:"Meeting Notes/*" tag:#urgent leftover',
    // #718 review — a value that is itself `"`-wrapped after one strip
    // (`""a""` → value `"a"`) must be re-quoted on serialise, or the next
    // parse strips the literal quotes again and the value mutates.
    'path:""a""',
    'prop:k=""a""',
    // #3288 — multi-word tag names round-trip via "..." quoting.
    'tag:#"my tag"',
    'tag:#"my tag" tag:#urgent leftover',
    // #5679 — "Search everything under #tag".
    'under:#idea',
    'under:#"my tag" under:#urgent leftover',
  ]

  it('#3288 — tag: strips one surrounding quote pair, before or after the #', () => {
    for (const s of ['tag:#"my tag"', 'tag:"#my tag"', 'tag:"work"']) {
      const chip = parse(s).filters[0]
      expect(chip?.kind).toBe('tag')
      expect(chip?.kind === 'tag' && chip.value).toBe(s.includes('work') ? 'work' : 'my tag')
    }
    expect(tokenSource({ kind: 'tag', value: 'my tag', span: [0, 0] })).toBe('tag:#"my tag"')
  })

  it('#5679 — under: serialises with its own prefix', () => {
    expect(tokenSource({ kind: 'under', value: 'my tag', span: [0, 0] })).toBe('under:#"my tag"')
    expect(serialize(parse('under:#idea'))).toBe('under:#idea')
  })

  for (const s of canonicalInputs) {
    it(`canonical: serialize(parse('${s}')) === ('${s}')`, () => {
      const round = serialize(parse(s))
      // Reconstructed AST should be equivalent — chips and freetext
      // are order-preserving by their classification rules.
      expect(parse(round)).toEqual(parse(s))
    })
  }

  // Filters and freeText must match (key-by-key); spans may move.
  function roundTrips(s: string): boolean {
    const once = parse(s)
    const twice = parse(serialize(once))
    if (once.freeText !== twice.freeText) return false
    if (once.filters.length !== twice.filters.length) return false
    for (let i = 0; i < once.filters.length; i++) {
      const a = once.filters[i]
      const b = twice.filters[i]
      if (!a || !b) return false
      if (a.kind !== b.kind) return false
      if (tokenSource(a) !== tokenSource(b)) return false
    }
    return true
  }

  it('idempotency: parse(serialize(parse(s))) === parse(s)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom('tag:#urgent', 'path:Journal/*', '#followup', 'hello world'),
          fc.string({ minLength: 0, maxLength: 30 }),
        ),
        roundTrips,
      ),
      { numRuns: 200 },
    )
  })

  // Counterexamples the property found. A word whose `"` never closed used
  // to become a chip, and serialise moved free text holding a `"` after it,
  // closing the quote over everything in between.
  it.each([
    '" A:"#', // seed 2008733170
    '"a" X:" q"z', // no ordering of chips and free text survives
    '" #a"b',
    'rock" prop:title="Hello',
    // A value that is only safe bare, or only safe quoted.
    'path:a" "',
    'path:"""',
    'path:"a"b"',
    'prop:k=" "',
    'prop:"=""',
    '#" "',
    // The tokeniser splits on the whitespace the free-text cleanup collapses.
    'a\u00A0#a', // no-break space (macOS Option+Space)
    'a\u3000#a', // ideographic space
  ])('round-trips %j', (s) => {
    expect(roundTrips(s)).toBe(true)
  })

  it('removeFilterAt drops the requested token', () => {
    const ast = parse('tag:#a tag:#b tag:#c')
    const next = removeFilterAt(ast, 1)
    expect(next.filters).toHaveLength(2)
    expect(serialize(next)).toBe('tag:#a tag:#c')
  })

  it('addFilter appends to the end', () => {
    const ast = parse('tag:#a hello')
    const next = addFilter(ast, { kind: 'pathInclude', value: 'X/*', span: [0, 0] })
    expect(serialize(next)).toBe('tag:#a path:X/* hello')
  })

  it('#152 — tokenSource quotes a prop value that contains whitespace', () => {
    expect(tokenSource({ kind: 'prop', key: 'status', value: 'in progress', span: [0, 0] })).toBe(
      'prop:status="in progress"',
    )
    expect(tokenSource({ kind: 'notProp', key: 'owner', value: 'Jane Doe', span: [0, 0] })).toBe(
      'not-prop:owner="Jane Doe"',
    )
  })

  it('#152 — tokenSource leaves whitespace-free prop values bare', () => {
    expect(tokenSource({ kind: 'prop', key: 'status', value: 'done', span: [0, 0] })).toBe(
      'prop:status=done',
    )
  })

  it('#718 — tokenSource quotes a path glob that contains whitespace', () => {
    expect(tokenSource({ kind: 'pathInclude', value: 'Meeting Notes/*', span: [0, 0] })).toBe(
      'path:"Meeting Notes/*"',
    )
    expect(tokenSource({ kind: 'pathExclude', value: 'Old Archive/**', span: [0, 0] })).toBe(
      'not-path:"Old Archive/**"',
    )
  })

  it('#718 — tokenSource leaves whitespace-free path globs bare', () => {
    expect(tokenSource({ kind: 'pathInclude', value: 'Journal/*', span: [0, 0] })).toBe(
      'path:Journal/*',
    )
    expect(tokenSource({ kind: 'pathExclude', value: 'Archive/**', span: [0, 0] })).toBe(
      'not-path:Archive/**',
    )
  })

  it('#718 review — tokenSource re-quotes a value that is itself `"`-wrapped', () => {
    // Without re-quoting, serialise emits `path:"a"` and the next parse
    // strips the literal quotes as if they were syntax — the value would
    // silently mutate `"a"` → `a` on every serialise→parse cycle.
    expect(tokenSource({ kind: 'pathInclude', value: '"a"', span: [0, 0] })).toBe('path:""a""')
    expect(tokenSource({ kind: 'prop', key: 'k', value: '"a"', span: [0, 0] })).toBe('prop:k=""a""')
    const round = parse('path:""a""')
    expect(round.filters[0]).toMatchObject({ kind: 'pathInclude', value: '"a"' })
    const twice = parse(serialize(round))
    expect(twice.filters[0]).toMatchObject({ kind: 'pathInclude', value: '"a"' })
  })

  it('quoteValueIfNeeded: a value whose `"` would stay unclosed bare is quoted', () => {
    expect(quoteValueIfNeeded('"')).toBe('"""')
    expect(quoteValueIfNeeded('"ab')).toBe('""ab"')
    expect(quoteValueIfNeeded('ab"')).toBe('"ab""')
    expect(quoteValueIfNeeded('a"b')).toBe('"a"b"')
  })

  it('quoteValueIfNeeded: a value whose `"` closes at its end is left bare', () => {
    expect(quoteValueIfNeeded('a"b"')).toBe('a"b"')
    // Quoting this one would close at its first `" `.
    expect(quoteValueIfNeeded('a" "')).toBe('a" "')
  })

  it('quoteValueIfNeeded: a value with trailing whitespace is quoted', () => {
    expect(quoteValueIfNeeded('a ')).toBe('"a "')
  })

  it('quoteValueIfNeeded: a prefix holding a `"` decides whether the value closes it', () => {
    expect(quoteValueIfNeeded('', 'prop:"=')).toBe('""')
    expect(quoteValueIfNeeded('b"', 'prop:"=')).toBe('b"')
  })

  it('quoteValueIfNeeded: a plain whitespace-free value is left bare', () => {
    expect(quoteValueIfNeeded('ab')).toBe('ab')
  })

  it('quoteValueIfNeeded: a value quote-surrounded on both ends is re-quoted even without whitespace', () => {
    expect(quoteValueIfNeeded('"ab"')).toBe('""ab""')
  })

  // -------------------------------------------------------------------
  // Mutation-survivor coverage (GH #3761)
  // -------------------------------------------------------------------

  it('quoteValueIfNeeded: a value of exactly length 2 (two `"` chars) is quote-surrounded, not just longer ones (serialize.ts:40)', () => {
    // The `length >= 2` guard must include its own boundary — a value
    // of exactly two characters where both are `"` (the string `""`)
    // is quote-surrounded and must be re-quoted. A `length > 2` guard
    // would exclude this exact length and leave it bare.
    expect(quoteValueIfNeeded('""')).toBe('""""')
  })

  it('#718 — a pathInclude token with spaces survives serialize → parse', () => {
    // The FilterHelperPopover path: SearchPanel builds the token from the
    // raw submitted glob; the serialised query must re-parse to the SAME
    // chip instead of fragmenting into `path:Meeting` + free text.
    const ast = addFilter(parse(''), {
      kind: 'pathInclude',
      value: 'Meeting Notes/*',
      span: [0, 0],
    })
    expect(serialize(ast)).toBe('path:"Meeting Notes/*"')
    const round = parse(serialize(ast))
    expect(round.filters).toHaveLength(1)
    expect(round.filters[0]).toMatchObject({ kind: 'pathInclude', value: 'Meeting Notes/*' })
    expect(round.freeText).toBe('')
  })

  it('tokenSource echoes an invalid token back verbatim (serialize.ts:80)', () => {
    // `invalid` is the only kind whose source text is not rebuilt from
    // structured fields — it must be replayed byte-for-byte. If the case
    // stops returning, the switch falls out and yields `undefined`, so
    // serialize() would splice the literal string `undefined` into the
    // query and the user's unrecognised chip would be destroyed.
    expect(
      tokenSource({
        kind: 'invalid',
        source: 'bogus:foo',
        error: "unknown filter key 'bogus:'",
        span: [0, 9],
      }),
    ).toBe('bogus:foo')

    const ast = parse('bogus:foo tag:#a')
    expect(ast.filters[0]).toMatchObject({ kind: 'invalid', source: 'bogus:foo' })
    expect(serialize(ast)).toBe('bogus:foo tag:#a')
  })
})
