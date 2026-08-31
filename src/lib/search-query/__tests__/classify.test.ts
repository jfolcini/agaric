import { describe, expect, it } from 'vitest'

import { i18n } from '@/lib/i18n'
import { classify, parse } from '@/lib/search-query/classify'
import { ensureRegistered } from '@/lib/search-query/register'
import type { RawToken } from '@/lib/search-query/tokenize'

describe('classify / parse', () => {
  it('parses an empty string', () => {
    const ast = parse('')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('')
  })

  it('recognises tag: prefix', () => {
    const ast = parse('tag:#urgent')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'urgent' })
    expect(ast.freeText).toBe('')
  })

  it('recognises bare #tag alias', () => {
    const ast = parse('#urgent')
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'urgent' })
  })

  it('strips leading # inside tag: value', () => {
    const a = parse('tag:#x')
    const b = parse('tag:x')
    expect(a.filters[0]).toMatchObject({ kind: 'tag', value: 'x' })
    expect(b.filters[0]).toMatchObject({ kind: 'tag', value: 'x' })
  })

  it('recognises path: include and not-path: exclude', () => {
    const ast = parse('path:Journal/* not-path:Archive/**')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({ kind: 'pathInclude', value: 'Journal/*' })
    expect(ast.filters[1]).toMatchObject({ kind: 'pathExclude', value: 'Archive/**' })
  })

  it('places free text into freeText, preserving order-agnostically', () => {
    const ast = parse('hello tag:#urgent world')
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'urgent' })
    expect(ast.freeText).toBe('hello world')
  })

  it('rejects unknown filter keys as invalid tokens', () => {
    const ast = parse('foo:bar baz')
    expect(ast.filters).toHaveLength(1)
    const tok = ast.filters[0]
    expect(tok).toMatchObject({
      kind: 'invalid',
      source: 'foo:bar',
    })
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain("'foo:'")
    }
    expect(ast.freeText).toBe('baz')
  })

  it('keeps a pasted URL as free text rather than an invalid chip', () => {
    // `http:` matches the unknown-prefix shape, but the `//` right after
    // the colon means it is a URL, not a filter — it must survive in
    // free text instead of being consumed (and dropped) as an invalid
    // chip.
    for (const url of ['http://example.com', 'https://example.com/a?b=c', 'file:///tmp/x']) {
      const ast = parse(url)
      expect(ast.filters).toEqual([])
      expect(ast.freeText).toBe(url)
    }
  })

  it('accepts due:/scheduled: NONE case-insensitively, normalised to "none"', () => {
    for (const raw of ['due:NONE', 'due:none', 'due:None']) {
      const ast = parse(raw)
      expect(ast.filters[0]).toMatchObject({ kind: 'due', value: { kind: 'named', name: 'none' } })
    }
    expect(parse('scheduled:NONE').filters[0]).toMatchObject({
      kind: 'scheduled',
      value: { kind: 'named', name: 'none' },
    })
  })

  it('collapses internal whitespace in free text (contract)', () => {
    // Documented lossy round-trip: runs of whitespace between free-text
    // words collapse to a single space.
    const ast = parse('foo    bar\t\tbaz')
    expect(ast.freeText).toBe('foo bar baz')
  })

  it('flags an earlier shadowed due: token as invalid', () => {
    const ast = parse('due:today due:this-week')
    expect(ast.filters).toHaveLength(2)
    // The first (shadowed) token is marked invalid so its chip reflects
    // that it does not apply; the last due: stays valid.
    expect(ast.filters[0]).toMatchObject({ kind: 'invalid', source: 'due:today' })
    if (ast.filters[0]?.kind === 'invalid') {
      expect(ast.filters[0].error).toContain('shadowed')
    }
    expect(ast.filters[1]).toMatchObject({
      kind: 'due',
      value: { kind: 'named', name: 'this-week' },
    })
  })

  it('flags malformed glob as invalid with InvalidGlob: prefix', () => {
    const ast = parse('path:[unclosed')
    expect(ast.filters).toHaveLength(1)
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toMatch(/^InvalidGlob:/)
      expect(tok.error).toContain('unbalanced bracket')
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('flags brace nesting as invalid', () => {
    const ast = parse('path:{a,{b,c}}')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain('brace nesting')
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('flags empty tag: value as invalid', () => {
    const ast = parse('tag:')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain('required')
    } else {
      throw new Error('expected invalid token')
    }
  })

  // #4555 — register.ts's parser error strings used to be hardcoded English
  // literals (`'tag: value required'`, `` `unknown ${noun} '${value}'` ``).
  // The English catalog value is byte-equal to the old literal, so a test
  // only checking the rendered English text can't tell "reads the catalog"
  // from "hardcoded literal" — overriding the catalog value and asserting
  // the override appears proves the call site actually resolves through
  // `t()`. This fails if a recogniser reverts to a bare string literal.
  it('#4555: the empty-tag error resolves through the i18n catalog, not a hardcoded literal', () => {
    const KEY = 'searchQuery.valueRequired'
    const original = i18n.t(KEY, { prefix: 'tag:' })
    i18n.addResource('en', 'translation', KEY, '__OVERRIDDEN__ {{prefix}}')
    try {
      const ast = parse('tag:')
      const tok = ast.filters[0]
      if (tok && tok.kind === 'invalid') {
        expect(tok.error).toBe('__OVERRIDDEN__ tag:')
      } else {
        throw new Error('expected invalid token')
      }
    } finally {
      // Restore the raw template (not the interpolated `original`) so the
      // catalog goes back to its real, still-interpolatable shape.
      i18n.addResource('en', 'translation', KEY, '{{prefix}} value required')
      expect(i18n.t(KEY, { prefix: 'tag:' })).toBe(original)
    }
  })

  it('preserves Unicode tag names', () => {
    const ast = parse('tag:#日本語')
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: '日本語' })
  })

  it('passes quoted phrases through to free text verbatim', () => {
    const ast = parse('"exact phrase" tag:#x')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'x' })
    expect(ast.freeText).toContain('exact phrase')
  })

  it('preserves multiple internal spaces inside a quoted phrase', () => {
    // A quoted phrase is matched exactly, so the free-text collapse must
    // NOT touch whitespace inside the quotes.
    const ast = parse('"two  spaces   here"')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('"two  spaces   here"')
  })

  it('collapses whitespace outside quotes while preserving it inside', () => {
    const ast = parse('alpha    "two  spaces"    beta')
    expect(ast.filters).toEqual([])
    // Outside the quotes: runs collapse to one space. Inside: verbatim.
    expect(ast.freeText).toBe('alpha "two  spaces" beta')
  })

  it('preserves intra-quote whitespace alongside a consumed filter', () => {
    const ast = parse('tag:#x   "keep  the   gaps"   word')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'x' })
    expect(ast.freeText).toBe('"keep  the   gaps" word')
  })

  it('handles two quoted phrases each preserving internal spacing', () => {
    const ast = parse('"a  b"   "c   d"')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('"a  b" "c   d"')
  })

  it('treats an unterminated quote as a word and collapses normally', () => {
    // No closing quote at a token boundary → the tokeniser degrades the
    // stray quote to a word, so the run is plain free text and collapses.
    const ast = parse('foo  "bar  baz')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('foo "bar baz')
  })

  it('keeps an empty quoted phrase and collapses around it', () => {
    // An empty `""` is a zero-length quoted range; it must survive while
    // the whitespace on either side still collapses.
    const ast = parse('a ""  b')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('a "" b')
  })

  it('shields a colon inside a quoted phrase from filter recognition', () => {
    // `due:today` would normally be consumed as a filter, but inside quotes
    // the whole phrase is verbatim free text — the colon must NOT be parsed
    // as a filter key, and the internal spacing is preserved.
    const ast = parse('"due:today  is  fine"')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('"due:today  is  fine"')
  })

  it('does not treat boolean operators as filters', () => {
    const ast = parse('foo AND bar OR baz NOT quux')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('foo AND bar OR baz NOT quux')
  })

  it('falls back to substring-style bare token as freeText, not a filter', () => {
    // Decision: bare tokens stay in freeText (FTS5 trigram
    // substring already covers the "match anywhere" use-case).
    const ast = parse('alpha')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('alpha')
  })

  it('supports multiple path: tokens (AND across the IN clause)', () => {
    const ast = parse('path:Journal/* path:Notes/*')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({ kind: 'pathInclude', value: 'Journal/*' })
    expect(ast.filters[1]).toMatchObject({ kind: 'pathInclude', value: 'Notes/*' })
  })

  it('accepts brace expansion', () => {
    const ast = parse('path:{Journal,Archive}/*')
    expect(ast.filters[0]).toMatchObject({
      kind: 'pathInclude',
      value: '{Journal,Archive}/*',
    })
  })

  it('records token spans pointing into the original input', () => {
    const input = '  tag:#urgent  '
    const ast = parse(input)
    const tok = ast.filters[0]
    if (!tok) throw new Error('expected a filter token')
    const span = tok.span
    expect(input.slice(span[0], span[1])).toBe('tag:#urgent')
  })

  // -------------------------------------------------------------------
  // State / priority / due / scheduled / prop tokens
  // -------------------------------------------------------------------

  it('recognises state: tokens', () => {
    const ast = parse('state:TODO state:DOING')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({ kind: 'state', value: 'TODO' })
    expect(ast.filters[1]).toMatchObject({ kind: 'state', value: 'DOING' })
  })

  it('recognises not-state: tokens', () => {
    const ast = parse('not-state:DONE')
    expect(ast.filters[0]).toMatchObject({ kind: 'notState', value: 'DONE' })
  })

  it('recognises priority: tokens with none sentinel', () => {
    const ast = parse('priority:1 priority:none')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({ kind: 'priority', value: '1' })
    expect(ast.filters[1]).toMatchObject({ kind: 'priority', value: 'none' })
  })

  // #2276 — an out-of-vocabulary state/priority must be an invalid chip, not a
  // false-valid green one that projects a never-matching value to the wire.
  it('flags an out-of-vocabulary state: value as invalid', () => {
    const tok = parse('state:BOGUS').filters[0]
    expect(tok).toMatchObject({ kind: 'invalid', source: 'state:BOGUS' })
    if (tok?.kind === 'invalid') {
      expect(tok.error).toContain("unknown state 'BOGUS'")
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('flags an out-of-vocabulary priority: value as invalid', () => {
    const tok = parse('priority:banana').filters[0]
    expect(tok).toMatchObject({ kind: 'invalid', source: 'priority:banana' })
    if (tok?.kind === 'invalid') {
      expect(tok.error).toContain("unknown priority 'banana'")
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('flags an out-of-vocabulary not-state: / not-priority: value as invalid', () => {
    expect(parse('not-state:NOPE').filters[0]).toMatchObject({
      kind: 'invalid',
      source: 'not-state:NOPE',
    })
    expect(parse('not-priority:zzz').filters[0]).toMatchObject({
      kind: 'invalid',
      source: 'not-priority:zzz',
    })
  })

  it('accepts the none sentinel case-insensitively for state:/priority:', () => {
    expect(parse('state:NONE').filters[0]).toMatchObject({ kind: 'state', value: 'NONE' })
    expect(parse('priority:None').filters[0]).toMatchObject({ kind: 'priority', value: 'None' })
  })

  it('recognises due: bucket keywords', () => {
    // Each keyword tested in isolation — multiple due: tokens in one
    // Query now shadow all but the last, so recognition is a
    // per-token unit assertion.
    for (const name of ['today', 'this-week', 'overdue', 'none'] as const) {
      const ast = parse(`due:${name}`)
      expect(ast.filters[0]).toMatchObject({ kind: 'due', value: { kind: 'named', name } })
    }
  })

  it('recognises scheduled: comparison form', () => {
    expect(parse('scheduled:>=2026-01-01').filters[0]).toMatchObject({
      kind: 'scheduled',
      value: { kind: 'op', op: '>=', date: '2026-01-01' },
    })
    expect(parse('scheduled:<2026-06-01').filters[0]).toMatchObject({
      kind: 'scheduled',
      value: { kind: 'op', op: '<', date: '2026-06-01' },
    })
  })

  it('recognises bare ISO date as = form', () => {
    const ast = parse('due:2026-05-17')
    expect(ast.filters[0]).toMatchObject({
      kind: 'due',
      value: { kind: 'op', op: '=', date: '2026-05-17' },
    })
  })

  it('flags unknown date bucket as invalid', () => {
    const ast = parse('due:tomorrowish')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toMatch(/^InvalidDateFilter:/)
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('flags unparseable date in op form as invalid', () => {
    const ast = parse('due:>=2026-13-99')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toMatch(/^InvalidDateFilter:/)
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('flags calendar-invalid dates that pass the range checks as invalid', () => {
    // `2026-13-99` short-circuits on `isIsoDate`'s month>12 / day>31 range
    // guards. These two have in-range month AND day, so the ONLY thing that
    // rejects them is the `Date.UTC` calendar roundtrip (Feb has no 30th;
    // April has no 31st). Pins that branch, which was otherwise uncovered.
    for (const query of ['due:2026-02-30', 'scheduled:>=2026-04-31']) {
      const tok = parse(query).filters[0]
      if (tok && tok.kind === 'invalid') {
        expect(tok.error).toMatch(/^InvalidDateFilter:/)
      } else {
        throw new Error(`expected invalid token for '${query}'`)
      }
    }
  })

  it('recognises prop:key=value tokens', () => {
    const ast = parse('prop:status=done not-prop:archived=true')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({
      kind: 'prop',
      key: 'status',
      value: 'done',
    })
    expect(ast.filters[1]).toMatchObject({
      kind: 'notProp',
      key: 'archived',
      value: 'true',
    })
  })

  it('accepts prop:key= (empty value = key-presence-only)', () => {
    const ast = parse('prop:status=')
    expect(ast.filters[0]).toMatchObject({
      kind: 'prop',
      key: 'status',
      value: '',
    })
  })

  it('flags prop without = as invalid', () => {
    const ast = parse('prop:status')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain('key=value')
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('flags prop with empty key as invalid', () => {
    const ast = parse('prop:=value')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain('key cannot be empty')
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('parses prop:key="value with spaces" (#152)', () => {
    const ast = parse('prop:status="in progress"')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({
      kind: 'prop',
      key: 'status',
      value: 'in progress',
    })
    expect(ast.freeText).toBe('')
  })

  it('parses not-prop:key="value with spaces" (#152)', () => {
    const ast = parse('not-prop:owner="Jane Doe"')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({
      kind: 'notProp',
      key: 'owner',
      value: 'Jane Doe',
    })
    expect(ast.freeText).toBe('')
  })

  it('quoted prop value coexists with other tokens (#152)', () => {
    const ast = parse('tag:#urgent prop:status="in progress" leftover words')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'urgent' })
    expect(ast.filters[1]).toMatchObject({
      kind: 'prop',
      key: 'status',
      value: 'in progress',
    })
    expect(ast.freeText).toBe('leftover words')
  })

  it('parses path:"glob with spaces" (#718)', () => {
    const ast = parse('path:"Meeting Notes/*"')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({
      kind: 'pathInclude',
      value: 'Meeting Notes/*',
    })
    expect(ast.freeText).toBe('')
  })

  it('parses not-path:"glob with spaces" (#718)', () => {
    const ast = parse('not-path:"Old Archive/**"')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({
      kind: 'pathExclude',
      value: 'Old Archive/**',
    })
    expect(ast.freeText).toBe('')
  })

  it('strips quotes from a quoted path glob without spaces (#718)', () => {
    const ast = parse('path:"Journal/*"')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({ kind: 'pathInclude', value: 'Journal/*' })
  })

  it('quoted path glob coexists with other tokens (#718)', () => {
    const ast = parse('tag:#urgent path:"Meeting Notes/*" leftover words')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'urgent' })
    expect(ast.filters[1]).toMatchObject({
      kind: 'pathInclude',
      value: 'Meeting Notes/*',
    })
    expect(ast.freeText).toBe('leftover words')
  })

  it('an UNquoted path glob still splits at the first space (#718 contract)', () => {
    // Whitespace ends an unquoted token — quoting is the only way to
    // carry a space inside a path: value.
    const ast = parse('path:Meeting Notes/*')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({ kind: 'pathInclude', value: 'Meeting' })
    expect(ast.freeText).toBe('Notes/*')
  })

  it('an empty quoted path value is invalid (#718)', () => {
    const ast = parse('path:""')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain('path: value required')
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('a quoted path glob is still glob-validated after unquoting (#718)', () => {
    const ast = parse('path:"Meeting [unclosed"')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain('InvalidGlob')
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('serialise round-trip preserves  token shapes', () => {
    // Canonical form is reproduced verbatim.
    const inputs = [
      'state:TODO',
      'not-state:DONE',
      'priority:1',
      'not-priority:none',
      'due:today',
      'due:>=2026-01-01',
      'scheduled:none',
      'prop:status=done',
      'not-prop:archived=true',
      'prop:tag=', // key-presence-only
    ]
    for (const input of inputs) {
      const ast = parse(input)
      expect(ast.filters).toHaveLength(1)
      // Round-trip invariant: re-parsing serialise(parse(input)) yields
      // the same filter list — guards the registry-source-string
      // invariant. The actual round-trip is exercised in
      // `serialize.test.ts`; here we just assert each shape is
      // recognised in isolation.
      expect(ast.filters[0]?.kind).not.toBe('invalid')
    }
  })

  // -------------------------------------------------------------------
  // Mutation-survivor coverage (GH #3142)
  // -------------------------------------------------------------------

  it('does not treat a lone "#" as the tag alias (requires text after it)', () => {
    // classify.ts:58 — `tok.text.startsWith('#') && tok.text.length > 1`.
    // A bare `#` has length 1 and must fall through to free text instead of
    // becoming a tag chip with an empty value.
    const ast = parse('#')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('#')
  })

  it('shadows all but the last due:/scheduled: token even with other filters interleaved', () => {
    // classify.ts:87/90/91/93 — the shadowing loop must iterate every
    // filter (not stop early), only enter its branch once there are truly
    // 2+ occurrences of the SAME kind, drop exactly all-but-the-last via
    // `indices.slice(0, -1)` (three due: tokens here, so the slice bound
    // matters — not just "keep only the first"), and never touch a
    // differently-kinded filter sitting in between.
    const ast = parse(
      'due:today tag:#x due:this-week due:overdue scheduled:none scheduled:>=2026-01-01',
    )
    expect(ast.filters).toHaveLength(6)
    expect(ast.filters[0]).toMatchObject({ kind: 'invalid', source: 'due:today' })
    expect(ast.filters[1]).toMatchObject({ kind: 'tag', value: 'x' })
    expect(ast.filters[2]).toMatchObject({ kind: 'invalid', source: 'due:this-week' })
    expect(ast.filters[3]).toMatchObject({
      kind: 'due',
      value: { kind: 'named', name: 'overdue' },
    })
    expect(ast.filters[4]).toMatchObject({ kind: 'invalid', source: 'scheduled:none' })
    expect(ast.filters[5]).toMatchObject({
      kind: 'scheduled',
      value: { kind: 'op', op: '>=', date: '2026-01-01' },
    })
  })

  it('sorts consumed filter spans defensively even when fed out of order', () => {
    // classify.ts:125 — `consumedOrdered = [...consumed].toSorted((a, b) => a[0] - b[0])`.
    // `classify()` is the documented lower-level entry that accepts a
    // pre-tokenised stream directly, so feed it tokens whose spans are NOT
    // in left-to-right order (the tokeniser always emits ascending spans,
    // but this call proves the "don't rely on it" defensive sort).
    ensureRegistered()
    const input = 'tag:#a tag:#b'
    const tokens: RawToken[] = [
      { kind: 'word', text: 'tag:#b', span: [7, 13] },
      { kind: 'word', text: 'tag:#a', span: [0, 6] },
    ]
    const ast = classify(tokens, input)
    expect(ast.filters).toHaveLength(2)
    // If the sort were broken (or a no-op), the stripping pass would treat
    // the spans as already-ascending and produce leaked/garbled free text
    // instead of consuming both filters cleanly.
    expect(ast.freeText).toBe('')
  })

  it('sorts quoted phrase spans defensively even when fed out of order', () => {
    // classify.ts:126 — same defensive sort for `quotedOrdered`.
    ensureRegistered()
    const input = '"aa  bb" "cc  dd"'
    const tokens: RawToken[] = [
      { kind: 'quoted', text: '"cc  dd"', span: [9, 17] },
      { kind: 'quoted', text: '"aa  bb"', span: [0, 8] },
    ]
    const ast = classify(tokens, input)
    expect(ast.filters).toEqual([])
    // A broken sort corrupts the quoted-range bookkeeping and either
    // collapses the internal double-spaces it should preserve, or garbles
    // the output outright.
    expect(ast.freeText).toBe('"aa  bb" "cc  dd"')
  })

  it('skips a stale quoted span that was already inside a consumed filter span', () => {
    // classify.ts:139 — the `while (qi < quotedOrdered.length && (quotedOrdered[qi]?.[1] ?? 0) <= from)`
    // skip-loop must advance `qi` past a quoted span that a later append()
    // call never actually visited. Feed classify() a quoted token whose
    // span is entirely swallowed by a filter's consumed span (never
    // reachable from real tokenize() output, but the defensive contract
    // classify() documents for a hand-built token stream) followed by a
    // real trailing quoted phrase, and confirm only the real one survives.
    ensureRegistered()
    const input = 'lead tag:#covers "BB"'
    const tokens: RawToken[] = [
      { kind: 'word', text: 'lead', span: [0, 4] },
      { kind: 'quoted', text: '"AA"', span: [5, 9] },
      { kind: 'word', text: 'tag:#covers', span: [5, 16] },
      { kind: 'quoted', text: '"BB"', span: [17, 21] },
    ]
    const ast = classify(tokens, input)
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'covers' })
    expect(ast.freeText).toBe('lead "BB"')
  })

  it('does not re-emit a quoted span that exactly coincides with a consumed filter span', () => {
    // classify.ts:139 — `(quotedOrdered[qi]?.[1] ?? 0) <= from`. When a quoted
    // span's end exactly equals the `from` of the NEXT append() call (here
    // both the quote and the filter cover the same [10, 14) range), the
    // skip-loop must advance `qi` PAST it (`<=`) rather than leaving it
    // pointing at the already-consumed span (`<`). If it doesn't advance,
    // the stale span gets re-recorded as a zero-width `quotedOut` entry
    // sitting in the middle of the surrounding whitespace, which splits the
    // whitespace-collapse into two independent passes and leaves a double
    // space behind instead of collapsing to one.
    ensureRegistered()
    const input = 'freeword  XXXX trailing'
    const tokens: RawToken[] = [
      { kind: 'quoted', text: '"AA"', span: [10, 14] },
      { kind: 'word', text: '#XXX', span: [10, 14] },
    ]
    const ast = classify(tokens, input)
    expect(ast.freeText).toBe('freeword trailing')
  })

  it('does not duplicate the overlap when two quoted spans nest inside one append() range', () => {
    // classify.ts:148 — `if (q[1] <= to) { qi++; ... } else { break }`. When
    // a quoted span's end falls beyond the current append() range (`to`),
    // the loop must `break` and leave `q` (and `qi`) pointing at that same
    // span so the NEXT append() call resumes handling it, instead of
    // advancing `qi` unconditionally and treating it as fully consumed here.
    // Two overlapping quotes — [0, 10) and [3, 6), the second nested wholly
    // inside the first but with an end past the append() boundary carved
    // out by the [8, 12) filter — force the loop to take the `else break`
    // path; mutating the guard to `true` makes it advance `qi` regardless,
    // so on the FOLLOWING append() call the first quote's tail gets
    // re-recorded a second time as its own `quotedOut` entry, duplicating
    // that substring in the reconstructed free text.
    ensureRegistered()
    const input = '0123456789ABCDEFGHIJ'
    const tokens: RawToken[] = [
      { kind: 'quoted', text: 'A', span: [0, 10] },
      { kind: 'quoted', text: 'B', span: [3, 6] },
      { kind: 'word', text: '#ZZZZ', span: [8, 12] },
    ]
    const ast = classify(tokens, input)
    expect(ast.freeText).toBe('01234567CDEFGHIJ')
  })
  // Note: the `q[1] <= to` -> `q[1] < to` mutant on that same line
  // (classify.ts:148:11) is EQUIVALENT for every input `parse()` can produce,
  // so it is recorded as an accepted gap rather than killed. `tokenize`
  // advances a single cursor, so it only ever emits strictly ordered, disjoint,
  // in-bounds spans: when a quoted span ends exactly at `to`, the next quoted
  // span starts at or after `to` (`q[0] < to` is already false, so the loop
  // exits either way), and the following append() call's leading skip-loop
  // discards the un-advanced `qi` anyway because `q[1] <= from`. Only a
  // hand-built stream with NESTED quoted spans separates the two variants, and
  // what it exposes is the duplicated overlap the test above exists to forbid
  // — pinning that output would contract-ify a bug. Verified by differential
  // execution over 612 696 `parse()`-reachable inputs: zero output differences.

  it('collapses whitespace right up to (not past) the next quoted span boundary', () => {
    // classify.ts:159 — `if (s > cursor) append(cursor, s)`. Between two
    // adjacent filters that both sit inside the same quoted span's
    // reach, this guard must fire only when there's a genuine gap to
    // append; if it always ran (mutant `true`) or ran on an off-by-one
    // boundary (mutant `s >= cursor`), a stale/zero-width slice of the
    // quoted span would get appended and re-recorded, splitting the
    // free-text whitespace collapse into two independent passes and
    // leaving a double space where the real output collapses to one.
    ensureRegistered()
    const input = 'AB  CDEFGHIJ  XY'
    const tokens: RawToken[] = [
      { kind: 'quoted', text: 'Q', span: [4, 12] },
      { kind: 'word', text: '#f1', span: [4, 8] },
      { kind: 'word', text: '#f2', span: [8, 12] },
    ]
    const ast = classify(tokens, input)
    expect(ast.freeText).toBe('AB XY')
  })

  it('does not duplicate the tail when a consumed span runs past the end of the input', () => {
    // classify.ts:162 — `if (cursor < input.length) append(cursor, input.length)`.
    // The guard is load-bearing, not cosmetic: a consumed span whose end
    // exceeds `input.length` leaves `cursor` past the end, and calling
    // append(cursor, input.length) with `from > to` inverts the quoted-span
    // arithmetic — `qs`/`qe` come out reversed, so `quotedOut` receives a
    // NEGATIVE-width entry. The second pass then rewinds `pos` behind itself,
    // and the trailing `if (pos < stripped.length)` re-emits text it had
    // already emitted, duplicating the tail of the free text.
    // Mutating the guard to `true` (or dropping it) reproduces exactly that:
    // free text 'aa' instead of 'a'.
    //
    // This fixture — a quoted span `[0, 9]` reaching past a 3-char input,
    // overlapping a word span `[1, 5]` — is not one `tokenize` can ever
    // produce for `parse()`: `tokenize` advances a single cursor and only
    // ever emits strictly ordered, disjoint, in-bounds spans, so it is not
    // `parse()`-reachable. That puts it in the same fabricated-fixture class
    // as the test removed elsewhere in this file — but with a different
    // outcome: that removed test pinned whatever the mutant happened to
    // emit as if it were correct behavior, while this test asserts the
    // actually-correct output ('a', not 'aa') and exercises `classify`
    // itself, which is an exported, directly-callable lower-level entry
    // point with its own defensive contract independent of what `parse()`
    // can hand it. That is the line being drawn: fabricated inputs are a
    // problem when they pin artifacts, not when they probe a defensive
    // contract with the correct expectation.
    ensureRegistered()
    const input = 'abc'
    const tokens: RawToken[] = [
      { kind: 'quoted', text: 'A', span: [0, 9] },
      { kind: 'word', text: '#tag', span: [1, 5] },
    ]
    const ast = classify(tokens, input)
    expect(ast.freeText).toBe('a')
  })

  it('reconstructs free text around multiple quoted phrases interleaved with multiple filters', () => {
    // classify.ts:143/148/159/162/169/173 — buildFreeText's stripping +
    // whitespace-collapse passes, exercised together: one quoted phrase
    // before the first filter, one between the two filters, one after the
    // last filter — each preserving its internal double space, while the
    // whitespace between filters/phrases collapses to a single space.
    const ast = parse('"lead  in" tag:#x "middle  gap" not-path:Arch/** "trail  ing"')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'x' })
    expect(ast.filters[1]).toMatchObject({ kind: 'pathExclude', value: 'Arch/**' })
    expect(ast.freeText).toBe('"lead  in" "middle  gap" "trail  ing"')
  })
})
