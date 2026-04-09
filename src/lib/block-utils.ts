/**
 * Block utility functions — pure helpers with no React dependencies.
 *
 * Extracted from BlockTree.tsx to keep the orchestrator lean.
 */

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
