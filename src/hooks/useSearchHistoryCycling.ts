/**
 * PEND-55 — `↑` / `↓` recall through the search history MRU list.
 *
 * Behaviour mirrors the browser address bar / shell history:
 *
 * - `↑` when input is empty → fill with the most-recent entry
 *   (`history[0]`). Each subsequent `↑` walks backward through older
 *   entries; pressing past the oldest entry is a no-op.
 * - `↓` walks toward the newest entry; past the newest entry the input
 *   clears and the state resets.
 * - Any non-arrow keystroke (or a typed character) snaps back to
 *   `typing` mode — subsequent `↑` reseeds from the most-recent entry,
 *   not the previous browse position.
 *
 * **Precedence rule** (locked by the maintainer's pre-flight notes):
 *   - `↑`/`↓` cycle history only when the input is empty.
 *   - When the input has content, the keys pass through to whatever
 *     consumer wants them (e.g. PEND-54's deferred typed-token
 *     autocomplete; today, the result list keyboard nav).
 *
 * Returned `handleKeyDown` calls `preventDefault()` only when the hook
 * consumed the event; otherwise the caller's downstream listener fires
 * normally.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface SearchHistoryCycling {
  /** Bind to the input's `onKeyDown`. Returns true when consumed. */
  handleKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => boolean
  /** Reset to typing mode externally (e.g. when history changes). */
  reset: () => void
}

interface BrowseState {
  mode: 'typing' | 'browsing'
  index: number
}

const INITIAL_STATE: BrowseState = { mode: 'typing', index: -1 }

export function useSearchHistoryCycling(
  history: ReadonlyArray<string>,
  query: string,
  setQuery: (next: string) => void,
): SearchHistoryCycling {
  const [state, setState] = useState<BrowseState>(INITIAL_STATE)
  // Keep the latest history / query in a ref so the memoised callback
  // never closes over stale arrays.
  const historyRef = useRef(history)
  const queryRef = useRef(query)
  // Track the value we last wrote via `setQuery` so the external-edit
  // effect can ignore self-driven changes (otherwise every cycle
  // snaps us back to typing mode).
  const lastSelfWriteRef = useRef<string | null>(null)
  historyRef.current = history
  queryRef.current = query

  // When the user edits the input outside the hook's own writes,
  // snap back to typing mode so the next `↑` reseeds from the
  // most-recent entry.
  useEffect(() => {
    if (lastSelfWriteRef.current === query) {
      // Self-driven write — clear the marker but don't reset state.
      lastSelfWriteRef.current = null
      return
    }
    setState((prev) => (prev.mode === 'typing' ? prev : INITIAL_STATE))
  }, [query])

  const reset = useCallback(() => setState(INITIAL_STATE), [])

  const writeQuery = useCallback(
    (next: string) => {
      lastSelfWriteRef.current = next
      setQuery(next)
    },
    [setQuery],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
        return false
      }
      // Precedence: only recall when the input is empty (or already
      // browsing). Otherwise pass through — the typed query takes
      // priority and the result list / autocomplete handle the event.
      if (queryRef.current.length > 0 && state.mode === 'typing') {
        return false
      }
      const hist = historyRef.current
      if (hist.length === 0) {
        // Nothing to recall — eat the event so the result-list doesn't
        // run while focus is in the input.
        event.preventDefault()
        return true
      }

      let nextIndex: number
      if (event.key === 'ArrowUp') {
        // Walk backward (older). At the oldest, no-op (clamp).
        nextIndex = state.mode === 'typing' ? 0 : Math.min(state.index + 1, hist.length - 1)
      } else {
        // ArrowDown — walk forward (newer). At -1, clear the input and
        // return to typing mode.
        nextIndex = state.mode === 'typing' ? -1 : state.index - 1
      }

      // Clamp = no movement: still consume the event so the result
      // list nav doesn't fire, but skip the redundant setQuery write.
      if (state.mode === 'browsing' && nextIndex === state.index) {
        event.preventDefault()
        return true
      }

      if (nextIndex < 0) {
        setState(INITIAL_STATE)
        writeQuery('')
      } else {
        const entry = hist[nextIndex]
        if (entry == null) return false
        setState({ mode: 'browsing', index: nextIndex })
        writeQuery(entry)
      }
      event.preventDefault()
      return true
    },
    [state, writeQuery],
  )

  return { handleKeyDown, reset }
}
