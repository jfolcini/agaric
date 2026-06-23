/**
 * useEmojiRecents — localStorage-backed FREQUENTLY-USED emoji list (#286).
 *
 * Shared by the browse-grid `<EmojiPicker>` dialog, the inline `:` picker, and
 * the page-title / tag emoji buttons so a "Frequently Used" row can surface the
 * emoji the user reaches for most. Each insertion bumps a per-emoji use count
 * (and a last-used timestamp); the list is ranked by count, with recency as the
 * tiebreak — so a long-favourite emoji stays near the front and isn't pushed
 * out by a one-off pick (the failure mode of a strict most-recent-used list).
 *
 * Storage is a `{ char: { n: count, t: lastUsedMs } }` map under
 * {@link EMOJI_FREQUENCY_KEY}; a pre-existing legacy MRU array under
 * {@link EMOJI_RECENTS_KEY} is migrated once (most-recent → highest rank).
 *
 * Defensive against localStorage's failure modes (read/parse/write may throw in
 * private mode or on quota) — mirrors `useLocalStoragePreference` /
 * `recent-pages.ts`: every access is try/caught and falls back to an empty
 * list. A `storage` event listener keeps multiple open windows in sync.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'

import { logger } from '../lib/logger'

const SOURCE = 'useEmojiRecents'

/** Legacy MRU array key — read once to migrate, then left untouched. */
export const EMOJI_RECENTS_KEY = 'emoji_recents'
/** Current frequency-map key: `{ char: { n, t } }`. */
export const EMOJI_FREQUENCY_KEY = 'emoji_frequency'
/** Upper bound on stored entries; lowest-ranked are dropped past this. */
export const MAX_EMOJI_FREQUENCY = 64

interface FreqEntry {
  /** Use count — the primary ranking key. */
  readonly n: number
  /** Last-used epoch-ms — the recency tiebreak between equal counts. */
  readonly t: number
}
type FreqMap = Readonly<Record<string, FreqEntry>>

/** Read + validate the legacy MRU array (used only for one-time migration). */
function readLegacyRecents(): string[] {
  try {
    const raw = localStorage.getItem(EMOJI_RECENTS_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((c): c is string => typeof c === 'string' && c.length > 0)
  } catch {
    return []
  }
}

/** Validate a parsed blob as a `FreqMap` (defensive against corruption). */
function asFreqMap(parsed: unknown): FreqMap | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const out: Record<string, FreqEntry> = {}
  for (const [char, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (char.length === 0 || value === null || typeof value !== 'object') continue
    const { n, t } = value as Record<string, unknown>
    if (typeof n === 'number' && Number.isFinite(n) && n > 0 && typeof t === 'number') {
      out[char] = { n, t }
    }
  }
  return out
}

function readFrequency(): FreqMap {
  try {
    const raw = localStorage.getItem(EMOJI_FREQUENCY_KEY)
    if (raw !== null) {
      const map = asFreqMap(JSON.parse(raw))
      if (map !== null) return map
    }
  } catch {
    // fall through to migration / empty
  }
  // One-time migration from the legacy MRU array: most-recent first becomes the
  // highest recency tiebreak, every migrated emoji seeded at count 1.
  const legacy = readLegacyRecents()
  if (legacy.length === 0) return {}
  const base = Date.now()
  const migrated: Record<string, FreqEntry> = {}
  legacy.forEach((char, i) => {
    migrated[char] = { n: 1, t: base - i }
  })
  return migrated
}

// Strictly-monotonic "last used" stamp. Wall-clock based so it stays comparable
// across windows, but forced to always increase so two inserts in the SAME
// millisecond (rapid clicks / programmatic pushes) still get a deterministic
// recency order — `Date.now()` alone collides at sub-ms resolution.
let lastStamp = 0
function nextStamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1)
  return lastStamp
}

