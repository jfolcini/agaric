/**
 * TipTap extension: footnote_ref inline node (#6033), a `[^label]` reference.
 *
 * Atomic inline node, attr `label`. It shows its label's number on the page
 * (`options.footnotes`), muted with a tooltip when no block defines the label,
 * and a click focuses the defining block. Typing `[^label]` converts on the
 * closing `]`; one undo restores the typed text.
 *
 * Page mode's document holds the whole page, so by default the numbering is
 * read from it, and the shown numbers follow every edit. Block mode's editor
 * holds one block: it passes the page store's numbering instead.
 */

import { mergeAttributes, Node } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Node as PMNode, NodeType } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'

import {
  blockFootnotes,
  type BlockFootnotes,
  type FootnoteNumbering,
  numberFootnotes,
} from '@/editor/footnotes'
import { blockDocJson } from '@/editor/page-mode/page-document'
import { blockIdOf } from '@/editor/token-ids'
import { t } from '@/lib/i18n'

export interface FootnoteRefOptions {
  /** The numbering of the page the editor's document is on. */
  footnotes: (doc: PMNode) => FootnoteNumbering
  /** Focuses a block of the page: the definition a clicked reference names. */
  onNavigate?: ((id: string) => void) | undefined
}

interface FootnoteRefStorage {
  /** Redraws each live node view, after the numbering changed. */
  views: Set<() => void>
}

const blockNotes = new WeakMap<PMNode, BlockFootnotes>()
const pageNotes = new WeakMap<PMNode, FootnoteNumbering>()

/**
 * The numbering of page mode's document, one `pageBlock` per block, each block
 * read again only once an edit changed it.
 */
export function footnotesOfPageDoc(doc: PMNode): FootnoteNumbering {
  let numbering = pageNotes.get(doc)
  if (numbering !== undefined) return numbering
  const blocks: Array<{ id: string; footnotes: BlockFootnotes }> = []
  doc.forEach((node) => {
    const id = blockIdOf(node)
    if (id === null) return
    let footnotes = blockNotes.get(node)
    if (footnotes === undefined) {
      footnotes = blockFootnotes(blockDocJson(node))
      blockNotes.set(node, footnotes)
    }
    blocks.push({ id, footnotes })
  })
  numbering = numberFootnotes(blocks)
  pageNotes.set(doc, numbering)
  return numbering
}

function sameMap<V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) if (b.get(key) !== value) return false
  return true
}

function sameNumbering(a: FootnoteNumbering, b: FootnoteNumbering): boolean {
  return sameMap(a.numbers, b.numbers) && sameMap(a.definitions, b.definitions)
}

/** The text before the caret a typed `]` closes into a reference: `[^label`. */
const TYPED_REF = /\[\^([^\s[\]\\\uFFFC]+)$/

/**
 * `[^label]` typed converts on its `]`: the `]` goes in as typed text, then
 * the conversion follows as its own undo step, so one undo gives the text back.
 */
function typedReference(type: NodeType): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== ']' || view.composing) return false
        const $from = view.state.doc.resolve(from)
        const code = view.state.schema.marks['code']
        if ($from.parent.type.spec.code || (code !== undefined && code.isInSet($from.marks()))) {
          return false
        }
        const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\uFFFC')
        const match = TYPED_REF.exec(before)
        if (match === null) return false
        view.dispatch(view.state.tr.insertText(text, from, to))
        const start = from - match[0].length
        const tr = view.state.tr.replaceWith(start, from + 1, type.create({ label: match[1] }))
        view.dispatch(closeHistory(tr))
        // Typing on after it is a step of its own too.
        view.dispatch(closeHistory(view.state.tr))
        return true
      },
    },
  })
}

export const FootnoteRef = Node.create<FootnoteRefOptions, FootnoteRefStorage>({
  name: 'footnote_ref',
  group: 'inline',
  inline: true,
  atom: true,

  addOptions() {
    return { footnotes: footnotesOfPageDoc, onNavigate: undefined }
  },

  addStorage() {
    return { views: new Set() }
  },

  addAttributes() {
    return {
      label: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-label') ?? '',
        renderHTML: (attrs) => ({ 'data-label': attrs['label'] as string }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'sup[data-type="footnote-ref"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'sup',
      mergeAttributes(HTMLAttributes, { 'data-type': 'footnote-ref', class: 'footnote-ref' }),
      node.attrs['label'] as string,
    ]
  },

  addNodeView() {
    const { options, storage } = this
    return ({ node, editor }) => {
      const dom = document.createElement('sup')
      let label = node.attrs['label'] as string
      let definition: string | undefined

      function render() {
        const numbering = options.footnotes(editor.state.doc)
        definition = numbering.definitions.get(label)
        dom.textContent = String(numbering.numbers.get(label) ?? label)
        dom.setAttribute('data-type', 'footnote-ref')
        dom.setAttribute('data-label', label)
        dom.className =
          definition === undefined
            ? 'footnote-ref footnote-ref-missing'
            : 'footnote-ref cursor-pointer'
        if (definition === undefined) dom.setAttribute('title', t('editor.footnoteMissing'))
        else dom.removeAttribute('title')
      }

      render()
      storage.views.add(render)

      const clickHandler = (event: MouseEvent) => {
        if (definition === undefined) return
        event.preventDefault()
        event.stopPropagation()
        options.onNavigate?.(definition)
      }
      dom.addEventListener('click', clickHandler)

      return {
        dom,
        update(updated) {
          if (updated.type.name !== 'footnote_ref') return false
          label = updated.attrs['label'] as string
          render()
          return true
        },
        destroy() {
          dom.removeEventListener('click', clickHandler)
          storage.views.delete(render)
        },
      }
    }
  },

  addProseMirrorPlugins() {
    const { options, storage } = this
    return [
      typedReference(this.type),
      // The node views redraw when an edit changes the numbering: a reference
      // typed earlier on the page renumbers the ones after it.
      new Plugin({
        view: (view) => {
          let shown = options.footnotes(view.state.doc)
          return {
            update(next) {
              const numbering = options.footnotes(next.state.doc)
              if (numbering === shown || sameNumbering(numbering, shown)) return
              shown = numbering
              for (const render of storage.views) render()
            },
          }
        },
      }),
    ]
  },
})
