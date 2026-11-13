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
  isLegacyQueryText,
  type QueryTextDeps,
  readQueryText,
  unescapeQueryText,
} from '@/lib/query-text'
import { serialize } from '@/lib/search-query'
import { addLeafToTree, builderTreeToFilterExpr, makeEmptyRoot } from '@/stores/advancedQuery'

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
    // A `#` makes it the search syntax.
    ['tag:#work', false],
    ['tag:work tag:#home', false],
    ['#work', false],
    [`#[${TAG_WORK}]`, false],
    ['tag:#"my tag"', false],
    // So does any other word: a search token, free text, an unknown key.
    ['tag:work state:TODO', false],
    ['tag:work\nstate:TODO', false],
    ['tag:work hello', false],
    ['tag:work foo:bar', false],
    ['state:TODO', false],
    ['prop:status=done', false],
    ['under:#work', false],
    ['due:today', false],
    ['hello', false],
    ['todo:TODO', false],
    // Quoting: the older text splits on whitespace, quotes or not.
    ['tag:"my tag"', false],
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

  it('the filters only the search box runs', async () => {
    expect(await problems('under:#work path:Journal/* not-path:"Old Notes/*"')).toEqual([
      { token: 'under:#work', column: 1, message: t('query.text.cannotRun') },
      { token: 'path:Journal/*', column: 13, message: t('query.text.cannotRun') },
      { token: 'not-path:"Old Notes/*"', column: 28, message: t('query.text.cannotRun') },
    ])
  })

  it('a relative date, and free text, not yet', async () => {
    expect(await problems('due:this-week state:TODO my tasks')).toEqual([
      { token: 'due:this-week', column: 1, message: t('query.text.relativeDate') },
      { token: 'my tasks', column: 26, message: t('query.text.freeText') },
    ])
    expect(await problems('scheduled:today')).toEqual([
      { token: 'scheduled:today', column: 1, message: t('query.text.relativeDate') },
    ])
  })

  it('a tag the space has no tag of that name for', async () => {
    expect(await problems('state:TODO tag:#nope')).toEqual([
      { token: 'tag:#nope', column: 12, message: t('query.text.unknownTag', { name: 'nope' }) },
    ])
  })

  it('counts columns in the text as the editor shows it, view words included', async () => {
    expect(await problems('table:true prop:a\\_b=c under:#x')).toEqual([
      { token: 'under:#x', column: 23, message: t('query.text.cannotRun') },
    ])
  })

  it('nothing to run: a block of view words alone runs nothing rather than everything', async () => {
    expect(await problems('table:true columns:a')).toEqual([])
  })
})
