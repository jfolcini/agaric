import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { parse } from '../classify'
import { addFilter, removeFilterAt, serialize, tokenSource } from '../serialize'

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
  ]

  for (const s of canonicalInputs) {
    it(`canonical: serialize(parse('${s}')) === ('${s}')`, () => {
      const round = serialize(parse(s))
      // Reconstructed AST should be equivalent — chips and freetext
      // are order-preserving by their classification rules.
      expect(parse(round)).toEqual(parse(s))
    })
  }

  it('idempotency: parse(serialize(parse(s))) === parse(s)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom('tag:#urgent', 'path:Journal/*', '#followup', 'hello world'),
          fc.string({ minLength: 0, maxLength: 30 }),
        ),
        (s) => {
          const once = parse(s)
          const twice = parse(serialize(once))
          // Filters and freeText must match (key-by-key).
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
        },
      ),
      { numRuns: 200 },
    )
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
})
