/**
 * Tests for the clipboard-HTML → Agaric-Markdown block converter (#1439, MVP).
 *
 * Drives the REAL Turndown configuration (`createInlineTurndown`) through the
 * DOM walk (`htmlBodyToOutline`) so the assertions cover the production
 * conversion, then verifies the emitted indented markdown re-parses into the
 * expected block tree (structure + inline marks) via the same
 * `parseIndentedMarkdown` + `parse` the paste path uses.
 */

import { describe, expect, it } from 'vitest'

import { parseIndentedMarkdown } from '../../lib/block-clipboard'
import { isUsableHtml } from '../extensions/html-paste'
import { htmlBodyToOutline, type OutlineBlock, outlineToIndentedMarkdown } from '../html-to-blocks'
import { createInlineTurndown } from '../inline-turndown'
import { parse } from '../markdown-serializer'

/** Convert an HTML fragment to the outline blocks via the real Turndown config. */
function convert(html: string): OutlineBlock[] {
  const body = new DOMParser().parseFromString(html, 'text/html').body
  const { inline } = createInlineTurndown()
  return htmlBodyToOutline(body, inline)
}

/** Convert to the indented-markdown outline string the paste path emits. */
function convertToMarkdown(html: string): string {
  return outlineToIndentedMarkdown(convert(html))
}

describe('isUsableHtml', () => {
  it('rejects absent / empty payloads', () => {
    expect(isUsableHtml(undefined)).toBe(false)
    expect(isUsableHtml(null)).toBe(false)
    expect(isUsableHtml('')).toBe(false)
  })

  it('rejects tag-free escaped plain text', () => {
    expect(isUsableHtml('just some plain text, no tags')).toBe(false)
  })

  it('rejects a bare wrapper with no visible text', () => {
    expect(isUsableHtml('<html><body><!--StartFragment--><!--EndFragment--></body></html>')).toBe(
      false,
    )
    expect(isUsableHtml('<div></div>')).toBe(false)
  })

  it('accepts a real fragment with visible text', () => {
    expect(isUsableHtml('<p>hello <b>world</b></p>')).toBe(true)
    expect(
      isUsableHtml('<html><body><!--StartFragment--><h1>Hi</h1><!--EndFragment--></body></html>'),
    ).toBe(true)
  })
})

describe('htmlBodyToOutline — block structure', () => {
  it('converts headings to ATX heading blocks', () => {
    expect(convert('<h1>Title</h1><h3>Sub</h3>')).toEqual([
      { content: '# Title', depth: 0 },
      { content: '### Sub', depth: 0 },
    ])
  })

  it('converts paragraphs to plain blocks', () => {
    expect(convert('<p>First</p><p>Second</p>')).toEqual([
      { content: 'First', depth: 0 },
      { content: 'Second', depth: 0 },
    ])
  })

  it('converts an unordered list to one bullet block per item', () => {
    expect(convert('<ul><li>a</li><li>b</li></ul>')).toEqual([
      { content: '- a', depth: 0 },
      { content: '- b', depth: 0 },
    ])
  })

  it('converts an ordered list to numbered blocks', () => {
    expect(convert('<ol><li>one</li><li>two</li></ol>')).toEqual([
      { content: '1. one', depth: 0 },
      { content: '2. two', depth: 0 },
    ])
  })

  it('nests a child list one depth under its parent item', () => {
    const html = '<ul><li>parent<ul><li>child</li><li>child2</li></ul></li><li>sibling</li></ul>'
    expect(convert(html)).toEqual([
      { content: '- parent', depth: 0 },
      { content: '- child', depth: 1 },
      { content: '- child2', depth: 1 },
      { content: '- sibling', depth: 0 },
    ])
  })

  it('descends into wrapper divs without creating extra blocks', () => {
    expect(convert('<div><p>wrapped</p></div>')).toEqual([{ content: 'wrapped', depth: 0 }])
  })

  it('returns [] for whitespace-only / structurally-empty HTML', () => {
    expect(convert('<div>   </div>')).toEqual([])
  })
})

