/**
 * PageBrowserHeader — header for `PageBrowser`.
 *
 * Search first (#5637): the first row is the search input, the sort
 * dropdown, saved views and the New page button that opens the New page
 * dialog; below it, the buttons that open the page-adjacent views (#5269).
 * The search input is the view's primary focus only with a fine pointer, so
 * entering the view on a phone does not raise the keyboard over the list.
 * The list state lives in the orchestrator (`PageBrowser`) and is passed in
 * as props; the view buttons read the navigation store and the trash count
 * themselves.
 */

import { Plus, Search } from 'lucide-react'
import type React from 'react'
import { type RefObject, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { SavedViewsDropdown } from '@/components/PageBrowser/SavedViewsDropdown'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { SearchInput } from '@/components/ui/search-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsTouch } from '@/hooks/useIsTouch'
import type { SortOption } from '@/hooks/usePageBrowserSort'
import { useRegisterPrimaryFocus } from '@/hooks/usePrimaryFocus'
import { useTrashCount } from '@/hooks/useTrashCount'
import { NAV_ITEMS } from '@/lib/nav-items'
import { openNewPageDialog } from '@/lib/overlay-events'
import type { SavedPagesView } from '@/lib/preferences'
import { useNavigationStore } from '@/stores/navigation'

/** Registered on touch so the view falls back to its container, not the search input. */
const NO_PRIMARY_FOCUS: RefObject<HTMLElement | null> = { current: null }

const VIEW_BUTTONS = (['tags', 'graph', 'query', 'templates', 'trash'] as const).flatMap((view) =>
  NAV_ITEMS.filter((item) => item.id === view),
)

export interface PageBrowserHeaderProps {
  /**
   * When true, renders the count, sort and saved views. Search and New page
   * always render: search is the view's primary focus, taken before the
   * first page load lands.
   */
  showSortAndViews: boolean
  filterText: string
  onFilterTextChange: (value: string) => void
  sortOption: SortOption
  onSortChange: (value: SortOption) => void
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
  /** Saved Pages views (#2003 piece 1) — sort/filters snapshots. */
  savedViews: SavedPagesView[]
  /** The saved view matching the current tuple, or `null` if none matches. */
  activeSavedView: SavedPagesView | null
  onApplySavedView: (view: SavedPagesView) => void
  onDeleteSavedView: (view: SavedPagesView) => void
  onSaveCurrentView: (name: string) => void
}

export function PageBrowserHeader({
  showSortAndViews,
  filterText,
  onFilterTextChange,
  sortOption,
  onSortChange,
  totalCount,
  filteredCount,
  hasTextQuery,
  hasChipFilters,
  savedViews,
  activeSavedView,
  onApplySavedView,
  onDeleteSavedView,
  onSaveCurrentView,
}: PageBrowserHeaderProps): React.ReactElement {
  const { t } = useTranslation()
  const setView = useNavigationStore((s) => s.setView)
  const trashCount = useTrashCount()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const isTouch = useIsTouch()
  useRegisterPrimaryFocus(isTouch ? NO_PRIMARY_FOCUS : searchInputRef)
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
      {/* `flex-wrap` lets the controls stack onto a second line on narrow
          viewports instead of overflowing. The search field keeps a sensible
          min-width so it never collapses to an unusable sliver before wrapping. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <Search
            className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <SearchInput
            ref={searchInputRef}
            value={filterText}
            onChange={(e) => onFilterTextChange(e.target.value)}
            placeholder={t('pageBrowser.searchPlaceholder')}
            className="pl-8"
            aria-label={t('pageBrowser.searchPlaceholder')}
          />
        </div>
        {showSortAndViews && (
          <>
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
                <SelectItem value="recently-modified">
                  {t('pageBrowser.sortRecentlyModified')}
                </SelectItem>
                <SelectItem value="most-linked">{t('pageBrowser.sortMostLinked')}</SelectItem>
                <SelectItem value="most-content">{t('pageBrowser.sortMostContent')}</SelectItem>
              </SelectContent>
            </Select>
            <SavedViewsDropdown
              views={savedViews}
              activeView={activeSavedView}
              onApply={onApplySavedView}
              onDelete={onDeleteSavedView}
              onSaveCurrentView={onSaveCurrentView}
            />
          </>
        )}
        {/* Icon-only below `sm`, so on a phone it can sit beside sort and
            saved views. */}
        <Button
          className="ml-auto max-sm:w-9 max-sm:px-0 max-sm:[@media(pointer:coarse)]:w-11"
          aria-label={t('pageBrowser.newPage')}
          onClick={() => openNewPageDialog()}
        >
          <Plus />
          <span className="max-sm:sr-only">{t('pageBrowser.newPage')}</span>
        </Button>
      </div>

      <div className="flex items-center gap-1">
        {VIEW_BUTTONS.map(({ id: view, icon: Icon, labelKey }) => {
          const label = t(labelKey)
          const showTrashCount = view === 'trash' && trashCount > 0
          return (
            <IconButton
              key={view}
              variant="ghost"
              className="relative"
              tooltip={label}
              // The name replaces the button's content for assistive tech, so
              // the count the badge shows has to be in the name as well.
              ariaLabel={
                showTrashCount
                  ? t('pageBrowser.viewButtons.trashWithCount', { count: trashCount })
                  : label
              }
              onClick={() => setView(view)}
            >
              <Icon />
              {showTrashCount && (
                <Badge tone="secondary" size="xs" className="absolute -top-1 -right-1">
                  {trashCount}
                </Badge>
              )}
            </IconButton>
          )
        })}
      </div>
    </div>
  )
}
