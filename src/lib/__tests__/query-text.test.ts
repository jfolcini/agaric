/**
 * A query block's search-syntax text (#6628): which text a block is read as,
 * and the filter each token compiles to.
 */

import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'

import type { FilterExpr, FilterPrimitive } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import {
  compileQueryText,
  compileQueryTextWithTags,
  filterToQueryText,
  isLegacyQueryText,
  type QueryTextDeps,
  readQueryText,
  unescapeQueryText,
} from '@/lib/query-text'
import { serialize } from '@/lib/search-query'
import {
  addLeafToTree,
  builderTreeToFilterExpr,
  filterExprToBuilderTree,
  makeEmptyRoot,
} from '@/stores/advancedQuery'

const TAG_WORK = '01HZY3V9Q8K2M4N6P7R8S9T0VW'
const TAG_HOME = '01HZY3V9Q8K2M4N6P7R8S9T0VX'

const deps: QueryTextDeps = {
  listTags: async () => [
    { tag_id: TAG_WORK, name: 'Work' },
    { tag_id: TAG_HOME, name: 'home' },
  ],
}

/** The filter the builder writes for these leaves, added one by one to its root `And`. */
function built(...primitives: FilterPrimitive[]): FilterExpr {
  const root = primitives.reduce(
    (tree, primitive, i) => addLeafToTree(tree, [], primitive, i + 1),
    makeEmptyRoot(),
  )
  return builderTreeToFilterExpr(root)
}

async function compiled(text: string): Promise<FilterExpr> {
  const result = await compileQueryText(text, deps)
  if (!result.ok) throw new Error(`"${text}" did not compile: ${JSON.stringify(result.problems)}`)
  return result.filter
}

async function problems(text: string) {
  const result = await compileQueryText(text, deps)
  if (result.ok) throw new Error(`"${text}" compiled`)
  return result.problems
}

describe('isLegacyQueryText', () => {
  it.each([
    // A key only the older text reads, each of them.
    ['property:context=@office', true],
    ['type:tag expr:work', true],
    ['type:property key:status value:done', true],
    ['type:property key:priority value:1 operator:gt', true],
    ['type:property key:due date:2026-01-05', true],
    ['type:backlinks target:00000000000000000000PAGE01', true],
    ['expr:work', true],
    ['key:status', true],
    ['value:done', true],
    ['target:X', true],
    ['operator:eq', true],
    ['date:2026-01-05', true],
    // Beside search tokens, a legacy key still decides.
    ['property:k=v state:TODO', true],
    ['tag:#work property:k=v', true],
    ['tag:project-x property:todo_state=TODO', true],
    // Nothing but `tag:` words without `#`.
    ['tag:work', true],
    ['tag:work tag:personal', true],
    ['tag:foo tag:foo', true],
    ['tag:', true],
    ['tag:"work"', true],
    ['tag:work table:true', true],
    ['tag:work table:true columns:due_date,owner', true],
    ['  tag:work\t tag:x  ', true],
    // Words without a key, which the older text skips, do not decide.
    ['tag:work hello', true],
    [`tag:work #[${TAG_WORK}]`, true],
    ['tag:"my tag"', true],
    // A `#` makes it the search syntax.
    ['tag:#work', false],
    ['tag:work tag:#home', false],
    ['#work', false],
    [`#[${TAG_WORK}]`, false],
    ['tag:#"my tag"', false],
    // So does any other word: a search token, free text, an unknown key.
    ['tag:work state:TODO', false],
    ['tag:work\nstate:TODO', false],
    ['tag:work foo:bar', false],
    ['state:TODO', false],
    ['prop:status=done', false],
    ['under:#work', false],
    ['due:today', false],
    ['hello', false],
    ['todo:TODO', false],
    // Quoting: the older text splits on whitespace, quotes or not.
    ['"type:tag"', false],
    ['prop:k="x type:y"', true],
    // The block's Markdown escapes are decoded first.
    ['property:project\\=beta', true],
    ['tag:\\#\\[x\\]', false],
    // No filter word at all.
    ['', false],
    ['table:true', false],
  ])('%j is legacy: %s', (text, legacy) => {
    expect(isLegacyQueryText(text)).toBe(legacy)
  })

  // The search serializer writes `tag:#x`, so a search-syntax text written
  // back by it can never turn legacy.
  it('stays the search syntax through a parse and serialize round trip', () => {
    const word = fc.constantFrom(
      'tag:work',
      'tag:#work',
      'tag:',
      'tag:#',
      '#work',
      '#',
      'state:TODO',
      'state:todo',
      'not-prop:k=',
      'prop:k="a b"',
      'under:#x',
      'due:2026-01-05',
      'due:today',
      'type:tag',
      'property:k=v',
      'expr:x',
      'table:true',
      'columns:a,b',
      'hello',
      '"a b"',
      '"',
      '""',
      '\\#\\[x\\]',
      `#[${TAG_WORK}]`,
    )
    const space = fc.constantFrom(' ', '  ', '\t', '\n', ' ')
    const text = fc.oneof(
      fc
        .array(fc.tuple(word, space), { minLength: 1, maxLength: 6 })
        .map((parts) => parts.flat().join('')),
      fc.string({ maxLength: 30 }),
    )
    fc.assert(
      fc.property(text, (s) => {
        fc.pre(!isLegacyQueryText(s))
        expect(isLegacyQueryText(serialize(readQueryText(s).ast))).toBe(false)
      }),
      { numRuns: 500 },
    )
  })
})

