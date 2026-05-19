/**
 * Recent commands — localStorage-backed list of recently-run palette
 * commands (PEND-67 Phase 2). Mirrors `recent-pages.ts` but stores
 * command ids (e.g. `go-settings`) rather than page refs, and caps at
 * `MAX_RECENT_COMMANDS` (5).
 *
 * Storage key shape: `recent_commands:<spaceId>` (or
 * `recent_commands:__legacy__` when no space is selected — mirrors
 * `activeSpaceKey()`). Space-scoped so different spaces never see each
 * other's MRU (FEAT-3 invariant: every list slice partitions by space).
 *
 * Brand-new lib in PEND-67, so there is no legacy global key to
 * migrate. The cap is enforced only against non-pinned entries; v1
 * has no pin concept (deferred to Phase 4).
 */

import { activeSpaceKey } from './active-space'

const SPACE_KEY_PREFIX = 'recent_commands'
const MAX_RECENT_COMMANDS = 5

export interface RecentCommand {
  /** Stable command id (e.g. `go-settings`, `search-everywhere`). */
  id: string
  /** ISO timestamp of the most recent run — written by `addRecentCommand`. */
  runAt: string
}

function isRecentCommand(item: unknown): item is RecentCommand {
  if (item === null || typeof item !== 'object') return false
  const r = item as Record<string, unknown>
  return typeof r['id'] === 'string' && typeof r['runAt'] === 'string'
}

function storageKey(): string {
  return `${SPACE_KEY_PREFIX}:${activeSpaceKey()}`
}

/** Read the recent-commands list for the active space from localStorage. */
export function getRecentCommands(): RecentCommand[] {
  try {
    const raw = localStorage.getItem(storageKey())
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecentCommand)
  } catch {
    return []
  }
}

/**
 * Add (or move) a command to the top of the active-space recent list.
 *
 * - If the command already exists it is moved to position 0 with an
 *   updated `runAt` timestamp.
 * - The list is capped at `MAX_RECENT_COMMANDS` entries.
 */
export function addRecentCommand(commandId: string): void {
  const commands = getRecentCommands().filter((c) => c.id !== commandId)
  commands.unshift({ id: commandId, runAt: new Date().toISOString() })
  if (commands.length > MAX_RECENT_COMMANDS) commands.length = MAX_RECENT_COMMANDS
  try {
    localStorage.setItem(storageKey(), JSON.stringify(commands))
  } catch {
    // localStorage may throw under quota (private-mode browsers, full
    // disk). The recents strip is a convenience; losing one write is
    // preferable to crashing the command handler.
  }
}