describe('htmlBodyToOutline — inline marks', () => {
  it('converts bold / italic / code / strike marks', () => {
    const blocks = convert('<p><b>bold</b> <i>italic</i> <code>code</code> <s>struck</s></p>')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.content).toBe('**bold** _italic_ `code` ~~struck~~')
  })

  it('keeps an http(s) link as [text](url)', () => {
    const blocks = convert('<p>see <a href="https://example.com">site</a></p>')
    expect(blocks[0]?.content).toBe('see [site](https://example.com)')
  })
})

describe('security guards', () => {
  it('drops a javascript: link to plain text (de-linked)', () => {
    const blocks = convert('<p>click <a href="javascript:alert(1)">here</a></p>')
    expect(blocks[0]?.content).toBe('click here')
    expect(blocks[0]?.content).not.toContain('javascript:')
    expect(blocks[0]?.content).not.toContain('(')
  })

  it('drops a data: link to plain text', () => {
    const blocks = convert('<p><a href="data:text/html,<script>1</script>">x</a></p>')
    expect(blocks[0]?.content).toBe('x')
    expect(blocks[0]?.content).not.toContain('data:')
  })

  it('strips <script> content entirely', () => {
    const blocks = convert('<p>safe</p><script>alert("xss")</script>')
    const md = blocks.map((b) => b.content).join('\n')
    expect(md).toBe('safe')
    expect(md).not.toContain('alert')
  })

  it('strips <style> and <noscript> content', () => {
    const blocks = convert('<style>.x{color:red}</style><p>visible</p><noscript>nojs</noscript>')
    const md = blocks.map((b) => b.content).join('\n')
    expect(md).toBe('visible')
    expect(md).not.toContain('color')
    expect(md).not.toContain('nojs')
  })
})

describe('outline → indented markdown → block tree', () => {
  it('round-trips a nested list into the expected parent/child block tree', () => {
    const html = '<ul><li>parent<ul><li>child</li></ul></li></ul>'
    const markdown = convertToMarkdown(html)
    expect(markdown).toBe('- parent\n  - child')

    const parsed = parseIndentedMarkdown(markdown)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toEqual({ content: '- parent', parentIndex: null })
    expect(parsed[1]).toEqual({ content: '- child', parentIndex: 0 })
  })

  it('emits a heading whose content re-parses to a heading node', () => {
    const markdown = convertToMarkdown('<h2>Hello <b>bold</b></h2>')
    expect(markdown).toBe('## Hello **bold**')
    const doc = parse(markdown)
    const block = doc.content?.[0]
    expect(block?.type).toBe('heading')
    expect((block as { attrs?: { level?: number } }).attrs?.level).toBe(2)
  })

  it('emits a paragraph whose marks survive a re-parse', () => {
    const markdown = convertToMarkdown('<p>a <b>b</b> c</p>')
    const doc = parse(markdown)
    const inline = doc.content?.[0]?.content ?? []
    // The bold run carries the bold mark.
    const bold = inline.find((n) => n.type === 'text' && (n as { text?: string }).text === 'b') as
      | { marks?: Array<{ type: string }> }
      | undefined
    expect(bold?.marks?.some((m) => m.type === 'bold')).toBe(true)
  })
})

// ── #1439 Phase 2: tables, code fences, images, blockquotes, task lists ───────

/**
 * Drive a single fragment through the FULL paste path — DOM walk → indented
 * markdown (with the multi-line-block newline encoding) → `parseIndentedMarkdown`
 * (decode) → per-block `parse` — and return the parsed block specs with each
 * block's content reparsed to its top-level node. Mirrors what `pasteBlocks`
 * does so the assertions cover the real round-trip, not just the converter.
 */
