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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { usePriorityLevels } from '@/hooks/usePriorityLevels'
import type { DatePredicate, PropertyPredicate } from '@/lib/bindings'
import { projectPageFilterThroughCanonical } from '@/lib/filters/pageBrowserAdapter'
import type { FilterExpr, FilterPrimitive } from '@/lib/tauri'

import {
  BlockTypeEditor,
  CreatedEditor,
  DatePredicateEditor,
  InlineValueEditor,
  LinkTargetEditor,
  PathEditor,
  PropertyEditor,
  StateEditor,
} from './add-filter/editors'
import { FilterCategoryGroup, FilterMenuItem } from './add-filter/menu'
import {
  type DateOpKind,
  type EditorKey,
  LAST_EDITED_BUCKETS,
  type PropertyOpKind,
  VALUE_BEARING_OPS,
} from './add-filter/vocab'

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
  /**
   * #1478 — renders the `HasParentMatching` editor (the nested mini-builder).
   * Dependency-INJECTED rather than imported so this popover imports neither
   * `HasParentMatchingEditor` nor `FilterGroup`; importing either would close an
   * import cycle (both reach back here via `advancedQuery.ts` /
   * `PageBrowserFilterRow.tsx`, and through `FilterGroup`'s own "+ Filter"
   * popover). `FilterGroup` passes a closure that renders the editor (wiring
   * `FilterGroup` itself in as the editor's recursive sub-builder). The
   * Pages-surface usages pass nothing, so the has-parent facet is not offered
   * there. The popover only knows the editor's two callbacks; the editor compiles
   * the matcher and hands it back via `onApply`.
   */
  renderHasParentEditor?: (props: {
    onApply: (matcher: FilterExpr) => void
    onBack: () => void
  }) => React.ReactNode
}

export function AddFilterPopover({
  onAddFilter,
  warnManyFilters,
  hidePagesFacets,
  showAdvancedFacets,
  renderHasParentEditor,
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
  // #1478 — relational link picker state (shared by the links-to / linked-from
  // editors; `linkKind` says which primitive the open editor emits).
  const [linkKind, setLinkKind] = useState<'LinksTo' | 'LinkedFrom'>('LinksTo')
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
    setLinkKind('LinksTo')
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    reset()
    // Restore focus to the trigger so keyboard users don't lose their place.
    triggerRef.current?.focus()
  }, [reset])

  // #1646 (surface 2) — the Pages browser now projects its internal filter
  // representation THROUGH the canonical `FilterPredicate` model before it
  // crosses the IPC boundary, so all four filter surfaces share one source of
  // truth. The UI and the gestures are unchanged: each category still builds a
  // `FilterPrimitive`, but `emit` round-trips it
  // (`FilterPrimitive` → canonical → `FilterPrimitive`) so the emitted wire
  // value provably equals the canonical projection. The round-trip is lossless
  // for every Pages category (proven by the parity table in
  // `pageBrowserAdapter.test.ts`), so the emitted backend filter stays
  // BYTE-IDENTICAL to the pre-migration path. The deferred `HasParentMatching`
  // (recursive `FilterExpr`) has no flat canonical category yet, so the adapter
  // passes it through untouched (see the helper's docstring).
  const emit = useCallback(
    (filter: FilterPrimitive) => {
      onAddFilter(projectPageFilterThroughCanonical(filter))
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
                {/* #1478 — relational predicates (engine landed in #1455). */}
                <FilterMenuItem
                  onClick={() => {
                    setLinkKind('LinksTo')
                    setEditor('linksTo')
                  }}
                  description={t('pageBrowser.filter.facetLinksToDesc')}
                >
                  {t('pageBrowser.filter.facetLinksTo')}
                </FilterMenuItem>
                <FilterMenuItem
                  onClick={() => {
                    setLinkKind('LinkedFrom')
                    setEditor('linkedFrom')
                  }}
                  description={t('pageBrowser.filter.facetLinkedFromDesc')}
                >
                  {t('pageBrowser.filter.facetLinkedFrom')}
                </FilterMenuItem>
                {/* The has-parent facet needs an injected editor (the popover
                    imports neither the editor nor `FilterGroup`); offer it only
                    when the caller supplies one. */}
                {renderHasParentEditor && (
                  <FilterMenuItem
                    onClick={() => setEditor('hasParent')}
                    description={t('pageBrowser.filter.facetHasParentMatchingDesc')}
                  >
                    {t('pageBrowser.filter.facetHasParentMatching')}
                  </FilterMenuItem>
                )}
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

        {(editor === 'linksTo' || editor === 'linkedFrom') && (
          <LinkTargetEditor
            label={
              linkKind === 'LinksTo'
                ? t('pageBrowser.filter.linkTargetLabel')
                : t('pageBrowser.filter.linkSourceLabel')
            }
            onBack={() => setEditor(null)}
            onSelect={(id) =>
              emit(
                linkKind === 'LinksTo'
                  ? { type: 'LinksTo', target: id }
                  : { type: 'LinkedFrom', source: id },
              )
            }
          />
        )}

        {editor === 'hasParent' &&
          renderHasParentEditor?.({
            onBack: () => setEditor(null),
            onApply: (matcher) => emit({ type: 'HasParentMatching', matcher }),
          })}
      </PopoverContent>
    </Popover>
  )
}
