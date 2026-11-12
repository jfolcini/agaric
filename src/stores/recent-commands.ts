/**
 * Recently run palette commands, per space and capped at
 * `MAX_RECENT_COMMANDS`. The slash menu keeps its own list under
 * `RECENT_SLASH_PREFIX`, so palette and slash ids never collide (#1105).
 */

import {
  PREFERENCES,
  type PreferenceDefinition,
  readPreference,
  type RecentCommand,
  writePreference,
} from '@/lib/preferences'
import { activeSpaceKey } from '@/stores/active-space'

export type { RecentCommand } from '@/lib/preferences'

const SPACE_KEY_PREFIX = 'recent_commands'
const MAX_RECENT_COMMANDS = 5

/** The slash menu's namespace (#1105). */
export const RECENT_SLASH_PREFIX = 'recent_slash'

/** The preference behind a namespace; there are only the two. */
function prefFor(prefix: string): PreferenceDefinition<RecentCommand[]> {
  return prefix === RECENT_SLASH_PREFIX
    ? PREFERENCES.recentCommandsSlash
    : PREFERENCES.recentCommandsPalette
}

/**
 * The active space's recent commands. `prefix` defaults to the palette's
 * namespace; the slash menu passes `RECENT_SLASH_PREFIX`.
 */
export function getRecentCommands(prefix: string = SPACE_KEY_PREFIX): RecentCommand[] {
  return readPreference(prefFor(prefix), activeSpaceKey())
}

/**
 * Move a command to the top of the active space's list, stamping `runAt`;
 * capped at `MAX_RECENT_COMMANDS`. `prefix` as for `getRecentCommands`.
 */
export function addRecentCommand(commandId: string, prefix: string = SPACE_KEY_PREFIX): void {
  const commands = getRecentCommands(prefix).filter((c) => c.id !== commandId)
  commands.unshift({ id: commandId, runAt: new Date().toISOString() })
  if (commands.length > MAX_RECENT_COMMANDS) commands.length = MAX_RECENT_COMMANDS
  // `writePreference` logs and swallows a quota error: a lost recents write
  // must not crash the command.
  writePreference(prefFor(prefix), commands, activeSpaceKey())
}
