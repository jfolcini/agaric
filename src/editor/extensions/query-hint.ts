/**
 * TipTap extension: inline `{{query …}}` syntax-hint (#907).
 *
 * Renders a passive **ghost-text** completion as a ProseMirror *widget
 * decoration* (a `<span class="query-hint">`), NOT a `.suggestion-popup`.
 * Accept on **Tab** (or click); Enter is never inspected here, so it always
 * propagates to the block-save flow.
 *
 * Why this can't intercept Enter — see `src/editor/query-hint.ts` for the full
 * rationale. In short:
 *   - `useBlockKeyboard` defers Enter to the Suggestion plugin only when a
 *     `.suggestion-popup` is visible. This plugin renders no such element, so
 *     `isSuggestionPopupVisible()` stays false and Enter saves the block.
 *   - This plugin's `handleKeyDown` returns `true` for exactly one key, `Tab`,
 *     and only while a hint is active. Every other key — including Enter,
 *     Escape, Backspace, arrows, and Space — falls through untouched.
 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

import { computeQueryHint, type QueryHint as QueryHintData } from '../query-hint'

export const queryHintPluginKey = new PluginKey<QueryHintState>('queryHint')

interface QueryHintState {
  /** The active hint (when the caret sits where a completion is offered). */
  hint: QueryHintData | null
  /** Document position at which to render the ghost-text widget. */
  pos: number
}

const EMPTY: QueryHintState = { hint: null, pos: 0 }

/**
 * Derive the hint state from the current editor state. Operates on the text of
 * the textblock containing a *collapsed* selection; returns no hint for range
 * selections or non-text contexts (code blocks etc. have no `{{query`).
 */
function deriveState(state: import('@tiptap/pm/state').EditorState): QueryHintState {
  const { selection } = state
  if (!selection.empty) return EMPTY
  const { $from } = selection
  // Only hint inside ordinary textblocks (paragraph / heading). Skip code.
  const parent = $from.parent
  if (!parent.isTextblock || parent.type.spec.code) return EMPTY

  const blockStart = $from.start()
  const text = parent.textBetween(0, parent.content.size, '\n', '￼')
  const caret = $from.pos - blockStart

  const hint = computeQueryHint({ text, caret })
  if (!hint) return EMPTY
  return { hint, pos: $from.pos }
}

function buildDecorations(
  state: import('@tiptap/pm/state').EditorState,
  hintState: QueryHintState,
): DecorationSet {
  const { hint } = hintState
  if (!hint) return DecorationSet.empty
  const widget = Decoration.widget(
    hintState.pos,
    () => {
      const span = document.createElement('span')
      span.className = 'query-hint'
      span.setAttribute('data-testid', 'query-hint')
      span.setAttribute('aria-hidden', 'true')
      // contenteditable=false so the caret can't enter the ghost text and it
      // never becomes part of the document / serialized markdown.
      span.contentEditable = 'false'
      span.textContent = hint.completion
      return span
    },
    // side > 0 so the widget renders *after* the caret position; key so
    // ProseMirror reuses/replaces it cleanly as the completion changes.
    { side: 1, key: `query-hint:${hint.completion}`, ignoreSelection: true },
  )
  return DecorationSet.create(state.doc, [widget])
}

export const QueryHint = Extension.create({
  name: 'queryHint',

  addProseMirrorPlugins() {
    return [
      new Plugin<QueryHintState>({
        key: queryHintPluginKey,
        state: {
          init: (_config, editorState) => deriveState(editorState),
          apply: (tr, value, oldState, newState) => {
            // The hint is a pure function of the textblock's content and the
            // (collapsed) caret position. When a transaction changes neither —
            // e.g. a metadata-only tr, or one that fires with the selection
            // unchanged — the previous value is still valid, so skip the
            // O(blockSize) `textBetween` + `computeQueryHint` recompute. This
            // is the standard ProseMirror decoration-plugin short-circuit.
            // We still recompute on every doc change AND on every selection
            // move (caret position is an input to the hint), preserving
            // correctness; only true no-ops are short-circuited.
            if (!tr.docChanged && tr.selection.eq(oldState.selection)) return value
            return deriveState(newState)
          },
        },
        props: {
          decorations(state) {
            const hintState = queryHintPluginKey.getState(state) ?? EMPTY
            return buildDecorations(state, hintState)
          },
          handleKeyDown(view, event) {
            // Claim ONLY Tab, and only when a hint is active. Crucially we
            // never look at Enter, so Enter always reaches the block-save
            // handler. Modifier-Tab (Shift/Ctrl/Cmd/Alt) is left for the
            // outline indent/focus handling.
            if (event.key !== 'Tab') return false
            if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false
            const hintState = queryHintPluginKey.getState(view.state) ?? EMPTY
            if (!hintState.hint) return false

            event.preventDefault()
            const { completion } = hintState.hint
            const tr = view.state.tr.insertText(completion, hintState.pos)
            view.dispatch(tr)
            return true
          },
        },
      }),
    ]
  },
})
