/**
 * Syntax colours for code blocks, as lowlight's own plugin draws them, kept up
 * per edit: a transaction re-highlights only the code blocks its changes touch
 * and maps every other colour along. The stock plugin
 * (`@tiptap/extension-code-block-lowlight`) walks the whole document twice on
 * every transaction, selection moves included, and re-highlights every code
 * block when one changes; in page mode's whole-page document that is each
 * keystroke (#5691).
 */

import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { createLowlight } from 'lowlight'

type Lowlight = ReturnType<typeof createLowlight>

/** The parts of lowlight's hast tree a colour is read from. */
interface HastNode {
  type: string
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

interface Options {
  name: string
  lowlight: Lowlight
  defaultLanguage: string | null | undefined
}

/** One inline decoration per classed run of `node`'s text, `pos` being where the node starts. */
function highlightBlock(node: PMNode, pos: number, o: Options): Decoration[] {
  const language = (node.attrs['language'] as string | null) || o.defaultLanguage
  const text = node.textContent
  const tree =
    language && o.lowlight.registered(language)
      ? o.lowlight.highlight(language, text)
      : o.lowlight.highlightAuto(text)
  const decorations: Decoration[] = []
  let from = pos + 1
  const walk = (nodes: readonly HastNode[], classes: readonly string[]): void => {
    for (const child of nodes) {
      const own = child.properties?.className
      const inner = Array.isArray(own) ? [...classes, ...(own as string[])] : classes
      if (child.children !== undefined) {
        walk(child.children, inner)
        continue
      }
      const to = from + (child.value ?? '').length
      if (inner.length > 0)
        decorations.push(Decoration.inline(from, to, { class: inner.join(' ') }))
      from = to
    }
  }
  walk(tree.children, [])
  return decorations
}

/** The code blocks in `doc` overlapping `from`…`to`, by position. */
function codeBlocksIn(
  doc: PMNode,
  from: number,
  to: number,
  o: Options,
  found: Map<number, PMNode>,
) {
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === o.name) found.set(pos, node)
    return !node.isTextblock
  })
}

/** The code blocks `tr` changed, in its resulting document. */
function touched(tr: Transaction, o: Options): Map<number, PMNode> {
  const found = new Map<number, PMNode>()
  tr.mapping.maps.forEach((map, i) => {
    const after = tr.mapping.slice(i + 1)
    map.forEach((_oldFrom, _oldTo, from, to) => {
      codeBlocksIn(tr.doc, after.map(from, -1), after.map(to, 1), o, found)
    })
  })
  return found
}

export function codeHighlightPlugin(o: Options): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: new PluginKey('codeHighlight'),
    state: {
      init: (_, { doc }) => {
        const found = new Map<number, PMNode>()
        codeBlocksIn(doc, 0, doc.content.size, o, found)
        return DecorationSet.create(
          doc,
          [...found].flatMap(([pos, node]) => highlightBlock(node, pos, o)),
        )
      },
      apply: (tr, set) => {
        if (!tr.docChanged) return set
        let next = set.map(tr.mapping, tr.doc)
        for (const [pos, node] of touched(tr, o)) {
          const stale = next.find(pos + 1, pos + node.nodeSize - 1)
          next = next.remove(stale).add(tr.doc, highlightBlock(node, pos, o))
        }
        return next
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)
      },
    },
  })
}