function pasteRoundTrip(html: string): { content: string; node: ReturnType<typeof parse> }[] {
  const markdown = convertToMarkdown(html)
  return parseIndentedMarkdown(markdown).map((b) => ({
    content: b.content,
    node: parse(b.content),
  }))
}

describe('htmlBodyToOutline — tables (Phase 2)', () => {
  it('emits a single GFM pipe-table block that re-parses to one table node', () => {
    const html =
      '<table><thead><tr><th>H1</th><th>H2</th></tr></thead>' +
      '<tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>'
    const blocks = convert(html)
    expect(blocks).toHaveLength(1)
    // One block; its content is multi-line GFM with a separator row.
    expect(blocks[0]?.content).toBe('| H1 | H2 |\n| --- | --- |\n| a | b |\n| c | d |')

    // The multi-line block survives the line-oriented outline as ONE block …
    const round = pasteRoundTrip(html)
    expect(round).toHaveLength(1)
    expect(round[0]?.content).toContain('\n') // newlines restored
    // … and re-parses to a single table node with the right shape.
    const doc = round[0]?.node
    const table = doc?.content?.[0]
    expect(table?.type).toBe('table')
    expect((table as unknown as { content?: unknown[] }).content).toHaveLength(3) // header + 2 data rows
  })

  it('escapes a literal pipe inside a cell so it is not a column boundary', () => {
    const blocks = convert('<table><tr><td>a|b</td><td>c</td></tr></table>')
    expect(blocks[0]?.content).toContain('a\\|b')
    // Re-parses to a single 2-column row (the escaped pipe stays in the cell).
    const doc = parse(blocks[0]?.content ?? '')
    const table = doc.content?.[0] as unknown as { content?: { content?: unknown[] }[] } | undefined
    const row = table?.content?.[0]
    expect(row?.content).toHaveLength(2)
  })

  it('escapes a trailing backslash so it cannot escape the column delimiter', () => {
    // A literal `\` at the end of a cell must not shield the next `|` separator
    // (CodeQL js/incomplete-sanitization). Backslash is escaped first → `\\`.
    const blocks = convert('<table><tr><td>a\\</td><td>b</td></tr></table>')
    expect(blocks[0]?.content).toContain('a\\\\')
    // Re-parses to a single 2-column row — the delimiter survived.
    const doc = parse(blocks[0]?.content ?? '')
    const table = doc.content?.[0] as unknown as { content?: { content?: unknown[] }[] } | undefined
    const row = table?.content?.[0]
    expect(row?.content).toHaveLength(2)
  })
})

describe('htmlBodyToOutline — fenced code blocks (Phase 2)', () => {
  it('emits a fenced block carrying the language from a language-xxx class', () => {
    const html = '<pre><code class="language-ts">const x = 1\nconst y = 2</code></pre>'
    const blocks = convert(html)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.content).toBe('```ts\nconst x = 1\nconst y = 2\n```')

    const doc = parse(blocks[0]?.content ?? '')
    const code = doc.content?.[0]
    expect(code?.type).toBe('codeBlock')
    expect((code as unknown as { attrs?: { language?: string } }).attrs?.language).toBe('ts')
    expect((code as unknown as { content?: { text?: string }[] }).content?.[0]?.text).toBe(
      'const x = 1\nconst y = 2',
    )
  })

  it('grows the fence past a backtick run inside the code so it cannot close early', () => {
    const html = '<pre><code>a ``` b</code></pre>'
    const content = convert(html)[0]?.content ?? ''
    // Fence is at least 4 backticks (longer than the inner ``` run).
    expect(content.startsWith('````')).toBe(true)
    const doc = parse(content)
    const code = doc.content?.[0]
    expect(code?.type).toBe('codeBlock')
    expect(
      (code as unknown as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text,
    ).toBe('a ``` b')
  })

  it('survives the outline round-trip as one code block', () => {
    const round = pasteRoundTrip('<pre><code class="language-js">line1\nline2</code></pre>')
    expect(round).toHaveLength(1)
    expect(round[0]?.node.content?.[0]?.type).toBe('codeBlock')
  })
})

