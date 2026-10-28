/**
 * ListMarkerDecoration (#3000) — paints the focused block's list marker inside
 * the roving editor so it matches the read-only `StaticBlock` marker across
 * focus. Because list-ness is a block ATTRIBUTE (not content and not a
 * ProseMirror list node), the marker cannot come from the document — it is fed
 * to this plugin as external state (`{ style, ordinal }`) via a `setMeta`
 * transaction (see `RovingEditorHandle.updateListMarker`).
 *
 * The marker renders as a widget `Decoration` at the start of the first
 * top-level textblock, in the content column, on the same line as the text.
 * It is `aria-hidden`, non-editable, and `ignoreSelection`, so it never enters
 * a selection or the serialized markdown — blur-serialize stays bare.
 */

import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

import { renderedText } from '@/editor/page-mode/page-rendered'
import { listMarkerText } from '@/lib/list-marker-glyph'
import { type ListStyle, showsListMarker } from '@/lib/list-style'

export interface ListMarkerState {
  style: ListStyle
  ordinal: number | undefined
}

const EMPTY_STATE: ListMarkerState = { style: 'none', ordinal: undefined }

/** Plugin key — also the meta key used to push new marker state. */
export const listMarkerPluginKey = new PluginKey<ListMarkerState>('listMarkerDecoration')

/** Build the meta payload that sets the marker state on a transaction. */
export function setListMarkerMeta(tr: Transaction, next: ListMarkerState): Transaction {
  return tr.setMeta(listMarkerPluginKey, next)
}

/**
 * The marker the plugin is currently showing (`'none'` before any push, and
 * while the block does not open with a paragraph: `docShowsListMarker`).
 * #4552 slice 3 — the Enter / Backspace handlers read the focused block's
 * style from here: it is what `EditableBlock` pushed from `ListMarkerContext`,
 * and those handlers sit above the property batch provider with no other
 * synchronous source. The ordinal comes with it so a failed write can put back
 * the exact marker it cleared, numbering included.
 */
export function listMarkerOf(state: EditorState): ListMarkerState {
  const marker = listMarkerPluginKey.getState(state) ?? EMPTY_STATE
  return docShowsListMarker(state.doc) ? marker : EMPTY_STATE
}

/** Whether `doc`, holding one block's top-level nodes, shows a list marker (`showsListMarker`). */
export function docShowsListMarker(doc: PMNode): boolean {
  return showsListMarker(doc.firstChild?.type.name, renderedText(doc) !== null)
}

/** Build the marker decoration set for the given state (exported for tests). */
export function buildDecorations(state: EditorState): DecorationSet {
  const marker = listMarkerOf(state)
  if (marker.style === 'none') return DecorationSet.empty
  const text = listMarkerText(marker.style, marker.ordinal)
  // Position 1 = inside the first block, before its inline content.
  const widget = Decoration.widget(
    1,
    () => {
      const span = document.createElement('span')
      span.className = 'list-marker'
      span.setAttribute('aria-hidden', 'true')
      span.setAttribute('contenteditable', 'false')
      span.textContent = text
      return span
    },
    // A negative side keeps the widget before the caret at position 1, and this
    // one is below every side MarkdownReveal draws there (from -100), so the
    // marker leads the line and the Markdown revealed at its start follows it.
    // ignoreSelection + a content key (so PM recreates the DOM only when the
    // glyph changes).
    { side: -1000, ignoreSelection: true, key: `list-marker:${text}` },
  )
  return DecorationSet.create(state.doc, [widget])
}

/** Build the ProseMirror plugin (exported for unit tests). */
export function createListMarkerPlugin(): Plugin<ListMarkerState> {
  return new Plugin<ListMarkerState>({
    key: listMarkerPluginKey,
    state: {
      init: () => EMPTY_STATE,
      apply(tr, prev) {
        const meta = tr.getMeta(listMarkerPluginKey) as ListMarkerState | undefined
        return meta ?? prev
      },
    },
    props: {
      decorations: (state) => buildDecorations(state),
    },
  })
}

export const ListMarkerDecoration = Extension.create({
  name: 'listMarkerDecoration',
  addProseMirrorPlugins() {
    return [createListMarkerPlugin()]
  },
})
