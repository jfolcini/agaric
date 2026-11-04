/**
 * Footnotes (#6033), numbered per page. A reference is `[^label]` inline; a
 * block whose text starts `[^label]: ` defines the label. References show 1, 2,
 * 3 in the order their labels are first referenced on the page, a definition
 * its label's number; the stored text keeps the label as written.
 */

import { parse } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'

/** A page's footnotes: each referenced label's number, and the block that defines each label. */
export interface FootnoteNumbering {
  readonly numbers: ReadonlyMap<string, number>
  readonly definitions: ReadonlyMap<string, string>
}

export const NO_FOOTNOTES: FootnoteNumbering = { numbers: new Map(), definitions: new Map() }

/** What one block's text holds: the labels it refers to, in order, and the one it defines. */
export interface BlockFootnotes {
  readonly refs: readonly string[]
  readonly defines: string | null
}

const NONE: BlockFootnotes = { refs: [], defines: null }

/** The label a block defines: its text starts `[^label]: `. */
export function definedLabel(doc: DocNode): string | null {
  const first = doc.content?.[0]
  if (first?.type !== 'paragraph') return null
  const [ref, rest] = first.content ?? []
  if (ref?.type !== 'footnote_ref' || rest?.type !== 'text' || !rest.text.startsWith(': ')) {
    return null
  }
  return ref.attrs.label
}

function collectRefs(nodes: readonly object[] | undefined, out: string[]): void {
  for (const node of nodes ?? []) {
    const { type, attrs, content } = node as {
      type: string
      attrs?: { label?: string }
      content?: readonly object[]
    }
    if (type === 'footnote_ref') out.push(attrs?.label ?? '')
    else collectRefs(content, out)
  }
}

export function blockFootnotes(doc: DocNode): BlockFootnotes {
  const refs: string[] = []
  collectRefs(doc.content, refs)
  const defines = definedLabel(doc)
  // A definition's own marker is the first reference walked, and refers to nothing.
  return { refs: defines === null ? refs : refs.slice(1), defines }
}

/** The numbering of a page whose blocks, in tree order, hold `footnotes`. */
export function numberFootnotes(
  blocks: Iterable<{ readonly id: string; readonly footnotes: BlockFootnotes }>,
): FootnoteNumbering {
  const numbers = new Map<string, number>()
  const definitions = new Map<string, string>()
  for (const { id, footnotes } of blocks) {
    for (const label of footnotes.refs)
      if (!numbers.has(label)) numbers.set(label, numbers.size + 1)
    const { defines } = footnotes
    if (defines !== null && !definitions.has(defines)) definitions.set(defines, id)
  }
  return { numbers, definitions }
}

interface PageBlockText {
  readonly id: string
  readonly content: string | null
}

const numberedPages = new WeakMap<readonly PageBlockText[], FootnoteNumbering>()

/**
 * The numbering of the page whose blocks, in tree order, are `blocks`: worked
 * out once per list, so every block of a page store reads the same one until
 * the page's blocks change.
 */
export function pageFootnotes(blocks: readonly PageBlockText[]): FootnoteNumbering {
  let numbering = numberedPages.get(blocks)
  if (numbering === undefined) {
    numbering = numberFootnotes(
      blocks.map(({ id, content }) => ({
        id,
        footnotes: content?.includes('[^') ? blockFootnotes(parse(content)) : NONE,
      })),
    )
    numberedPages.set(blocks, numbering)
  }
  return numbering
}
