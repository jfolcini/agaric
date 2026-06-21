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
