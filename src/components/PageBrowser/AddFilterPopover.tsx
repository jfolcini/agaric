/**
 * AddFilterPopover — PEND-58 Phase 4. The discovery affordance for the
 * Pages-view compound-filter chip-row.
 *
 * Modelled on `GraphFilterBar`'s Add-Filter popover: a trigger button
 * (`aria-haspopup="dialog"`) opens a categorised menu. Boolean Pages-only
 * primitives (`Orphan` / `Stub` / `HasNoInboundLinks`) add immediately on
 * click; value-bearing primitives (`Tag` / `PathGlob` / `HasProperty` /
 * `LastEdited` / `Priority`) open an inline editor inside the same popover.
 *
 * Only the Pages-surface allow-list is offered — the Search-only primitives
 * (`Regex` / `CaseSensitive` / `WholeWord` / `Snippet`) and the implicit
 * `Space` filter are never shown.
 *
 * Focus restore on close mirrors `BacklinkFilterBuilder` — the trigger ref
 * is re-focused when the popover dismisses so keyboard users land back on
 * the affordance they opened.
 */

import { Plus } from 'lucide-react'
import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { usePriorityLevels } from '@/hooks/usePriorityLevels'
import type { DatePredicate, PropertyPredicate } from '@/lib/bindings'
import type { FilterPrimitive } from '@/lib/tauri'

export interface AddFilterPopoverProps {
  /** Emits the chosen primitive. The parent appends it to its chip set. */
  onAddFilter: (filter: FilterPrimitive) => void
  /** Soft-cap warning copy shown when the chip count is already high. */
  warnManyFilters?: boolean
  /**
   * #1280 D1 — when `true`, the Pages-only facet group (Orphan / Stub / No
   * inbound links) is hidden, leaving only the SHARED vocabulary
   * (tag / path / has-property / last-edited / priority). The advanced-query
   * engine rejects the Pages-only leaves, so the Advanced Query surface passes
   * this to restrict the offered keys to the supported set.
   */
  hidePagesFacets?: boolean
  /**
   * #1280 D2 — when `true`, the advanced-only facet group (State / Block type /
   * Due date / Scheduled / Created) is offered in addition to the shared
   * vocabulary. These compile to real SQL in the advanced-query engine + the
   * PagesProjection but are deliberately gated OFF on the Pages browser, which
   * passes neither this nor `hidePagesFacets`. The Advanced Query surface passes
   * `showAdvancedFacets` (and keeps `hidePagesFacets`).
   */
  showAdvancedFacets?: boolean
}

/** Which inline value-editor is open inside the popover (null = category menu). */
type EditorKey =
  | 'tag'
  | 'path'
  | 'property'
  | 'state'
  | 'blockType'
  | 'due'
  | 'scheduled'
  | 'created'
  | null

/** D24 — the four property predicate kinds the popover can emit. */
type PropertyOpKind = PropertyPredicate['type']

/** Predicate kinds that compare a value (the value input is required for these). */
const VALUE_BEARING_OPS: ReadonlySet<PropertyOpKind> = new Set<PropertyOpKind>(['Eq', 'Ne'])

/**
 * #1280 D2 — the todo-state values offered by the State editor. Mirrors the
 * canonical states the agenda/backlink surfaces emit (TODO/DOING/DONE/CANCELLED;
 * see `agenda-sort.ts`'s `stateRank`). These match `b.todo_state` byte-for-byte
 * so the projection's `IN (...)` membership test resolves.
 */
const TODO_STATE_VALUES: ReadonlyArray<string> = ['TODO', 'DOING', 'DONE', 'CANCELLED']

/**
 * #1280 D2 — the block-type values offered by the Block type editor. Mirrors the
 * `b.block_type` vocabulary (content/page/tag/todo; see the backlink
 * `TypeFilterForm`). `todo` is included so the advanced query can filter the
 * task rows specifically.
 */
const BLOCK_TYPE_VALUES: ReadonlyArray<string> = ['content', 'page', 'tag', 'todo']

/** #1280 D2 — the date predicate operators the Due/Scheduled editors offer, in display order. */
type DateOpKind = DatePredicate['type']
const DATE_OPS: ReadonlyArray<{ value: DateOpKind; labelKey: string }> = [
  { value: 'IsNull', labelKey: 'pageBrowser.filter.dateOpIsNull' },
  { value: 'Before', labelKey: 'pageBrowser.filter.dateOpBefore' },
  { value: 'After', labelKey: 'pageBrowser.filter.dateOpAfter' },
  { value: 'OnOrBefore', labelKey: 'pageBrowser.filter.dateOpOnOrBefore' },
  { value: 'OnOrAfter', labelKey: 'pageBrowser.filter.dateOpOnOrAfter' },
  { value: 'On', labelKey: 'pageBrowser.filter.dateOpOn' },
  { value: 'Between', labelKey: 'pageBrowser.filter.dateOpBetween' },
]

