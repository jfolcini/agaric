/**
 * AddFilterRow — inline form row for picking a filter category and
 * entering its value(s) before applying it to the backlink query.
 *
 * Extracted from BacklinkFilterBuilder.tsx for file organization
 * (MAINT-96).  Per-category form bodies are split into sibling files
 * under `categories/` (MAINT-128) — each form owns its own state
 * slots and exposes a `getState()` slice via `useImperativeHandle`.
 * AddFilterRow remains the orchestrator: it owns the category
 * selector, holds a single ref to the currently mounted form, and
 * dispatches Apply through the module-level `buildFilterForCategory`
 * switch.
 */

import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { BacklinkFilter } from '../../lib/tauri'
import { ContainsFilterForm } from './categories/ContainsFilterForm'
import { DateFilterForm } from './categories/DateFilterForm'
import { HasTagFilterForm } from './categories/HasTagFilterForm'
import { PriorityFilterForm } from './categories/PriorityFilterForm'
import { PropertyEmptyFilterForm } from './categories/PropertyEmptyFilterForm'
import { PropertyFilterForm } from './categories/PropertyFilterForm'
import { PropertySetFilterForm } from './categories/PropertySetFilterForm'
import { StatusFilterForm } from './categories/StatusFilterForm'
import { TagPrefixFilterForm } from './categories/TagPrefixFilterForm'
import { TypeFilterForm } from './categories/TypeFilterForm'
import type { BuildState, FilterFormHandle } from './categories/types'

type FilterCategory =
  | 'type'
  | 'status'
  | 'priority'
  | 'contains'
  | 'property'
  | 'date'
  | 'property-set'
  | 'property-empty'
  | 'has-tag'
  | 'tag-prefix'

// ---------------------------------------------------------------------------
// Per-category filter builders (extracted from handleApply to reduce complexity)
// ---------------------------------------------------------------------------

type BuildResult = { filter: BacklinkFilter } | { error: string }
// biome-ignore lint/suspicious/noExplicitAny: TFunction overload set is too complex
type TFunc = (...args: any[]) => any

function buildTypeFilter(s: BuildState): BuildResult {
  return { filter: { type: 'BlockType', block_type: s.blockType } }
}

function buildStatusFilter(s: BuildState): BuildResult {
  return { filter: { type: 'PropertyText', key: 'todo', op: 'Eq', value: s.statusValue } }
}

function buildPriorityFilter(s: BuildState): BuildResult {
  return { filter: { type: 'PropertyText', key: 'priority', op: 'Eq', value: s.priorityValue } }
}

function buildContainsFilter(s: BuildState, t: TFunc): BuildResult {
  const query = s.containsQuery.trim()
  if (!query) return { error: t('backlink.searchTextRequired') }
  return { filter: { type: 'Contains', query } }
}

function buildPropertyFilter(s: BuildState, t: TFunc): BuildResult {
  const trimmedKey = s.propKey.trim()
  if (!trimmedKey) return { error: t('backlink.propertyKeyRequired') }
  if (s.propertyKeys.length > 0 && !s.propertyKeys.includes(trimmedKey)) {
    return { error: t('backlink.propertyNotFound', { key: trimmedKey }) }
  }
  if (s.propType === 'num') {
    const numVal = Number.parseFloat(s.propValue)
    if (!Number.isFinite(numVal)) return { error: t('backlink.invalidNumber') }
    return { filter: { type: 'PropertyNum', key: s.propKey, op: s.propOp, value: numVal } }
  }
  if (s.propType === 'date') {
    if (!s.propValue) return { error: t('backlink.dateValueRequired') }
    return {
      filter: { type: 'PropertyDate', key: s.propKey, op: s.propOp, value: s.propValue },
    }
  }
  return { filter: { type: 'PropertyText', key: s.propKey, op: s.propOp, value: s.propValue } }
}

function buildDateFilter(s: BuildState, t: TFunc): BuildResult {
  if (!s.dateAfter && !s.dateBefore) return { error: t('backlink.dateRangeRequired') }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/
  if (s.dateAfter && !dateRe.test(s.dateAfter)) return { error: t('backlink.invalidDateAfter') }
  if (s.dateBefore && !dateRe.test(s.dateBefore)) {
    return { error: t('backlink.invalidDateBefore') }
  }
  return {
    filter: {
      type: 'CreatedInRange',
      after: s.dateAfter || null,
      before: s.dateBefore || null,
    },
  }
}

function buildPropertySetFilter(s: BuildState, t: TFunc): BuildResult {
  if (!s.propSetKey.trim()) return { error: t('backlink.propertyKeyRequired') }
  return { filter: { type: 'PropertyIsSet', key: s.propSetKey } }
}

function buildPropertyEmptyFilter(s: BuildState, t: TFunc): BuildResult {
  if (!s.propEmptyKey.trim()) return { error: t('backlink.propertyKeyRequired') }
  return { filter: { type: 'PropertyIsEmpty', key: s.propEmptyKey } }
}

function buildHasTagFilter(s: BuildState, t: TFunc): BuildResult {
  const id = s.tagValue.trim()
  if (!id) return { error: t('backlink.tagRequired') }
  return { filter: { type: 'HasTag', tag_id: id } }
}

function buildTagPrefixFilter(s: BuildState, t: TFunc): BuildResult {
  const prefix = s.prefixValue.trim()
  if (!prefix) return { error: t('backlink.tagPrefixRequired') }
  return { filter: { type: 'HasTagPrefix', prefix } }
}

