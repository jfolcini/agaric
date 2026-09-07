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
 *   - Group-by → `AdvancedQueryRequest.groupBy` (None default, one of the
 *     single-dimension `GroupKey`s, a `Property` key, or a `DateBucket`
 *     source × unit pair — #4553 Phase 2).
 *   - Aggregates → `AdvancedQueryRequest.aggregates` (op + optional column target).
 *
 * Controls are always-visible inline form rows (not behind a popover) so they
 * stay keyboard-reachable and screen-reader-labelled; every control owns an
 * explicit `<Label htmlFor>`. State lives in the per-space advanced-query store;
 * this component is a controlled view over that working set.
 */

import { X } from 'lucide-react'
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
  DateBucketUnit,
  DateField,
  GroupKey,
  GroupSpec,
  SortColumn,
  SortKey,
  SortSource,
} from '@/lib/bindings'

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

/** The `DateField` sources offered for a `DateBucket` grouping, in display order. */
const DATE_FIELDS: readonly DateField[] = ['due', 'scheduled', 'created', 'lastEdited']

/** The `DateBucketUnit`s offered for a `DateBucket` grouping, in display order. */
const DATE_UNITS: readonly DateBucketUnit[] = ['day', 'week', 'month']

/** The `DateBucket` grouping seeded when the option is picked (the two Selects refine it). */
const DEFAULT_DATE_BUCKET: GroupKey = { type: 'DateBucket', source: 'due', unit: 'week' }

/** The aggregate operators offered in the op picker, in display order. */
const AGG_OPS: readonly AggOp[] = ['count', 'sum', 'avg', 'min', 'max']

/** The aggregate column targets offered (`none` = `COUNT(*)` / no target). */
const AGG_COLUMNS: readonly AggregateColumn[] = ['priority', 'position']

/** Sentinel option value for "no group-by / no target" (Select needs a string). */
const NONE = '__none__'
/**
 * #4553 — sentinel value encoding the `Property` variant in the aggregate
 * target Select and the group-by Select (mirrors `RELEVANCE` below for
 * `SortSource`). Selecting it reveals a property-key text input; the emitted
 * target / group key is `{ type: 'Property', key }` once a key is typed.
 */
