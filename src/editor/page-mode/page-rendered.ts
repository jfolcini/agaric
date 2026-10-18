/**
 * Page mode's query and embed blocks (#5743). Block mode draws a block whose
 * text is a `{{query …}}` or an `{{embed …}}` as the query's results or the
 * embedded block (`StaticBlock`), and shows the text only while the block is
 * edited. Page mode draws the same `StaticBlock` in the block's node view,
 * outside its editable text (`page-tasks.ts`), and swaps the two on the caret:
 * the text shows only while the caret is in the block, the results only while
 * it is not. What they show is the text as the caret left it, so an edit of
 * the text shows in the results once the caret leaves the block, as block
 * mode's do once the block is left.
 *
 * The browser's own caret skips text that is not shown, so the arrows step
 * into such a block here.
 */

import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, Selection } from '@tiptap/pm/state'

import { serialize } from '@/editor/markdown-serializer'
import { blockDocJson } from '@/editor/page-mode/page-document'
import { parseEmbedToken } from '@/lib/embed-token'

/** The attribute a block's node view carries while it draws the block's results in place of its text. */
export const RENDERED = 'data-rendered'

/** Block `node`'s text, when block mode draws it as a query's results or an embed; else null. */
export function renderedText(node: PMNode): string | null {
  // Only a block whose text opens with `{{` is serialised to find out.
  const first = node.firstChild?.firstChild
  if (first?.isText !== true || first.text?.trimStart().startsWith('{{') !== true) return null
  const markdown = serialize(blockDocJson(node))
  // `StaticBlock`'s own sniff.
  const query = markdown.startsWith('{{query ') && markdown.endsWith('}}')
  return query || parseEmbedToken(markdown) !== null ? markdown : null
}

const ARROWS: Record<string, { dir: 1 | -1; side: 'up' | 'down' | 'left' | 'right' }> = {
  ArrowUp: { dir: -1, side: 'up' },
  ArrowDown: { dir: 1, side: 'down' },
  ArrowLeft: { dir: -1, side: 'left' },
  ArrowRight: { dir: 1, side: 'right' },
}

/** An arrow leaving a textblock towards a block whose text is not shown puts the caret in it. */
export const PageRenderedKeys = Extension.create({
  name: 'pageRenderedKeys',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            const arrow = ARROWS[event.key]
            if (arrow === undefined || event.shiftKey || event.altKey) return false
            if (event.ctrlKey || event.metaKey) return false
            const { selection } = view.state
            if (!selection.empty || !view.endOfTextblock(arrow.side)) return false
            const { $head } = selection
            const past = view.state.doc.resolve(arrow.dir > 0 ? $head.after() : $head.before())
            const into = Selection.findFrom(past, arrow.dir, true)
            if (into === null) return false
            const block = view.nodeDOM(into.$head.before(1))
            if (!(block instanceof HTMLElement) || !block.hasAttribute(RENDERED)) return false
            view.dispatch(view.state.tr.setSelection(into).scrollIntoView())
            return true
          },
        },
      }),
    ]
  },
})
