/**
 * Search history: a persisted per-space MRU of submitted queries, partitioned
 * so a query naming one space's pages or tags never shows in another. A
 * resubmitted query moves to the front.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { safePersistStorage } from '@/lib/safe-persist-storage'

/** Entries kept per space; the cap applies only in `push`, so raising it is safe. */
export const MAX_HISTORY = 20

/** Key for callers with no space (tests, fixtures), like `recent-pages`' `__legacy__`. */
export const LEGACY_HISTORY_SPACE_KEY = '__legacy__'

interface SearchHistoryState {
  /** Per-space MRU lists. Keyed by space id (or `__legacy__`). */
  bySpace: Record<string, string[]>
  /** When `false`, `push` records nothing and the dropdown says so. Persisted. */
  historyEnabled: boolean
  /** Push a submitted query onto the active-space MRU list. No-op on empty. */
  push: (spaceId: string | null | undefined, query: string) => void
  /** Clear the MRU list for the given space (does not affect other spaces). */
  clear: (spaceId: string | null | undefined) => void
  /**
   * Remove a single query from the given space's MRU list.
   * No-op when the query isn't present. Other spaces untouched.
   */
  removeEntry: (spaceId: string | null | undefined, query: string) => void
  /** Toggle whether new submissions are recorded. */
  setHistoryEnabled: (enabled: boolean) => void
}

function spaceKey(spaceId: string | null | undefined): string {
  if (!spaceId) return LEGACY_HISTORY_SPACE_KEY
  return spaceId
}

/**
 * Coerce persisted JSON into a valid `bySpace`: `localStorage` can hold
 * anything, and a bare cast lets a malformed blob crash the reducers. Keeps
 * string arrays only, dropping empty and duplicate entries, capped at
 * `MAX_HISTORY`.
 */
export function coerceBySpace(raw: unknown): Record<string, string[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const seen = new Set<string>()
    const cleaned: string[] = []
    for (const item of value) {
      if (typeof item !== 'string') continue
      const trimmed = item.trim()
      if (trimmed.length === 0 || seen.has(trimmed)) continue
      seen.add(trimmed)
      cleaned.push(trimmed)
      if (cleaned.length >= MAX_HISTORY) break
    }
    if (cleaned.length > 0) out[key] = cleaned
  }
  return out
}

/**
 * Coerce a whole persisted blob field by field (#1609). Both `migrate` and
 * `merge` call it: zustand runs `migrate` only on a version mismatch, so a
 * corrupt blob with the current version reaches `merge` raw. Idempotent.
 */
function coercePersistedSearchHistory(
  persisted: unknown,
): Pick<SearchHistoryState, 'bySpace' | 'historyEnabled'> {
  const blob = (persisted != null && typeof persisted === 'object' ? persisted : {}) as Record<
    string,
    unknown
  >
  return {
    bySpace: coerceBySpace(blob['bySpace']),
    historyEnabled: typeof blob['historyEnabled'] === 'boolean' ? blob['historyEnabled'] : true,
  }
}

export const useSearchHistoryStore = create<SearchHistoryState>()(
  persist(
    (set) => ({
      bySpace: {},
      historyEnabled: true,
      push: (spaceId, query) =>
        set((state) => {
          if (!state.historyEnabled) return state
          const trimmed = query.trim()
          if (trimmed.length === 0) return state
          const key = spaceKey(spaceId)
          const existing = state.bySpace[key] ?? []
          // Case-sensitive, so `tag:#Urgent` and `tag:#urgent` stay distinct.
          const filtered = existing.filter((q) => q !== trimmed)
          const next = [trimmed, ...filtered].slice(0, MAX_HISTORY)
          return { bySpace: { ...state.bySpace, [key]: next } }
        }),
      clear: (spaceId) =>
        set((state) => {
          const key = spaceKey(spaceId)
          return { bySpace: { ...state.bySpace, [key]: [] } }
        }),
      removeEntry: (spaceId, query) =>
        set((state) => {
          const key = spaceKey(spaceId)
          const existing = state.bySpace[key]
          if (!existing) return state
          const next = existing.filter((q) => q !== query)
          // Unchanged: keep the reference so selectors do not fire.
          if (next.length === existing.length) return state
          return { bySpace: { ...state.bySpace, [key]: next } }
        }),
      setHistoryEnabled: (enabled) => set({ historyEnabled: enabled }),
    }),
    {
      name: 'agaric:search-history',
      version: 1,
      storage: safePersistStorage,
      partialize: (state) => ({
        bySpace: state.bySpace,
        historyEnabled: state.historyEnabled,
      }),
      // Both coerce (#1609): zustand calls `migrate` only on a version mismatch
      // and hands a same-version blob straight to `merge`. A version bump
      // without a real migration here would wipe every history.
      migrate: (persisted, _version) => coercePersistedSearchHistory(persisted),
      merge: (persisted, current) => ({
        ...current,
        ...coercePersistedSearchHistory(persisted),
      }),
    },
  ),
)

/** The MRU for a space; the reference changes only when that space's list does. */
export function selectHistoryForSpace(
  state: SearchHistoryState,
  spaceId: string | null | undefined,
): ReadonlyArray<string> {
  return state.bySpace[spaceKey(spaceId)] ?? EMPTY_HISTORY
}

// One frozen reference, so selectors do not fire on every render.
const EMPTY_HISTORY: ReadonlyArray<string> = Object.freeze([])
