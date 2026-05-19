/**
 * Recent pages — localStorage-backed list of recently visited pages.
 *
 * Stores up to MAX_RECENT non-pinned entries (most-recent first) plus
 * any number of pinned entries (exempt from eviction), partitioned by
 * the active space so different spaces never see each other's history
 * (FEAT-3 Phase 3 parity with `stores/recent-pages.ts`).
 *
 * Storage key shape: `recent_pages:<spaceId>` (or `recent_pages:__legacy__`
 * when no space is selected — mirrors `activeSpaceKey()`).
 *
 * A pre-FEAT-3 single-key `recent_pages` entry is migrated lazily on first
 * read into the legacy slot so returning users don't lose their MRU. The
 * migration runs at most once per process (module-level guard).
 *
 * PEND-67 Phase 4 — entries gain an optional `pinned?: boolean` field.
 * Pinned entries are rendered first (in pin order) and are NOT counted
 * against MAX_RECENT eviction. Existing entries default to unpinned
 * (the field is omitted) so the read path stays backwards-compatible.
 */

import { activeSpaceKey } from './active-space'

/**
 * Per-space storage keys are always `${SPACE_KEY_PREFIX}:${spaceId}`.
 * Never collides with `LEGACY_UNSCOPED_KEY` because the prefix is always
 * followed by `:` while the legacy key is the bare prefix.
 */
const SPACE_KEY_PREFIX = 'recent_pages'
const LEGACY_UNSCOPED_KEY = 'recent_pages'
const LEGACY_SLOT_KEY = `${SPACE_KEY_PREFIX}:__legacy__`
const MAX_RECENT = 10

/**
 * Module-level guard so `migrateLegacyKey` only does work once per
 * process. Without this the migration runs `localStorage.getItem` on
 * every `getRecentPages` call (cheap, but unnecessary noise).
 */
let migrated = false

export interface RecentPage {
  id: string
  title: string
  visitedAt: string
  /**
   * PEND-67 Phase 4 — pinned entries stick at the top of the recents
   * list in pin order and are exempt from the MAX_RECENT eviction.
   * The field is optional so existing stored entries (which predate
   * Phase 4) deserialize unchanged.
   */
  pinned?: boolean
}

function isRecentPage(item: unknown): item is RecentPage {
  if (item === null || typeof item !== 'object') return false
  const r = item as Record<string, unknown>
  if (
    typeof r['id'] !== 'string' ||
    typeof r['title'] !== 'string' ||
    typeof r['visitedAt'] !== 'string'
  ) {
    return false
  }
  // `pinned` is optional but must be a boolean when present.
  return r['pinned'] === undefined || typeof r['pinned'] === 'boolean'
}

function storageKey(): string {
  return `${SPACE_KEY_PREFIX}:${activeSpaceKey()}`
}

/**
 * Read the raw stored entries WITHOUT the pin-first sort. Used
 * internally by mutating helpers that need to preserve the on-disk
 * order across edits (otherwise a write-then-read round-trip would
 * silently shuffle pinned entries).
 */
function readRawRecentPages(): RecentPage[] {
  migrateLegacyKey()
  try {
    const raw = localStorage.getItem(storageKey())
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecentPage)
  } catch {
    return []
  }
}

/**
 * Persist a list of entries, applying the MAX_RECENT cap against
 * non-pinned entries only. Pinned entries are always retained.
 */
function writeRecentPages(pages: RecentPage[]): void {
  const pinned = pages.filter((p) => p.pinned === true)
  const unpinned = pages.filter((p) => p.pinned !== true).slice(0, MAX_RECENT)
  try {
    localStorage.setItem(storageKey(), JSON.stringify([...pinned, ...unpinned]))
  } catch {
    // localStorage may throw under quota; the MRU strip is a
    // convenience, not load-bearing — drop the write silently.
  }
}

/**
 * One-shot migration: move the pre-FEAT-3 unscoped `recent_pages` entry
 * under the legacy space slot. Runs at most once per process via the
 * module-level `migrated` flag.
 *
 * Concurrency note: Agaric is a single-renderer Tauri app, so the
 * window between read and write here cannot race a sibling tab. In a
 * web context two tabs running this migration simultaneously could
 * clobber each other's `__legacy__` writes; we guard with a "don't
 * overwrite existing" check below to make the worst-case lossless.
 */
function migrateLegacyKey(): void {
  if (migrated) return
  migrated = true
  try {
    const legacyRaw = localStorage.getItem(LEGACY_UNSCOPED_KEY)
    if (legacyRaw == null) return
    if (localStorage.getItem(LEGACY_SLOT_KEY) == null) {
      localStorage.setItem(LEGACY_SLOT_KEY, legacyRaw)
    }
    localStorage.removeItem(LEGACY_UNSCOPED_KEY)
  } catch {
    // localStorage unavailable — nothing to migrate.
  }
}

/**
 * Read the recent-pages list for the active space, sorted with pinned
 * entries first (PEND-67 Phase 4). Pinned entries appear in their
 * stored order (pin order), unpinned in MRU order. The on-disk layout
 * already matches this — pinned entries are persisted first by
 * `writeRecentPages`.
 */
export function getRecentPages(): RecentPage[] {
  const all = readRawRecentPages()
  const pinned = all.filter((p) => p.pinned === true)
  const unpinned = all.filter((p) => p.pinned !== true)
  return [...pinned, ...unpinned]
}

/**
 * Add (or move) a page to the top of the active-space recent list.
 *
 * - If the page already exists, it is moved to position 0 of its
 *   pinned/unpinned partition with an updated `visitedAt`. A pinned
 *   entry stays pinned (its `pinned: true` flag is preserved).
 * - The non-pinned partition is capped at MAX_RECENT entries; pinned
 *   entries are never evicted (PEND-67 Phase 4).
 */
export function addRecentPage(id: string, title: string): void {
  const all = readRawRecentPages()
  const existing = all.find((p) => p.id === id)
  const pages = all.filter((p) => p.id !== id)
  const next: RecentPage = {
    id,
    title,
    visitedAt: new Date().toISOString(),
    ...(existing?.pinned === true && { pinned: true }),
  }
  pages.unshift(next)
  writeRecentPages(pages)
}

/**
 * PEND-67 Phase 4 — toggle the pinned state of a recents entry. Returns
 * the new pinned state, or `null` if the id was not found.
 *
 * Pinning preserves the entry's `visitedAt`; unpinning re-stamps it to
 * "now" so the entry's MRU position reflects the unpin moment rather
 * than the original visit (otherwise an entry pinned six months ago
 * would jump straight to the bottom of the unpinned partition).
 */
export function togglePinRecentPage(id: string): boolean | null {
  const all = readRawRecentPages()
  const idx = all.findIndex((p) => p.id === id)
  if (idx < 0) return null
  const current = all[idx]
  if (current == null) return null
  const wasPinned = current.pinned === true
  const updated: RecentPage = {
    id: current.id,
    title: current.title,
    visitedAt: wasPinned ? new Date().toISOString() : current.visitedAt,
    ...(!wasPinned && { pinned: true }),
  }
  const next = [...all.slice(0, idx), updated, ...all.slice(idx + 1)]
  writeRecentPages(next)
  return !wasPinned
}

/**
 * Test-only: reset the module-level `migrated` flag so the migration
 * can run again on the next `getRecentPages` call. Production code
 * never calls this — the one-shot semantics are the whole point.
 */
export function __resetMigrationFlagForTests(): void {
  migrated = false
}
