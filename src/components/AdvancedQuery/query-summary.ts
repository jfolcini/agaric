/**
 * The advanced query as one line of text, for the summary the folded query
 * form shows above the results (#7040).
 */

import type { TFunction } from 'i18next'

import { pageFilterSummary } from '@/components/PageBrowser/PageBrowserFilterRow'
import type { FilterPrimitive, GroupKey, SortKey } from '@/lib/bindings'
import type { AdvancedQueryControls, BuilderGroupNode, BuilderNode } from '@/stores/advancedQuery'

/**
 * A filter leaf's label, as its chip shows it. Tag and link ids show as the
 * title they resolve to; a tag id that resolves to nothing shows as itself
 * rather than the resolver's `[[…]]` placeholder.
 */
export function builderLeafLabel(
  primitive: FilterPrimitive,
  t: TFunction,
  resolveTitle: (id: string) => string,
): string {
  return pageFilterSummary(
    primitive,
    t,
    (id) => {
      const title = resolveTitle(id)
      return title.startsWith('[[') ? id : title
    },
    resolveTitle,
  )
}

/** Whether the query is the untouched default: no condition and every control at rest. */
export function isEmptyQuery(builder: BuilderGroupNode, controls: AdvancedQueryControls): boolean {
  return (
    builder.children.length === 0 &&
    builder.op === 'And' &&
    !builder.negated &&
    controls.fulltext.trim() === '' &&
    controls.sort.length === 0 &&
    controls.groupBy == null &&
    controls.aggregates.length === 0
  )
}

/** The filter tree as text: `and` / `or` between conditions, a nested group in parentheses. */
function filterText(
  root: BuilderGroupNode,
  t: TFunction,
  leafLabel: (primitive: FilterPrimitive) => string,
): string {
  const not = (term: string): string => t('advancedQuery.summary.not', { term })
  const partsOf = (group: BuilderGroupNode): string[] =>
    group.children.flatMap((child) => {
      const text = childText(child)
      return text === null ? [] : [text]
    })
  const groupBody = (group: BuilderGroupNode, parts: string[], nested: boolean): string => {
    const joined =
      parts.length === 0
        ? t(
            group.op === 'And'
              ? 'advancedQuery.builder.emptyGroupAnd'
              : 'advancedQuery.builder.emptyGroupOr',
          )
        : parts.join(
            ` ${t(group.op === 'And' ? 'advancedQuery.summary.and' : 'advancedQuery.summary.or')} `,
          )
    const bracketed = (nested || group.negated) && parts.length > 1 ? `(${joined})` : joined
    return group.negated ? not(bracketed) : bracketed
  }
  // A nested group with no condition constrains nothing worth a word; the
  // root's says what an empty query matches.
  function childText(node: BuilderNode): string | null {
    if (node.kind === 'leaf') {
      const label = leafLabel(node.primitive)
      return node.negated ? not(label) : label
    }
    const parts = partsOf(node)
    return parts.length === 0 ? null : groupBody(node, parts, true)
  }
  return groupBody(root, partsOf(root), false)
}

function sortText(key: SortKey, t: TFunction): string {
  const name =
    key.source.type === 'Relevance'
      ? t('advancedQuery.sort.relevance')
      : t(`advancedQuery.sort.column.${key.source.name}`)
  return `${name} ${key.desc ? '↓' : '↑'}`
}

function groupText(key: GroupKey, t: TFunction): string {
  if (key.type === 'Property') return key.key === '' ? t('advancedQuery.group.property') : key.key
  if (key.type === 'DateBucket') {
    return `${t(`advancedQuery.group.dateSource.${key.source}`)} (${t(`advancedQuery.group.dateUnit.${key.unit}`)})`
  }
  return t(`advancedQuery.group.${key.type.charAt(0).toLowerCase()}${key.type.slice(1)}`)
}

/** The query's conditions, full-text term, sort and grouping, joined by ` · `. */
export function querySummary(
  builder: BuilderGroupNode,
  controls: AdvancedQueryControls,
  t: TFunction,
  leafLabel: (primitive: FilterPrimitive) => string,
): string {
  const parts = [filterText(builder, t, leafLabel)]
  const text = controls.fulltext.trim()
  if (text !== '') parts.push(t('advancedQuery.summary.text', { text }))
  if (controls.sort.length > 0) {
    const keys = controls.sort.map((key) => sortText(key, t)).join(', ')
    parts.push(t('advancedQuery.summary.sort', { keys }))
  }
  if (controls.groupBy != null) {
    parts.push(t('advancedQuery.summary.group', { key: groupText(controls.groupBy.key, t) }))
  }
  return parts.join(' · ')
}
