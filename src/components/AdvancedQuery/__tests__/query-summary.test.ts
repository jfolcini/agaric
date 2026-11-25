import { describe, expect, it } from 'vitest'

import {
  builderLeafLabel,
  isEmptyQuery,
  querySummary,
} from '@/components/AdvancedQuery/query-summary'
import type { FilterPrimitive } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import type {
  AdvancedQueryControls,
  BuilderGroupNode,
  BuilderLeafNode,
} from '@/stores/advancedQuery'

const CONTROLS: AdvancedQueryControls = {
  fulltext: '',
  sort: [],
  groupBy: null,
  aggregates: [],
  view: 'list',
}

const TITLES: Record<string, string> = { TAG_A: 'work', TAG_B: 'home', PAGE_X: 'Roadmap' }
const resolveTitle = (id: string): string => TITLES[id] ?? `[[${id}]]`
const label = (primitive: FilterPrimitive): string => builderLeafLabel(primitive, t, resolveTitle)

function leaf(tag: string, negated = false): BuilderLeafNode {
  return { kind: 'leaf', id: 0, primitive: { type: 'Tag', tag }, negated }
}

function group(
  op: 'And' | 'Or',
  children: BuilderGroupNode['children'],
  negated = false,
): BuilderGroupNode {
  return { kind: 'group', id: 0, op, negated, children }
}

describe('builderLeafLabel', () => {
  it('names a tag and a link by the title their id resolves to', () => {
    expect(label({ type: 'Tag', tag: 'TAG_A' })).toBe('tag: work')
    expect(label({ type: 'LinksTo', target: 'PAGE_X' })).toBe('links to Roadmap')
  })

  it('shows a tag id that resolves to nothing as itself', () => {
    expect(label({ type: 'Tag', tag: 'GONE' })).toBe('tag: GONE')
  })
})

describe('querySummary', () => {
  it('says what an empty query matches', () => {
    expect(querySummary(group('And', []), CONTROLS, t, label)).toBe(
      t('advancedQuery.builder.emptyGroupAnd'),
    )
    expect(querySummary(group('Or', []), CONTROLS, t, label)).toBe(
      t('advancedQuery.builder.emptyGroupOr'),
    )
  })

  it('joins conditions by the group combinator, a nested group in parentheses', () => {
    const tree = group('And', [
      leaf('TAG_A'),
      group('Or', [leaf('TAG_B'), leaf('GONE', true)]),
      group('And', []),
    ])
    expect(querySummary(tree, CONTROLS, t, label)).toBe(
      'tag: work and (tag: home or NOT tag: GONE)',
    )
  })

  it('negates a root group in parentheses, and a lone condition without', () => {
    expect(
      querySummary(group('Or', [leaf('TAG_A'), leaf('TAG_B')], true), CONTROLS, t, label),
    ).toBe('NOT (tag: work or tag: home)')
    expect(querySummary(group('And', [leaf('TAG_A')], true), CONTROLS, t, label)).toBe(
      'NOT tag: work',
    )
  })

  it('adds the full-text term, the sort keys and the grouping', () => {
    const controls: AdvancedQueryControls = {
      ...CONTROLS,
      fulltext: '  standup ',
      sort: [
        { source: { type: 'Column', name: 'priority' }, desc: false },
        { source: { type: 'Relevance' }, desc: true },
      ],
      groupBy: { key: { type: 'DateBucket', source: 'due', unit: 'week' } },
    }
    expect(querySummary(group('And', [leaf('TAG_A')]), controls, t, label)).toBe(
      'tag: work · text “standup” · sorted by Priority ↑, Relevance ↓ · grouped by Due (Week)',
    )
  })

  it('names a grouping by its key, and a property grouping by the property', () => {
    const by = (key: NonNullable<AdvancedQueryControls['groupBy']>['key']): string =>
      querySummary(group('And', [leaf('TAG_A')]), { ...CONTROLS, groupBy: { key } }, t, label)
    expect(by({ type: 'BlockType' })).toBe('tag: work · grouped by Block type')
    expect(by({ type: 'Property', key: 'status' })).toBe('tag: work · grouped by status')
    expect(by({ type: 'Property', key: '' })).toBe('tag: work · grouped by Property')
  })
})

describe('isEmptyQuery', () => {
  it('holds only for no condition and every control at rest', () => {
    expect(isEmptyQuery(group('And', []), CONTROLS)).toBe(true)
    expect(isEmptyQuery(group('And', [leaf('TAG_A')]), CONTROLS)).toBe(false)
    expect(isEmptyQuery(group('Or', []), CONTROLS)).toBe(false)
    expect(isEmptyQuery(group('And', [], true), CONTROLS)).toBe(false)
    expect(isEmptyQuery(group('And', []), { ...CONTROLS, fulltext: 'x' })).toBe(false)
    const created = { source: { type: 'Column', name: 'created' }, desc: false } as const
    expect(isEmptyQuery(group('And', []), { ...CONTROLS, sort: [created] })).toBe(false)
    expect(isEmptyQuery(group('And', []), { ...CONTROLS, groupBy: { key: { type: 'Tag' } } })).toBe(
      false,
    )
    expect(
      isEmptyQuery(group('And', []), { ...CONTROLS, aggregates: [{ op: 'count', target: null }] }),
    ).toBe(false)
  })
})
