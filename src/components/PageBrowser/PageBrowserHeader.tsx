/**
 * PageBrowserHeader — presentational header for `PageBrowser`.
 *
 * Owns the create-page form, the search/filter input, and the sort
 * dropdown. All state lives in the orchestrator (`PageBrowser`) and is
 * passed in as props — this sibling is layout-only.
 *
 * Extracted from `PageBrowser.tsx` (MAINT-128).
 */

import { Plus, Search } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { SearchInput } from '@/components/ui/search-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
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
}: PageBrowserHeaderProps): React.ReactElement {
  const { t } = useTranslation()
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
          <Select value={sortOption} onValueChange={(v) => onSortChange(v as SortOption)}>
            <SelectTrigger
              size="sm"
              className="w-auto min-w-[7rem]"
              aria-label={t('pageBrowser.sortLabel')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="alphabetical">{t('pageBrowser.sortAlphabetical')}</SelectItem>
              <SelectItem value="recent">{t('pageBrowser.sortRecent')}</SelectItem>
              <SelectItem value="created">{t('pageBrowser.sortCreated')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}