const LAST_EDITED_BUCKETS: ReadonlyArray<{ key: string; spec: FilterPrimitive }> = [
  { key: 'today', spec: { type: 'LastEdited', spec: { type: 'Rolling', days: 1 } } },
  { key: 'thisWeek', spec: { type: 'LastEdited', spec: { type: 'Rolling', days: 7 } } },
  { key: 'thisMonth', spec: { type: 'LastEdited', spec: { type: 'Rolling', days: 30 } } },
  { key: 'older', spec: { type: 'LastEdited', spec: { type: 'OlderThan', days: 30 } } },
]

export function AddFilterPopover({
  onAddFilter,
  warnManyFilters,
  hidePagesFacets,
  showAdvancedFacets,
}: AddFilterPopoverProps): React.ReactElement {
  const { t } = useTranslation()
  // E1 — the offered Priority values must mirror the user-configured priority
  // levels (default `1/2/3`), NOT a hardcoded `A/B/C`. The backend matches
  // `b.priority = ?` against the stored level strings, so an `A/B/C` popover
  // returned zero pages out of the box. Subscribe like `GraphFilterBar` so the
  // list reflects live edits in the Properties tab without a reload.
  const priorityLevels = usePriorityLevels()
  const [open, setOpen] = useState(false)
  const [editor, setEditor] = useState<EditorKey>(null)
  const [tagValue, setTagValue] = useState('')
  const [pathValue, setPathValue] = useState('')
  const [pathExclude, setPathExclude] = useState(false)
  const [propKey, setPropKey] = useState('')
  const [propValue, setPropValue] = useState('')
  const [propOp, setPropOp] = useState<PropertyOpKind>('Eq')
  // #1280 D2 — advanced facet editor state.
  const [stateValues, setStateValues] = useState<ReadonlyArray<string>>([])
  const [stateIsNull, setStateIsNull] = useState(false)
  const [stateExclude, setStateExclude] = useState(false)
  const [blockTypeValues, setBlockTypeValues] = useState<ReadonlyArray<string>>([])
  const [blockTypeExclude, setBlockTypeExclude] = useState(false)
  // Due / Scheduled share the same predicate-editor shape; `dateKind` says
  // which primitive the open editor emits.
  const [dateKind, setDateKind] = useState<'DueDate' | 'Scheduled'>('DueDate')
  const [dateOp, setDateOp] = useState<DateOpKind>('OnOrBefore')
  const [dateValue, setDateValue] = useState('')
  const [dateValue2, setDateValue2] = useState('')
  const [createdAfter, setCreatedAfter] = useState('')
  const [createdBefore, setCreatedBefore] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)

  const reset = useCallback(() => {
    setEditor(null)
    setTagValue('')
    setPathValue('')
    setPathExclude(false)
    setPropKey('')
    setPropValue('')
    setPropOp('Eq')
    setStateValues([])
    setStateIsNull(false)
    setStateExclude(false)
    setBlockTypeValues([])
    setBlockTypeExclude(false)
    setDateKind('DueDate')
    setDateOp('OnOrBefore')
    setDateValue('')
    setDateValue2('')
    setCreatedAfter('')
    setCreatedBefore('')
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    reset()
    // Restore focus to the trigger so keyboard users don't lose their place.
    triggerRef.current?.focus()
  }, [reset])

  const emit = useCallback(
    (filter: FilterPrimitive) => {
      onAddFilter(filter)
      close()
    },
    [onAddFilter, close],
  )

  // D14/D24: the property editor's key is always required. For Eq/Ne the value
  // is required too; for Exists/NotExists there is no value. Centralise the
  // emit so both the Apply button and Enter-to-apply share one guard, and so
  // the predicate shape (D8) is built in one place.
  const applyProperty = useCallback(() => {
    const k = propKey.trim()
    if (!k) return
    let predicate: PropertyPredicate
    if (VALUE_BEARING_OPS.has(propOp)) {
      const v = propValue.trim()
      if (!v) return
      // The Pages UI only emits Text values; Ref is reserved for saved-views.
      predicate = { type: propOp as 'Eq' | 'Ne', value: { type: 'Text', value: v } }
    } else {
      predicate = { type: propOp as 'Exists' | 'NotExists' }
    }
    emit({ type: 'HasProperty', key: k, predicate })
  }, [propKey, propValue, propOp, emit])

  // #1280 D2 — State: emit the multi-value membership leaf. At least one value
  // OR the is-null toggle must be set (an empty, non-null State is a no-op the
  // engine treats as match-nothing); gate Apply on that in the editor.
  const applyState = useCallback(() => {
    if (stateValues.length === 0 && !stateIsNull) return
    emit({
      type: 'State',
      values: [...stateValues],
      is_null: stateIsNull,
      exclude: stateExclude,
    })
  }, [stateValues, stateIsNull, stateExclude, emit])

  // #1280 D2 — BlockType: emit the multi-value membership leaf.
  const applyBlockType = useCallback(() => {
    if (blockTypeValues.length === 0) return
    emit({ type: 'BlockType', values: [...blockTypeValues], exclude: blockTypeExclude })
  }, [blockTypeValues, blockTypeExclude, emit])

  // #1280 D2 — Due/Scheduled: build the DatePredicate and emit. IsNull needs no
  // date; Between needs both; the rest need one. The editor gates Apply on the
  // same condition.
  const applyDate = useCallback(() => {
    let predicate: DatePredicate
    if (dateOp === 'IsNull') {
      predicate = { type: 'IsNull' }
    } else if (dateOp === 'Between') {
      const from = dateValue.trim()
      const to = dateValue2.trim()
      if (!from || !to) return
      predicate = { type: 'Between', from, to }
    } else {
      const date = dateValue.trim()
      if (!date) return
      predicate = { type: dateOp, date }
    }
    emit({ type: dateKind, predicate })
  }, [dateKind, dateOp, dateValue, dateValue2, emit])

  // #1280 D2 — Created: an after/before ULID-range. Either bound may be null,
  // but emitting with both null is a no-op; require at least one.
  const applyCreated = useCallback(() => {
    const after = createdAfter.trim()
    const before = createdBefore.trim()
    if (!after && !before) return
    emit({ type: 'Created', after: after || null, before: before || null })
  }, [createdAfter, createdBefore, emit])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t('pageBrowser.filter.addFilter')}
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
          {t('pageBrowser.filter.addFilter')}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        // Radix Popover.Content does not auto-apply a role; the trigger
        // advertises `aria-haspopup="dialog"`, so name the role here to match.
        //
        // D25 — interaction model: we KEEP `role="dialog"` (the lighter fix)
        // rather than converting the category list to a roving-tabindex
        // `role="menu"`. The items are plain buttons; Radix's dialog focus
        // scope handles Tab/Shift+Tab traversal in DOM order, Esc dismisses,
        // and each item carries a visible focus ring (`focus-ring-visible` on
        // FilterMenuItem; the Button base ring on the bucket/priority/Apply
        // controls). This keeps the markup honest — a non-menu container of
        // buttons should not advertise menu semantics it doesn't implement.
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- this is a Radix PopoverContent component, not an HTML element; a native <dialog> would lose Radix's focus-scope/positioning
        role="dialog"
        align="start"
        // The facet list can exceed the viewport on short windows (each menu
        // item carries a two-line description). The base PopoverContent caps
        // height at `100dvh-4rem` but does not scroll, so overflowing facets
        // (e.g. the last "No inbound links" item) render below the fold with no
        // way to reach them. Make this popover its own scroll container.
        className="w-72 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-2"
        aria-label={t('pageBrowser.filter.addFilterDialogLabel')}
      >
        {warnManyFilters && (
          <p className="px-1 pb-2 text-xs text-muted-foreground" role="note">
            {t('pageBrowser.filter.manyFiltersWarning')}
          </p>
        )}

        {editor === null && (
          <div className="flex flex-col gap-2">
            <FilterCategoryGroup label={t('pageBrowser.filter.sharedGroup')}>
              <FilterMenuItem
                onClick={() => setEditor('tag')}
                description={t('pageBrowser.filter.facetTagDesc')}
              >
                {t('pageBrowser.filter.facetTag')}
              </FilterMenuItem>
              <FilterMenuItem
                onClick={() => setEditor('path')}
                description={t('pageBrowser.filter.facetPathDesc')}
              >
                {t('pageBrowser.filter.facetPath')}
              </FilterMenuItem>
              <FilterMenuItem
                onClick={() => setEditor('property')}
                description={t('pageBrowser.filter.facetHasPropertyDesc')}
              >
                {t('pageBrowser.filter.facetHasProperty')}
              </FilterMenuItem>
              <div className="flex flex-col gap-0.5 px-1">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="self-center text-xs text-muted-foreground">
                    {t('pageBrowser.filter.lastEditedGroup')}
                  </span>
                  {LAST_EDITED_BUCKETS.map((bucket) => (
                    <Button
                      key={bucket.key}
                      type="button"
                      variant="outline"
                      size="xs"
                      className="text-xs"
                      onClick={() => emit(bucket.spec)}
                    >
                      {t(`pageBrowser.filter.lastEdited.${bucket.key}`)}
                    </Button>
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">
                  {t('pageBrowser.filter.facetLastEditedDesc')}
                </span>
              </div>
              <div className="flex flex-col gap-0.5 px-1">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="self-center text-xs text-muted-foreground">
                    {t('pageBrowser.filter.facetPriority')}
                  </span>
                  {priorityLevels.map((p) => (
                    <Button
                      key={p}
                      type="button"
                      variant="outline"
                      size="xs"
                      className="text-xs"
                      onClick={() => emit({ type: 'Priority', priority: p })}
                    >
                      {p}
                    </Button>
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">
                  {t('pageBrowser.filter.facetPriorityDesc')}
                </span>
              </div>
            </FilterCategoryGroup>

            {showAdvancedFacets && (
              <FilterCategoryGroup label={t('pageBrowser.filter.advancedGroup')}>
                <FilterMenuItem
                  onClick={() => setEditor('state')}
                  description={t('pageBrowser.filter.facetStateDesc')}
                >
                  {t('pageBrowser.filter.facetState')}
                </FilterMenuItem>
                <FilterMenuItem
                  onClick={() => setEditor('blockType')}
                  description={t('pageBrowser.filter.facetBlockTypeDesc')}
                >
                  {t('pageBrowser.filter.facetBlockType')}
                </FilterMenuItem>
                <FilterMenuItem
                  onClick={() => {
                    setDateKind('DueDate')
                    setEditor('due')
                  }}
                  description={t('pageBrowser.filter.facetDueDateDesc')}
                >
                  {t('pageBrowser.filter.facetDueDate')}
                </FilterMenuItem>
                <FilterMenuItem
                  onClick={() => {
                    setDateKind('Scheduled')
                    setEditor('scheduled')
                  }}
                  description={t('pageBrowser.filter.facetScheduledDesc')}
                >
                  {t('pageBrowser.filter.facetScheduled')}
                </FilterMenuItem>
                <FilterMenuItem
                  onClick={() => setEditor('created')}
                  description={t('pageBrowser.filter.facetCreatedDesc')}
                >
                  {t('pageBrowser.filter.facetCreated')}
                </FilterMenuItem>
              </FilterCategoryGroup>
            )}

            {!hidePagesFacets && (
              <FilterCategoryGroup label={t('pageBrowser.filter.pagesGroup')}>
                <FilterMenuItem
                  onClick={() => emit({ type: 'Orphan' })}
                  description={t('pageBrowser.filter.facetOrphanDesc')}
                >
                  {t('pageBrowser.filter.facetOrphan')}
                </FilterMenuItem>
                <FilterMenuItem
                  onClick={() => emit({ type: 'Stub' })}
                  description={t('pageBrowser.filter.facetStubDesc')}
                >
                  {t('pageBrowser.filter.facetStub')}
                </FilterMenuItem>
                <FilterMenuItem
                  onClick={() => emit({ type: 'HasNoInboundLinks' })}
                  description={t('pageBrowser.filter.facetHasNoInboundLinksDesc')}
                >
                  {t('pageBrowser.filter.facetHasNoInboundLinks')}
                </FilterMenuItem>
              </FilterCategoryGroup>
            )}
          </div>
        )}

        {editor === 'tag' && (
          <InlineValueEditor
            label={t('pageBrowser.filter.facetTag')}
            value={tagValue}
            onChange={setTagValue}
            onBack={() => setEditor(null)}
            onApply={() => {
              const v = tagValue.trim()
              if (v) emit({ type: 'Tag', tag: v })
            }}
            applyLabel={t('pageBrowser.filter.apply')}
            backLabel={t('pageBrowser.filter.back')}
            placeholder={t('pageBrowser.filter.tagPlaceholder')}
          />
        )}

        {editor === 'path' && (
          <PathEditor
            value={pathValue}
            exclude={pathExclude}
            onChange={setPathValue}
            onExcludeChange={setPathExclude}
            onBack={() => setEditor(null)}
            onApply={() => {
              const v = pathValue.trim()
              if (v) emit({ type: 'PathGlob', pattern: v, exclude: pathExclude })
            }}
          />
        )}

        {editor === 'property' && (
          <PropertyEditor
            propKey={propKey}
            propValue={propValue}
            propOp={propOp}
            onKeyChange={setPropKey}
            onValueChange={setPropValue}
            onOpChange={setPropOp}
            onBack={() => setEditor(null)}
            onApply={applyProperty}
          />
        )}

        {editor === 'state' && (
          <StateEditor
            values={stateValues}
            isNull={stateIsNull}
            exclude={stateExclude}
            onToggleValue={(v) =>
              setStateValues((prev) =>
                prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v],
              )
            }
            onIsNullChange={setStateIsNull}
            onExcludeChange={setStateExclude}
            onBack={() => setEditor(null)}
            onApply={applyState}
          />
        )}

        {editor === 'blockType' && (
          <BlockTypeEditor
            values={blockTypeValues}
            exclude={blockTypeExclude}
            onToggleValue={(v) =>
              setBlockTypeValues((prev) =>
                prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v],
              )
            }
            onExcludeChange={setBlockTypeExclude}
            onBack={() => setEditor(null)}
            onApply={applyBlockType}
          />
        )}

        {(editor === 'due' || editor === 'scheduled') && (
          <DatePredicateEditor
            label={
              dateKind === 'DueDate'
                ? t('pageBrowser.filter.facetDueDate')
                : t('pageBrowser.filter.facetScheduled')
            }
            op={dateOp}
            date={dateValue}
            date2={dateValue2}
            onOpChange={setDateOp}
            onDateChange={setDateValue}
            onDate2Change={setDateValue2}
            onBack={() => setEditor(null)}
            onApply={applyDate}
          />
        )}

        {editor === 'created' && (
          <CreatedEditor
            after={createdAfter}
            before={createdBefore}
            onAfterChange={setCreatedAfter}
            onBeforeChange={setCreatedBefore}
            onBack={() => setEditor(null)}
            onApply={applyCreated}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function FilterCategoryGroup({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <span className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  )
}

function FilterMenuItem({
  onClick,
  children,
  description,
}: {
  onClick: () => void
  children: React.ReactNode
  /** Optional muted helper text rendered under the label (facet disambiguation). */
  description?: string
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-ring-visible"
    >
      {children}
      {description && (
        <span className="block text-xs font-normal text-muted-foreground">{description}</span>
      )}
    </button>
  )
}

function InlineValueEditor({
  label,
  value,
  onChange,
  onBack,
  onApply,
  applyLabel,
  backLabel,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onBack: () => void
  onApply: () => void
  applyLabel: string
  backLabel: string
  placeholder: string
}): React.ReactElement {
  // D14: a required-input editor is a dead-end when Apply silently no-ops on
  // empty input. Gate both Apply (click) and Enter-to-apply on a non-blank
  // value so the affordance can't fail silently.
  const canApply = value.trim().length > 0
  return (
    <div className="flex flex-col gap-2">
      <span className="px-1 text-xs font-medium">{label}</span>
      <Input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- this sub-editor renders only after the user opens it from the filter menu; focusing the single required text input lets them type the value immediately without an extra click/tab
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (canApply) onApply()
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={onBack}>
          {backLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onApply}
          disabled={!canApply}
          aria-disabled={!canApply}
        >
          {applyLabel}
        </Button>
      </div>
    </div>
  )
}

/**
 * Editor for the `PathGlob` facet. Mirrors `InlineValueEditor`'s UX (D21 —
 * autoFocus + Enter-to-apply, D14 — Apply gated on a non-blank pattern) but
 * adds the D24 "Exclude" toggle so the user can emit `PathGlob{exclude:true}`
 * ("not path:"); previously only `exclude:false` was reachable.
 */
function PathEditor({
  value,
  exclude,
  onChange,
  onExcludeChange,
  onBack,
  onApply,
}: {
  value: string
  exclude: boolean
  onChange: (v: string) => void
  onExcludeChange: (v: boolean) => void
  onBack: () => void
  onApply: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const canApply = value.trim().length > 0
  return (
    <div className="flex flex-col gap-2">
      <span className="px-1 text-xs font-medium">{t('pageBrowser.filter.facetPath')}</span>
      <Input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- this facet-path sub-editor renders only after the user opens it from the filter menu; focusing the path input lets them type immediately without an extra click/tab
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (canApply) onApply()
          }
        }}
        placeholder={t('pageBrowser.filter.pathPlaceholder')}
        aria-label={t('pageBrowser.filter.pathPlaceholder')}
      />
      {/* oxlint-disable-next-line jsx-a11y/label-has-associated-control -- the Radix Checkbox (a button) is the control and carries its own aria-label; oxlint can't see it through the component boundary */}
      <label className="flex items-center gap-2 px-1 text-xs">
        <Checkbox
          checked={exclude}
          onCheckedChange={(next) => onExcludeChange(next === true)}
          aria-label={t('pageBrowser.filter.pathExcludeLabel')}
        />
        {t('pageBrowser.filter.pathExcludeLabel')}
      </label>
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={onBack}>
          {t('pageBrowser.filter.back')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onApply}
          disabled={!canApply}
          aria-disabled={!canApply}
        >
          {t('pageBrowser.filter.apply')}
        </Button>
      </div>
    </div>
  )
}

/** The four predicate kinds the property op selector offers, in display order. */
const PROPERTY_OPS: ReadonlyArray<{ value: PropertyOpKind; labelKey: string }> = [
  { value: 'Eq', labelKey: 'pageBrowser.filter.propertyOpEq' },
  { value: 'Ne', labelKey: 'pageBrowser.filter.propertyOpNe' },
  { value: 'Exists', labelKey: 'pageBrowser.filter.propertyOpExists' },
  { value: 'NotExists', labelKey: 'pageBrowser.filter.propertyOpNotExists' },
]

/**
 * Editor for the `HasProperty` facet. Mirrors `InlineValueEditor`'s UX (D21):
 * the key field `autoFocus`es and Enter applies from any input. The key is
 * always required (D14).
 *
 * D24 — a predicate op selector offers `is` (Eq), `is not` (Ne), `exists`
 * (Exists) and `doesn't exist` (NotExists). For Eq/Ne the value input is shown
 * and required; for Exists/NotExists the value input is hidden and Apply is
 * enabled on a non-empty key alone. The predicate shape is built by the
 * parent's `applyProperty`.
 */
function PropertyEditor({
  propKey,
  propValue,
  propOp,
  onKeyChange,
  onValueChange,
  onOpChange,
  onBack,
  onApply,
}: {
  propKey: string
  propValue: string
  propOp: PropertyOpKind
  onKeyChange: (v: string) => void
  onValueChange: (v: string) => void
  onOpChange: (v: PropertyOpKind) => void
  onBack: () => void
  onApply: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const needsValue = VALUE_BEARING_OPS.has(propOp)
  // D14/D24: key always required; value required only for Eq/Ne.
  const canApply = propKey.trim().length > 0 && (!needsValue || propValue.trim().length > 0)
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (canApply) onApply()
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="px-1 text-xs font-medium">{t('pageBrowser.filter.facetHasProperty')}</span>
      <Input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- this has-property sub-editor renders only after the user opens it from the filter menu; focusing the property-key input (the first of its fields) lets them type immediately without an extra click/tab
        autoFocus
        value={propKey}
        onChange={(e) => onKeyChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('pageBrowser.filter.propertyKeyPlaceholder')}
        aria-label={t('pageBrowser.filter.propertyKeyPlaceholder')}
      />
      {/* Native <select>: Radix Select portals + a focus-scope inside the
          Popover dialog scope, which is brittle in jsdom and overkill for a
          4-option control. The native element is fully accessible + testable. */}
      <select
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-hidden transition-[color,box-shadow] focus-visible:border-ring focus-ring-visible"
        value={propOp}
        onChange={(e) => onOpChange(e.target.value as PropertyOpKind)}
        aria-label={t('pageBrowser.filter.propertyOpLabel')}
      >
        {PROPERTY_OPS.map((op) => (
          <option key={op.value} value={op.value}>
            {t(op.labelKey)}
          </option>
        ))}
      </select>
      {needsValue && (
        <Input
          value={propValue}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('pageBrowser.filter.propertyValuePlaceholder')}
          aria-label={t('pageBrowser.filter.propertyValuePlaceholder')}
        />
      )}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={onBack}>
          {t('pageBrowser.filter.back')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onApply}
          disabled={!canApply}
          aria-disabled={!canApply}
        >
          {t('pageBrowser.filter.apply')}
        </Button>
      </div>
    </div>
  )
}

/**
 * #1280 D2 — shared Back/Apply footer for the advanced facet editors. Mirrors
 * the inline editors' footer (D14 — Apply gated/disabled when the editor's
 * required input is incomplete).
 */
function EditorFooter({
  canApply,
  onBack,
  onApply,
}: {
  canApply: boolean
  onBack: () => void
  onApply: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex justify-between gap-2">
      <Button type="button" variant="ghost" size="xs" onClick={onBack}>
        {t('pageBrowser.filter.back')}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={onApply}
        disabled={!canApply}
        aria-disabled={!canApply}
      >
        {t('pageBrowser.filter.apply')}
      </Button>
    </div>
  )
}

/**
 * #1280 D2 — a labelled multi-select checkbox row. Each value renders as a
 * checkbox the user toggles; the parent owns the membership set. Used by both
 * the State and Block-type editors.
 */
function MultiSelectGroup({
  legend,
  options,
  selected,
  optionLabel,
  onToggle,
}: {
  legend: string
  options: ReadonlyArray<string>
  selected: ReadonlyArray<string>
  optionLabel: (value: string) => string
  onToggle: (value: string) => void
}): React.ReactElement {
  return (
    <fieldset className="flex flex-col gap-1 px-1">
      <legend className="text-xs font-medium">{legend}</legend>
      {options.map((value) => {
        const label = optionLabel(value)
        return (
          // oxlint-disable-next-line jsx-a11y/label-has-associated-control -- the Radix Checkbox (a button) is the control and carries its own aria-label; oxlint can't see it through the component boundary
          <label key={value} className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={selected.includes(value)}
              onCheckedChange={() => onToggle(value)}
              aria-label={label}
            />
            {label}
          </label>
        )
      })}
    </fieldset>
  )
}

/**
 * Editor for the `State` facet (#1280 D2). A multi-select of todo-state values
 * plus a "none / unset" toggle (`is_null`) and an "exclude" toggle. Apply is
 * gated on at least one selected value OR the is-null toggle (an empty,
 * non-null State matches nothing). Emits
 * `{ type: 'State', values, is_null, exclude }`.
 */
function StateEditor({
  values,
  isNull,
  exclude,
  onToggleValue,
  onIsNullChange,
  onExcludeChange,
  onBack,
  onApply,
}: {
  values: ReadonlyArray<string>
  isNull: boolean
  exclude: boolean
  onToggleValue: (value: string) => void
  onIsNullChange: (v: boolean) => void
  onExcludeChange: (v: boolean) => void
  onBack: () => void
  onApply: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const canApply = values.length > 0 || isNull
  return (
    <div className="flex flex-col gap-2">
      <span className="px-1 text-xs font-medium">{t('pageBrowser.filter.facetState')}</span>
      <MultiSelectGroup
        legend={t('pageBrowser.filter.stateValuesLabel')}
        options={TODO_STATE_VALUES}
        selected={values}
        optionLabel={(v) => v}
        onToggle={onToggleValue}
      />
      {/* oxlint-disable-next-line jsx-a11y/label-has-associated-control -- the Radix Checkbox (a button) is the control and carries its own aria-label */}
      <label className="flex items-center gap-2 px-1 text-xs">
        <Checkbox
          checked={isNull}
          onCheckedChange={(next) => onIsNullChange(next === true)}
          aria-label={t('pageBrowser.filter.stateIsNullLabel')}
        />
        {t('pageBrowser.filter.stateIsNullLabel')}
      </label>
      {/* oxlint-disable-next-line jsx-a11y/label-has-associated-control -- the Radix Checkbox (a button) is the control and carries its own aria-label */}
      <label className="flex items-center gap-2 px-1 text-xs">
        <Checkbox
          checked={exclude}
          onCheckedChange={(next) => onExcludeChange(next === true)}
          aria-label={t('pageBrowser.filter.excludeLabel')}
        />
        {t('pageBrowser.filter.excludeLabel')}
      </label>
      <EditorFooter canApply={canApply} onBack={onBack} onApply={onApply} />
    </div>
  )
}

/**
 * Editor for the `BlockType` facet (#1280 D2). A multi-select of block types
 * plus an "exclude" toggle. Apply is gated on at least one selected value.
 * Emits `{ type: 'BlockType', values, exclude }`.
 */
function BlockTypeEditor({
  values,
  exclude,
  onToggleValue,
  onExcludeChange,
  onBack,
  onApply,
}: {
  values: ReadonlyArray<string>
  exclude: boolean
  onToggleValue: (value: string) => void
  onExcludeChange: (v: boolean) => void
  onBack: () => void
  onApply: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const canApply = values.length > 0
  return (
    <div className="flex flex-col gap-2">
      <span className="px-1 text-xs font-medium">{t('pageBrowser.filter.facetBlockType')}</span>
      <MultiSelectGroup
        legend={t('pageBrowser.filter.blockTypeValuesLabel')}
        options={BLOCK_TYPE_VALUES}
        selected={values}
        optionLabel={(v) => t(`pageBrowser.filter.blockType.${v}`)}
        onToggle={onToggleValue}
      />
      {/* oxlint-disable-next-line jsx-a11y/label-has-associated-control -- the Radix Checkbox (a button) is the control and carries its own aria-label */}
      <label className="flex items-center gap-2 px-1 text-xs">
        <Checkbox
          checked={exclude}
          onCheckedChange={(next) => onExcludeChange(next === true)}
          aria-label={t('pageBrowser.filter.excludeLabel')}
        />
        {t('pageBrowser.filter.excludeLabel')}
      </label>
      <EditorFooter canApply={canApply} onBack={onBack} onApply={onApply} />
    </div>
  )
}

/**
 * Editor for the `DueDate` / `Scheduled` facets (#1280 D2). An operator dropdown
 * (is-null / before / after / on-or-before / on-or-after / on / between) plus
 * date input(s) — one for the single-date ops, two for `Between`, none for
 * `IsNull`. Apply is gated on the required date(s) being present. The parent's
 * `applyDate` builds the `DatePredicate` and emits the correct primitive.
 */
function DatePredicateEditor({
  label,
  op,
  date,
  date2,
  onOpChange,
  onDateChange,
  onDate2Change,
  onBack,
  onApply,
}: {
  label: string
  op: DateOpKind
  date: string
  date2: string
  onOpChange: (v: DateOpKind) => void
  onDateChange: (v: string) => void
  onDate2Change: (v: string) => void
  onBack: () => void
  onApply: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const isNull = op === 'IsNull'
  const isBetween = op === 'Between'
  const canApply =
    isNull || (isBetween ? date.trim() !== '' && date2.trim() !== '' : date.trim() !== '')
  return (
    <div className="flex flex-col gap-2">
      <span className="px-1 text-xs font-medium">{label}</span>
      {/* Native <select>: see PropertyEditor for the rationale (Radix Select
          portals + focus-scope inside the dialog scope are brittle in jsdom). */}
      <select
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-hidden transition-[color,box-shadow] focus-visible:border-ring focus-ring-visible"
        value={op}
        onChange={(e) => onOpChange(e.target.value as DateOpKind)}
        aria-label={t('pageBrowser.filter.dateOpLabel')}
      >
        {DATE_OPS.map((o) => (
          <option key={o.value} value={o.value}>
            {t(o.labelKey)}
          </option>
        ))}
      </select>
      {!isNull && (
        <Input
          type="date"
          value={date}
          onChange={(e) => onDateChange(e.target.value)}
          aria-label={
            isBetween ? t('pageBrowser.filter.dateFromLabel') : t('pageBrowser.filter.dateLabel')
          }
        />
      )}
      {isBetween && (
        <Input
          type="date"
          value={date2}
          onChange={(e) => onDate2Change(e.target.value)}
          aria-label={t('pageBrowser.filter.dateToLabel')}
        />
      )}
      <EditorFooter canApply={canApply} onBack={onBack} onApply={onApply} />
    </div>
  )
}

/**
 * Editor for the `Created` facet (#1280 D2). An after/before date range; either
 * bound may be left blank (→ `null`). Apply is gated on at least one bound being
 * set. Emits `{ type: 'Created', after, before }`.
 */
function CreatedEditor({
  after,
  before,
  onAfterChange,
  onBeforeChange,
  onBack,
  onApply,
}: {
  after: string
  before: string
  onAfterChange: (v: string) => void
  onBeforeChange: (v: string) => void
  onBack: () => void
  onApply: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const canApply = after.trim() !== '' || before.trim() !== ''
  return (
    <div className="flex flex-col gap-2">
      <span className="px-1 text-xs font-medium">{t('pageBrowser.filter.facetCreated')}</span>
      <label className="flex flex-col gap-1 px-1 text-xs">
        {t('pageBrowser.filter.createdAfterLabel')}
        <Input
          type="date"
          value={after}
          onChange={(e) => onAfterChange(e.target.value)}
          aria-label={t('pageBrowser.filter.createdAfterLabel')}
        />
      </label>
      <label className="flex flex-col gap-1 px-1 text-xs">
        {t('pageBrowser.filter.createdBeforeLabel')}
        <Input
          type="date"
          value={before}
          onChange={(e) => onBeforeChange(e.target.value)}
          aria-label={t('pageBrowser.filter.createdBeforeLabel')}
        />
      </label>
      <EditorFooter canApply={canApply} onBack={onBack} onApply={onApply} />
    </div>
  )
}