function writeFrequency(map: FreqMap): void {
  try {
    localStorage.setItem(EMOJI_FREQUENCY_KEY, JSON.stringify(map))
  } catch (err) {
    logger.warn(SOURCE, 'Failed to write emoji frequency', { key: EMOJI_FREQUENCY_KEY }, err)
  }
}

/** Rank chars: highest count first, ties broken by most-recently-used. */
function rankChars(map: FreqMap): string[] {
  return Object.keys(map).toSorted((a, b) => {
    const ea = map[a]
    const eb = map[b]
    if (ea === undefined || eb === undefined) return 0
    return eb.n - ea.n || eb.t - ea.t
  })
}

/** Drop the lowest-ranked entries so the stored map stays bounded. */
function capMap(map: FreqMap): FreqMap {
  const ranked = rankChars(map)
  if (ranked.length <= MAX_EMOJI_FREQUENCY) return map
  const kept: Record<string, FreqEntry> = {}
  for (const char of ranked.slice(0, MAX_EMOJI_FREQUENCY)) {
    const entry = map[char]
    if (entry !== undefined) kept[char] = entry
  }
  return kept
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i])
}

// External store so every mounted picker reflects the same list and a push in
// one surface (block editor) is seen by another (page title) without a prop
// drill. `useSyncExternalStore` also keeps the snapshot referentially stable
// between notifications, so consumers don't re-render needlessly.
const listeners = new Set<() => void>()

let freqMap: FreqMap = readFrequency()
// Cache the ranked snapshot so `getSnapshot` returns a stable reference until
// the ORDER actually changes (re-`useSyncExternalStore` requires this).
let snapshot: string[] = rankChars(freqMap)

function emit(): void {
  for (const listener of listeners) listener()
}

// Cross-window sync: another tab mutating either key re-reads + notifies. Module
// scope so add/removeEventListener share one function reference.
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== EMOJI_FREQUENCY_KEY && event.key !== EMOJI_RECENTS_KEY) {
    return
  }
  freqMap = readFrequency()
  snapshot = rankChars(freqMap)
  emit()
}

function subscribe(listener: () => void): () => void {
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
 * Record an emoji as just-used: increment its count, stamp it most-recent, and
 * keep the stored map bounded. No-op for empty input. Always persists (the
 * count changed) but only notifies subscribers when the visible ORDER changes.
 */
export function pushEmojiRecent(char: string): void {
  if (char.length === 0) return
  const prev = freqMap[char]
  const next = capMap({ ...freqMap, [char]: { n: (prev?.n ?? 0) + 1, t: nextStamp() } })
  freqMap = next
  writeFrequency(next)
  const ranked = rankChars(next)
  if (!sameOrder(ranked, snapshot)) {
    snapshot = ranked
    emit()
  }
}

/** Clear the entire frequently-used list. */
export function clearEmojiRecents(): void {
  if (Object.keys(freqMap).length === 0) return
  freqMap = {}
  snapshot = []
  writeFrequency(freqMap)
  emit()
}

export interface UseEmojiRecents {
  /** Frequently-used emoji, highest count first (recency breaks ties). */
  readonly frequent: readonly string[]
  /** Record `char` as just-used (bumps count + recency). */
  readonly push: (char: string) => void
  /** Clear the list. */
  readonly clear: () => void
}

/**
 * Subscribe to the shared frequently-used emoji list. Returns the ranked list
 * plus stable `push`/`clear` callbacks. Multiple components share one list.
 */
export function useEmojiRecents(): UseEmojiRecents {
  const frequent = useSyncExternalStore(subscribe, getSnapshot)
  const push = useCallback((char: string) => pushEmojiRecent(char), [])
  const clear = useCallback(() => clearEmojiRecents(), [])
  // Re-sync the module snapshot on first mount in a fresh process in case
  // another window wrote while this one had no subscribers. No-op when current.
  useEffect(() => {
    const fresh = readFrequency()
    const ranked = rankChars(fresh)
    if (!sameOrder(ranked, snapshot)) {
      freqMap = fresh
      snapshot = ranked
      emit()
    }
  }, [])
  return { frequent, push, clear }
}
