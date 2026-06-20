/**
 * PageBrowserHeader — presentational header for `PageBrowser`.
 *
 * Owns the create-page form, the search/filter input, and the sort
 * dropdown. All state lives in the orchestrator (`PageBrowser`) and is
 * passed in as props — this sibling is layout-only.
 *
 * Extracted from `PageBrowser.tsx`.
 */

import { Plus, Rows3, Search } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { SearchInput } from '@/components/ui/search-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import type { DensityMode } from '../../hooks/usePageBrowserDensity'
import type { SortOption } from '../../hooks/usePageBrowserSort'

export interface PageBrowserHeaderProps {
  formRef: React.RefObject<HTMLFormElement | null>
  newPageInputRef: React.RefObject<HTMLInputElement | null>
  newPageName: string
  onNewPageNameChange: (value: string) => void
  isCreating: boolean
  onSubmit: () => void
  /** When true, renders the search + sort row (the create form is always rendered). */
  showSearchAndSort: boolean
  filterText: string
  onFilterTextChange: (value: string) => void
  sortOption: SortOption
  onSortChange: (value: SortOption) => void
  /**
   * Current density mode. Persisted in localStorage via
   * `usePageBrowserDensity`; passed in by `PageBrowser` orchestrator.
   */
  density: DensityMode
  onDensityChange: (value: DensityMode) => void
  /**
   * Total number of pages available (from the backend `total_count`).
   * When omitted, the count chip is not rendered.
   */
  totalCount?: number | undefined
  /**
   * Number of pages matching the current filter (post-filter).
   * Drives the "X of Y matching" form when a filter is active.
   */
  filteredCount?: number | undefined
  /**
   * True when the free-text search box is non-empty. The
   * text box narrows the loaded set client-side, so its count chip is
   * "X of Y matching" (loaded-narrowed numerator over the filtered
   * total). Distinct from `hasChipFilters` so the count chip can pick a
   * numerator/denominator that share a basis.
   */
  hasTextQuery?: boolean
  /**
   * True when ≥1 compound-filter chip is active. Chips
   * narrow server-side, so their count chip is "{{count}} matching
   * pages" using the filtered total (`totalCount`), avoiding the skew of
   * pairing a loaded numerator with a filtered-total denominator.
   */
  hasChipFilters?: boolean
  /**
   * True when a frontend-only sort (`alphabetical`,
   * `recent`, `created`) is active AND more pages remain to load. The
   * client-side reorder only covers the loaded pages, so we surface a
   * subtle cue near the sort control to set expectations. Never set for
   * `default` or the server-side sorts, nor when fully loaded.
   */
  frontendSortAtScale?: boolean
}

