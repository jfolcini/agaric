/**
 * Block utility functions — pure helpers with no React dependencies.
 *
 * Extracted from BlockTree.tsx to keep the orchestrator lean.
 */

/**
 * Property keys that are tracked internally by the materializer but never
 * shown in the per-block UI display. Filter sites should import this set
 * rather than redeclaring the list inline.
 *
 * Distinct from `NON_DELETABLE_PROPERTIES` in `property-save-utils.ts`,
 * which mirrors `is_builtin_property_key` in `src-tauri/src/op.rs` for
 * deletion guards. That set is broader (includes `todo_state`, `priority`,
 * `due_date`, `scheduled_date`, `repeat-until`, `repeat-count`).
 *
 * Added for MAINT-187.
 */
export const INTERNAL_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'repeat',
  'created_at',
  'completed_at',
  'repeat-seq',
  'repeat-origin',
])

/**
 * Detect markdown checkbox syntax at the start of content.
 * `- [ ] ` -> TODO, `- [x] ` / `- [X] ` -> DONE.
 * Returns the cleaned content and the detected todo state, or null if no match.
 */
export function processCheckboxSyntax(content: string): {
  cleanContent: string
  todoState: string | null
} {
  if (content.startsWith('- [ ] ')) {
    return { cleanContent: content.slice(6), todoState: 'TODO' }
  }
  if (content.startsWith('- [x] ') || content.startsWith('- [X] ')) {
    return { cleanContent: content.slice(6), todoState: 'DONE' }
  }
  return { cleanContent: content, todoState: null }
}
