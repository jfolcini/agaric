import { describe, expect, it } from 'vitest'

import {
  holdsLogseqQuery,
  logseqTagNames,
  translateLogseqQueries,
  translateLogseqQuery,
} from '@/lib/logseq-query'
import { parse } from '@/lib/search-query'

const TAGS = new Set(['work', 'home', 'big idea'])

/** The expression of each supported form, and the query block text it becomes. */
const SUPPORTED: [form: string, expression: string, block: string][] = [
  ['task', '(task TODO DOING)', '{{query state:TODO state:DOING}}'],
  ['todo, the older name', '(todo DONE)', '{{query state:DONE}}'],
  [
    'task markers fold into the four states',
    '(task LATER NOW WAITING)',
    '{{query state:TODO state:DOING}}',
  ],
  ['task markers that fold together', '(task LATER TODO)', '{{query state:TODO}}'],
  ['task, any case', '(TASK canceled)', '{{query state:CANCELLED}}'],
  ['priority', '(priority A)', '{{query priority:1}}'],
  ['priority, several', '(priority A C)', '{{query priority:1 priority:3}}'],
  ['page reference of a tag', '[[work]]', '{{query tag:#work}}'],
  ['page reference, any case', '[[Work]]', '{{query tag:#Work}}'],
  ['page-tags', '(page-tags work)', '{{query tag:#work}}'],
  ['page-tags, a name with spaces', '(page-tags [[Big Idea]])', '{{query tag:#"Big Idea"}}'],
  ['property', '(property type book)', '{{query prop:type=book}}'],
  [
    'property, a value with spaces',
    '(property status "in progress")',
    '{{query prop:status="in progress"}}',
  ],
  ['property, a key alone', '(property owner)', '{{query prop:owner=}}'],
  ['page-property', '(page-property type book)', '{{query prop:type=book}}'],
  ['page', '(page inbox)', '{{query path:[i]nbox}}'],
  ['page, a title with spaces', '(page "Meeting Notes")', '{{query path:"[M]eeting Notes"}}'],
  ['and', '(and (task TODO) [[work]])', '{{query state:TODO tag:#work}}'],
  [
    'and of several kinds',
    '(and (task TODO) (priority A) (property type book))',
    '{{query state:TODO priority:1 prop:type=book}}',
  ],
  [
    'and, nested',
    '(and (task TODO) (and [[work]] [[home]]))',
    '{{query state:TODO tag:#work tag:#home}}',
  ],
  ['or', '(or [[work]] [[home]])', '{{query tag:#work OR tag:#home}}'],
  [
    'or inside and',
    '(and (task TODO) (or [[work]] [[home]]))',
    '{{query state:TODO (tag:#work OR tag:#home)}}',
  ],
  [
    'and inside or',
    '(or (and (task TODO) [[work]]) [[home]])',
    '{{query state:TODO tag:#work OR tag:#home}}',
  ],
  ['or of two task clauses', '(or (task TODO) (task DONE))', '{{query state:TODO OR state:DONE}}'],
  ['not of a task', '(not (task DONE CANCELED))', '{{query not-state:DONE not-state:CANCELLED}}'],
  [
    'not of a priority',
    '(and (task TODO) (not (priority C)))',
    '{{query state:TODO not-priority:3}}',
  ],
  ['not of a page', '(not (page inbox))', '{{query not-path:[i]nbox}}'],
  ['not of a property', '(not (property archived true))', '{{query not-prop:archived=true}}'],
  [
    'not of an or, by De Morgan',
    '(not (or (task DONE) (task CANCELED)))',
    '{{query not-state:DONE not-state:CANCELLED}}',
  ],
  [
    'not of an and, by De Morgan',
    '(not (and (task DONE) (priority A)))',
    '{{query not-state:DONE OR not-priority:1}}',
  ],
  ['a phrase', '"meeting notes"', '{{query "meeting notes"}}'],
  ['a phrase beside a filter', '(and "meeting" (task TODO))', '{{query state:TODO "meeting"}}'],
]

