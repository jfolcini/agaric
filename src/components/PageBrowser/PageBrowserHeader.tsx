/**
 * PageBrowserHeader — presentational header for `PageBrowser`.
 *
 * Owns the create-page form, the search/filter input, and the sort
 * dropdown. All state lives in the orchestrator (`PageBrowser`) and is
 * passed in as props — this sibling is layout-only.
 *
 * Extracted from `PageBrowser.tsx` (MAINT-128).
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
   * Current density mode (PEND-56). Persisted in localStorage via
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
  /** True when a search filter is active (suppresses the "all pages" form). */
  isFiltering?: boolean
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
  isFiltering,
}: PageBrowserHeaderProps): React.ReactElement {
  const { t } = useTranslation()
  // PageBrowser pagination UX (2026-05-14) — small muted text near
  // the search input so users always know roughly how many pages
  // they're looking at. Two forms:
  //  - "312 pages" when no filter is active.
  //  - "23 of 312 matching" when filtering against an alpha set.
  // Hidden when `totalCount` is `undefined` (backend didn't report).
  const countLabel: string | null = (() => {
    if (typeof totalCount !== 'number') return null
    if (isFiltering && typeof filteredCount === 'number') {
      return t('pageBrowser.countFiltered', {
        loaded: filteredCount,
        total: totalCount,
      })
    }
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
      {showSearchAndSort && (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
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
            <TooltipProvider>
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
            </TooltipProvider>
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
          <Select value={density} onValueChange={(v) => onDensityChange(v as DensityMode)}>
            <TooltipProvider>
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
            </TooltipProvider>
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
