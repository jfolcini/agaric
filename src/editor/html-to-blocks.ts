/**
 * Clipboard-HTML → Agaric-Markdown block outline (#1439, MVP).
 *
 * Pasting from a web page (or another rich editor) puts an HTML fragment on the
 * clipboard under `text/html`. This module walks that fragment and emits the
 * INDENTED-MARKDOWN outline our block store already understands
 * (`parseIndentedMarkdown` → `pasteBlocks`, `src/lib/block-clipboard.ts`): one
 * block per block-level element, children indented {@link INDENT_UNIT} spaces
 * per level.
 *
 * The walk is deliberately a DOM walk rather than a single `turndown(html)`
 * call: Turndown emits a multi-line markdown document (lists on their own
 * lines, a heading then a blank line, …), but an Agaric block's content is
 * SINGLE-LINE markdown — one block per heading / paragraph / list item. So we
 * split the document into blocks ourselves and run Turndown only on each
 * element's INLINE content (bold/italic/code/strike/links). The block STRUCTURE
 * (which line, how deeply nested) is expressed by the outline indentation, which
 * `pasteBlocks` turns into real parent/child blocks.
 *
 * MVP scope: headings (`h1`–`h6`), paragraphs, lists (`ul`/`ol`, incl. nesting),
 * links, and the `bold`/`italic`/`code`/`strike` inline marks. Tables, fenced
 * code blocks, images, blockquotes/callouts and task lists are intentionally
 * left to a follow-up — anything not recognised here contributes its text only.
 *
 * Security: the HTML is UNTRUSTED and there is no sanitizer in the paste path,
 * so the Turndown instance must be built via {@link createInlineTurndown},
 * which strips `script`/`style`/`noscript` and clamps link hrefs to http(s).
 */

import { INDENT_UNIT } from '@/lib/block-clipboard'

/**
 * Converts one element's INLINE content to single-line Agaric markdown
 * (bold/italic/code/strike/links). Injected so the DOM walk stays free of a
 * hard Turndown dependency and is unit-testable with a real configured
 * instance. Implemented by {@link createInlineTurndown} over `service.turndown`.
 */
export type InlineToMarkdown = (el: Element) => string

/** A block produced by the walk: its single-line markdown content + nesting depth. */
export interface OutlineBlock {
  /** Single-line Agaric markdown (already carrying any list marker). */
  content: string
  /** 0 = top-level paste block; each nested list level adds one. */
  depth: number
}

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
const BLOCK_CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'BODY', 'HTML'])
/**
 * Executable / presentational elements whose CONTENT must never leak into a
 * block (untrusted HTML). Dropped in the DOM walk itself — `el.innerHTML` of a
 * `<script>` is bare text by the time Turndown sees it, so Turndown's own
 * `.remove(...)` (which matches the element, not its text) cannot catch these.
 */
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT'])

/** Collapse runs of whitespace (incl. newlines from the source HTML) to single spaces. */
function squashWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Walk the children of `parent`, appending one {@link OutlineBlock} per
 * recognised block-level element at the given `depth`. Unrecognised inline-ish
 * containers (`div`/`section`/…) are descended into so their block children are
 * still found; bare inline content directly under such a container is collected
 * into a single paragraph block.
 */