describe('htmlBodyToOutline — images (Phase 2)', () => {
  it('emits ![alt](src) for a block-level http(s) image', () => {
    const blocks = convert('<img src="https://x.com/c.png" alt="cat">')
    expect(blocks).toEqual([{ content: '![cat](https://x.com/c.png)', depth: 0 }])
    const doc = parse(blocks[0]?.content ?? '')
    expect(doc.content?.[0]?.content?.[0]).toEqual({
      type: 'image',
      attrs: { alt: 'cat', src: 'https://x.com/c.png' },
    })
  })

  it('DROPS a javascript: image src (no block emitted)', () => {
    expect(convert('<img src="javascript:alert(1)" alt="x">')).toEqual([])
  })

  it('DROPS a data: image src (no block emitted)', () => {
    expect(convert('<img src="data:image/png;base64,AAAA" alt="x">')).toEqual([])
  })

  it('drops the src of an INLINE image with a javascript: scheme, keeping only alt', () => {
    // An inline image (inside a paragraph) goes through Turndown's safeImage rule.
    const blocks = convert('<p>see <img src="javascript:alert(1)" alt="bad"> here</p>')
    expect(blocks[0]?.content).not.toContain('javascript:')
    expect(blocks[0]?.content).not.toContain('](') // no image markdown emitted
    expect(blocks[0]?.content).toContain('bad') // alt text survives
  })

  it('keeps an inline http(s) image as ![alt](src)', () => {
    const blocks = convert('<p><img src="https://x.com/c.png" alt="cat"></p>')
    expect(blocks[0]?.content).toBe('![cat](https://x.com/c.png)')
  })

  it('escapes ] and \\ in an inline image alt so it cannot inject markdown', () => {
    // A crafted alt must not break out of ![alt](src) to smuggle a second image
    // with a javascript: src that bypasses isValidHttpUrl.
    const blocks = convert('<p><img src="https://x.com/ok.png" alt="](javascript:xss) ![fake"></p>')
    const content = blocks[0]?.content ?? ''
    // The leading `]` is escaped to `\]`, so the alt span is not closed early
    // and the only image src is the safe https one.
    expect(content).toBe('![\\](javascript:xss) ![fake](https://x.com/ok.png)')
  })
})

describe('htmlBodyToOutline — blockquotes (Phase 2)', () => {
  it('emits a > -prefixed block that re-parses to a blockquote node', () => {
    const blocks = convert('<blockquote><p>quoted line</p></blockquote>')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.content).toBe('> quoted line')
    const doc = parse(blocks[0]?.content ?? '')
    expect(doc.content?.[0]?.type).toBe('blockquote')
  })

  it('prefixes every inner line of a multi-paragraph quote', () => {
    const content = convert('<blockquote><p>one</p><p>two</p></blockquote>')[0]?.content ?? ''
    expect(content).toBe('> one\n> two')
    expect(parse(content).content?.[0]?.type).toBe('blockquote')
  })
})

describe('htmlBodyToOutline — task lists (Phase 2)', () => {
  it('emits - [ ] / - [x] items for a checkbox list (checked + unchecked)', () => {
    const html =
      '<ul>' +
      '<li><input type="checkbox"> todo item</li>' +
      '<li><input type="checkbox" checked> done item</li>' +
      '</ul>'
    expect(convert(html)).toEqual([
      { content: '- [ ] todo item', depth: 0 },
      { content: '- [x] done item', depth: 0 },
    ])
  })

  it('each task line re-parses to a paragraph carrying the right todoState', () => {
    const html =
      '<ul><li><input type="checkbox"> a</li><li><input type="checkbox" checked> b</li></ul>'
    const round = pasteRoundTrip(html)
    expect(round).toHaveLength(2)
    const a = round[0]?.node.content?.[0]
    const b = round[1]?.node.content?.[0]
    expect((a as unknown as { attrs?: { todoState?: string } }).attrs?.todoState).toBe('TODO')
    expect((b as unknown as { attrs?: { todoState?: string } }).attrs?.todoState).toBe('DONE')
  })

  it('a non-task <ul> still produces plain bullets (no regression)', () => {
    expect(convert('<ul><li>a</li><li>b</li></ul>')).toEqual([
      { content: '- a', depth: 0 },
      { content: '- b', depth: 0 },
    ])
  })
})