const PROPERTY = '__property__'
/** Sentinel group-by value encoding the `DateBucket` variant (source + unit Selects). */
const DATE_BUCKET = '__date__'
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
  const groupKey = groupBy?.key

  // Local mirror of the full-text input so typing is responsive while the
  // committed value is debounced into the store.
  const [fulltextDraft, setFulltextDraft] = useState(fulltext)
  // Re-sync the local mirror when the committed value changes from outside
  // (e.g. a space switch resets `fulltext` to the new space's value) so the
  // input never shows a stale term while the query sends a different one.
  // While typing this is a no-op: the prop only changes once the debounced
  // commit lands, at which point it already equals the draft.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- resyncs the debounced input mirror when the committed `fulltext` prop changes externally (space switch); deriving it would discard in-flight typing; see #4407
    setFulltextDraft(fulltext)
  }, [fulltext])
  const debounced = useDebouncedCallback(onFulltextChange, 300)
  const hasFulltext = fulltext.trim() !== ''

  // #2216 — the `Relevance` sort source is only valid with a full-text term
  // (the engine rejects `Relevance` without `fulltext`) and its SelectItem is
  // gated on `hasFulltext`. When the user empties the full-text input, any
  // existing `{type:'Relevance'}` sort key would otherwise leave the Select
  // blank (its option is gone) AND send an engine-rejected request. Reconcile
  // the committed sort array down to the same safe default the "add sort key"
  // action uses (`Column`/`created`) so the control stays in-vocabulary and the
  // query stays valid. Deriving the reconciliation here (over inline render
  // side-effects) mirrors the existing `fulltextDraft` sync-effect pattern.
  useEffect(() => {
    if (hasFulltext) return
    if (!sort.some((key) => key.source.type === 'Relevance')) return
    onSortChange(
      sort.map((key) =>
        key.source.type === 'Relevance'
          ? { ...key, source: { type: 'Column', name: 'created' } }
          : key,
      ),
    )
  }, [hasFulltext, sort, onSortChange])

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
    const key: GroupKey =
      value === PROPERTY
        ? { type: 'Property', key: '' }
        : value === DATE_BUCKET
          ? DEFAULT_DATE_BUCKET
          : { type: value as SimpleGroupKeyType }
    onGroupByChange({ key })
  }
  const setGroupPropertyKey = (key: string): void => {
    onGroupByChange({ key: { type: 'Property', key } })
  }
  const setGroupDate = (patch: { source?: DateField; unit?: DateBucketUnit }): void => {
    if (groupKey?.type !== 'DateBucket') return
    onGroupByChange({ key: { ...groupKey, ...patch } })
  }
  const groupValue: string =
    groupKey == null
      ? NONE
      : groupKey.type === 'Property'
        ? PROPERTY
        : groupKey.type === 'DateBucket'
          ? DATE_BUCKET
          : groupKey.type

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
    // #4553 Phase 1 — selecting "Property" seeds an empty key (the key input
    // below fills it in); the key itself is edited via `setAggTargetKey`, not
    // by re-selecting this dropdown.
    const target: AggregateSpec['target'] =
      value === NONE
        ? null
        : value === PROPERTY
          ? { type: 'Property', key: '' }
          : { type: 'Column', name: value as AggregateColumn }
    onAggregatesChange(aggregates.map((a, i) => (i === index ? { ...a, target } : a)))
  }
  // #4553 Phase 1 — the property-key input's own onChange, kept separate from
  // `setAggTarget` (which only fires on a dropdown selection): typing in the
  // key box must not re-select the dropdown option, just update `key`.
  const setAggTargetKey = (index: number, key: string): void => {
    onAggregatesChange(
      aggregates.map((a, i) =>
        i === index && a.target?.type === 'Property'
          ? { ...a, target: { type: 'Property', key } }
          : a,
      ),
    )
  }
  const aggTargetValue = (spec: AggregateSpec): string =>
    spec.target != null ? (spec.target.type === 'Column' ? spec.target.name : PROPERTY) : NONE

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
                  <X className="h-3 w-3" aria-hidden="true" />
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
            {GROUP_KEYS.map((key) => (
              <SelectItem key={key} value={key}>
                {t(`advancedQuery.group.${key.charAt(0).toLowerCase()}${key.slice(1)}`)}
              </SelectItem>
            ))}
            <SelectItem value={PROPERTY}>{t('advancedQuery.group.property')}</SelectItem>
            <SelectItem value={DATE_BUCKET}>{t('advancedQuery.group.dateBucket')}</SelectItem>
          </SelectContent>
        </Select>
        {groupKey?.type === 'Property' && (
          <Input
            className="h-8 w-40 text-xs"
            value={groupKey.key}
            onChange={(e) => setGroupPropertyKey(e.target.value)}
            placeholder={t('advancedQuery.group.propertyKeyPlaceholder')}
            aria-label={t('advancedQuery.group.propertyKeyLabel')}
            data-testid="advanced-query-group-property-key"
          />
        )}
        {groupKey?.type === 'DateBucket' && (
          <div className="flex items-center gap-2" data-testid="advanced-query-group-date">
            <Select
              value={groupKey.source}
              onValueChange={(v) => setGroupDate({ source: v as DateField })}
            >
              <SelectTrigger size="sm" aria-label={t('advancedQuery.group.dateSourceLabel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATE_FIELDS.map((field) => (
                  <SelectItem key={field} value={field}>
                    {t(`advancedQuery.group.dateSource.${field}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={groupKey.unit}
              onValueChange={(v) => setGroupDate({ unit: v as DateBucketUnit })}
            >
              <SelectTrigger size="sm" aria-label={t('advancedQuery.group.dateUnitLabel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATE_UNITS.map((unit) => (
                  <SelectItem key={unit} value={unit}>
                    {t(`advancedQuery.group.dateUnit.${unit}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
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
                  {/* #4553 Phase 1 — `AggregateTarget::Property`: the only
                      summable target anyone actually wants (`priority`/`position`
                      are closed, fixed-purpose columns). Paired with the
                      `agg_target_expr` engine fix so `sum`/`avg` over a
                      `number`-declared property reads `value_num`, not just
                      `value_text`. */}
                  <SelectItem value={PROPERTY}>
                    {t('advancedQuery.aggregate.target.property')}
                  </SelectItem>
                </SelectContent>
              </Select>
              {spec.target?.type === 'Property' && (
                <Input
                  className="h-8 w-28 text-xs"
                  value={spec.target.key}
                  onChange={(e) => setAggTargetKey(index, e.target.value)}
                  placeholder={t('advancedQuery.aggregate.propertyKeyPlaceholder')}
                  aria-label={t('advancedQuery.aggregate.propertyKeyLabel')}
                />
              )}
              <Button
                variant="ghost"
                size="xs"
                onClick={() => removeAggregate(index)}
                aria-label={t('advancedQuery.aggregate.remove')}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </fieldset>
  )
}