function walkChildren(
  parent: ParentNode,
  depth: number,
  inline: InlineToMarkdown,
  out: OutlineBlock[],
): void {
  // Inline content sitting directly between block elements (e.g. loose text in
  // a `<div>`) is buffered into an implicit paragraph and flushed when a real
  // block element is hit or the container ends.
  let inlineBuffer = ''
  const flushInline = (): void => {
    const md = squashWhitespace(inlineBuffer)
    if (md.length > 0) out.push({ content: md, depth })
    inlineBuffer = ''
  }

  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === node.TEXT_NODE) {
      inlineBuffer += node.textContent ?? ''
      continue
    }
    if (node.nodeType !== node.ELEMENT_NODE) continue
    const el = node as Element
    const tag = el.tagName

    // Security: drop executable/presentational elements outright (their text
    // must never become block content). Defence-in-depth with Turndown's own
    // `.remove(...)`, which only catches them when nested inside a converted
    // element's innerHTML.
    if (DROP_TAGS.has(tag)) continue

    if (HEADING_TAGS.has(tag)) {
      flushInline()
      const level = Number(tag[1])
      const text = squashWhitespace(inline(el))
      if (text.length > 0) out.push({ content: `${'#'.repeat(level)} ${text}`, depth })
      continue
    }

    if (tag === 'P') {
      flushInline()
      const text = squashWhitespace(inline(el))
      if (text.length > 0) out.push({ content: text, depth })
      continue
    }

    if (tag === 'UL' || tag === 'OL') {
      flushInline()
      walkList(el, tag === 'OL', depth, inline, out)
      continue
    }

    if (BLOCK_CONTAINER_TAGS.has(tag)) {
      // A wrapper element: flush any pending inline text, then descend so its
      // block children are emitted at the SAME depth (the wrapper is not itself
      // a block).
      flushInline()
      walkChildren(el, depth, inline, out)
      continue
    }

    // Any other element (a stray inline element directly under the container,
    // e.g. `<a>`/`<strong>`/`<span>` loose text) contributes to the buffered
    // paragraph via its Turndown inline rendering.
    inlineBuffer += inline(el)
  }

  flushInline()
}

/** Walk a `<ul>`/`<ol>`, emitting one block per `<li>` and recursing nested lists. */
function walkList(
  list: Element,
  ordered: boolean,
  depth: number,
  inline: InlineToMarkdown,
  out: OutlineBlock[],
): void {
  let ordinal = 1
  for (const node of Array.from(list.childNodes)) {
    if (node.nodeType !== node.ELEMENT_NODE) continue
    const el = node as Element
    if (el.tagName !== 'LI') continue

    // The item's OWN inline text excludes any nested list — clone the `<li>`,
    // drop nested `ul`/`ol`, and Turndown the remainder for the marker line.
    const clone = el.cloneNode(true) as Element
    for (const nested of Array.from(clone.querySelectorAll('ul, ol'))) nested.remove()
    const text = squashWhitespace(inline(clone))
    const marker = ordered ? `${ordinal}. ` : '- '
    // Always emit the item (even when empty) so a nested list keeps a parent.
    out.push({ content: `${marker}${text}`, depth })
    ordinal += 1

    // Recurse into nested lists found directly inside this `<li>`, one level
    // deeper so `pasteBlocks` nests them under this item's block.
    for (const childList of Array.from(el.children)) {
      if (childList.tagName === 'UL' || childList.tagName === 'OL') {
        walkList(childList, childList.tagName === 'OL', depth + 1, inline, out)
      }
    }
  }
}

/**
 * Convert a clipboard HTML fragment into a flat list of {@link OutlineBlock}s in
 * document order. `inline` renders each element's inline content (see
 * {@link createInlineTurndown}). The `body` is parsed from `html` by the caller
 * (so this stays DOM-agnostic and testable with any `DOMParser`).
 *
 * Returns `[]` when nothing block-like (and no text) is present — the caller
 * treats that as "not usable HTML" and falls back to the normal paste path.
 */
export function htmlBodyToOutline(body: ParentNode, inline: InlineToMarkdown): OutlineBlock[] {
  const out: OutlineBlock[] = []
  walkChildren(body, 0, inline, out)
  return out
}

/**
 * Render an {@link OutlineBlock} list as the indented-markdown outline string
 * `parseIndentedMarkdown` consumes: `INDENT_UNIT` spaces per depth level.
 */
export function outlineToIndentedMarkdown(blocks: readonly OutlineBlock[]): string {
  return blocks.map((b) => ' '.repeat(INDENT_UNIT * b.depth) + b.content).join('\n')
}
