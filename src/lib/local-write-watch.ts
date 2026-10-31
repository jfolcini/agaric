/**
 * local-write-watch — calls back after every generated `commands.*` call that
 * can write notes settles, so a cache with no finer invalidation (the Pages
 * list, #5446) can go stale on any local write.
 *
 * Classified by name, failing toward "write": anything without a read verb
 * counts, so a new command costs at worst a needless refetch, never a stale
 * view. `conformance-coverage.test.ts` checks every read-classified command
 * against its Rust signature, so a read verb on a command that takes a write
 * handle fails there.
 */

const READ_ONLY_PREFIXES: readonly string[] = [
  'get_',
  'list_',
  'query_',
  'search_',
  'count_',
  'read_',
  'find_',
  'compute_',
  'resolve_',
  'load_',
  'is_',
  'collect_',
  'export_',
]

/** Read-only commands whose names don't carry a query-verb prefix. */
const READ_ONLY_EXACT: ReadonlySet<string> = new Set<string>([
  'batch_resolve',
  'first_child_for_blocks',
  'trash_descendant_counts',
  'filtered_blocks_query',
  'run_advanced_query',
  'preview_space_move',
  'preview_property_merge',
  'preview_property_type_change',
  'preview_unfit_property_move',
])

/** True when the snake_case IPC `command` has no persistent effect. */
export function isReadOnlyCommand(command: string): boolean {
  return READ_ONLY_PREFIXES.some((p) => command.startsWith(p)) || READ_ONLY_EXACT.has(command)
}

/**
 * Writes that change no note and fire without the user editing one (logging,
 * tracing, link previews, the periodic sync, reminders, the draft flush on
 * every window hide, the stamp on every page open); counting them would
 * refetch the Pages list on every return. Synced changes arrive through
 * `useSyncEvents` instead, the typing a draft holds is already committed by
 * `useDebouncedContentCommit`'s `edit_block`, whose debounce is shorter than
 * the draft's, and the Pages list refetches its "Last opened" sort itself.
 */
const NON_NOTE_WRITES: ReadonlySet<string> = new Set<string>([
  'log_frontend',
  'ingest_otel_spans',
  'fetch_link_metadata',
  'start_sync',
  'notify_task',
  'flush_all_drafts',
  'record_page_open',
])

type CommandTable = Record<string, (...args: never[]) => Promise<unknown>>

/** Wrap each note-writing command of `table` (the generated `commands`) in place. */
export function watchLocalWrites(table: CommandTable, onWrite: () => void): void {
  const commands = table as Record<string, (...args: unknown[]) => Promise<unknown>>
  for (const [name, call] of Object.entries(commands)) {
    const command = name.replaceAll(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
    if (isReadOnlyCommand(command) || NON_NOTE_WRITES.has(command)) continue
    commands[name] = (...args) => {
      const settled = call(...args)
      // On rejection too: a needless stale mark costs one refetch, and the
      // caller still receives the rejection from `settled`.
      settled.then(onWrite, onWrite)
      return settled
    }
  }
}
