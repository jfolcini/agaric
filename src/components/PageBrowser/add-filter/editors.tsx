/**
 * AddFilterPopover — inline value/predicate editor sub-components (#1648,
 * extracted from `AddFilterPopover.tsx`). Each editor is a controlled view: the
 * parent owns the state and the emit/guard logic, the editor renders the inputs
 * and reports back via callbacks. The shared `EditorFooter` and
 * `MultiSelectGroup` are co-located here.
 */

import { FileSearch } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { logger } from '@/lib/logger'
import type { PageHeading } from '@/lib/tauri'
import { listAllPagesInSpace } from '@/lib/tauri'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

import {
  BLOCK_TYPE_VALUES,
  DATE_OPS,
  type DateOpKind,
  PROPERTY_OPS,
  type PropertyOpKind,
  TODO_STATE_VALUES,
  VALUE_BEARING_OPS,
} from './vocab'

export function InlineValueEditor({
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
export function PathEditor({
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
export function PropertyEditor({
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
export function EditorFooter({
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
export function MultiSelectGroup({
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
export function StateEditor({
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
      <label className="flex items-center gap-2 px-1 text-xs">
        <Checkbox
          checked={isNull}
          onCheckedChange={(next) => onIsNullChange(next === true)}
          aria-label={t('pageBrowser.filter.stateIsNullLabel')}
        />
        {t('pageBrowser.filter.stateIsNullLabel')}
      </label>
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
export function BlockTypeEditor({
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
export function DatePredicateEditor({
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
export function CreatedEditor({
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

/**
 * #1478 — page picker for the `LinksTo` / `LinkedFrom` relational facets. The
 * value the user picks is a page/block ULID, but the user chooses it BY TITLE,
 * so this mirrors the shared ref-picker UX (`RefEditor`): a search box over the
 * space's page list (`listAllPagesInSpace`, filtered client-side with the
 * Unicode-aware fold), each row showing the resolved title. On click it hands
 * the page's ULID to `onSelect`; the parent emits the leaf with the id stored.
 * The chip then resolves the id BACK to a title via the same resolver.
 */
export function LinkTargetEditor({
  label,
  onSelect,
  onBack,
}: {
  label: string
  onSelect: (id: string) => void
  onBack: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const resolveTitle = useResolveStore((s) => s.resolveTitle)
  const [search, setSearch] = useState('')
  const [pages, setPages] = useState<PageHeading[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    // Phase 4 — `listAllPagesInSpace` requires a space id; the `?? ''`
    // pre-bootstrap fallback forces an empty (no-match) result rather than a
    // runtime null-deref, matching the property ref picker.
    listAllPagesInSpace(currentSpaceId ?? '')
      .then((res) => {
        if (!cancelled) setPages(res)
      })
      .catch((err: unknown) => {
        logger.error('AddFilterPopover', 'Failed to load pages for link picker', undefined, err)
        if (!cancelled) setPages([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentSpaceId])

  const filtered = useMemo(() => {
    if (!search) return pages
    return pages.filter((p) => matchesSearchFolded(p.content || '', search))
  }, [pages, search])

  return (
    <div className="flex flex-col gap-2" data-testid="link-target-editor">
      <span className="px-1 text-xs font-medium">{label}</span>
      <Input
        className="h-8 text-xs"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t('pageBrowser.filter.linkSearchPages')}
        aria-label={t('pageBrowser.filter.linkSearchPages')}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- this picker renders only after the user opens it from the filter menu; focusing the search input lets them filter pages immediately without an extra click/tab
        autoFocus
      />
      <ScrollArea className="max-h-48">
        <div className="flex flex-col gap-0.5" aria-busy={loading}>
          {loading ? (
            <div className="flex justify-center py-3">
              <Spinner size="sm" />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState icon={FileSearch} message={t('pageBrowser.filter.linkNoPages')} compact />
          ) : (
            filtered.map((page) => (
              <button
                key={page.id}
                type="button"
                className="rounded px-2 py-1 text-left text-xs transition-colors hover:bg-accent focus-ring-visible truncate"
                onClick={() => onSelect(page.id)}
              >
                {/* `PageHeading.content` IS the page title; prefer it. Fall back
                    to the resolver (so a content-less row still shows something),
                    then to "Untitled". The chip resolves the stored id→title via
                    the SAME resolver after selection. */}
                {page.content || resolveTitle(page.id) || t('block.untitled')}
              </button>
            ))
          )}
        </div>
      </ScrollArea>
      <div className="flex justify-start">
        <Button type="button" variant="ghost" size="xs" onClick={onBack}>
          {t('pageBrowser.filter.back')}
        </Button>
      </div>
    </div>
  )
}
