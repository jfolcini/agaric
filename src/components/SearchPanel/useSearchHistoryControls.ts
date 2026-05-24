/**
 * useSearchHistoryControls — the SearchPanel search-history surface.
 *
 * PEND-58g FE-A18 — extracted from the SearchPanel god-component. Owns the
 * per-space history store wiring (entries, push, clear, per-row delete, the
 * enable/disable toggle), the ArrowUp/Down recall cycling machine, the
 * listbox id for combobox a11y, and the recall/clear/remove/toggle handlers.
 * Behaviour-preserving lift: the handler bodies are unchanged from the
 * inline version.
 *
 * The query-input setters (`setQueryAndCaret`, `setDebouncedQuery`, …) and
 * the shared `debounced` callback stay owned by SearchPanel and are passed
 * in, because they are shared with the non-history input handlers.
 */
import { useCallback, useId } from 'react'
import { useSearchHistoryCycling } from '../../hooks/useSearchHistoryCycling'
import { selectHistoryForSpace, useSearchHistoryStore } from '../../stores/search-history'

export interface UseSearchHistoryControlsOptions {
  currentSpaceId: string | null
  /** Live query string — feeds the recall cycling + dropdown visibility. */
  query: string
  /** Sets the controlled input value (and pending caret). */
  setQueryAndCaret: (value: string, caret?: number) => void
  setDebouncedQuery: (value: string) => void
  setSearched: (value: boolean) => void
  setTyping: (value: boolean) => void
  /** The shared debounce controller; recall cancels any pending search. */
  debounced: { cancel: () => void }
}

export interface UseSearchHistoryControlsValue {
  historyEntries: readonly string[]
  historyEnabled: boolean
  /** Push on submit; also re-used by `handlePickHistory`. */
  pushHistory: (spaceId: string | null | undefined, query: string) => void
  cycling: ReturnType<typeof useSearchHistoryCycling>
  historyListboxId: string
  handlePickHistory: (entry: string) => void
  handleClearHistory: () => void
  handleRemoveHistory: (entry: string) => void
  handleToggleHistoryEnabled: () => void
}

export function useSearchHistoryControls({
  currentSpaceId,
  query,
  setQueryAndCaret,
  setDebouncedQuery,
  setSearched,
  setTyping,
  debounced,
}: UseSearchHistoryControlsOptions): UseSearchHistoryControlsValue {
  // PEND-55 — history store + cycling hook.
  const historyEntries = useSearchHistoryStore((s) => selectHistoryForSpace(s, currentSpaceId))
  const pushHistory = useSearchHistoryStore((s) => s.push)
  const clearHistory = useSearchHistoryStore((s) => s.clear)
  // UX-11 — per-row delete + record-history toggle.
  const removeHistoryEntry = useSearchHistoryStore((s) => s.removeEntry)
  const historyEnabled = useSearchHistoryStore((s) => s.historyEnabled)
  const setHistoryEnabled = useSearchHistoryStore((s) => s.setHistoryEnabled)
  const cycling = useSearchHistoryCycling(historyEntries, query, setQueryAndCaret)
  // PEND-73 Phase 3.U2 — stable id for the history listbox so the owning
  // input can wire `aria-controls` and `aria-activedescendant`.
  const historyListboxId = useId()

  const handlePickHistory = useCallback(
    (entry: string) => {
      setQueryAndCaret(entry)
      setDebouncedQuery(entry)
      setSearched(true)
      pushHistory(currentSpaceId, entry)
      debounced.cancel()
      setTyping(false)
    },
    [
      currentSpaceId,
      debounced,
      pushHistory,
      setQueryAndCaret,
      setDebouncedQuery,
      setSearched,
      setTyping,
    ],
  )

  const handleClearHistory = useCallback(() => {
    clearHistory(currentSpaceId)
  }, [clearHistory, currentSpaceId])

  const handleRemoveHistory = useCallback(
    (entry: string) => {
      removeHistoryEntry(currentSpaceId, entry)
    },
    [currentSpaceId, removeHistoryEntry],
  )

  const handleToggleHistoryEnabled = useCallback(() => {
    setHistoryEnabled(!historyEnabled)
  }, [historyEnabled, setHistoryEnabled])

  return {
    historyEntries,
    historyEnabled,
    pushHistory,
    cycling,
    historyListboxId,
    handlePickHistory,
    handleClearHistory,
    handleRemoveHistory,
    handleToggleHistoryEnabled,
  }
}