describe('unescapeQueryText', () => {
  it('decodes the escapes the Markdown parser decodes, and no others', () => {
    expect(unescapeQueryText('prop:a\\_b=\\$5 \\#\\[x\\] \\\\ \\a')).toBe('prop:a_b=$5 #[x] \\ \\a')
  })
})

describe('compileQueryText: each token is the leaf the builder writes', () => {
  it.each<[string, FilterPrimitive]>([
    ['tag:#work', { type: 'Tag', tag: TAG_WORK }],
    ['#work', { type: 'Tag', tag: TAG_WORK }],
    ['tag:#WORK', { type: 'Tag', tag: TAG_WORK }],
    ['tag:#"home"', { type: 'Tag', tag: TAG_HOME }],
    [`#[${TAG_HOME}]`, { type: 'Tag', tag: TAG_HOME }],
    ['state:TODO', { type: 'State', values: ['TODO'], is_null: false, exclude: false }],
    ['state:none', { type: 'State', values: [], is_null: true, exclude: false }],
    ['state:NONE', { type: 'State', values: [], is_null: true, exclude: false }],
    ['not-state:DONE', { type: 'State', values: ['DONE'], is_null: false, exclude: true }],
    ['not-state:none', { type: 'State', values: [], is_null: true, exclude: true }],
    ['priority:1', { type: 'Priority', values: ['1'], is_null: false, exclude: false }],
    ['priority:none', { type: 'Priority', values: [], is_null: true, exclude: false }],
    ['not-priority:3', { type: 'Priority', values: ['3'], is_null: false, exclude: true }],
    [
      'prop:status=done',
      {
        type: 'HasProperty',
        key: 'status',
        predicate: { type: 'Eq', value: { type: 'Text', value: 'done' } },
      },
    ],
    [
      'prop:status="in progress"',
      {
        type: 'HasProperty',
        key: 'status',
        predicate: { type: 'Eq', value: { type: 'Text', value: 'in progress' } },
      },
    ],
    [
      'prop:effort=3.5',
      {
        type: 'HasProperty',
        key: 'effort',
        predicate: { type: 'Eq', value: { type: 'Num', value: 3.5 } },
      },
    ],
    [
      'prop:deadline=2026-01-05',
      {
        type: 'HasProperty',
        key: 'deadline',
        predicate: { type: 'Eq', value: { type: 'Date', value: '2026-01-05' } },
      },
    ],
    ['prop:status=', { type: 'HasProperty', key: 'status', predicate: { type: 'Exists' } }],
    [
      'not-prop:status=done',
      {
        type: 'HasProperty',
        key: 'status',
        predicate: { type: 'Ne', value: { type: 'Text', value: 'done' } },
      },
    ],
    ['not-prop:status=', { type: 'HasProperty', key: 'status', predicate: { type: 'NotExists' } }],
    ['due:<2026-01-05', { type: 'DueDate', predicate: { type: 'Before', date: '2026-01-05' } }],
    [
      'due:<=2026-01-05',
      { type: 'DueDate', predicate: { type: 'OnOrBefore', date: '2026-01-05' } },
    ],
    ['due:=2026-01-05', { type: 'DueDate', predicate: { type: 'On', date: '2026-01-05' } }],
    ['due:2026-01-05', { type: 'DueDate', predicate: { type: 'On', date: '2026-01-05' } }],
    ['due:>=2026-01-05', { type: 'DueDate', predicate: { type: 'OnOrAfter', date: '2026-01-05' } }],
    ['due:>2026-01-05', { type: 'DueDate', predicate: { type: 'After', date: '2026-01-05' } }],
    ['due:none', { type: 'DueDate', predicate: { type: 'IsNull' } }],
    ['scheduled:2026-01-05', { type: 'Scheduled', predicate: { type: 'On', date: '2026-01-05' } }],
    [
      'scheduled:<2026-01-05',
      { type: 'Scheduled', predicate: { type: 'Before', date: '2026-01-05' } },
    ],
    ['scheduled:NONE', { type: 'Scheduled', predicate: { type: 'IsNull' } }],
  ])('%s', async (text, primitive) => {
    expect(await compiled(text)).toEqual(built(primitive))
  })

  it('ANDs the tokens: tags one leaf each, states and priorities one leaf per sign', async () => {
    expect(
      await compiled(
        'tag:#work #home #work state:TODO state:DOING state:TODO not-state:none priority:1 prop:a=b not-prop:c= due:<2026-01-05 scheduled:none',
      ),
    ).toEqual(
      built(
        { type: 'Tag', tag: TAG_WORK },
        { type: 'Tag', tag: TAG_HOME },
        { type: 'State', values: ['TODO', 'DOING'], is_null: false, exclude: false },
        { type: 'State', values: [], is_null: true, exclude: true },
        { type: 'Priority', values: ['1'], is_null: false, exclude: false },
        {
          type: 'HasProperty',
          key: 'a',
          predicate: { type: 'Eq', value: { type: 'Text', value: 'b' } },
        },
        { type: 'HasProperty', key: 'c', predicate: { type: 'NotExists' } },
        { type: 'DueDate', predicate: { type: 'Before', date: '2026-01-05' } },
        { type: 'Scheduled', predicate: { type: 'IsNull' } },
      ),
    )
  })

  it('reads the text the block stores: escapes decoded, view words left out', async () => {
    expect(await compiled('prop:a\\_b=c table:true columns:due_date,owner')).toEqual(
      built({
        type: 'HasProperty',
        key: 'a_b',
        predicate: { type: 'Eq', value: { type: 'Text', value: 'c' } },
      }),
    )
  })

  it('looks the tags up only for a tag named in the text', async () => {
    const listTags = vi.fn(deps.listTags)
    await compileQueryText(`#[${TAG_WORK}] state:TODO`, { listTags })
    expect(listTags).not.toHaveBeenCalled()
    await compileQueryText('#work', { listTags })
    expect(listTags).toHaveBeenCalledTimes(1)
  })
})

