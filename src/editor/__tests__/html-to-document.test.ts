/**
 * #6277 E5 — an HTML paste is sent as Document text (`outlineToDocument`), so
 * the backend reads it as it reads any pasted text: a list item is a bulleted
 * or numbered block with its `listStyle` and plain content, not a block holding
 * `- a`. Each case writes the walk's blocks with the real Turndown config, then
 * reads the text back with `parsePastedText`, the reader the conformance
 * vectors pin to `import::parse_pasted_text`.
 */

import { describe, expect, it } from 'vitest'

import { htmlBodyToOutline, outlineToDocument } from '@/editor/html-to-blocks'
import { createInlineTurndown } from '@/editor/inline-turndown'
import { parsePastedText } from '@/editor/source-buffer-document'

function documentOf(html: string): string {
  const body = new DOMParser().parseFromString(html, 'text/html').body
  return outlineToDocument(htmlBodyToOutline(body, createInlineTurndown().inline))
}

/** The blocks a paste of `text` creates: depth, content, list style, task state. */
function pasted(text: string) {
  return parsePastedText(text).map((block) => ({
    depth: block.depth,
    content: block.content,
    listStyle: block.listStyle,
    todoState: block.todoState,
  }))
}

const item = (depth: number, content: string, listStyle: string | null) => ({
  depth,
  content,
  listStyle,
  todoState: null,
})

describe('outlineToDocument — HTML paste as Document text (#6277 E5)', () => {
  it('writes a <ul> as bullet lines, each a bulleted block holding only its text', () => {
    const text = documentOf('<ul><li>a</li><li><b>b</b></li></ul>')
    expect(text).toBe('- a\n- **b**\n')
    expect(pasted(text)).toEqual([item(0, 'a', 'bullet'), item(0, '**b**', 'bullet')])
  })

  it('writes an <ol> as numbered lines, each a numbered block', () => {
    const text = documentOf('<ol><li>a</li><li>b</li></ol>')
    expect(text).toBe('1. a\n2. b\n')
    expect(pasted(text)).toEqual([item(0, 'a', 'ordered'), item(0, 'b', 'ordered')])
  })

  it('nests a list under its item, each level keeping its own kind', () => {
    const text = documentOf('<ul><li>a<ol><li>b<ul><li>c</li></ul></li></ol></li><li>d</li></ul>')
    expect(text).toBe('- a\n  1. b\n     - c\n- d\n')
    expect(pasted(text)).toEqual([
      item(0, 'a', 'bullet'),
      item(1, 'b', 'ordered'),
      item(2, 'c', 'bullet'),
      item(0, 'd', 'bullet'),
    ])
  })

  it('writes a task list as checkbox lines, each a task with no list style', () => {
    const text = documentOf(
      '<ul><li><input type="checkbox"> open</li><li><input type="checkbox" checked> done</li></ul>',
    )
    expect(text).toBe('- [ ] open\n- [x] done\n')
    expect(pasted(text)).toEqual([
      { depth: 0, content: 'open', listStyle: null, todoState: 'TODO' },
      { depth: 0, content: 'done', listStyle: null, todoState: 'DONE' },
    ])
  })

  it('keeps a paragraph after a heading its sibling: a heading owns nothing', () => {
    const text = documentOf('<h2>Plan</h2><p>first</p><ul><li>step</li></ul>')
    expect(text).toBe('## Plan\n\nfirst\n\n- step\n')
    expect(pasted(text)).toEqual([
      item(0, '## Plan', null),
      item(0, 'first', null),
      item(0, 'step', 'bullet'),
    ])
  })

  it('writes an <hr> as a `---` block, a `+` item where it opens the text', () => {
    const text = documentOf('<hr><p>a</p><hr><p>b</p>')
    expect(text).toBe('+ ---\n\na\n\n---\n\nb\n')
    expect(pasted(text)).toEqual([
      item(0, '---', null),
      item(0, 'a', null),
      item(0, '---', null),
      item(0, 'b', null),
    ])
  })

  it('writes <del>, <s> and <strike> as ~~strike~~', () => {
    const text = documentOf('<p>a <del>b</del> <s>c</s> <strike>d</strike></p>')
    expect(text).toBe('a ~~b~~ ~~c~~ ~~d~~\n')
    expect(pasted(text)).toEqual([item(0, 'a ~~b~~ ~~c~~ ~~d~~', null)])
  })

  it('escapes a paragraph that reads as a list item, so it stays a paragraph', () => {
    const text = documentOf('<p>- not a list</p><p>1. nor this</p>')
    expect(pasted(text)).toEqual([item(0, '\\- not a list', null), item(0, '1\\. nor this', null)])
  })

  it('escapes a paragraph that reads as a property line, so it stays its own block', () => {
    const text = documentOf('<p>intro</p><p>key:: value</p>')
    expect(text).toBe('intro\n\n\\key:: value\n')
    const blocks = parsePastedText(text)
    expect(blocks.map((b) => [b.content, b.properties])).toEqual([
      ['intro', []],
      ['key:: value', []],
    ])
  })

  it('keeps a table and a code block one block each', () => {
    const text = documentOf(
      '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>' +
        '<pre><code class="language-js">x\ny</code></pre>',
    )
    expect(pasted(text)).toEqual([
      item(0, '| a | b |\n| --- | --- |\n| 1 | 2 |', null),
      item(0, '```js\nx\ny\n```', null),
    ])
  })
})

describe('createInlineTurndown — the rule set the imports share (#6277 E5)', () => {
  it('writes a rule as `---` and a strike as `~~x~~`, as `createHtmlTurndown` does', () => {
    const { service } = createInlineTurndown()
    expect(service.turndown('<p>a</p><hr><p><del>b</del></p>')).toBe('a\n\n---\n\n~~b~~')
  })
})
