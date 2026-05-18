/**
 * Recent pages — localStorage-backed list of recently visited pages.
 *
 * Stores up to MAX_RECENT entries, most-recent first, partitioned by
 * the active space so different spaces never see each other's history
 * (FEAT-3 Phase 3 parity with `stores/recent-pages.ts`).
 *
 * Storage key shape: `recent_pages:<spaceId>` (or `recent_pages:__legacy__`
 * when no space is selected — mirrors `activeSpaceKey()`).
 *
 * A pre-FEAT-3 single-key `recent_pages` entry is migrated lazily on first
 * read into the legacy slot so returning users don't lose their MRU. The
 * migration runs at most once per process (module-level guard).
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
}

function isRecentPage(item: unknown): item is RecentPage {
  if (item === null || typeof item !== 'object') return false
  const r = item as Record<string, unknown>
  return (
    typeof r['id'] === 'string' &&
    typeof r['title'] === 'string' &&
    typeof r['visitedAt'] === 'string'
  )
}

function storageKey(): string {
  return `${SPACE_KEY_PREFIX}:${activeSpaceKey()}`
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

/** Read the recent-pages list for the active space from localStorage. */
export function getRecentPages(): RecentPage[] {
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
 * Add (or move) a page to the top of the active-space recent list.
 *
 * - If the page already exists it is moved to position 0 with an updated timestamp.
 * - The list is capped at MAX_RECENT entries.
 */
export function addRecentPage(id: string, title: string): void {
  const pages = getRecentPages().filter((p) => p.id !== id)
  pages.unshift({ id, title, visitedAt: new Date().toISOString() })
  if (pages.length > MAX_RECENT) pages.length = MAX_RECENT
  try {
    localStorage.setItem(storageKey(), JSON.stringify(pages))
  } catch {
    // localStorage may throw under quota (private-mode browsers, full
    // disk). The MRU strip is a convenience; losing one write is
    // preferable to crashing the click handler.
  }
}

/**
 * Test-only: reset the module-level `migrated` flag so the migration
 * can run again on the next `getRecentPages` call. Production code
 * never calls this — the one-shot semantics are the whole point.
 */
export function __resetMigrationFlagForTests(): void {
  migrated = false
}
