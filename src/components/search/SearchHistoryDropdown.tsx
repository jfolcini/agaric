/**
 * PEND-55 — Search history dropdown.
 *
 * Listbox of recent submitted queries, shown beneath the input when
 * the input is empty and focused. Click → fills the input + submits.
 * `Clear history` footer wipes the per-space MRU list.
 *
 * The dropdown is unconditionally rendered (visibility controlled by
 * the `visible` prop) so the parent can drive it from any combination
 * of focus + emptiness without coupling to popover state.
 *
 * Accessibility:
 *   - `role="listbox"` on the container, `role="option"` on each row.
 *   - `aria-label` on the listbox names the section.
 *   - The "Clear history" control sits in a footer outside the
 *     listbox so it doesn't pollute option counts.
 *   - When `entries.length === 0`, an empty-state message replaces
 *     the listbox; no `option` elements are rendered.
 */

import { Clock, Trash2 } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface SearchHistoryDropdownProps {
  entries: ReadonlyArray<string>
  visible: boolean
  /** Pick a history entry — fills the input and triggers a search. */
  onPick: (query: string) => void
  /** Wipe the per-space MRU list. */
  onClear: () => void
}

export function SearchHistoryDropdown({
  entries,
  visible,
  onPick,
  onClear,
}: SearchHistoryDropdownProps): React.ReactElement | null {
  const { t } = useTranslation()
  if (!visible) return null

  const isEmpty = entries.length === 0
  const listboxLabel = t('search.history.title')

  return (
    <div
      data-testid="search-history-dropdown"
      className="search-history-dropdown rounded-md border border-input bg-background shadow-sm"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <Clock className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{listboxLabel}</span>
      </div>
      {isEmpty ? (
        <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="search-history-empty">
          {t('search.history.empty')}
        </p>
      ) : (
        <div
          role="listbox"
          aria-label={listboxLabel}
          data-testid="search-history-list"
          className="m-0 list-none p-0"
        >
          {entries.map((entry, idx) => (
            <div
              // The query string is the natural key. Duplicates can't
              // occur in this list (the store dedupes on insert).
              key={entry}
              role="option"
              aria-selected={false}
              tabIndex={-1}
              data-testid={`search-history-entry-${idx}`}
              onClick={() => onPick(entry)}
              // PEND-73 Phase 3.U5 — preventDefault on mousedown keeps
              // the search input focused through the click. Without
              // this, the input blurs first (mousedown fires before
              // click), the dropdown unmounts via its visibility gate,
              // and the click then lands on nothing. The historical
              // SearchPanel mitigation deferred the blur via
              // `setTimeout(() => setInputFocused(false), 150)` — that
              // line is being deleted in the same commit.
              onMouseDown={(e) => {
                e.preventDefault()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onPick(entry)
                }
              }}
              className={cn(
                'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm',
                'hover:bg-accent/30 active:bg-accent/40 transition-colors',
                'truncate',
              )}
              aria-label={t('search.history.entryLabel', { query: entry })}
            >
              <span className="flex-1 truncate font-mono">{entry}</span>
            </div>
          ))}
        </div>
      )}
      {!isEmpty && (
        <div className="border-t border-input">
          <button
            type="button"
            data-testid="search-history-clear"
            onClick={onClear}
            // PEND-73 Phase 3.U5 — sibling rationale: keep input
            // focused through the click so the dropdown's visibility
            // gate doesn't unmount it before onClick fires.
            onMouseDown={(e) => {
              e.preventDefault()
            }}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground',
              'hover:bg-accent/30 transition-colors',
              'focus-ring-visible rounded-none',
            )}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('search.history.clear')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
