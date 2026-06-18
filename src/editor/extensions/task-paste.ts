/**
 * TipTap extension: route a pasted GFM task line into a task paragraph (#1481).
 *
 * Pasting `- [ ] buy milk` should create a TODO task block — not literal
 * `- [ ] buy milk` text. ProseMirror's default clipboard handling inserts the
 * raw text and our input rules do NOT fire on paste, so without this the marker
 * would only ever fold into `todo_state` at flush time (and only for TODO/DONE).
 *
 * Strategy (deliberately narrow to avoid regressing normal paste):
 *   1. Act ONLY when the selection is empty (cursor only) — never clobber a
 *      paste-over-selection.
 *   2. Act ONLY when the pasted text/plain, trimmed, parses to EXACTLY ONE
 *      paragraph carrying a `todoState` attr (a single GFM task line). Anything
 *      else — plain text, multi-line markdown, a heading, a bullet list, a task
 *      with trailing blocks — returns `false` and falls through to the editor's
 *      default paste (and, for multi-block content, the flush → splitBlock path).
 *   3. Replace the current (empty) paragraph's content with the task's inline
 *      content and stamp `todoState` on it, so the live doc carries the state
 *      (preserved by the `TaskParagraph` schema attr) and serializes back to the
 *      same marker.
 *
 * This does NOT change the markdown parse/serialize logic from #1435 — it only
 * reuses `parse` to recognize a task line on paste.
 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

import { parse } from '../markdown-serializer'
import type { ParagraphNode, TodoState } from '../types'

const taskPastePluginKey = new PluginKey('taskPaste')

/**
 * Parse the pasted text and return the single task paragraph it represents, or
 * null when it is NOT exactly one GFM task line. Exported for testing.
 */
export function pastedTaskParagraph(text: string): ParagraphNode | null {
  const trimmed = text.replace(/\r\n/g, '\n').trim()
  if (trimmed.length === 0 || trimmed.includes('\n')) return null
  const doc = parse(trimmed)
  const content = doc.content
  if (!content || content.length !== 1) return null
  const block = content[0]
  if (
    block?.type !== 'paragraph' ||
    !(block as ParagraphNode).attrs ||
    !(block as ParagraphNode).attrs?.todoState
  ) {
    return null
  }
  return block as ParagraphNode
}

export const TaskPaste = Extension.create({
  name: 'taskPaste',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: taskPastePluginKey,
        props: {
          handlePaste: (view, event) => {
            // Only act on a bare cursor — never override a paste-over-selection.
            if (!view.state.selection.empty) return false

            const clipboardText = event.clipboardData?.getData('text/plain')
            if (!clipboardText) return false

            const taskNode = pastedTaskParagraph(clipboardText)
            if (!taskNode) return false

            const { schema } = view.state
            const paragraphType = schema.nodes['paragraph']
            if (!paragraphType) return false

            // Build the inline content from the parsed task's JSON. nodeFromJSON
            // would reject loose inline nodes, so build a full paragraph node
            // from JSON (which the TaskParagraph schema accepts, carrying the
            // `todoState` attr) and insert its content into the current block.
            const todoState = taskNode.attrs?.todoState as TodoState
            let pmParagraph
            try {
              pmParagraph = schema.nodeFromJSON({
                type: 'paragraph',
                attrs: { todoState },
                content: taskNode.content ? [...taskNode.content] : undefined,
              })
            } catch {
              return false
            }

            const { $from } = view.state.selection
            // Replace the entire current paragraph (the empty/cursor block) with
            // the task paragraph so the block becomes a task, mirroring how
            // typing `- [ ] ` converts the current block.
            const start = $from.before($from.depth)
            const end = $from.after($from.depth)
            const tr = view.state.tr.replaceRangeWith(start, end, pmParagraph)
            // The caret is carried through the replace step by ProseMirror's
            // selection mapping (it lands inside the new task paragraph); no
            // explicit setSelection is needed for the single-block case.
            view.dispatch(tr)
            return true
          },
        },
      }),
    ]
  },
})