describe('compileQueryText: the tokens a query block refused before #6742', () => {
  const tags = [
    { tag_id: TAG_WORK, name: 'Work' },
    { tag_id: TAG_HOME, name: 'home' },
  ]
  // A Wednesday.
  const today = new Date(2026, 10, 18)
  const run = (text: string) => {
    const result = compileQueryTextWithTags(text, tags, today)
    if (!result.ok) throw new Error(`"${text}" did not compile: ${JSON.stringify(result.problems)}`)
    return result
  }
  const glob = (pattern: string, exclude = false): FilterExpr => ({
    type: 'Leaf',
    primitive: { type: 'PathGlob', pattern, exclude },
  })

  it.each<[string, FilterPrimitive['type'], object]>([
    ['today', 'DueDate', { type: 'Between', from: '2026-11-18', to: '2026-11-18' }],
    ['yesterday', 'DueDate', { type: 'Between', from: '2026-11-17', to: '2026-11-17' }],
    ['overdue', 'DueDate', { type: 'Before', date: '2026-11-18' }],
    ['older', 'DueDate', { type: 'Before', date: '2026-10-19' }],
    ['this-week', 'DueDate', { type: 'Between', from: '2026-11-16', to: '2026-11-22' }],
    ['next-week', 'DueDate', { type: 'Between', from: '2026-11-23', to: '2026-11-29' }],
    ['this-month', 'DueDate', { type: 'Between', from: '2026-11-01', to: '2026-11-30' }],
    ['this-week', 'Scheduled', { type: 'Between', from: '2026-11-16', to: '2026-11-22' }],
  ])(
    'a relative date, %s, is the dates it names on the day the query runs',
    (name, type, predicate) => {
      const result = run(`${type === 'DueDate' ? 'due' : 'scheduled'}:${name}`)
      expect(result.filter).toEqual(built({ type, predicate } as FilterPrimitive))
      expect(result.textOnly).toBe(true)
    },
  )

  it('a relative date moves with the day: the week of a Sunday ends on it, the next starts after', () => {
    const due = (day: Date) => compileQueryTextWithTags('due:this-week', [], day)
    expect(due(new Date(2026, 10, 22))).toMatchObject({
      filter: built({
        type: 'DueDate',
        predicate: { type: 'Between', from: '2026-11-16', to: '2026-11-22' },
      }),
    })
    expect(due(new Date(2026, 10, 23))).toMatchObject({
      filter: built({
        type: 'DueDate',
        predicate: { type: 'Between', from: '2026-11-23', to: '2026-11-29' },
      }),
    })
  })

  it('free text is the full-text term, beside the filters and alone', () => {
    expect(run('state:TODO meeting notes')).toEqual({
      ok: true,
      filter: built({ type: 'State', values: ['TODO'], is_null: false, exclude: false }),
      fulltext: 'meeting notes',
      textOnly: true,
    })
    expect(run('meeting')).toEqual({
      ok: true,
      filter: { type: 'And', children: [] },
      fulltext: 'meeting',
      textOnly: true,
    })
  })

  it('under: is the tag attached, inline or inherited', () => {
    const result = run('under:#work under:#home')
    expect(result.filter).toEqual(
      built({ type: 'TagUnder', tag: TAG_WORK }, { type: 'TagUnder', tag: TAG_HOME }),
    )
    expect(result.textOnly).toBe(true)
    expect(compileQueryTextWithTags('under:#nope', tags, today)).toEqual({
      ok: false,
      problems: [
        { token: 'under:#nope', column: 1, message: t('query.text.unknownTag', { name: 'nope' }) },
      ],
    })
  })

  it('path: is the patterns search binds; several page names are any of them', () => {
    expect(run('path:Journal').filter).toEqual({ type: 'And', children: [glob('*journal*')] })
    expect(run('path:"Old Notes/*"').filter).toEqual({
      type: 'And',
      children: [glob('old notes/*')],
    })
    expect(run('path:{Work,Home}/* path:Inbox state:TODO')).toEqual({
      ok: true,
      filter: {
        type: 'And',
        children: [
          { type: 'Or', children: [glob('work/*'), glob('home/*'), glob('*inbox*')] },
          {
            type: 'Leaf',
            primitive: { type: 'State', values: ['TODO'], is_null: false, exclude: false },
          },
        ],
      },
      fulltext: '',
      textOnly: true,
    })
  })

  it('not-path: leaves out a block on any of its page names', () => {
    expect(run('not-path:Journal/*,Archive not-path:Old').filter).toEqual({
      type: 'And',
      children: [glob('journal/*', true), glob('*archive*', true), glob('*old*', true)],
    })
  })

  it('a page name search would refuse is named with its column', () => {
    // Each entry expands to the cap; together they pass it.
    const wide = `path:${'{a,b}'.repeat(6)},${'{c,d}'.repeat(6)}`
    const result = compileQueryTextWithTags(`state:TODO ${wide}`, tags, today)
    expect(result).toEqual({
      ok: false,
      problems: [{ token: wide, column: 12, message: expect.stringContaining('InvalidGlob') }],
    })
  })
})

