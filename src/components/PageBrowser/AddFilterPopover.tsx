/**
 * AddFilterPopover — Phase 4. The discovery affordance for the
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  BlockTypeEditor,
  CreatedEditor,
  DatePredicateEditor,
  LinkTargetEditor,
  PathEditor,
  PropertyEditor,
  StateEditor,
  TagPickerEditor,
} from '@/components/PageBrowser/add-filter/editors'
import { FilterCategoryGroup, FilterMenuItem } from '@/components/PageBrowser/add-filter/menu'
import {
  type DateOpKind,
  type EditorKey,
  LAST_EDITED_BUCKETS,
  PROPERTY_OPS,
  type PropertyOpKind,
  propertyOpsForValueKind,
  propertyValueKindForType,
  type PropertyValueKind,
  VALUE_BEARING_OPS,
} from '@/components/PageBrowser/add-filter/vocab'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { usePriorityLevels } from '@/hooks/usePriorityLevels'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type {
  DatePredicate,
  FilterExpr,
  FilterPrimitive,
  PropertyPredicate,
  PropertyValue,
} from '@/lib/bindings'
import { logger } from '@/lib/logger'

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
  const [pathValue, setPathValue] = useState('')
  const [pathExclude, setPathExclude] = useState(false)
  const [propKey, setPropKey] = useState('')
  const [propValue, setPropValue] = useState('')
  const [rawPropOp, setPropOp] = useState<PropertyOpKind>('Eq')
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
  // #4553 Phase 1 — `key -> value_type` from the schema registry
  // (`listPropertyDefs`), fetched lazily (see the effect below) so the
  // operator set + `PropertyValue` variant the property editor offers can be
  // DERIVED from the property's declared type instead of hardcoded to Text.
  const [propertyValueTypes, setPropertyValueTypes] = useState<ReadonlyMap<string, string>>(
    new Map(),
  )
  const triggerRef = useRef<HTMLButtonElement>(null)

  // #4553 Phase 1 — fetch the property-defs registry once the has-property
  // editor opens, but ONLY on the advanced surface (`showAdvancedFacets`):
  // the Pages browser's `+ Filter` popover must keep its classic
  // 4-operator/Text-only behaviour untouched (acceptance criterion 7), and
  // never issue this IPC call at all. `listPropertyDefs` is paginated; this
  // popover is single-page-by-design (mirrors `QueryBuilderModal`'s datalist
  // fetch) — the seeded vocabulary fits well under a single page, and a key
  // beyond the first page simply falls back to the undeclared (Text)
  // behaviour rather than blocking on a full walk.
  useEffect(() => {
    if (!showAdvancedFacets || editor !== 'property') return
    let cancelled = false
    commands
      .listPropertyDefs(null, null)
      .then(unwrap)
      .then(({ items }) => {
        if (!cancelled)
          setPropertyValueTypes(new Map(items.map((def) => [def.key, def.value_type])))
      })
      .catch((err: unknown) => {
        logger.warn('AddFilterPopover', 'failed to load property definitions', undefined, err)
        if (!cancelled) setPropertyValueTypes(new Map())
      })
    return () => {
      cancelled = true
    }
  }, [showAdvancedFacets, editor])

  // The `PropertyValue` variant + operator set the has-property editor
  // offers for the CURRENTLY TYPED key. On the Pages browser
  // (`!showAdvancedFacets`) these are pinned to the historical Text/4-op
  // pair regardless of the registry, matching acceptance criterion 7.
  const propertyValueKind: PropertyValueKind = useMemo(
    () =>
      showAdvancedFacets
        ? propertyValueKindForType(propertyValueTypes.get(propKey.trim()))
        : 'Text',
    [showAdvancedFacets, propKey, propertyValueTypes],
  )
  const propertyOps = useMemo(
    () => (showAdvancedFacets ? propertyOpsForValueKind(propertyValueKind) : PROPERTY_OPS),
    [showAdvancedFacets, propertyValueKind],
  )

  // Reconcile `propOp` when the derived operator set no longer contains it —
  // e.g. the user had `Lt` selected for a `number` key, then edited the key to
  // one declared `ref`, which only offers Eq/Ne/Exists/NotExists. `Eq` is in
  // every set, so it is always a valid landing spot.
  //
  // DERIVED during render rather than reconciled in an effect. The effect form
  // (which `QueryControlsBar`'s Relevance-sort reconciliation still uses) needs
  // a second render to settle, so for one commit the native `<select>` is
  // pointed at an option that no longer renders AND `buildPredicate` can read
  // the stale operator. Deriving makes the invalid state unrepresentable
  // instead of transient, and drops the `react(set-state-in-effect)` warning
  // this file did not have before.
  const propOp = propertyOps.some((op) => op.value === rawPropOp) ? rawPropOp : 'Eq'

  const reset = useCallback(() => {
    setEditor(null)
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

  // Each category builds a `FilterPrimitive` leaf and emits it directly to the
  // backend query. (#2258 removed a no-op round-trip through the canonical
  // `FilterPredicate` model here: it was the identity for every category the
  // popover builds, so it carried no runtime payoff.)
  const emit = useCallback(
    (filter: FilterPrimitive) => {
      onAddFilter(filter)
      close()
    },
    [onAddFilter, close],
  )

  // D14/D24: the property editor's key is always required. For a value-bearing
  // op the value is required too; for Exists/NotExists there is no value.
  // Centralise the emit so both the Apply button and Enter-to-apply share one
  // guard, and so the predicate shape (D8) is built in one place.
  //
  // #4553 Phase 1 — the emitted `PropertyValue` variant is `propertyValueKind`
  // (derived above from the key's declared `value_type`), NOT hardcoded to
  // Text. On the Pages browser `propertyValueKind` is pinned to `'Text'`, so
  // this reduces to the exact predicate the popover always emitted there.
  const applyProperty = useCallback(() => {
    const k = propKey.trim()
    if (!k) return
    let predicate: PropertyPredicate
    if (VALUE_BEARING_OPS.has(propOp)) {
      const v = propValue.trim()
      if (!v) return
      let value: PropertyValue
      switch (propertyValueKind) {
        case 'Num': {
          const n = Number(v)
          // Guards the same case the editor's `canApply` already blocks
          // (e.g. a bare "-" or "."); belt-and-braces against emitting a
          // non-finite `f64` if this is ever called from elsewhere.
          if (!Number.isFinite(n)) return
          value = { type: 'Num', value: n }
          break
        }
        case 'Date': {
          value = { type: 'Date', value: v }
          break
        }
        case 'Ref': {
          value = { type: 'Ref', value: v }
          break
        }
        default: {
          value = { type: 'Text', value: v }
        }
      }
      predicate = {
        type: propOp as 'Eq' | 'Ne' | 'Lt' | 'Gt' | 'Lte' | 'Gte' | 'Contains' | 'StartsWith',
        value,
      }
    } else {
      predicate = { type: propOp as 'Exists' | 'NotExists' }
    }
    emit({ type: 'HasProperty', key: k, predicate })
  }, [propKey, propValue, propOp, propertyValueKind, emit])

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
        // height at the collision-aware available height and scrolls its own
        // overflow (#1960, #4313), so nothing here has to arrange that — this
        // only tightens the padding for a menu of rows. (No `w-72` either: the
        // base already sets it, and repeating it just makes twMerge re-resolve
        // the same class.)
        className="p-2"
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
                      onClick={() =>
                        emit({ type: 'Priority', values: [p], is_null: false, exclude: false })
                      }
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
          <TagPickerEditor
            label={t('pageBrowser.filter.facetTag')}
            onSelect={(tagId) => emit({ type: 'Tag', tag: tagId })}
            onBack={() => setEditor(null)}
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
            ops={propertyOps}
            valueKind={propertyValueKind}
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

        {/* #4406 — the finding here is LOCAL, not inherited through the
            render-prop boundary. `onApply` calls `emit`, `emit` calls `close`,
            and `close` reads `triggerRef.current` to restore focus to the
            trigger. So oxlint sees an object literal built during render whose
            callbacks do reach a ref, and it cannot prove they are only invoked
            later. Measured, not assumed: delete the `triggerRef.current
            ?.focus()` in `close` and this finding disappears with the render
            prop untouched; strip only the directive and it returns.
            It is safe because both callbacks are event handlers — the ref read
            runs when the user applies or dismisses, never during this render.
            (`HasParentMatchingEditor`, which `FilterGroup.tsx` mounts through
            this prop, carries its own same-shaped finding for its own reason —
            that is a parallel, not the cause of this one.) */}
        {editor === 'hasParent' &&
          // oxlint-disable-next-line react/refs -- `onApply` reaches `triggerRef.current` through `emit` → `close`, so these callbacks genuinely touch a ref; they are event handlers, invoked on user action and never during this render — see the note above and #4406
          renderHasParentEditor?.({
            onBack: () => setEditor(null),
            onApply: (matcher) => emit({ type: 'HasParentMatching', matcher }),
          })}
      </PopoverContent>
    </Popover>
  )
}
