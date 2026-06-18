/**
 * QueryControlsBar — the #1280 D2 advanced-query controls.
 *
 * Sits above the flat chip-row builder and exposes the engine capabilities that
 * were already shipped but unreachable from the UI:
 *
 *   - Full-text term (debounced) → `AdvancedQueryRequest.fulltext`.
 *   - Multi-key sort → `AdvancedQueryRequest.sort` (each `SortKey` is a labelled
 *     `SortColumn`, or `Relevance` — only offered when a full-text term is set,
 *     since the engine rejects `Relevance` without `fulltext`).
 *   - Group-by → `AdvancedQueryRequest.groupBy` (None default, or one of the
 *     single-dimension `GroupKey`s).
 *   - Aggregates → `AdvancedQueryRequest.aggregates` (op + optional column target).
 *
 * Controls are always-visible inline form rows (not behind a popover) so they
 * stay keyboard-reachable and screen-reader-labelled; every control owns an
 * explicit `<Label htmlFor>`. State lives in the per-space advanced-query store;
 * this component is a controlled view over that working set.
 */

import type React from 'react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import type {
  AggOp,
  AggregateColumn,
  AggregateSpec,
  GroupKey,
  GroupSpec,
  SortColumn,
  SortKey,
  SortSource,
} from '@/lib/tauri'

/** The labelled, closed set of `SortColumn`s offered in the sort source picker. */
const SORT_COLUMNS: readonly SortColumn[] = [
  'created',
  'lastEdited',
  'position',
  'priority',
  'title',
]

/** The single-dimension `GroupKey`s offered in the group-by picker (None = no grouping). */
const GROUP_KEYS = ['Tag', 'Page', 'State', 'BlockType', 'Priority'] as const
type SimpleGroupKeyType = (typeof GROUP_KEYS)[number]

/** The aggregate operators offered in the op picker, in display order. */
const AGG_OPS: readonly AggOp[] = ['count', 'sum', 'avg', 'min', 'max']

/** The aggregate column targets offered (`none` = `COUNT(*)` / no target). */
const AGG_COLUMNS: readonly AggregateColumn[] = ['priority', 'position']

/** Sentinel option value for "no group-by / no target" (Select needs a string). */
const NONE = '__none__'
/** Sentinel `SortSource` value encoding the Relevance variant in the Select. */
const RELEVANCE = '__relevance__'

export interface QueryControlsBarProps {
  /** Current full-text term (controlled). */
  fulltext: string
  /** Set the full-text term (already debounced upstream is NOT required; this debounces). */
  onFulltextChange: (value: string) => void
  /** Current ordered sort keys (controlled). */
  sort: SortKey[]
  onSortChange: (sort: SortKey[]) => void
  /** Current grouping directive (controlled). */
  groupBy: GroupSpec | null
  onGroupByChange: (groupBy: GroupSpec | null) => void
  /** Current aggregate specs (controlled). */
  aggregates: AggregateSpec[]
  onAggregatesChange: (aggregates: AggregateSpec[]) => void
}

/** Serialise a `SortSource` to a stable Select option value. */
function sortSourceValue(source: SortSource): string {
  return source.type === 'Relevance' ? RELEVANCE : source.name
}

