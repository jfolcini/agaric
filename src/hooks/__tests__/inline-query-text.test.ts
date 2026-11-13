/**
 * A query block written in the search syntax (#6628), run end to end through
 * `resolveInlineQuery` over the mock backend's real handlers; and every block
 * read as the older query text, or as a `v2:` payload, sending exactly the
 * requests it sent before the search syntax was accepted. The oracle for that
 * is the resolver as it stood then, kept verbatim below.
 */

import { invoke } from '@tauri-apps/api/core'
import fc from 'fast-check'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  dispatchQuery,
  fetchRichInlineQuery,
  QueryValidationError,
  type QueryFetchResult,
  resolveInlineQuery,
} from '@/hooks/useQueryExecution'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { resolveLegacyQueryToFilterExpr } from '@/lib/inline-query-resolve'
import { decodeInlineQueryPayload, encodeInlineQueryPayload } from '@/lib/inline-query-spec'
import { isLegacyQueryText } from '@/lib/query-text'
import { parseQueryExpression } from '@/lib/query-utils'
import { requireActiveScope } from '@/lib/space-scope'
import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blockTagRefs,
  blockTags,
  blocks,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
  seedBlocks,
} from '@/lib/tauri-mock/seed'

const SPACE = 'SPACE_TX'.padStart(26, '0')

function id(label: string): string {
  return label.padStart(26, '0')
}

const PAGE = id('PAGE')
const TAG_WORK = id('TAGWORK')
const TAG_WORKSHOP = id('TAGWORKSHOP')
const B1 = id('B1') // tag work attached, TODO, priority 1
const B3 = id('B3') // tag work attached, no state, context=@office
const B5 = id('B5') // tag workshop attached, DONE
const B7 = id('B7') // tag work written inline only, TODO

function childBlock(blockId: string, fields: Record<string, string> = {}): void {
  const b = makeBlock(blockId, 'text', `block ${blockId}`, PAGE, 1)
  b['page_id'] = PAGE
  for (const [k, v] of Object.entries(fields)) b[k] = v
  blocks.set(blockId, b)
}

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(
    async (cmd: string, args?: unknown) => dispatch(cmd, args) as never,
  )
  seedBlocks()
  blocks.clear()
  properties.clear()
  blockTags.clear()
  blockTagRefs.clear()
  propertyDefs.clear()
  opLog.length = 0

  blocks.set(PAGE, { ...makeBlock(PAGE, 'page', 'Page', null, 1), space_id: SPACE })
  blocks.set(TAG_WORK, { ...makeBlock(TAG_WORK, 'tag', 'work', null, 1), space_id: SPACE })
  blocks.set(TAG_WORKSHOP, {
    ...makeBlock(TAG_WORKSHOP, 'tag', 'workshop', null, 1),
    space_id: SPACE,
  })
  childBlock(B1, { todo_state: 'TODO', priority: '1' })
  childBlock(B3)
  properties.set(
    B3,
    new Map([
      [
        'context',
        {
          key: 'context',
          value_text: '@office',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      ],
    ]),
  )
  childBlock(B5, { todo_state: 'DONE' })
  childBlock(B7, { todo_state: 'TODO' })
  blockTags.set(B1, new Set([TAG_WORK]))
  blockTags.set(B3, new Set([TAG_WORK]))
  blockTags.set(B5, new Set([TAG_WORKSHOP]))
  blockTagRefs.set(B7, new Set([TAG_WORK]))
})

async function ids(text: string): Promise<string[]> {
  const res = await resolveInlineQuery(text, undefined, SPACE)
  return res.items.map((b) => b.id).toSorted()
}

describe('a query block in the search syntax', () => {
  it('runs the tag by name, attached only, beside a state', async () => {
    expect(await ids('tag:#work state:TODO')).toEqual([B1])
  })

  it('runs a tag chip by its id, and ANDs repeated tags', async () => {
    expect(await ids(`#[${TAG_WORK}]`)).toEqual([B1, B3])
    expect(await ids('#work #workshop')).toEqual([])
  })

  it('runs states, priorities and properties as the search box does', async () => {
    expect(await ids('not-state:none not-state:DONE')).toEqual([B1, B7])
    expect(await ids('priority:1')).toEqual([B1])
    expect(await ids('prop:context=@office')).toEqual([B3])
    expect(await ids('#work not-prop:context=')).toEqual([B1])
  })

  it('reads the same `tag:` as the older text differently: exact and attached', async () => {
    expect(await ids('tag:work')).toEqual([B1, B3, B5, B7])
    expect(await ids('tag:#work')).toEqual([B1, B3])
  })

  it('refuses a token it cannot run with a validation error naming it, sending no query', async () => {
    const run = resolveInlineQuery('state:todo #nope', undefined, SPACE)
    await expect(run).rejects.toThrow(QueryValidationError)
    await expect(run).rejects.toThrow(
      [
        t('query.text.problem', {
          token: 'state:todo',
          column: 1,
          message: t('searchQuery.unknownValue', { noun: 'state', value: 'todo' }),
        }),
        t('query.text.problem', {
          token: '#nope',
          column: 12,
          message: t('query.text.unknownTag', { name: 'nope' }),
        }),
      ].join('; '),
    )
    const sent = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd)
    expect(sent).toEqual(['list_all_tags_in_space'])
  })

  it('refuses a block with no filter rather than listing every block', async () => {
    await expect(resolveInlineQuery('table:true', undefined, SPACE)).rejects.toThrow(
      t('query.expressionEmpty'),
    )
  })
})

