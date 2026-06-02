/**
 * useEmojiRecents — localStorage-backed MRU list of recently inserted emoji
 * (#286).
 *
 * Shared by the browse-grid `<EmojiPicker>` dialog and (eventually) the inline
 * `:` picker so a Recents row can surface the user's most-used emoji first.
 * Stores the native Unicode `char` strings most-recent-first, capped at
 * {@link MAX_EMOJI_RECENTS}; re-inserting an existing emoji moves it to the
 * front rather than duplicating it.
 *
 * Defensive against localStorage's failure modes (read/parse/write may throw
 * in private mode or on quota) — mirrors `useLocalStoragePreference` /
 * `recent-pages.ts`: every access is try/caught and falls back to an empty
 * list. A `storage` event listener keeps multiple open windows in sync.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'

import { logger } from '../lib/logger'

const SOURCE = 'useEmojiRecents'

export const EMOJI_RECENTS_KEY = 'emoji_recents'
export const MAX_EMOJI_RECENTS = 24

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(EMOJI_RECENTS_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Keep only non-empty strings — guards against a corrupted/migrated blob.
    return parsed.filter((c): c is string => typeof c === 'string' && c.length > 0)
  } catch {
    // Invalid stored data — fall back silently (not actionable; matches the
    // useLocalStoragePreference convention).
    return []
  }
}

function writeRecents(next: readonly string[]): void {
  try {
    localStorage.setItem(EMOJI_RECENTS_KEY, JSON.stringify(next))
  } catch (err) {
    logger.warn(SOURCE, 'Failed to write emoji recents', { key: EMOJI_RECENTS_KEY }, err)
  }
}

// External store so every mounted picker reflects the same recents list and a
// push in one surface (block editor) is seen by another (page title) without a
// prop drill. `useSyncExternalStore` also keeps the snapshot referentially
// stable between notifications, so consumers don't re-render needlessly.
const listeners = new Set<() => void>()

// Cache the parsed snapshot so `getSnapshot` returns a stable reference until
// the list actually changes — `useSyncExternalStore` throws on a new array
// every call ("getSnapshot should be cached").
let snapshot: string[] = readRecents()

function emit(): void {
  for (const listener of listeners) listener()
}

// Cross-window sync: another tab/window mutating the same key fires a
// `storage` event here; re-read and notify local subscribers. Hoisted to
// module scope so add/removeEventListener use the SAME function reference — a
// per-`subscribe` closure made `removeEventListener` a no-op (different
// identity), leaking the handler and stacking duplicates across
// subscribe/unsubscribe cycles.
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== EMOJI_RECENTS_KEY) return
  snapshot = readRecents()
  emit()
}

function subscribe(listener: () => void): () => void {
  // Attach on the 0→1 transition, detach on 1→0, both with `onStorage`.
  if (listeners.size === 0) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('storage', onStorage)
  }
}

function getSnapshot(): string[] {
  return snapshot
}

/**
 * Record an emoji as just-used: move it to the front (de-duplicating) and cap
 * the list at {@link MAX_EMOJI_RECENTS}. No-op for empty input.
 */
export function pushEmojiRecent(char: string): void {
  if (char.length === 0) return
  const current = snapshot
  const next = [char, ...current.filter((c) => c !== char)].slice(0, MAX_EMOJI_RECENTS)
  // Skip the write + notify when nothing changed (re-using the already-first
  // emoji) so we don't churn localStorage or re-render consumers.
  if (next.length === current.length && next.every((c, i) => c === current[i])) return
  snapshot = next
  writeRecents(next)
  emit()
}

/** Clear the entire recents list. */
export function clearEmojiRecents(): void {
  if (snapshot.length === 0) return
  snapshot = []
  writeRecents(snapshot)
  emit()
}

export interface UseEmojiRecents {
  /** Recently used emoji, most-recent first. */
  readonly recents: readonly string[]
  /** Record `char` as just-used (MRU front, de-duplicated, capped). */
  readonly push: (char: string) => void
  /** Clear all recents. */
  readonly clear: () => void
}

/**
 * Subscribe to the shared emoji-recents MRU list. Returns the current list
 * plus stable `push`/`clear` callbacks. Multiple components share one list.
 */
export function useEmojiRecents(): UseEmojiRecents {
  const recents = useSyncExternalStore(subscribe, getSnapshot)
  const push = useCallback((char: string) => pushEmojiRecent(char), [])
  const clear = useCallback(() => clearEmojiRecents(), [])
  // Re-sync the module snapshot to disk on first mount in a fresh process in
  // case another window wrote while this one had no subscribers. Harmless
  // no-op when already current.
  useEffect(() => {
    const fresh = readRecents()
    if (fresh.length !== snapshot.length || !fresh.every((c, i) => c === snapshot[i])) {
      snapshot = fresh
      emit()
    }
  }, [])
  return { recents, push, clear }
}