describe('outline newline encoding (Phase 2)', () => {
  it('round-trips a multi-line block as ONE block without shredding it', () => {
    const html = '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>'
    const markdown = convertToMarkdown(html)
    // The encoded outline is a SINGLE line (no real newlines between block rows).
    expect(markdown.split('\n')).toHaveLength(1)
    // Decoding restores the real newlines into one block's content.
    const parsed = parseIndentedMarkdown(markdown)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.content.split('\n').length).toBeGreaterThan(1)
  })

  it('leaves single-line block content untouched (no sentinel present)', () => {
    const parsed = parseIndentedMarkdown('plain one-liner\n  child line')
    expect(parsed).toEqual([
      { content: 'plain one-liner', parentIndex: null },
      { content: 'child line', parentIndex: 0 },
    ])
  })
})

// ── #1960: "Turn into" styles — HTML paste parity ────────────────────────────
// Every block style the "Turn into" menu can apply that ALSO has an HTML
// representation must survive an HTML paste: the clipboard fragment must walk
// to markdown that re-parses to the correct block node (the #1960 hard
// constraint covers the HTML paste/export path, not just markdown). Callout has
// no standard HTML element, so it is intentionally absent here — it is reached
// via markdown (`> [!INFO]`) and the slash/turn-into path, both covered by the
// markdown round-trip suite.
describe('"Turn into" styles — HTML paste parity (#1960)', () => {
  /** First top-level node type produced by pasting a single-block fragment. */
  function firstNodeType(html: string): string | undefined {
    return pasteRoundTrip(html)[0]?.node.content?.[0]?.type
  }

  it('paragraph: <p> → paragraph node', () => {
    expect(firstNodeType('<p>plain text</p>')).toBe('paragraph')
  })

  it('heading: <h1>/<h2>/<h3> → heading node with matching level', () => {
    for (const level of [1, 2, 3] as const) {
      const block = pasteRoundTrip(`<h${level}>Title</h${level}>`)[0]
      const node = block?.node.content?.[0]
      expect(node?.type).toBe('heading')
      expect((node as { attrs?: { level?: number } }).attrs?.level).toBe(level)
    }
  })

  it('bullet list: <ul><li> → bulletList node', () => {
    expect(firstNodeType('<ul><li>item</li></ul>')).toBe('bulletList')
  })

  it('ordered list: <ol><li> → orderedList node', () => {
    expect(firstNodeType('<ol><li>item</li></ol>')).toBe('orderedList')
  })

  it('quote: <blockquote> → blockquote node (no callout type)', () => {
    const node = pasteRoundTrip('<blockquote>quoted</blockquote>')[0]?.node.content?.[0]
    expect(node?.type).toBe('blockquote')
    expect((node as { attrs?: { calloutType?: string } }).attrs?.calloutType).toBeFalsy()
  })

  it('code block: <pre><code> → codeBlock node', () => {
    expect(firstNodeType('<pre><code>const x = 1</code></pre>')).toBe('codeBlock')
  })

  it('divider: <hr> → horizontalRule node (not dropped)', () => {
    const blocks = pasteRoundTrip('<p>a</p><hr><p>b</p>')
    // The divider is preserved between the two paragraphs (regression guard:
    // it used to be silently dropped, merging the surrounding blocks).
    const types = blocks.map((b) => b.node.content?.[0]?.type)
    expect(types).toEqual(['paragraph', 'horizontalRule', 'paragraph'])
  })
})