function buildFilterForCategory(
  category: FilterCategory,
  state: BuildState,
  t: TFunc,
): BuildResult {
  switch (category) {
    case 'type':
      return buildTypeFilter(state)
    case 'status':
      return buildStatusFilter(state)
    case 'priority':
      return buildPriorityFilter(state)
    case 'contains':
      return buildContainsFilter(state, t)
    case 'property':
      return buildPropertyFilter(state, t)
    case 'date':
      return buildDateFilter(state, t)
    case 'property-set':
      return buildPropertySetFilter(state, t)
    case 'property-empty':
      return buildPropertyEmptyFilter(state, t)
    case 'has-tag':
      return buildHasTagFilter(state, t)
    case 'tag-prefix':
      return buildTagPrefixFilter(state, t)
  }
}

// ---------------------------------------------------------------------------
// Add-filter row (inline form)
// ---------------------------------------------------------------------------

export interface AddFilterRowProps {
  propertyKeys: string[]
  tags: Array<{ id: string; name: string }>
  onApply: (filter: BacklinkFilter) => void
  onCancel: () => void
}

const DEFAULT_BUILD_STATE: Omit<BuildState, 'propertyKeys'> = {
  blockType: 'content',
  statusValue: 'TODO',
  priorityValue: '1',
  containsQuery: '',
  propKey: '',
  propOp: 'Eq',
  propValue: '',
  propType: 'text',
  dateAfter: '',
  dateBefore: '',
  propSetKey: '',
  propEmptyKey: '',
  tagValue: '',
  prefixValue: '',
}

export function AddFilterRow({
  propertyKeys,
  tags,
  onApply,
  onCancel,
}: AddFilterRowProps): React.ReactElement {
  const { t } = useTranslation()
  const [category, setCategory] = useState<FilterCategory | ''>('')
  const formRef = useRef<FilterFormHandle | null>(null)

  const handleApply = useCallback(() => {
    if (!category) return
    const slice = formRef.current?.getState() ?? {}
    const state: BuildState = {
      ...DEFAULT_BUILD_STATE,
      ...slice,
      propertyKeys,
    }
    const result = buildFilterForCategory(category, state, t)
    if ('filter' in result) {
      onApply(result.filter)
    } else {
      toast.error(result.error)
    }
  }, [category, propertyKeys, onApply, t])

  return (
    <form
      className="add-filter-row flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/50 p-2 [@media(pointer:coarse)]:flex-col [@media(pointer:coarse)]:items-stretch"
      aria-label={t('backlink.addFilterLabel')}
      onSubmit={(e) => {
        e.preventDefault()
        if (category) handleApply()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <Select
        value={category || '__none__'}
        onValueChange={(val) => setCategory(val === '__none__' ? '' : (val as FilterCategory))}
      >
        <SelectTrigger size="sm" aria-label={t('backlink.filterCategoryLabel')}>
          <SelectValue placeholder={t('backlink.selectFilter')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{t('backlink.selectFilter')}</SelectItem>
          <SelectItem value="type">{t('backlink.typeOption')}</SelectItem>
          <SelectItem value="status">{t('backlink.statusOption')}</SelectItem>
          <SelectItem value="priority">{t('backlink.priorityOption')}</SelectItem>
          <SelectItem value="contains">{t('backlink.containsOption')}</SelectItem>
          <SelectItem value="property">{t('backlink.propertyOption')}</SelectItem>
          <SelectItem value="date">{t('backlink.createdDateOption')}</SelectItem>
          <SelectItem value="property-set">{t('backlink.propertyIsSetOption')}</SelectItem>
          <SelectItem value="property-empty">{t('backlink.propertyIsEmptyOption')}</SelectItem>
          <SelectItem value="has-tag">{t('backlink.hasTagOption')}</SelectItem>
          <SelectItem value="tag-prefix">{t('backlink.tagPrefixOption')}</SelectItem>
        </SelectContent>
      </Select>

      {category === 'type' && <TypeFilterForm ref={formRef} />}
      {category === 'status' && <StatusFilterForm ref={formRef} />}
      {category === 'priority' && <PriorityFilterForm ref={formRef} />}
      {category === 'contains' && <ContainsFilterForm ref={formRef} />}
      {category === 'property' && <PropertyFilterForm ref={formRef} propertyKeys={propertyKeys} />}
      {category === 'date' && <DateFilterForm ref={formRef} />}
      {category === 'property-set' && (
        <PropertySetFilterForm ref={formRef} propertyKeys={propertyKeys} />
      )}
      {category === 'property-empty' && (
        <PropertyEmptyFilterForm ref={formRef} propertyKeys={propertyKeys} />
      )}
      {category === 'has-tag' && <HasTagFilterForm ref={formRef} tags={tags} />}
      {category === 'tag-prefix' && <TagPrefixFilterForm ref={formRef} />}

      {category && (
        <Button
          variant="default"
          size="xs"
          className="h-7 text-xs [@media(pointer:coarse)]:w-full"
          onClick={handleApply}
          aria-label={t('backlink.applyFilterLabel')}
        >
          {t('backlink.applyButton')}
        </Button>
      )}
      <Button
        variant="ghost"
        size="xs"
        className="h-7 text-xs [@media(pointer:coarse)]:w-full"
        onClick={onCancel}
        aria-label={t('backlink.cancelAddingFilterLabel')}
      >
        {t('backlink.cancelButton')}
      </Button>
    </form>
  )
}
