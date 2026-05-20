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
  onSubmit: (e: React.SubmitEvent<HTMLFormElement>) => void
  searchLoading: boolean
  typing: boolean
  t: TFunction
  /** PEND-55 — onKeyDown handler that consumes `↑`/`↓` for history recall. */
  onInputKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  /** PEND-55 — toggle row rendered next to the input. */
  toggleRow?: React.ReactNode
  /** PEND-55 — history dropdown rendered beneath the input. */
  historyDropdown?: React.ReactNode
  /** PEND-55 — visible inline error (e.g. invalid regex pattern). */
  inlineError?: string | null
  /** PEND-55 — controls the input's `aria-invalid` attribute. */
  invalid?: boolean
  /** PEND-55 — focus / blur tracking for the history dropdown. */
  onInputFocus?: () => void
  onInputBlur?: () => void
  /** PEND-60 Phase 1 a11y — ARIA combobox-with-listbox attrs applied
   *  to the input (role / aria-expanded / aria-controls /
   *  aria-activedescendant / aria-autocomplete / aria-haspopup).
   *  Computed by the orchestrator from autocomplete-popover state. */
  comboboxAttrs?: React.AriaAttributes & { role?: 'combobox' }
}

export function SearchHeader({
  inputRef,
  query,
  onInputChange,
  onSubmit,
  searchLoading,
  typing,
  t,
  onInputKeyDown,
  toggleRow,
  historyDropdown,
  inlineError,
  invalid,
  onInputFocus,
  onInputBlur,
  comboboxAttrs,
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
          onKeyDown={onInputKeyDown}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          placeholder={t('search.searchPlaceholder')}
          aria-label={t('search.searchLabel')}
          aria-invalid={invalid ? true : undefined}
          aria-errormessage={invalid && inlineError ? 'search-inline-error' : undefined}
          className="flex-1"
          autoFocus
          {...comboboxAttrs}
        />
        {toggleRow}
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
      {inlineError ? (
        <p
          id="search-inline-error"
          role="alert"
          data-testid="search-inline-error"
          className="mt-1 text-xs text-destructive"
        >
          {inlineError}
        </p>
      ) : null}
      {historyDropdown}
    </ViewHeader>
  )
}