/** `resolveInlineQuery` before #6628, verbatim: the oracle for every block not in the search syntax. */
async function resolveInlineQueryBefore6628(
  expression: string,
  pageCursor?: string,
  spaceId?: string | null,
): Promise<QueryFetchResult> {
  const structured = decodeInlineQueryPayload(expression)
  if (structured) {
    return await fetchRichInlineQuery(structured.filter, pageCursor, spaceId)
  }
  const parsed = parseQueryExpression(expression)
  const resolved = await resolveLegacyQueryToFilterExpr(parsed, {
    resolveTagPrefix: async (prefix) =>
      spaceId
        ? unwrap(await commands.listTagsByPrefix(prefix, null, requireActiveScope(spaceId))).map(
            (tag) => tag.tag_id,
          )
        : [],
  })
  if (resolved.filterExpr != null) {
    return await fetchRichInlineQuery(resolved.filterExpr, pageCursor, spaceId)
  }
  return await dispatchQuery(parsed, pageCursor, spaceId)
}

type Resolver = typeof resolveInlineQuery

/** Every IPC request `resolve` sends for `text`, and what it settles to. */
async function requests(resolve: Resolver, text: string) {
  const sent: Array<[string, unknown]> = []
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    sent.push([cmd, structuredClone(args)])
    return dispatch(cmd, args) as never
  })
  try {
    const res = await resolve(text, undefined, SPACE)
    return { sent, ids: res.items.map((b) => b.id) }
  } catch (e) {
    return { sent, error: String(e) }
  }
}

const V2 = encodeInlineQueryPayload({
  filter: { type: 'And', children: [{ type: 'Leaf', primitive: { type: 'Tag', tag: TAG_WORK } }] },
  table: true,
})

/**
 * Every query-block text this repository holds (fixtures, e2e specs, docs and
 * tests, `{{query …}}` placeholders left out), and the reading each gets.
 */
const LEGACY_IN_REPO = [
  'tag:work',
  'tag:personal',
  'tag:x',
  'tag:project',
  'tag:nothing-has-it',
  'tag:nonexistenttag',
  'tag:nonexistent',
  'tag:work table:true',
  'tag:foo tag:foo',
  'tag:project-x property:todo_state=TODO',
  'type:tag expr:project',
  'type:tag expr:work',
  'type:tag expr:updated',
  'type:tag expr:test',
  'type:tag expr:',
  'type:tag expr:alpha',
  'type:tag expr:beta',
  'type:tag expr:nonexistent',
  'type:tag expr:project table:true',
  'type:tag expr:project table:true columns:due_date,owner',
  'type:property key:status value:done',
  'type:property key:project table:true',
  'type:property key:context value:@remote',
  'type:property key:context value:@office',
  'type:property key:priority value:1',
  'type:property',
  'type:property value:1',
  `type:backlinks target:${PAGE}`,
  'type:backlinks target:TARGET1',
  'type:backlinks',
  'type:invalid',
  'property:context=@office',
  'property:project=beta',
  'property:project\\=beta',
  'property:todo_state=TODO',
  'property:priority=1',
  'property:due_date=2025-06-01',
  'property:due_date>today',
  'property:due_date<=2025-12-31',
  'property:todo_state=TODO property:priority=1',
  'property:status!=done',
  'property:context!=beta',
  'property:due>=2025-01-01 property:due<=2025-12-31',
  'property:todo_state=TODO table:true',
  'property:context=@office tag:work',
]

describe('a block not in the search syntax sends the requests it sent before', () => {
  it.each(LEGACY_IN_REPO)('%j', async (text) => {
    expect(isLegacyQueryText(text)).toBe(true)
    expect(await requests(resolveInlineQuery, text)).toEqual(
      await requests(resolveInlineQueryBefore6628, text),
    )
  })

  it('a v2: payload', async () => {
    const before = await requests(resolveInlineQueryBefore6628, V2)
    expect(before.ids).toEqual([B3, B1])
    expect(await requests(resolveInlineQuery, V2)).toEqual(before)
  })

  it('any text read as the older one', async () => {
    const word = fc.constantFrom(
      'tag:work',
      'tag:wo',
      'tag:',
      'tag:#work',
      'property:context=@office',
      'property:priority=1',
      'property:status!=done',
      'property:due_date<=2025-12-31',
      'property:k',
      'type:tag',
      'type:property',
      'type:backlinks',
      'type:invalid',
      'expr:work',
      'expr:',
      'key:context',
      'value:@office',
      'operator:gt',
      'date:2025-06-01',
      `target:${PAGE}`,
      'state:TODO',
      'prop:a=b',
      '#work',
      'hello',
      'table:true',
      'columns:a,b',
    )
    const text = fc
      .array(word, { minLength: 1, maxLength: 5 })
      .map((words) => words.join(' '))
      .filter(isLegacyQueryText)
    await fc.assert(
      fc.asyncProperty(text, async (s) => {
        expect(await requests(resolveInlineQuery, s)).toEqual(
          await requests(resolveInlineQueryBefore6628, s),
        )
      }),
      { numRuns: 150 },
    )
  })
})

describe('the search-syntax texts the repository holds', () => {
  // Each errored on the older reading too ("Unknown query type"); each still
  // errors, naming what is wrong, and runs no query.
  it.each([
    ['todo:TODO', "unknown filter key 'todo:'"],
    ['todo', t('query.text.freeText')],
    ['status = "done"', t('query.text.freeText')],
    ['(and [[page]] (task TODO))', t('query.text.freeText')],
    ['v2:!!!not-base64!!!', "unknown filter key 'v2:'"],
  ])('%j', async (text, message) => {
    expect(isLegacyQueryText(text)).toBe(false)
    const { sent, error } = await requests(resolveInlineQuery, text)
    expect(error).toContain(message)
    expect(sent).toEqual([])
  })
})
