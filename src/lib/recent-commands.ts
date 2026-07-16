/**
 * Recent commands — localStorage-backed list of recently-run palette
 * Commands (Phase 2). Mirrors `recent-pages.ts` but stores
 * command ids (e.g. `go-settings`) rather than page refs, and caps at
 * `MAX_RECENT_COMMANDS` (5).
 *
 * Storage key shape: `recent_commands:<spaceId>` (or
 * `recent_commands:__legacy__` when no space is selected — mirrors
 * `activeSpaceKey()`). Space-scoped so different spaces never see each
 * Other's MRU (invariant: every list slice partitions by space).
 *
 * #1105 — the slash menu reuses this exact MRU under its own namespace
 * (`recent_slash`, see `RECENT_SLASH_PREFIX`) so palette command ids and
 * slash command ids never collide. The prefix is the only knob; cap,
 * shape, and move-to-top semantics are shared verbatim.
 *
 * Brand-new lib in so there is no legacy global key to
 * migrate. The cap is enforced only against non-pinned entries; v1
 * has no pin concept (deferred to Phase 4).
 */

import { activeSpaceKey } from '@/lib/active-space'
import {
  PREFERENCES,
  type PreferenceDefinition,
  readPreference,
  type RecentCommand,
  writePreference,
} from '@/lib/preferences'

export type { RecentCommand } from '@/lib/preferences'

const SPACE_KEY_PREFIX = 'recent_commands'
const MAX_RECENT_COMMANDS = 5

/**
 * #1105 — namespace for the slash menu's MRU. Distinct from the palette's
 * default `recent_commands` prefix so the two id spaces never collide.
 */
export const RECENT_SLASH_PREFIX = 'recent_slash'

/**
 * Resolve the space-keyed `PreferenceDefinition` for a storage namespace.
 * `PREFERENCES.recentCommandsPalette` / `.recentCommandsSlash` are separate
 * registry entries (not a single multi-arg family) since `prefix` only ever
 * takes these two compile-time-known values — see the file header.
 */
function prefFor(prefix: string): PreferenceDefinition<RecentCommand[]> {
  return prefix === RECENT_SLASH_PREFIX
    ? PREFERENCES.recentCommandsSlash
    : PREFERENCES.recentCommandsPalette
}

/**
 * Read the recent-commands list for the active space from localStorage.
 *
 * @param prefix Storage namespace. Defaults to the palette's
 *   `recent_commands`; the slash menu passes `RECENT_SLASH_PREFIX` (#1105).
 */
export function getRecentCommands(prefix: string = SPACE_KEY_PREFIX): RecentCommand[] {
  return readPreference(prefFor(prefix), activeSpaceKey())
}

/**
 * Add (or move) a command to the top of the active-space recent list.
 *
 * - If the command already exists it is moved to position 0 with an
 *   updated `runAt` timestamp.
 * - The list is capped at `MAX_RECENT_COMMANDS` entries.
 *
 * @param prefix Storage namespace. Defaults to the palette's
 *   `recent_commands`; the slash menu passes `RECENT_SLASH_PREFIX` (#1105).
 */
export function addRecentCommand(commandId: string, prefix: string = SPACE_KEY_PREFIX): void {
  const commands = getRecentCommands(prefix).filter((c) => c.id !== commandId)
  commands.unshift({ id: commandId, runAt: new Date().toISOString() })
  if (commands.length > MAX_RECENT_COMMANDS) commands.length = MAX_RECENT_COMMANDS
  // localStorage may throw under quota (private-mode browsers, full disk) —
  // logged and swallowed by writePreference. The recents strip is a
  // convenience; losing one write is preferable to crashing the command handler.
  writePreference(prefFor(prefix), commands, activeSpaceKey())
}
