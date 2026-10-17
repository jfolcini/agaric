/**
 * Code-block highlighting (#5691): the decorations `CodeBlockLowlight`'s own
 * plugin makes, kept current by highlighting again only the code blocks a
 * transaction touched. The stock plugin walks the whole document on every
 * transaction, which in page mode is every block of the page.
 */

import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { createLowlight } from 'lowlight'

type Lowlight = ReturnType<typeof createLowlight>

/** The part of a hast tree lowlight returns that the decorations read. */
interface HastNode {
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

export interface CodeHighlightOptions {
  /** The code block node's name. */
  name: string
  lowlight: Lowlight
  defaultLanguage: string | null | undefined
}

/** Each run of `nodes`' text with the classes of the elements around it. */
function runs(nodes: readonly HastNode[], classes: readonly string[] = []) {
  return nodes.flatMap((node): Array<{ text: string; classes: readonly string[] }> => {
    const own = Array.isArray(node.properties?.className)
      ? (node.properties.className as string[])
      : []
    const inherited = own.length > 0 ? [...classes, ...own] : classes
    if (node.children !== undefined) return runs(node.children, inherited)
    return [{ text: node.value ?? '', classes: inherited }]
  })
}

/** The decorations for the code block `node` at `pos`, as lowlight's plugin makes them. */
function highlight(node: PMNode, pos: number, options: CodeHighlightOptions): Decoration[] {
  const { lowlight, defaultLanguage } = options
  const language = (node.attrs['language'] as string | null) || defaultLanguage
  const text = node.textContent
  const tree =
    language && lowlight.registered(language)
      ? lowlight.highlight(language, text)
      : lowlight.highlightAuto(text)
  const decorations: Decoration[] = []
  let from = pos + 1
  for (const run of runs((tree as unknown as HastNode).children ?? [])) {
    const to = from + run.text.length
    if (run.classes.length > 0) {
      decorations.push(Decoration.inline(from, to, { class: run.classes.join(' ') }))
    }
    from = to
  }
  return decorations
}

/** The ranges of `tr.doc` its steps changed. */
function touchedRanges(tr: Transaction): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1)
    map.forEach((_oldFrom, _oldTo, from, to) => {
      ranges.push([rest.map(from, -1), rest.map(to, 1)])
    })
  })
  return ranges
}

export function codeHighlight(options: CodeHighlightOptions): Plugin<DecorationSet> {
  const key = new PluginKey<DecorationSet>('codeHighlight')
  const isCode = (node: PMNode) => node.type.name === options.name
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, { doc }) => {
        const decorations: Decoration[] = []
        doc.descendants((node, pos) => {
          if (isCode(node)) decorations.push(...highlight(node, pos, options))
          return !isCode(node)
        })
        return DecorationSet.create(doc, decorations)
      },
      apply: (tr, previous) => {
        if (!tr.docChanged) return previous
        let set = previous.map(tr.mapping, tr.doc)
        const done = new Set<number>()
        for (const [from, to] of touchedRanges(tr)) {
          const end = Math.min(to, tr.doc.content.size)
          tr.doc.nodesBetween(Math.min(from, end), end, (node, pos) => {
            if (!isCode(node)) return true
            if (!done.has(pos)) {
              done.add(pos)
              set = set.remove(set.find(pos, pos + node.nodeSize))
              set = set.add(tr.doc, highlight(node, pos, options))
            }
            return false
          })
        }
        return set
      },
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  })
}