/** An expression no filter reads, and why. */
const UNSUPPORTED: [why: string, expression: string][] = [
  [
    'between names journal days, which no filter reads',
    '(between [[Oct 1st, 2026]] [[Oct 7th, 2026]])',
  ],
  ['between, relative', '(between -7d today)'],
  ['a page reference of a page that is no tag', '[[Project]]'],
  ['a tag cannot be negated', '(not [[work]])'],
  ['a tag cannot be negated, inside an and', '(and (task TODO) (not (page-tags work)))'],
  ['a phrase cannot be negated', '(not "draft")'],
  ['page-tags of several', '(page-tags work home)'],
  ['a tag name the search syntax cannot spell', '(page-tags [[" [ ]])'],
  ['two task clauses of one and would OR', '(and (task TODO) (task DOING))'],
  ['two priority clauses of one and would OR', '(and (priority A) (priority B))'],
  ['two pages of one and would OR', '(and (page a) (page b))'],
  ['a task clause beside an or that holds one', '(and (task TODO) (or [[work]] (task DONE)))'],
  ['a phrase inside an or', '(or "meeting" [[work]])'],
  ['a priority beyond C', '(priority D)'],
  ['a priority that is no letter', '(priority 1)'],
  ['a task marker of no state', '(task SOMEDAY)'],
  ['a task clause of no marker', '(task)'],
  ['a property the backend keeps in a column', '(property priority A)'],
  ['a property valued by a page', '(property type [[book]])'],
  ['a property of two values', '(property type book film)'],
  ['a page title holding a glob character', '(page "what?")'],
  ['a page title holding a comma', '(page "a,b")'],
  ['namespace', '(namespace projects)'],
  ['sort-by', '(sort-by created-at)'],
  ['sample', '(sample 5)'],
  ['an empty and', '(and)'],
  ['an unclosed list', '(and (task TODO)'],
  ['text after the expression', '(task TODO) [[work]]'],
  ['a bare word', 'work'],
]

describe('translateLogseqQuery', () => {
  it.each(SUPPORTED)('translates %s', (_form, expression, block) => {
    expect(translateLogseqQuery(expression, TAGS)).toBe(block)
  })

  it.each(SUPPORTED)(
    'writes text of the search syntax that reads back whole: %s',
    (_form, expression) => {
      const block = translateLogseqQuery(expression, TAGS) as string
      const text = block.slice('{{query '.length, -'}}'.length)
      const ast = parse(text)
      expect(ast.filters.filter((token) => token.kind === 'invalid')).toEqual([])
      expect(ast.filters.length + (ast.freeText === '' ? 0 : 1)).toBeGreaterThan(0)
    },
  )

  it.each(UNSUPPORTED)('has no equivalent: %s', (_why, expression) => {
    expect(translateLogseqQuery(expression, TAGS)).toBeNull()
  })
})

describe('translateLogseqQueries', () => {
  const run = (content: string) => translateLogseqQueries(content, TAGS)

  it('rewrites the bullet of a translatable macro and counts nothing', () => {
    expect(run('- {{query (task TODO)}}\n- plain')).toEqual({
      content: '- {{query state:TODO}}\n- plain',
      kept: 0,
    })
  })

  it('keeps an untranslatable macro in a marked code block under its bullet, and counts it', () => {
    const macro = '{{query (between -7d today)}}'
    expect(run(`- before\n  - ${macro}\n  - after`)).toEqual({
      content: `- before\n  - \`\`\`logseq-query\n    Logseq query, not translated:\n    ${macro}\n    \`\`\`\n  - after`,
      kept: 1,
    })
  })

  it('counts each kept macro of a page', () => {
    const { content, kept } = run(
      '- {{query (sort-by x)}}\n- {{query (task TODO)}}\n- {{query (sample 3)}}',
    )
    expect(kept).toBe(2)
    expect(
      content.split('\n').filter((line) => line.includes('{{query state:TODO}}')),
    ).toHaveLength(1)
  })

  it('leaves a macro in a code fence, a macro within other text, and a query already in the search syntax', () => {
    const content = [
      '- ```',
      '  {{query (task TODO)}}',
      '  ```',
      '- see {{query (task TODO)}} here',
      '- {{query tag:#work state:TODO}}',
      '- {{query v2:abc}}',
    ].join('\n')
    expect(run(content)).toEqual({ content, kept: 0 })
  })

  it('leaves an advanced query, which is no macro, as it is', () => {
    const content = '- #+BEGIN_QUERY\n  {:query [:find ?b]}\n  #+END_QUERY'
    expect(run(content)).toEqual({ content, kept: 0 })
  })

  it('translates a macro that is a paragraph of its own', () => {
    expect(run('{{query (priority A)}}').content).toBe('{{query priority:1}}')
  })
})

describe('logseqTagNames', () => {
  it('reads the names a page makes tags: inline, multi-word and in a `tags::` line', () => {
    const names = logseqTagNames(
      [
        'tags:: Project, [[Big Idea]], #q3',
        '- a #Work b',
        '- #[[Home Life]] c',
        '- issue #42',
        '- x#nope',
      ].join('\n'),
    )
    expect([...new Set(names)].toSorted()).toEqual([
      'big idea',
      'home life',
      'project',
      'q3',
      'work',
    ])
  })
})

describe('holdsLogseqQuery', () => {
  it('sees a macro, any case', () => {
    expect(holdsLogseqQuery('- {{Query (task TODO)}}')).toBe(true)
    expect(holdsLogseqQuery('- {{embed ((x))}}')).toBe(false)
  })
})
