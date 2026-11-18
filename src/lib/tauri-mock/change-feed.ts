/**
 * The mock's stand-in for the backend's change feed (#6545): once a command
 * that can write notes has answered, one `blocks:changed` naming every domain,
 * as the backend sends after a burst of local commits once their background
 * rebuilds have run. Commands answered within one task share one event.
 *
 * The mock has no materializer to say what a command committed, so commands
 * are classified by name, failing toward "write": anything without a read
 * verb counts, so a new command costs at worst a needless refetch, never a
 * stale view. `conformance-coverage.test.ts` checks every read-classified
 * command against its Rust signature, so a read verb on a command that takes
 * a write handle fails there.
 */

import { type BlocksChangedEvent, EVENT_BLOCKS_CHANGED } from '@/lib/bindings'
import { emitEvent } from '@/lib/tauri-mock/events'

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
  'check_latest_release',
])

/** True when the snake_case IPC `command` has no persistent effect. */
export function isReadOnlyCommand(command: string): boolean {
  return READ_ONLY_PREFIXES.some((p) => command.startsWith(p)) || READ_ONLY_EXACT.has(command)
}

/**
 * Writes that change no note and fire without the user editing one (logging,
 * tracing, link previews, the periodic sync, reminders, the draft flush on
 * every window hide, the stamp on every page open). The backend's feed sends
 * nothing for them, as they append no op; an event after each would refetch
 * every mounted view on every page open.
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

let scheduled = false

/** After `command` has answered: schedule the feed's event if it can have written a note. */
export function afterCommand(command: string): void {
  if (scheduled || command.startsWith('plugin:')) return
  if (isReadOnlyCommand(command) || NON_NOTE_WRITES.has(command)) return
  scheduled = true
  setTimeout(() => {
    scheduled = false
    emitEvent(EVENT_BLOCKS_CHANGED, {
      changed_page_ids: [],
      local_ops_appended: true,
      domains: null,
      local_command: true,
    } satisfies BlocksChangedEvent)
  }, 0)
}
