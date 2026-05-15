/**
 * SearchFilters — filter chip bar for SearchPanel.
 *
 * PEND-30 Phase 3b — extracted from `SearchPanel.tsx` (590 → ≤450 LOC
 * orchestrator). Owns only the rendering of the page-filter pill, tag
 * pills, page/tag picker popovers, and the "clear all" button.
 *
 * State stays in the parent (the `searchFilterReducer` + the two
 * `usePopoverEntity` hooks); this component is a pure view. Action
 * shapes for `dispatchFilter` are unchanged (audited in session 694).
 */

import type { TFunction } from 'i18next'
import type React from 'react'
import { FilterPill } from '@/components/ui/filter-pill'
import { cn } from '@/lib/utils'
import type { BlockRow, TagCacheRow } from '../../lib/tauri'
import { SearchablePopover } from '../SearchablePopover'
import type { SearchFilterAction, SearchFilterState } from './searchFilterReducer'
import { hasActiveFilters } from './searchFilterReducer'
import type { PopoverEntityState } from './usePopoverEntity'

export interface SearchFiltersProps {
  filterState: SearchFilterState
  dispatchFilter: React.Dispatch<SearchFilterAction>
  pagePopover: PopoverEntityState<BlockRow>
  tagPopover: PopoverEntityState<TagCacheRow>
  onSelectPage: (page: BlockRow) => void
  onSelectTag: (tag: TagCacheRow) => void
  t: TFunction
}

export function SearchFilters({
  filterState,
  dispatchFilter,
  pagePopover,
  tagPopover,
  onSelectPage,
  onSelectTag,
  t,
}: SearchFiltersProps): React.ReactElement {
  const { filterPageId, filterPageTitle, filterTagIds, filterTagNames } = filterState
  const hasFilters = hasActiveFilters(filterState)

  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset is for forms, not filter chip groups
    <div
      className={cn(
        'flex flex-wrap items-center gap-2',
        hasFilters && 'rounded-lg border border-primary/30 bg-primary/5 p-2',
      )}
      data-testid="filter-chip-bar"
      role="group"
      aria-label={t('search.filtersActive')}
    >
      {/* UX review Tier 1 item 7 — filter chips migrated to the shared
          `FilterPill` primitive (was: ad-hoc `<Badge>` + X button).
          Wraps the badge text in a `data-search-chip-text` span so the
          existing `getByText('in: …')` assertions keep matching after
          the wrap. */}
      {filterPageId && filterPageTitle && (
        <FilterPill
          label={t('search.inPage', { name: filterPageTitle })}
          removeAriaLabel={t('search.removePageFilter')}
          onRemove={() => dispatchFilter({ type: 'clear-page-filter' })}
        />
      )}

      {filterTagNames.map((name, index) => (
        <FilterPill
          key={filterTagIds[index]}
          label={`#${name}`}
          removeAriaLabel={t('search.removeTagFilter', { name })}
          onRemove={() => dispatchFilter({ type: 'remove-tag-filter', index })}
        />
      ))}

      <SearchablePopover<BlockRow>
        open={pagePopover.open}
        onOpenChange={pagePopover.setOpen}
        items={pagePopover.suggestions}
        isLoading={pagePopover.loading}
        onSelect={onSelectPage}
        renderItem={(page) => page.content ?? 'Untitled'}
        keyExtractor={(page) => page.id}
        searchValue={pagePopover.query}
        onSearchChange={pagePopover.setQuery}
        searchPlaceholder={t('search.searchPages')}
        emptyMessage={t('search.noPagesFound')}
        triggerLabel={t('search.addPage')}
        triggerDisabled={filterPageId !== null}
        triggerDisabledReason={t('search.addPageDisabledReason')}
      />

      <SearchablePopover<TagCacheRow>
        open={tagPopover.open}
        onOpenChange={tagPopover.setOpen}
        items={tagPopover.suggestions}
        isLoading={tagPopover.loading}
        onSelect={onSelectTag}
        renderItem={(tag) => `#${tag.name}`}
        keyExtractor={(tag) => tag.tag_id}
        searchValue={tagPopover.query}
        onSearchChange={tagPopover.setQuery}
        searchPlaceholder={t('search.searchTags')}
        emptyMessage={t('search.noTagsFound')}
        triggerLabel={t('search.addTag')}
        isItemDisabled={(tag) => filterTagIds.includes(tag.tag_id)}
      />

      {hasFilters && (
        <button
          type="button"
          onClick={() => dispatchFilter({ type: 'clear-all' })}
          className="text-xs text-muted-foreground hover:text-foreground underline ml-1 rounded-sm focus-ring-visible"
        >
          {t('search.clearAll')}
        </button>
      )}
    </div>
  )
}
