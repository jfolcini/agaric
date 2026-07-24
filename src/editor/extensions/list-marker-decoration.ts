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
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

import { listMarkerText } from '@/lib/list-marker-glyph'
import type { ListStyle } from '@/lib/list-style'

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

/** Build the marker decoration set for the given state (exported for tests). */
export function buildDecorations(state: EditorState): DecorationSet {
  const marker = listMarkerPluginKey.getState(state) ?? EMPTY_STATE
  if (marker.style === 'none') return DecorationSet.empty
  const first = state.doc.firstChild
  // Only textblocks (paragraph / heading) carry a list marker in this model.
  if (!first || !first.isTextblock) return DecorationSet.empty
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
    // side: -1 keeps the widget before the caret at position 1; ignoreSelection
    // + a content key (so PM recreates the DOM only when the glyph changes).
    { side: -1, ignoreSelection: true, key: `list-marker:${text}` },
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