export function PageBrowserHeader({
  formRef,
  newPageInputRef,
  newPageName,
  onNewPageNameChange,
  isCreating,
  onSubmit,
  showSearchAndSort,
  filterText,
  onFilterTextChange,
  sortOption,
  onSortChange,
  density,
  onDensityChange,
  totalCount,
  filteredCount,
  hasTextQuery,
  hasChipFilters,
  frontendSortAtScale,
}: PageBrowserHeaderProps): React.ReactElement {
  const { t } = useTranslation()
  // PageBrowser pagination UX + small muted text near
  // the search input so users always know roughly how many pages
  // they're looking at. Three forms, each with a basis-consistent
  // numerator/denominator:
  //  (a) no chips, no text → "312 pages"            (countAll, the total)
  //  (b) free-text query   → "23 of 312 matching"   (countFiltered: the
  //      loaded set narrowed by the text box over the filtered total)
  //  (c) chips, no text    → "312 matching pages"    (countMatching: the
  //      server-side filtered total — chips narrow server-side, so
  //      pairing a loaded numerator with a filtered-total denominator
  //      would skew; show just the total instead)
  // Hidden when `totalCount` is `undefined` (backend didn't report).
  const countLabel: string | null = (() => {
    if (typeof totalCount !== 'number') return null
    // (b) The free-text box narrows the loaded set client-side, so its
    // numerator is the loaded-narrowed count over the filtered total.
    // Takes precedence over chips because the text box always re-narrows
    // whatever the chips already filtered.
    if (hasTextQuery && typeof filteredCount === 'number') {
      return t('pageBrowser.countFiltered', {
        loaded: filteredCount,
        total: totalCount,
      })
    }
    // (c) Chips active but the text box is empty → the filtered total IS
    // the result count, so a single-number "matching pages" form keeps
    // the basis consistent.
    if (hasChipFilters) {
      return t('pageBrowser.countMatching', { count: totalCount })
    }
    // (a) Unfiltered → the grand total.
    return t('pageBrowser.countAll', { count: totalCount })
  })()
  return (
    <div className="page-browser-header space-y-2">
      {/* Create page form */}
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit()
        }}
        className="flex flex-col sm:flex-row sm:items-center gap-2"
      >
        <Label htmlFor="new-page-name" className="sr-only">
          {t('pageBrowser.createPageInputLabel')}
        </Label>
        <SearchInput
          ref={newPageInputRef}
          id="new-page-name"
          value={newPageName}
          onChange={(e) => onNewPageNameChange(e.target.value)}
          placeholder={t('pageBrowser.newPagePlaceholder')}
          className="flex-1"
        />
        <Button type="submit" variant="outline" disabled={isCreating || !newPageName.trim()}>
          {isCreating ? <Spinner /> : <Plus className="h-4 w-4" />}
          {t('pageBrowser.newPage')}
        </Button>
      </form>

      {/* Search/filter input + sort dropdown */}
      {/* `flex-wrap` lets the search/sort/density controls
          stack onto a second line on narrow viewports instead of
          overflowing. The search field keeps a sensible min-width so it
          never collapses to an unusable sliver before wrapping. */}
      {showSearchAndSort && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[12rem]">
            <Search
              className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            <SearchInput
              value={filterText}
              onChange={(e) => onFilterTextChange(e.target.value)}
              placeholder={t('pageBrowser.searchPlaceholder')}
              className="pl-8"
              aria-label={t('pageBrowser.searchPlaceholder')}
            />
          </div>
          {countLabel != null && (
            <span
              className="text-xs text-muted-foreground whitespace-nowrap"
              data-testid="page-browser-count"
            >
              {countLabel}
            </span>
          )}
          <Select value={sortOption} onValueChange={(v) => onSortChange(v as SortOption)}>
            <Tooltip>
              <TooltipTrigger asChild>
                <SelectTrigger
                  size="sm"
                  className="w-auto min-w-[7rem]"
                  aria-label={t('pageBrowser.sortLabel')}
                >
                  <SelectValue />
                </SelectTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('pageBrowser.sortPersistedTooltip')}</TooltipContent>
            </Tooltip>
            <SelectContent>
              <SelectItem value="alphabetical">{t('pageBrowser.sortAlphabetical')}</SelectItem>
              <SelectItem value="recent">{t('pageBrowser.sortRecent')}</SelectItem>
              <SelectItem value="created">{t('pageBrowser.sortCreated')}</SelectItem>
              <SelectSeparator />
              <SelectItem value="recently-modified">
                {t('pageBrowser.sortRecentlyModified')}
              </SelectItem>
              <SelectItem value="most-linked">{t('pageBrowser.sortMostLinked')}</SelectItem>
              <SelectItem value="most-content">{t('pageBrowser.sortMostContent')}</SelectItem>
              <SelectItem value="default">{t('pageBrowser.sortDefault')}</SelectItem>
            </SelectContent>
          </Select>
          {/* frontend-only sorts reorder just the loaded
              pages; while more remain, surface a muted cue so the user
              knows the visible order isn't the global order yet. */}
          {frontendSortAtScale && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="text-xs text-muted-foreground whitespace-nowrap cursor-default"
                  data-testid="page-browser-frontend-sort-cue"
                >
                  {t('pageBrowser.frontendSortHint')}
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('pageBrowser.frontendSortHintTooltip')}</TooltipContent>
            </Tooltip>
          )}
          <Select value={density} onValueChange={(v) => onDensityChange(v as DensityMode)}>
            <Tooltip>
              <TooltipTrigger asChild>
                <SelectTrigger
                  size="sm"
                  className="w-auto min-w-[7rem]"
                  aria-label={t('pageBrowser.densityLabel')}
                >
                  <Rows3 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <SelectValue />
                </SelectTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('pageBrowser.densityPersistedTooltip')}</TooltipContent>
            </Tooltip>
            <SelectContent>
              <SelectItem value="compact">{t('pageBrowser.densityCompact')}</SelectItem>
              <SelectItem value="regular">{t('pageBrowser.densityRegular')}</SelectItem>
              <SelectItem value="expanded">{t('pageBrowser.densityExpanded')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}
