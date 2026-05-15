/**
 * SearchHeader — input form + activity indicators for SearchPanel.
 *
 * PEND-30 Phase 3b — extracted from `SearchPanel.tsx` to keep the
 * orchestrator under 450 LOC. Owns only the `ViewHeader`-hosted form:
 * the `SearchInput`, submit button, and typing/searching indicators.
 *
 * Debouncing logic stays in the parent; this component is a pure view.
 * The `ref` is forwarded to the underlying `SearchInput` so the parent
 * can register it with `useRegisterPrimaryFocus` and trigger
 * auto-focus.
 */

import type { TFunction } from 'i18next'
import type React from 'react'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { Spinner } from '@/components/ui/spinner'
import { ViewHeader } from '../ViewHeader'

export interface SearchHeaderProps {
  inputRef: React.RefObject<HTMLInputElement | null>
  query: string
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onSubmit: (e: React.FormEvent) => void
  searchLoading: boolean
  typing: boolean
  t: TFunction
}

export function SearchHeader({
  inputRef,
  query,
  onInputChange,
  onSubmit,
  searchLoading,
  typing,
  t,
}: SearchHeaderProps): React.ReactElement {
  return (
    <ViewHeader>
      {/* biome-ignore lint/a11y/useSemanticElements: jsdom doesn't support <search> element */}
      <form
        onSubmit={onSubmit}
        role="search"
        className="search-panel-header flex flex-col sm:flex-row sm:items-center gap-2"
      >
        <SearchInput
          ref={inputRef}
          value={query}
          onChange={onInputChange}
          placeholder={t('search.searchPlaceholder')}
          aria-label={t('search.searchLabel')}
          className="flex-1"
          autoFocus
        />
        <Button type="submit" variant="outline" disabled={!query.trim()}>
          {t('search.searchButton')}
        </Button>
        {searchLoading ? (
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="search-fetching-indicator"
          >
            <Spinner /> {t('search.searching')}
          </span>
        ) : typing ? (
          <span className="text-xs text-muted-foreground" data-testid="search-typing-indicator">
            {t('search.typing')}
          </span>
        ) : null}
      </form>
    </ViewHeader>
  )
}
