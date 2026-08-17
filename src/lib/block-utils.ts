/**
 * Block utility functions — pure helpers with no React dependencies.
 *
 * Extracted from BlockTree.tsx to keep the orchestrator lean.
 */

import { MARKER_INDENT_SRC } from '@/editor/markdown-parse/vocab'
import { taskStateFromMarker, type TodoState } from '@/lib/task-states'

/**
 * Property keys that are tracked internally by the materializer but never
 * shown in the per-block UI display. Filter sites should import this set
 * rather than redeclaring the list inline.
 *
 * Distinct from `NON_DELETABLE_PROPERTIES` in `property-save-utils.ts`,
 * which mirrors `is_builtin_property_key` in `src-tauri/agaric-store/src/op.rs` for
 * deletion guards. That set is broader (includes `todo_state`, `priority`,
 * `due_date`, `scheduled_date`, `repeat-until`, `repeat-count`).
 *
 * Added for.
 */
export const INTERNAL_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'repeat',
  'created_at',
  'completed_at',
  'repeat-seq',
  'repeat-origin',
])

/**
 * Detect a leading GFM task-list marker on a single block's content and fold it
 * into the separate `todo_state` column (#1481). Markers map to the app's fixed
 * cycle, matching the markdown serialize/parse layer (#1435):
 *   `- [ ] ` → TODO   `- [/] ` → DOING   `- [x] `/`- [X] ` → DONE
 *   `- [-] ` → CANCELLED   (either `-` or `*` marker)
 *
 * Returns the marker-stripped content and the detected todo state, or the
 * original content with `todoState: null` when there is no leading marker.
 */
// Mirrors `TASK_ITEM_RE` in markdown-parse — same marker alphabet and the same
// marker-indent tolerance, built from the same `MARKER_INDENT_SRC` fragment, so
// a line the parser renders as a task also folds into the `todo_state` column
// here instead of keeping a literal marker in `content`. It differs only in
// requiring a trailing space: the empty `- [ ]` form is handled by the markdown
// layer on full-doc parse, not here (a bare marker with no text never reaches
// `edit`). Like the parser, the tolerated indent belongs to the marker, so
// `content.slice(match[0].length)` strips it along with the marker.
const LEADING_TASK_MARKER_RE = new RegExp(`^${MARKER_INDENT_SRC}[-*] \\[([ xX/-])\\] `)
export function processCheckboxSyntax(content: string): {
  cleanContent: string
  todoState: TodoState | null
} {
  const match = LEADING_TASK_MARKER_RE.exec(content)
  if (match) {
    return {
      cleanContent: content.slice(match[0].length),
      todoState: taskStateFromMarker(match[1] as string),
    }
  }
  return { cleanContent: content, todoState: null }
}