describe('compileQueryText: what it cannot run, named with its column', () => {
  it('a token the parser refuses, with its message: states are written as the parser spells them', async () => {
    expect(await problems('tag:#work state:todo')).toEqual([
      {
        token: 'state:todo',
        column: 11,
        message: t('searchQuery.unknownValue', { noun: 'state', value: 'todo' }),
      },
    ])
  })

  it('an incomplete token', async () => {
    expect(await problems('due:<2026-0')).toEqual([
      {
        token: 'due:<2026-0',
        column: 1,
        message: `InvalidDateFilter: ${t('searchQuery.dateExpectedAfterOperator', { op: '<', rest: '2026-0' })}`,
      },
    ])
  })

  it('a tag the space has no tag of that name for', async () => {
    expect(await problems('state:TODO tag:#nope')).toEqual([
      { token: 'tag:#nope', column: 12, message: t('query.text.unknownTag', { name: 'nope' }) },
    ])
  })

  it('counts columns in the text as the editor shows it, view words included', async () => {
    expect(await problems('table:true prop:a\\_b=c tag:#x')).toEqual([
      { token: 'tag:#x', column: 23, message: t('query.text.unknownTag', { name: 'x' }) },
    ])
  })

  it('nothing to run: a block of view words alone runs nothing rather than everything', async () => {
    expect(await problems('table:true columns:a')).toEqual([])
  })
})

