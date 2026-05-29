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
 *   - CR-A11Y (#151) — the listbox carries `aria-activedescendant`
 *     pointing at the active row id, matching the established
 *     `VirtualizedResultListbox` convention. The owning input keeps DOM
 *     focus (combobox-with-listbox pattern); Up/Down rove `activeIndex`
 *     and Delete/Backspace on the input removes the active row (see
 *     `SearchPanel.handleInputKeyDown`). This makes per-row delete
 *     keyboard-reachable for AT users — previously only the bulk
 *     "Clear history" action was.
 *   - The "Clear history" control sits in a footer outside the
 *     listbox so it doesn't pollute option counts.
 *   - When `entries.length === 0`, an empty-state message replaces
 *     the listbox; no `option` elements are rendered.
 */

import { Clock, PauseCircle, PlayCircle, Trash2, X } from 'lucide-react'
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
  /** UX-11 — remove a single entry from the per-space MRU list. */
  onRemoveEntry: (query: string) => void
  /**
   * UX-11 — whether new submissions are being recorded. When `false`,
   * the footer shows the "history is off" notice and an Enable toggle;
   * existing entries (if any) still render so they can be picked/removed.
   */
  historyEnabled: boolean
  /** UX-11 — flip the record-history preference. */
  onToggleEnabled: () => void
  /**
   * PEND-73 Phase 3.U2 — id attached to the inner `role="listbox"` so
   * the owning input can wire `aria-controls` to it. Stable per
   * dropdown instance; supplied by the parent so two dropdowns on the
   * same page (e.g. desktop palette vs mobile sheet) don't collide.
   */
  listboxId: string
  /**
   * Index of the currently-active history row driven by the parent's
   * `useSearchHistoryCycling.activeIndex`. `-1` means none active
   * (typing). Renders `aria-selected={idx === activeIndex}` per row.
   */
  activeIndex: number
}

/** Stable per-row id. Pure function of the listbox id + row index. */
export function searchHistoryRowId(listboxId: string, index: number): string {
  return `${listboxId}-opt-${index}`
}

export function SearchHistoryDropdown({
  entries,
  visible,
  onPick,
  onClear,
  onRemoveEntry,
  historyEnabled,
  onToggleEnabled,
  listboxId,
  activeIndex,
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
      {isEmpty && historyEnabled ? (
        <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="search-history-empty">
          {t('search.history.empty')}
        </p>
      ) : null}
      {!isEmpty && (
        <div
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- custom combobox-popup listbox driven by aria-activedescendant; <datalist>/<select> can't host the clickable history rows
          role="listbox"
          id={listboxId}
          aria-label={listboxLabel}
          // CR-A11Y (#151) — point at the active row id so screen readers
          // announce the roving selection. Matches the
          // `VirtualizedResultListbox` convention (the result-list
          // `role="listbox"` hosts `aria-activedescendant`). `undefined`
          // when no row is active so no stale descendant is announced.
          aria-activedescendant={
            activeIndex >= 0 ? searchHistoryRowId(listboxId, activeIndex) : undefined
          }
          // The search input retains DOM focus (combobox pattern); the listbox
          // hosts `aria-activedescendant`, so it needs a tabIndex to satisfy
          // `useAriaActivedescendantWithTabindex`. `-1` keeps it out of the tab
          // order while remaining a valid activedescendant host.
          tabIndex={-1}
          data-testid="search-history-list"
          className="m-0 list-none p-0"
        >
          {entries.map((entry, idx) => (
            <div
              // FE-13 — key on the positional row id (same basis as the
              // aria id) rather than the entry text, so view correctness
              // doesn't depend on the store's case-sensitive dedup.
              key={searchHistoryRowId(listboxId, idx)}
              id={searchHistoryRowId(listboxId, idx)}
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role="option" on the clickable history-row div; native <option> can't host the rich row content + click handling
              role="option"
              aria-selected={idx === activeIndex}
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
                // UX-11 — Delete/Backspace removes the row (mirrors the
                // FilterPill convention). The real keyboard path drives
                // this through the input's history-cycling handler; this
                // covers a directly-focused row too.
                if (e.key === 'Delete' || e.key === 'Backspace') {
                  e.preventDefault()
                  onRemoveEntry(entry)
                }
              }}
              className={cn(
                'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm [@media(pointer:coarse)]:min-h-11',
                'hover:bg-accent/30 active:bg-accent/40 transition-colors',
                'truncate',
              )}
              aria-label={t('search.history.entryLabel', { query: entry })}
            >
              <span className="flex-1 truncate font-mono">{entry}</span>
              {/* UX-11 — per-row delete as a pointer affordance. It is
                  `aria-hidden` on purpose: a real <button> inside
                  `role="option"` trips axe's nested-interactive rule
                  (measured), and a listbox option must not own focusable
                  controls. AT users delete in bulk via "Clear history"
                  below; the Delete/Backspace handler on the row covers a
                  directly-focused row. */}
              <span
                aria-hidden="true"
                data-testid={`search-history-remove-${idx}`}
                title={t('search.history.removeEntry', { query: entry })}
                onClick={(e) => {
                  e.stopPropagation()
                  onRemoveEntry(entry)
                }}
                onMouseDown={(e) => {
                  // Don't let the row's mousedown-preventDefault swallow
                  // this, and stop the row's onClick (pick) from firing.
                  e.preventDefault()
                  e.stopPropagation()
                }}
                className={cn(
                  'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full p-1',
                  'text-muted-foreground hover:bg-muted hover:text-foreground',
                  '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11',
                )}
              >
                <X className="h-3 w-3" />
              </span>
            </div>
          ))}
        </div>
      )}
      {!historyEnabled && (
        <p
          className="px-3 py-2 text-xs italic text-muted-foreground"
          data-testid="search-history-disabled-notice"
        >
          {t('search.history.disabledNotice')}
        </p>
      )}
      <div className="border-t border-input">
        {!isEmpty && (
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
              'flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground [@media(pointer:coarse)]:min-h-11',
              'hover:bg-accent/30 transition-colors',
              'focus-ring-visible rounded-none',
            )}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('search.history.clear')}</span>
          </button>
        )}
        <button
          type="button"
          data-testid="search-history-toggle"
          aria-pressed={!historyEnabled}
          onClick={onToggleEnabled}
          onMouseDown={(e) => {
            e.preventDefault()
          }}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground [@media(pointer:coarse)]:min-h-11',
            'hover:bg-accent/30 transition-colors',
            'focus-ring-visible rounded-none',
          )}
        >
          {historyEnabled ? (
            <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>{historyEnabled ? t('search.history.disable') : t('search.history.enable')}</span>
        </button>
      </div>
    </div>
  )
}
