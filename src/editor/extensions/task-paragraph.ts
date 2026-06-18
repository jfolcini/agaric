/**
 * TipTap extension: Paragraph + GFM task-list `todoState` attribute (#1481).
 *
 * The stock `@tiptap/extension-paragraph` declares no custom attributes, so
 * `schema.nodeFromJSON` SILENTLY DROPS any `attrs.todoState` produced by the
 * markdown parser (#1435). Without this declaration, parsing `- [ ] x` into a
 * paragraph carrying `todoState: 'TODO'` and feeding it to `setContent` would
 * round-trip back to a plain paragraph — the checkbox state would be lost.
 *
 * This extension ADDS the `todoState` attribute (default `null`) and bridges it
 * to a `data-todo-state` DOM attribute so the value survives:
 *   markdown-parse → nodeFromJSON → editor doc → getJSON → markdown-serialize.
 *
 * It does NOT change the markdown serialize/parse logic from #1435 — those read
 * `attrs.todoState` from the JSON; this just stops ProseMirror from discarding
 * the attribute as it crosses the live-editor schema.
 */

import Paragraph from '@tiptap/extension-paragraph'

import type { TodoState } from '../types'

/** Valid GFM task states (mirrors {@link TodoState}). */
const TODO_STATES = new Set<string>(['TODO', 'DOING', 'DONE', 'CANCELLED'])

function isTodoState(value: unknown): value is TodoState {
  return typeof value === 'string' && TODO_STATES.has(value)
}

/**
 * Paragraph extension declaring the `todoState` attribute so parsed GFM task
 * state survives the live editor's schema (#1481). Drop-in replacement for the
 * stock `Paragraph` in the editor extension list.
 */
export const TaskParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      todoState: {
        default: null,
        // Read the state back from the rendered DOM (paste from our own copy,
        // re-mount of a serialized doc). An unrecognized value degrades to
        // null (a plain paragraph) rather than corrupting the schema.
        parseHTML: (element: HTMLElement): TodoState | null => {
          const raw = element.getAttribute('data-todo-state')
          return isTodoState(raw) ? raw : null
        },
        // Only emit the attribute when the paragraph actually IS a task, so
        // non-task paragraphs render exactly as before (no empty attr noise).
        renderHTML: (attrs: Record<string, unknown>) => {
          const state = attrs['todoState']
          return isTodoState(state) ? { 'data-todo-state': state } : {}
        },
      },
    }
  },
})