export function QueryControlsBar({
  fulltext,
  onFulltextChange,
  sort,
  onSortChange,
  groupBy,
  onGroupByChange,
  aggregates,
  onAggregatesChange,
}: QueryControlsBarProps): React.ReactElement {
  const { t } = useTranslation()
  const fulltextId = useId()
  const groupId = useId()

  // Local mirror of the full-text input so typing is responsive while the
  // committed value is debounced into the store.
  const [fulltextDraft, setFulltextDraft] = useState(fulltext)
  // Re-sync the local mirror when the committed value changes from outside
  // (e.g. a space switch resets `fulltext` to the new space's value) so the
  // input never shows a stale term while the query sends a different one.
  // While typing this is a no-op: the prop only changes once the debounced
  // commit lands, at which point it already equals the draft.
  useEffect(() => {
    setFulltextDraft(fulltext)
  }, [fulltext])
  const debounced = useDebouncedCallback(onFulltextChange, 300)
  const hasFulltext = fulltext.trim() !== ''

  const handleFulltext = (value: string): void => {
    setFulltextDraft(value)
    debounced.schedule(value)
  }

  // --- Sort -----------------------------------------------------------------
  const addSortKey = (): void => {
    onSortChange([...sort, { source: { type: 'Column', name: 'created' }, desc: false }])
  }
  const removeSortKey = (index: number): void => {
    onSortChange(sort.filter((_, i) => i !== index))
  }
  const setSortSource = (index: number, value: string): void => {
    const source: SortSource =
      value === RELEVANCE ? { type: 'Relevance' } : { type: 'Column', name: value as SortColumn }
    onSortChange(sort.map((k, i) => (i === index ? { ...k, source } : k)))
  }
  const setSortDir = (index: number, value: string): void => {
    onSortChange(sort.map((k, i) => (i === index ? { ...k, desc: value === 'desc' } : k)))
  }

  // --- Group-by -------------------------------------------------------------
  const handleGroupBy = (value: string): void => {
    if (value === NONE) {
      onGroupByChange(null)
      return
    }
    const key: GroupKey = { type: value as SimpleGroupKeyType }
    onGroupByChange({ key })
  }
  const groupValue: string =
    groupBy == null
      ? NONE
      : groupBy.key.type === 'Property' || groupBy.key.type === 'DateBucket'
        ? // Property/DateBucket grouping isn't offered in this control yet; fall
          // back to None so the Select stays in a valid, in-vocabulary state.
          NONE
        : groupBy.key.type

  // --- Aggregates -----------------------------------------------------------
  const addAggregate = (): void => {
    onAggregatesChange([...aggregates, { op: 'count', target: null }])
  }
  const removeAggregate = (index: number): void => {
    onAggregatesChange(aggregates.filter((_, i) => i !== index))
  }
  const setAggOp = (index: number, value: string): void => {
    onAggregatesChange(aggregates.map((a, i) => (i === index ? { ...a, op: value as AggOp } : a)))
  }
  const setAggTarget = (index: number, value: string): void => {
    const target =
      value === NONE ? null : { type: 'Column' as const, name: value as AggregateColumn }
    onAggregatesChange(aggregates.map((a, i) => (i === index ? { ...a, target } : a)))
  }
  const aggTargetValue = (spec: AggregateSpec): string =>
    spec.target != null && spec.target.type === 'Column' ? spec.target.name : NONE

  return (
    <fieldset className="advanced-query-controls flex flex-col gap-3 border-0 p-0 m-0">
      <legend className="sr-only">{t('advancedQuery.controlsLabel')}</legend>
      {/* Full-text */}
      <div className="flex flex-col gap-1">
        <Label htmlFor={fulltextId} size="xs">
          {t('advancedQuery.fulltext.label')}
        </Label>
        <Input
          id={fulltextId}
          type="search"
          value={fulltextDraft}
          placeholder={t('advancedQuery.fulltext.placeholder')}
          onChange={(e) => handleFulltext(e.target.value)}
          data-testid="advanced-query-fulltext"
        />
      </div>

      {/* Sort */}
      <div className="flex flex-col gap-1" data-testid="advanced-query-sort">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground" id={`${fulltextId}-sort`}>
            {t('advancedQuery.sort.label')}
          </span>
          <Button variant="outline" size="xs" onClick={addSortKey}>
            {t('advancedQuery.sort.add')}
          </Button>
        </div>
        <ul aria-labelledby={`${fulltextId}-sort`} className="flex flex-col gap-1">
          {sort.map((key, index) => {
            const sourceVal = sortSourceValue(key.source)
            return (
              <li
                // oxlint-disable-next-line react/no-array-index-key -- engine-typed `SortKey[]` (no id, can hold duplicate source/dir pairs); rows are positional and the whole array is replaced on edit, so index is the stable identity here
                key={index}
                className="flex items-center gap-2"
                data-testid="advanced-query-sort-row"
              >
                <Select value={sourceVal} onValueChange={(v) => setSortSource(index, v)}>
                  <SelectTrigger size="sm" aria-label={t('advancedQuery.sort.sourceLabel')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SORT_COLUMNS.map((col) => (
                      <SelectItem key={col} value={col}>
                        {t(`advancedQuery.sort.column.${col}`)}
                      </SelectItem>
                    ))}
                    {hasFulltext && (
                      <SelectItem value={RELEVANCE}>{t('advancedQuery.sort.relevance')}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <Select
                  value={key.desc ? 'desc' : 'asc'}
                  onValueChange={(v) => setSortDir(index, v)}
                >
                  <SelectTrigger size="sm" aria-label={t('advancedQuery.sort.dirLabel')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="asc">{t('advancedQuery.sort.asc')}</SelectItem>
                    <SelectItem value="desc">{t('advancedQuery.sort.desc')}</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => removeSortKey(index)}
                  aria-label={t('advancedQuery.sort.remove')}
                >
                  ✕
                </Button>
              </li>
            )
          })}
        </ul>
      </div>

      {/* Group-by */}
      <div className="flex flex-col gap-1">
        <Label htmlFor={groupId} size="xs">
          {t('advancedQuery.group.label')}
        </Label>
        <Select value={groupValue} onValueChange={handleGroupBy}>
          <SelectTrigger id={groupId} size="sm" data-testid="advanced-query-group">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('advancedQuery.group.none')}</SelectItem>
            <SelectItem value="Tag">{t('advancedQuery.group.tag')}</SelectItem>
            <SelectItem value="Page">{t('advancedQuery.group.page')}</SelectItem>
            <SelectItem value="State">{t('advancedQuery.group.state')}</SelectItem>
            <SelectItem value="BlockType">{t('advancedQuery.group.blockType')}</SelectItem>
            <SelectItem value="Priority">{t('advancedQuery.group.priority')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Aggregates */}
      <div className="flex flex-col gap-1" data-testid="advanced-query-aggregates">
        <div className="flex items-center justify-between">
          <span
            className="text-xs font-medium text-muted-foreground"
            id={`${fulltextId}-aggregates`}
          >
            {t('advancedQuery.aggregate.label')}
          </span>
          <Button variant="outline" size="xs" onClick={addAggregate}>
            {t('advancedQuery.aggregate.add')}
          </Button>
        </div>
        <ul aria-labelledby={`${fulltextId}-aggregates`} className="flex flex-col gap-1">
          {aggregates.map((spec, index) => (
            <li
              // oxlint-disable-next-line react/no-array-index-key -- engine-typed `AggregateSpec[]` (no id, can hold duplicate op/target pairs); rows are positional and the whole array is replaced on edit, so index is the stable identity here
              key={index}
              className="flex items-center gap-2"
              data-testid="advanced-query-aggregate-row"
            >
              <Select value={spec.op} onValueChange={(v) => setAggOp(index, v)}>
                <SelectTrigger size="sm" aria-label={t('advancedQuery.aggregate.opLabel')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AGG_OPS.map((op) => (
                    <SelectItem key={op} value={op}>
                      {t(`advancedQuery.aggregate.op.${op}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={aggTargetValue(spec)} onValueChange={(v) => setAggTarget(index, v)}>
                <SelectTrigger size="sm" aria-label={t('advancedQuery.aggregate.targetLabel')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('advancedQuery.aggregate.target.none')}</SelectItem>
                  {AGG_COLUMNS.map((col) => (
                    <SelectItem key={col} value={col}>
                      {t(`advancedQuery.aggregate.target.${col}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => removeAggregate(index)}
                aria-label={t('advancedQuery.aggregate.remove')}
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </fieldset>
  )
}