describe('filterToQueryText: the text the builder saves', () => {
  const text = (value: string): FilterPrimitive => ({
    type: 'HasProperty',
    key: 'k',
    predicate: { type: 'Eq', value: { type: 'Text', value } },
  })
  const todo: FilterPrimitive = { type: 'State', values: ['TODO'], is_null: false, exclude: false }

  /** The leaves of a root `And`, in an order that does not depend on theirs. */
  function leafSet(filter: FilterExpr): string[] {
    if (filter.type !== 'And') throw new Error('not an And')
    return filter.children.map((child) => JSON.stringify(child)).toSorted()
  }

  it.each<[FilterPrimitive, string]>([
    [{ type: 'Tag', tag: TAG_WORK }, `#[${TAG_WORK}]`],
    [todo, 'state:TODO'],
    [
      { type: 'State', values: ['TODO', 'DOING'], is_null: true, exclude: false },
      'state:TODO state:DOING state:none',
    ],
    [{ type: 'State', values: ['DONE'], is_null: false, exclude: true }, 'not-state:DONE'],
    [{ type: 'Priority', values: ['1'], is_null: false, exclude: false }, 'priority:1'],
    [{ type: 'Priority', values: [], is_null: true, exclude: true }, 'not-priority:none'],
    [text('done'), 'prop:k=done'],
    [text('in progress'), 'prop:k="in progress"'],
    [
      {
        type: 'HasProperty',
        key: 'k',
        predicate: { type: 'Eq', value: { type: 'Num', value: 3.5 } },
      },
      'prop:k=3.5',
    ],
    [
      {
        type: 'HasProperty',
        key: 'k',
        predicate: { type: 'Ne', value: { type: 'Date', value: '2026-01-05' } },
      },
      'not-prop:k=2026-01-05',
    ],
    [{ type: 'HasProperty', key: 'k', predicate: { type: 'Exists' } }, 'prop:k='],
    [{ type: 'HasProperty', key: 'k', predicate: { type: 'NotExists' } }, 'not-prop:k='],
    [{ type: 'DueDate', predicate: { type: 'Before', date: '2026-01-05' } }, 'due:<2026-01-05'],
    [
      { type: 'DueDate', predicate: { type: 'OnOrBefore', date: '2026-01-05' } },
      'due:<=2026-01-05',
    ],
    [{ type: 'DueDate', predicate: { type: 'On', date: '2026-01-05' } }, 'due:2026-01-05'],
    [{ type: 'DueDate', predicate: { type: 'OnOrAfter', date: '2026-01-05' } }, 'due:>=2026-01-05'],
    [
      { type: 'Scheduled', predicate: { type: 'After', date: '2026-01-05' } },
      'scheduled:>2026-01-05',
    ],
    [{ type: 'Scheduled', predicate: { type: 'IsNull' } }, 'scheduled:none'],
  ])('%j is %s, and reads back as itself', (primitive, expected) => {
    const filter = built(primitive)
    expect(filterToQueryText(filter)).toBe(expected)
    expect(compileQueryTextWithTags(expected, [])).toEqual({
      ok: true,
      filter,
      fulltext: '',
      textOnly: false,
    })
  })

  it('writes the leaves in the builder order; the builder reopens the same filter', () => {
    const filter = built(
      todo,
      { type: 'Tag', tag: TAG_WORK },
      { type: 'DueDate', predicate: { type: 'IsNull' } },
      text('done'),
    )
    const written = filterToQueryText(filter)
    expect(written).toBe(`state:TODO #[${TAG_WORK}] due:none prop:k=done`)
    const read = compileQueryTextWithTags(written ?? '', [])
    if (!read.ok) throw new Error('did not compile')
    const reopened = builderTreeToFilterExpr(filterExprToBuilderTree(read.filter, () => 0))
    expect(leafSet(reopened)).toEqual(leafSet(filter))
  })

  it.each<[string, FilterExpr]>([
    ['an Or', { type: 'Or', children: [built(todo), built(text('a'))] }],
    ['a nested group', { type: 'And', children: [built(todo)] }],
    ['a negated leaf', { type: 'And', children: [{ type: 'Not', child: built(todo) }] }],
    ['a leaf at the root', { type: 'Leaf', primitive: todo }],
    ['no filter', built()],
    ['a tag matched inline too', built({ type: 'TagOrRef', tag: TAG_WORK })],
    ['a block type', built({ type: 'BlockType', values: ['page'], exclude: false })],
    [
      'a date range',
      built({
        type: 'DueDate',
        predicate: { type: 'Between', from: '2026-01-01', to: '2026-01-05' },
      }),
    ],
    [
      'a comparison',
      built({
        type: 'HasProperty',
        key: 'k',
        predicate: { type: 'Gt', value: { type: 'Num', value: 1 } },
      }),
    ],
    [
      'a reference value',
      built({
        type: 'HasProperty',
        key: 'k',
        predicate: { type: 'Eq', value: { type: 'Ref', value: TAG_WORK } },
      }),
    ],
    // The text would read these back as another filter.
    ['text the reader types as a number', built(text('5'))],
    ['text the reader types as a date', built(text('2026-01-05'))],
    ['text holding a Markdown escape', built(text('a\\*b'))],
    ['text holding a legacy key', built(text('x type:y'))],
    ['text holding a quote', built(text('a "b" c'))],
    ['two state leaves, which the text would merge', built(todo, { ...todo, values: ['DOING'] })],
    ['a tag named twice', built({ type: 'Tag', tag: TAG_WORK }, { type: 'Tag', tag: TAG_WORK })],
    ['a tag that is not an id', built({ type: 'Tag', tag: 'work' })],
    ['a state the search syntax rejects', built({ ...todo, values: ['todo'] })],
    [
      'two due dates',
      built(
        { type: 'DueDate', predicate: { type: 'OnOrAfter', date: '2026-01-01' } },
        { type: 'DueDate', predicate: { type: 'Before', date: '2026-01-05' } },
      ),
    ],
  ])('%s stays a v2 payload', (_name, filter) => {
    expect(filterToQueryText(filter)).toBeNull()
  })

  it('never writes a text that reads back as another filter, or as the older text', () => {
    const value = fc.oneof(
      fc.constantFrom('done', 'in progress', '5', 'a*b', 'x type:y', 'tag:z', '"q"', 'a}}b', ''),
      fc.string({ maxLength: 12 }),
    )
    const key = fc.oneof(fc.constantFrom('k', 'a_b', 'my key', 'k=v'), fc.string({ maxLength: 6 }))
    const state = fc.constantFrom('TODO', 'DOING', 'DONE', 'todo', 'none', 'x y')
    const date = fc.constantFrom('2026-01-05', '2026-13-40', 'today', '')
    const leaf: fc.Arbitrary<FilterPrimitive> = fc.oneof(
      fc.constantFrom(TAG_WORK, TAG_HOME, 'work').map((tag) => ({ type: 'Tag' as const, tag })),
      fc.record({
        type: fc.constantFrom('State' as const, 'Priority' as const),
        values: fc.array(state, { maxLength: 3 }),
        is_null: fc.boolean(),
        exclude: fc.boolean(),
      }),
      fc.tuple(key, value, fc.constantFrom('Eq' as const, 'Ne' as const)).map(([k, v, type]) => ({
        type: 'HasProperty' as const,
        key: k,
        predicate: { type, value: { type: 'Text' as const, value: v } },
      })),
      fc.tuple(key, fc.constantFrom('Exists' as const, 'NotExists' as const)).map(([k, type]) => ({
        type: 'HasProperty' as const,
        key: k,
        predicate: { type },
      })),
      fc
        .tuple(
          fc.constantFrom('DueDate' as const, 'Scheduled' as const),
          fc.constantFrom('Before' as const, 'On' as const, 'After' as const),
          date,
        )
        .map(([type, op, d]) => ({ type, predicate: { type: op, date: d } })),
    )
    let written = 0
    fc.assert(
      fc.property(fc.array(leaf, { maxLength: 4 }), (primitives) => {
        const filter = built(...primitives)
        const queryText = filterToQueryText(filter)
        if (queryText === null) return
        written += 1
        expect(isLegacyQueryText(queryText)).toBe(false)
        const read = compileQueryTextWithTags(queryText, [])
        if (!read.ok) throw new Error(`"${queryText}" did not compile`)
        expect(leafSet(read.filter)).toEqual(leafSet(filter))
      }),
      { numRuns: 1000 },
    )
    // The property is vacuous if nothing was ever written as text.
    expect(written).toBeGreaterThan(50)
  })
})
