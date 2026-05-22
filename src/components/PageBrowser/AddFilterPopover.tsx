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
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { FilterPrimitive } from '@/lib/tauri'

export interface AddFilterPopoverProps {
  /** Emits the chosen primitive. The parent appends it to its chip set. */
  onAddFilter: (filter: FilterPrimitive) => void
  /** Soft-cap warning copy shown when the chip count is already high. */
  warnManyFilters?: boolean
}

/** Which inline value-editor is open inside the popover (null = category menu). */
type EditorKey = 'tag' | 'path' | 'property' | null

const LAST_EDITED_BUCKETS: ReadonlyArray<{ key: string; spec: FilterPrimitive }> = [
  { key: 'today', spec: { type: 'LastEdited', spec: { type: 'Rolling', days: 1 } } },
  { key: 'thisWeek', spec: { type: 'LastEdited', spec: { type: 'Rolling', days: 7 } } },
  { key: 'thisMonth', spec: { type: 'LastEdited', spec: { type: 'Rolling', days: 30 } } },
  { key: 'older', spec: { type: 'LastEdited', spec: { type: 'OlderThan', days: 30 } } },
]

const PRIORITIES = ['A', 'B', 'C'] as const

export function AddFilterPopover({
  onAddFilter,
  warnManyFilters,
}: AddFilterPopoverProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [editor, setEditor] = useState<EditorKey>(null)
  const [tagValue, setTagValue] = useState('')
  const [pathValue, setPathValue] = useState('')
  const [propKey, setPropKey] = useState('')
  const [propValue, setPropValue] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)

  const reset = useCallback(() => {
    setEditor(null)
    setTagValue('')
    setPathValue('')
    setPropKey('')
    setPropValue('')
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
        align="start"
        className="w-72 p-2"
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
              <FilterMenuItem onClick={() => setEditor('tag')}>
                {t('pageBrowser.filter.facetTag')}
              </FilterMenuItem>
              <FilterMenuItem onClick={() => setEditor('path')}>
                {t('pageBrowser.filter.facetPath')}
              </FilterMenuItem>
              <FilterMenuItem onClick={() => setEditor('property')}>
                {t('pageBrowser.filter.facetHasProperty')}
              </FilterMenuItem>
              <div className="flex flex-wrap gap-1 px-1">
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
              <div className="flex flex-wrap gap-1 px-1">
                <span className="self-center text-xs text-muted-foreground">
                  {t('pageBrowser.filter.facetPriority')}
                </span>
                {PRIORITIES.map((p) => (
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
            </FilterCategoryGroup>

            <FilterCategoryGroup label={t('pageBrowser.filter.pagesGroup')}>
              <FilterMenuItem onClick={() => emit({ type: 'Orphan' })}>
                {t('pageBrowser.filter.facetOrphan')}
              </FilterMenuItem>
              <FilterMenuItem onClick={() => emit({ type: 'Stub' })}>
                {t('pageBrowser.filter.facetStub')}
              </FilterMenuItem>
              <FilterMenuItem onClick={() => emit({ type: 'HasNoInboundLinks' })}>
                {t('pageBrowser.filter.facetHasNoInboundLinks')}
              </FilterMenuItem>
            </FilterCategoryGroup>
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
          <InlineValueEditor
            label={t('pageBrowser.filter.facetPath')}
            value={pathValue}
            onChange={setPathValue}
            onBack={() => setEditor(null)}
            onApply={() => {
              const v = pathValue.trim()
              if (v) emit({ type: 'PathGlob', pattern: v, exclude: false })
            }}
            applyLabel={t('pageBrowser.filter.apply')}
            backLabel={t('pageBrowser.filter.back')}
            placeholder={t('pageBrowser.filter.pathPlaceholder')}
          />
        )}

        {editor === 'property' && (
          <div className="flex flex-col gap-2">
            <span className="px-1 text-xs font-medium">
              {t('pageBrowser.filter.facetHasProperty')}
            </span>
            <Input
              value={propKey}
              onChange={(e) => setPropKey(e.target.value)}
              placeholder={t('pageBrowser.filter.propertyKeyPlaceholder')}
              aria-label={t('pageBrowser.filter.propertyKeyPlaceholder')}
            />
            <Input
              value={propValue}
              onChange={(e) => setPropValue(e.target.value)}
              placeholder={t('pageBrowser.filter.propertyValuePlaceholder')}
              aria-label={t('pageBrowser.filter.propertyValuePlaceholder')}
            />
            <div className="flex justify-between gap-2">
              <Button type="button" variant="ghost" size="xs" onClick={() => setEditor(null)}>
                {t('pageBrowser.filter.back')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  const k = propKey.trim()
                  if (!k) return
                  const v = propValue.trim()
                  emit({
                    type: 'HasProperty',
                    key: k,
                    op: v ? 'eq' : 'exists',
                    value: v ? { type: 'Text', value: v } : null,
                  })
                }}
              >
                {t('pageBrowser.filter.apply')}
              </Button>
            </div>
          </div>
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
}: {
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-ring-visible"
    >
      {children}
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
  return (
    <div className="flex flex-col gap-2">
      <span className="px-1 text-xs font-medium">{label}</span>
      <Input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onApply()
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={onBack}>
          {backLabel}
        </Button>
        <Button type="button" variant="outline" size="xs" onClick={onApply}>
          {applyLabel}
        </Button>
      </div>
    </div>
  )
}
