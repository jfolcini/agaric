/**
 * TipTap extensions: math_inline and math_block nodes (#1437).
 *
 * `math_inline` — an atomic INLINE node for `$…$` math. `attrs.latex` holds the
 * raw LaTeX. Rendered via a React node view (`MathInlineNodeView`) that draws
 * the formula with KaTeX (lazy-loaded) and exposes a raw-source editor.
 *
 * `math_block` — an atomic BLOCK node for `$$…$$` display math. Same attr/node-
 * view shape, rendered in KaTeX display mode.
 *
 * Both round-trip through the markdown serializer (`$…$` / `$$…$$`); the nodes
 * are atoms so the LaTeX is edited only through the node view, never as inline
 * ProseMirror text.
 */

import { InputRule, mergeAttributes, Node } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'

import { MathBlockNodeView, MathInlineNodeView } from './MathNodeView'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mathInline: {
      insertInlineMath: (latex: string) => ReturnType
    }
    mathBlock: {
      insertBlockMath: (latex: string) => ReturnType
    }
  }
}

export const MathInline = Node.create({
  name: 'math_inline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-latex') ?? '',
        renderHTML: (attrs) => ({ 'data-latex': attrs['latex'] as string }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="math-inline"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-type': 'math-inline' }),
      `$${node.attrs['latex'] as string}$`,
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathInlineNodeView)
  },

  // Typing `$…$` converts to an inline-math node (mirrors the markdown parse
  // rule): the opening `$` must be followed by a non-space, non-digit char (so
  // `$5` currency is left as text), and the closing `$` is the just-typed char.
  // A custom InputRule (not nodeInputRule) is used so the `$` delimiters are
  // consumed — nodeInputRule preserves a captured group's surrounding text.
  addInputRules() {
    const type = this.type
    return [
      new InputRule({
        find: /\$([^\s$0-9][^$]*?)\$$/,
        handler: ({ state, range, match }) => {
          // #1537 — keep `$…$` literal inside code contexts (a code block, or
          // text carrying the inline-code mark). Defense-in-depth: TipTap's
          // `InputRule.run` already declines rules in those contexts before this
          // handler fires, so this guard makes the behavior explicit and
          // self-contained rather than relying on that vendored internal.
          const $from = state.doc.resolve(range.from)
          const codeMark = state.schema.marks['code']
          if (
            $from.parent.type.spec.code ||
            (codeMark != null && codeMark.isInSet($from.marks()))
          ) {
            return
          }
          const latex = match[1] ?? ''
          state.tr.replaceWith(range.from, range.to, type.create({ latex }))
        },
      }),
    ]
  },

  addCommands() {
    return {
      insertInlineMath:
        (latex: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { latex } }),
    }
  },
})

export const MathBlock = Node.create({
  name: 'math_block',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-latex') ?? '',
        renderHTML: (attrs) => ({ 'data-latex': attrs['latex'] as string }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="math-block"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'math-block' }),
      `$$${node.attrs['latex'] as string}$$`,
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathBlockNodeView)
  },

  // Typing a single-line `$$ … $$` (the whole line) converts to a display-math
  // block. A custom InputRule (not nodeInputRule) so the `$$` delimiters are
  // consumed; the `^` anchor requires the fence to be the entire textblock so
  // we can replace the enclosing (now-empty) paragraph with the block atom.
  addInputRules() {
    const type = this.type
    return [
      new InputRule({
        find: /^\$\$\s*([^$]+?)\s*\$\$$/,
        handler: ({ state, range, match }) => {
          const latex = (match[1] ?? '').trim()
          const $from = state.doc.resolve(range.from)
          // #1537 — keep `$$…$$` literal inside code contexts (defense-in-depth;
          // TipTap's `InputRule.run` already declines rules in a code block /
          // inline-code mark, but we guard explicitly here too).
          const codeMark = state.schema.marks['code']
          if (
            $from.parent.type.spec.code ||
            (codeMark != null && codeMark.isInSet($from.marks()))
          ) {
            return
          }
          // Replace the entire enclosing textblock (paragraph) with the atom.
          const blockStart = $from.before($from.depth)
          const blockEnd = $from.after($from.depth)
          state.tr.replaceWith(blockStart, blockEnd, type.create({ latex }))
        },
      }),
    ]
  },

  addCommands() {
    return {
      insertBlockMath:
        (latex: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { latex } }),
    }
  },
})
