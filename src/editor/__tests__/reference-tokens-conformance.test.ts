/**
 * #5160 — the editor's reading of the name-rule rows in
 * `conformance/reference-tokens.vectors.json`. The Rust side
 * (`name_rule_vectors_pin_todays_name_pass` in `markdown.rs`) pins which page
 * and tag names the text surfaces' name pass asks for and the content it
 * stores (`transformed`). This file pins what `parse` makes of that stored
 * content: text, a tag, a page link or a link.
 *
 * A row whose result differs from the decided grammar carries its #5160
 * finding, so the phase that fixes it flips exactly that row; a row where the
 * two sides disagree (Rust asked for a name the editor does not show as a tag
 * or page, or the reverse) must carry one.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { parse } from '@/editor/markdown-parse'
import type { DocNode, InlineNode, LinkMark } from '@/editor/types'

/** One piece of what the editor shows: `[kind, text]`. */
type Piece = [kind: 'text' | 'tag' | 'page' | 'link', text: string]

interface NameRuleCase {
  name: string
  transformed: string
  requestedPageNames: string[]
  requestedTagNames: string[]
  editor: Piece[]
  finding?: string
}

interface Vectors {
  pageResolutions: Record<string, string>
  tagResolutions: Record<string, string>
  nameRuleCases: NameRuleCase[]
}

const VECTORS_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'conformance',
  'reference-tokens.vectors.json',
)
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Vectors

const invert = (names: Record<string, string>) =>
  new Map(Object.entries(names).map(([name, id]) => [id, name]))
const pageNames = invert(vectors.pageResolutions)
const tagNames = invert(vectors.tagResolutions)

function inlinePiece(node: InlineNode): Piece {
  switch (node.type) {
    case 'tag_ref': {
      return ['tag', tagNames.get(node.attrs.id) ?? node.attrs.id]
    }
    case 'block_link': {
      return ['page', pageNames.get(node.attrs.id) ?? node.attrs.id]
    }
    case 'text': {
      const link = node.marks?.find((mark): mark is LinkMark => mark.type === 'link')
      if (link) return ['link', `${node.text} -> ${link.attrs.href}`]
      return ['text', node.text]
    }
    default: {
      throw new Error(`no piece for inline ${node.type}`)
    }
  }
}

/** The one block `markdown` parses to, as pieces; adjacent text is joined. */
function editorPieces(markdown: string): Piece[] {
  const doc: DocNode = parse(markdown)
  expect(doc.content, markdown).toHaveLength(1)
  const [block] = doc.content ?? []
  if (block?.type !== 'paragraph') throw new Error(`no pieces for block ${block?.type}`)
  const pieces: Piece[] = []
  for (const node of block.content ?? []) {
    const piece = inlinePiece(node)
    const last = pieces.at(-1)
    if (last?.[0] === 'text' && piece[0] === 'text') last[1] += piece[1]
    else pieces.push(piece)
  }
  return pieces
}

/** Whether the editor shows exactly the `names` Rust asked for as `kind`. */
const showsNames = (pieces: Piece[], kind: Piece[0], names: string[]) =>
  JSON.stringify(pieces.flatMap(([k, name]) => (k === kind ? [name] : [])).toSorted()) ===
  JSON.stringify(names.toSorted())

describe('name-rule vectors through the editor parse (#5160)', () => {
  it.each(vectors.nameRuleCases.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    const pieces = editorPieces(row.transformed)
    expect(pieces).toEqual(row.editor)
    const sidesAgree =
      showsNames(pieces, 'tag', row.requestedTagNames) &&
      showsNames(pieces, 'page', row.requestedPageNames)
    if (!sidesAgree) {
      expect(row.finding, 'a row where the sides disagree names its finding').toBeDefined()
    }
  })
})
