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
 * MVP scope (#1439): headings (`h1`–`h6`), paragraphs, lists (`ul`/`ol`, incl.
 * nesting), links, and the `bold`/`italic`/`code`/`strike` inline marks.
 *
 * Phase 2 (additive): `<table>` → a GFM pipe table block; `<pre>`/`<pre><code>`
 * → a fenced ```` ``` ```` code block (carrying a `language-xxx` language);
 * `<img>` → `![alt](src)` (src http(s)-clamped, else dropped); `<blockquote>`
 * → `>`-prefixed lines (the parser's callout/blockquote construct); a `<ul>`
 * whose items hold `<input type=checkbox>` → `- [ ]` / `- [x]` task blocks.
 *
 * Tables and code fences are MULTI-LINE markdown but must each stay ONE block
 * (the parser builds a single `table` / `codeBlock` node from the multi-line
 * string). The line-oriented {@link outlineToIndentedMarkdown} therefore encodes
 * a block's internal newlines as a {@link NEWLINE_SENTINEL} so the outline keeps
 * its one-line-per-block invariant; `parseIndentedMarkdown` decodes the sentinel
 * back to `\n` per block (a no-op for single-line blocks, so the copy/duplicate
 * outline paths are unaffected). Anything still not recognised contributes its
 * text only.
 *
 * Security: the HTML is UNTRUSTED and there is no sanitizer in the paste path,
 * so the Turndown instance must be built via {@link createInlineTurndown},
 * which strips `script`/`style`/`noscript` and clamps link hrefs to http(s).
 * Image `src` is clamped here via the SAME {@link isValidHttpUrl} — a
 * `javascript:`/`data:` image src is dropped rather than emitted.
 */

import { INDENT_UNIT, OUTLINE_NEWLINE_SENTINEL } from '@/lib/block-clipboard'

import { isValidHttpUrl } from './extensions/external-link'

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
 * Escape a table cell's inline markdown so a literal `|` inside the cell is not
 * read as a column separator (the parser unescapes `\|` → `|` per cell). Also
 * collapses whitespace so a multi-line cell stays on its single table row.
 */
function escapeTableCell(s: string): string {
  return squashWhitespace(s).replace(/\|/g, '\\|')
}

/**
 * Emit a GFM pipe table block from a `<table>` (Phase 2). One `OutlineBlock`
 * whose content is the multi-line ` | a | b |\n| --- | --- |\n| 1 | 2 | ` form
 * the parser's {@link parseTable} accepts: the first row is the header, the
 * `--- ` separator row is required (and skipped by the parser), data rows
 * follow. Cells render their INLINE content via `inline` (bold/links/…). A
 * table with no cell rows contributes nothing.
 */
function walkTable(
  table: Element,
  depth: number,
  inline: InlineToMarkdown,
  out: OutlineBlock[],
): void {
  const rows = Array.from(table.querySelectorAll('tr'))
  const matrix: string[][] = []
  for (const row of rows) {
    const cells = Array.from(row.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
    if (cells.length === 0) continue
    matrix.push(cells.map((c) => escapeTableCell(inline(c))))
  }
  if (matrix.length === 0) return

  const columnCount = matrix.reduce((max, r) => Math.max(max, r.length), 0)
  const toRow = (cells: string[]): string => {
    const padded = Array.from({ length: columnCount }, (_, i) => cells[i] ?? '')
    return `| ${padded.join(' | ')} |`
  }
  const lines: string[] = [toRow(matrix[0] as string[])]
  lines.push(`| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`)
  for (let r = 1; r < matrix.length; r++) lines.push(toRow(matrix[r] as string[]))

  out.push({ content: lines.join('\n'), depth })
}

/**
 * Emit a fenced code block from a `<pre>` (Phase 2). Carries the language from a
 * `language-xxx` class on the `<pre>` or its inner `<code>`. The code text is
 * taken RAW from `textContent` (no inline conversion — a code block is opaque),
 * and the fence length grows past any backtick run inside the code so the block
 * cannot be closed early (CommonMark variable-length fence; the parser accepts
 * 3+ backticks). One block; empty code contributes nothing.
 */
function walkPre(pre: Element, depth: number, out: OutlineBlock[]): void {
  const codeEl = pre.querySelector('code') ?? pre
  const language = extractCodeLanguage(pre) ?? extractCodeLanguage(codeEl)
  // `textContent` preserves the source newlines (unlike the whitespace-squashing
  // inline path). Trim only a single trailing newline (common in `<pre>`).
  const raw = codeEl.textContent ?? ''
  const code = raw.replace(/\n$/, '')
  if (code.length === 0) return

  // Grow the fence past the longest backtick run in the code so it can't close
  // the block prematurely (min 3 per the parser).
  let longest = 0
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const open = language ? `${fence}${language}` : fence
  out.push({ content: `${open}\n${code}\n${fence}`, depth })
}

/** Read a `language-xxx` / `lang-xxx` class and return `xxx` (parser-safe chars only). */
function extractCodeLanguage(el: Element): string | null {
  for (const cls of Array.from(el.classList)) {
    const m = cls.match(/^(?:language|lang)-(.+)$/)
    if (m && /^[a-zA-Z0-9_+\-#.]+$/.test(m[1] as string)) return m[1] as string
  }
  return null
}

/**
 * Emit an image as `![alt](src)` (Phase 2) with the `src` clamped to http(s)
 * via the SAME {@link isValidHttpUrl} the link path uses — a `javascript:` /
 * `data:` / other-scheme (or empty) src is DROPPED (returns false, no block).
 * The alt is whitespace-squashed; `]`/`\` in the alt are escaped so the
 * `![…](…)` shape round-trips through the parser's `unescapeImageAlt`.
 */
function imageMarkdown(img: Element): string | null {
  const src = img.getAttribute('src') ?? ''
  if (!isValidHttpUrl(src)) return null
  const alt = squashWhitespace(img.getAttribute('alt') ?? '').replace(/([\\\]])/g, '\\$1')
  return `![${alt}](${src})`
}

/**
 * Emit a blockquote as `>`-prefixed lines (Phase 2). The quote's block children
 * each become one `>` line (paragraphs / list items flattened to their inline
 * markdown); the parser's {@link parseBlockquote} rebuilds the blockquote node
 * from the consecutive `> ` lines. One block; an empty quote contributes
 * nothing.
 */
function walkBlockquote(
  quote: Element,
  depth: number,
  inline: InlineToMarkdown,
  out: OutlineBlock[],
): void {
  // Reuse the block walk to split the quote into its constituent lines, then
  // prefix each with `> `. Nested depth inside the quote is flattened (the
  // blockquote is a single block here), so all inner lines sit at depth 0.
  const inner: OutlineBlock[] = []
  walkChildren(quote, 0, inline, inner)
  const lines = inner.map((b) => b.content)
  if (lines.length === 0) {
    // No block children — fall back to the quote's own inline text.
    const text = squashWhitespace(inline(quote))
    if (text.length === 0) return
    lines.push(text)
  }
  const quoted = lines.map((l) => `> ${l}`).join('\n')
  out.push({ content: quoted, depth })
}

/**
 * Detect whether a `<ul>`/`<ol>` is a GFM task list — at least one `<li>`
 * directly containing a `<input type="checkbox">`. Such lists emit `- [ ]` /
 * `- [x]` task blocks (one per item) rather than plain bullets.
 */
function isTaskList(list: Element): boolean {
  for (const li of Array.from(list.children)) {
    if (li.tagName !== 'LI') continue
    if (li.querySelector(':scope > input[type="checkbox"]')) return true
  }
  return false
}

/**
 * Walk a task `<ul>`/`<ol>`, emitting `- [ ]` (unchecked) / `- [x]` (checked)
 * per item (Phase 2). The checkbox `<input>` is stripped from the item's text
 * so only the label remains. Nested lists recurse one level deeper (preserving
 * the outline nesting model); a nested task list stays a task list, a nested
 * plain list stays plain.
 */
function walkTaskList(
  list: Element,
  depth: number,
  inline: InlineToMarkdown,
  out: OutlineBlock[],
): void {
  for (const node of Array.from(list.childNodes)) {
    if (node.nodeType !== node.ELEMENT_NODE) continue
    const el = node as Element
    if (el.tagName !== 'LI') continue

    const checkbox = el.querySelector(':scope > input[type="checkbox"]')
    const checked = checkbox instanceof HTMLInputElement ? checkbox.checked : false
    const marker = checked ? '- [x]' : '- [ ]'

    // The item's OWN text excludes nested lists and the checkbox input.
    const clone = el.cloneNode(true) as Element
    for (const nested of Array.from(clone.querySelectorAll('ul, ol'))) nested.remove()
    for (const box of Array.from(clone.querySelectorAll('input'))) box.remove()
    const text = squashWhitespace(inline(clone))
    out.push({ content: text.length > 0 ? `${marker} ${text}` : marker, depth })

    // Recurse into nested lists found directly inside this `<li>`.
    for (const childList of Array.from(el.children)) {
      if (childList.tagName === 'UL' || childList.tagName === 'OL') {
        if (isTaskList(childList)) {
          walkTaskList(childList, depth + 1, inline, out)
        } else {
          walkList(childList, childList.tagName === 'OL', depth + 1, inline, out)
        }
      }
    }
  }
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
      if (isTaskList(el)) walkTaskList(el, depth, inline, out)
      else walkList(el, tag === 'OL', depth, inline, out)
      continue
    }

    if (tag === 'TABLE') {
      flushInline()
      walkTable(el, depth, inline, out)
      continue
    }

    if (tag === 'PRE') {
      flushInline()
      walkPre(el, depth, out)
      continue
    }

    if (tag === 'BLOCKQUOTE') {
      flushInline()
      walkBlockquote(el, depth, inline, out)
      continue
    }

    if (tag === 'IMG') {
      // A block-level (standalone) image becomes its own `![alt](src)` block.
      // A non-http(s) src is dropped (security). Images sitting inline within a
      // paragraph are handled by Turndown's inline conversion instead.
      flushInline()
      const md = imageMarkdown(el)
      if (md) out.push({ content: md, depth })
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
 *
 * A block whose content is itself MULTI-LINE (a table or fenced code block —
 * Phase 2) would otherwise be shredded by the line-oriented outline, so its
 * internal newlines are encoded as {@link OUTLINE_NEWLINE_SENTINEL};
 * `parseIndentedMarkdown` decodes them back to `\n` per block. Single-line
 * blocks contain no sentinel and are unaffected.
 */
export function outlineToIndentedMarkdown(blocks: readonly OutlineBlock[]): string {
  return blocks
    .map(
      (b) =>
        ' '.repeat(INDENT_UNIT * b.depth) + b.content.replaceAll('\n', OUTLINE_NEWLINE_SENTINEL),
    )
    .join('\n')
}
