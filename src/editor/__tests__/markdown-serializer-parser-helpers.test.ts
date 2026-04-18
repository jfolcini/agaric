/**
 * Tests for the extracted per-production block parsers and per-token inline
 * scanner helpers in `markdown-serializer.ts`. These helpers were extracted
 * from the monolithic `parse()` / `parseLine()` functions to lower cognitive
 * complexity below the project threshold.
 *
 * The public API (`parse`, `serialize`) is still covered by the existing
 * `markdown-serializer.test.ts` and `markdown-serializer.property.test.ts`
 * files. This file focuses on the grammar productions individually so that
 * regressions in specific productions are pinpointed quickly.
 */
import { describe, expect, it } from 'vitest'
import {
  createInlineState,
  parseBlockquote,
  parseCodeBlock,
  parseHeading,
  parseHorizontalRule,
  parseOrderedList,
  parseParagraph,
  parseTable,
  scanBold,
  scanCodeSpan,
  scanEscape,
  scanExternalLinkToken,
  scanHighlight,
  scanItalic,
  scanStrike,
  scanTokenRef,
} from '../markdown-serializer'

// -- Block production helpers ------------------------------------------------

describe('parseCodeBlock', () => {
  it('parses a fenced code block without language', () => {
    const lines = ['```', 'hello', 'world', '```']
    const result = parseCodeBlock(lines, 0)
    expect(result).toEqual({
      blocks: [{ type: 'codeBlock', content: [{ type: 'text', text: 'hello\nworld' }] }],
      consumed: 4,
    })
  })

  it('parses a fenced code block with language', () => {
    const lines = ['```ts', 'const x = 1', '```']
    const result = parseCodeBlock(lines, 0)
    expect(result).toEqual({
      blocks: [
        {
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [{ type: 'text', text: 'const x = 1' }],
        },
      ],
      consumed: 3,
    })
  })

  it('returns null when the line is not a fence', () => {
    expect(parseCodeBlock(['plain text'], 0)).toBeNull()
  })

  it('parses an empty code block', () => {
    const lines = ['```', '```']
    const result = parseCodeBlock(lines, 0)
    expect(result).toEqual({
      blocks: [{ type: 'codeBlock' }],
      consumed: 2,
    })
  })
})

describe('parseBlockquote', () => {
  it('parses a simple blockquote', () => {
    const lines = ['> hello']
    const result = parseBlockquote(lines, 0, 0)
    expect(result).toEqual({
      blocks: [
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
        },
      ],
      consumed: 1,
    })
  })

  it('parses a callout and lowercases its type', () => {
    const lines = ['> [!NOTE] remember this']
    const result = parseBlockquote(lines, 0, 0)
    expect(result?.blocks).toHaveLength(1)
    const block = result?.blocks[0]
    expect(block?.type).toBe('blockquote')
    expect(block?.type === 'blockquote' ? block.attrs : undefined).toEqual({ calloutType: 'note' })
    expect(result?.consumed).toBe(1)
  })

  it('returns null for non-blockquote lines', () => {
    expect(parseBlockquote(['plain'], 0, 0)).toBeNull()
  })

  it('collects consecutive > lines into one blockquote', () => {
    const lines = ['> one', '> two', 'after']
    const result = parseBlockquote(lines, 0, 0)
    expect(result?.consumed).toBe(2)
    expect(result?.blocks).toHaveLength(1)
  })
})

describe('parseHeading', () => {
  it('parses a level-1 heading', () => {
    const result = parseHeading(['# Title'], 0, 0)
    expect(result).toEqual({
      blocks: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Title' }],
        },
      ],
      consumed: 1,
    })
  })

  it('parses a level-6 heading', () => {
    const result = parseHeading(['###### Deep'], 0, 0)
    expect(result?.blocks).toHaveLength(1)
    const block = result?.blocks[0]
    expect(block?.type).toBe('heading')
    expect(block?.type === 'heading' ? block.attrs.level : null).toBe(6)
  })

  it('returns null when the line is not a heading', () => {
    expect(parseHeading(['plain'], 0, 0)).toBeNull()
  })

  it('returns null for 7+ hashes (out of range)', () => {
    expect(parseHeading(['####### too deep'], 0, 0)).toBeNull()
  })
})

describe('parseTable', () => {
  it('parses a simple table with header + data row', () => {
    const lines = ['| a | b |', '|---|---|', '| 1 | 2 |']
    const result = parseTable(lines, 0, 0)
    expect(result?.blocks).toHaveLength(1)
    const table = result?.blocks[0]
    expect(table?.type).toBe('table')
    const rows = table?.type === 'table' ? table.content : undefined
    // Header row + data row (separator line is skipped)
    expect(rows).toHaveLength(2)
    expect(result?.consumed).toBe(3)
  })

  it('returns null when the line does not start with |', () => {
    expect(parseTable(['plain'], 0, 0)).toBeNull()
  })

  it('produces zero blocks when every table line is a separator', () => {
    const lines = ['|---|---|']
    const result = parseTable(lines, 0, 0)
    expect(result?.blocks).toHaveLength(0)
    expect(result?.consumed).toBe(1)
  })
})

describe('parseHorizontalRule', () => {
  it('parses three hyphens as a horizontal rule', () => {
    expect(parseHorizontalRule(['---'], 0)).toEqual({
      blocks: [{ type: 'horizontalRule' }],
      consumed: 1,
    })
  })

  it('parses 5+ hyphens as a horizontal rule', () => {
    expect(parseHorizontalRule(['-----'], 0)).toEqual({
      blocks: [{ type: 'horizontalRule' }],
      consumed: 1,
    })
  })

  it('returns null for 2 or fewer hyphens', () => {
    expect(parseHorizontalRule(['--'], 0)).toBeNull()
  })

  it('returns null for non-hyphen content', () => {
    expect(parseHorizontalRule(['plain'], 0)).toBeNull()
  })
})

describe('parseOrderedList', () => {
  it('parses consecutive numbered items into a single list', () => {
    const lines = ['1. first', '2. second', 'after']
    const result = parseOrderedList(lines, 0, 0)
    expect(result?.consumed).toBe(2)
    const list = result?.blocks[0]
    expect(list?.type).toBe('orderedList')
    const items = list?.type === 'orderedList' ? list.content : undefined
    expect(items).toHaveLength(2)
  })

  it('returns null when the line is not a numbered list item', () => {
    expect(parseOrderedList(['plain'], 0, 0)).toBeNull()
  })

  it('handles a list with empty item text', () => {
    const lines = ['1. ']
    const result = parseOrderedList(lines, 0, 0)
    expect(result?.consumed).toBe(1)
    const list = result?.blocks[0]
    const items = list?.type === 'orderedList' ? list.content : undefined
    expect(items).toHaveLength(1)
    // Empty inline content produces a paragraph without content
    expect(items?.[0]?.content).toEqual([{ type: 'paragraph' }])
  })
})

describe('parseParagraph', () => {
  it('parses plain text as a paragraph', () => {
    const result = parseParagraph(['hello'], 0, 0)
    expect(result).toEqual({
      blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
      consumed: 1,
    })
  })

  it('produces a contentless paragraph for an empty line', () => {
    const result = parseParagraph([''], 0, 0)
    expect(result).toEqual({
      blocks: [{ type: 'paragraph' }],
      consumed: 1,
    })
  })
})

// -- Inline scanner helpers --------------------------------------------------

describe('scanCodeSpan', () => {
  it('opens and closes a code span on backtick, emitting code-marked text', () => {
    const st = createInlineState('`x`', 0)
    // Open
    expect(scanCodeSpan(st)).toBe(true)
    expect(st.inCode).toBe(true)
    // Literal content
    expect(scanCodeSpan(st)).toBe(true)
    expect(st.buf).toBe('x')
    // Close
    expect(scanCodeSpan(st)).toBe(true)
    expect(st.inCode).toBe(false)
    expect(st.nodes).toEqual([{ type: 'text', text: 'x', marks: [{ type: 'code' }] }])
  })

  it('returns false for non-backtick outside of code mode', () => {
    const st = createInlineState('abc', 0)
    expect(scanCodeSpan(st)).toBe(false)
    expect(st.scanner.pos).toBe(0)
  })
})

describe('scanEscape', () => {
  it('consumes a valid backslash escape and appends the escaped char to buf', () => {
    const st = createInlineState('\\*', 0)
    expect(scanEscape(st)).toBe(true)
    expect(st.buf).toBe('*')
    expect(st.scanner.pos).toBe(2)
  })

  it('returns false when the next char is not an escapable sigil', () => {
    const st = createInlineState('\\a', 0)
    expect(scanEscape(st)).toBe(false)
    expect(st.scanner.pos).toBe(0)
  })

  it('returns false for a backslash at end of input', () => {
    const st = createInlineState('\\', 0)
    expect(scanEscape(st)).toBe(false)
  })
})

describe('scanTokenRef', () => {
  it('consumes a tag_ref token', () => {
    const id = '0123456789ABCDEFGHJKMNPQRS'
    const st = createInlineState(`#[${id}]`, 0)
    expect(scanTokenRef(st)).toBe(true)
    expect(st.nodes).toEqual([{ type: 'tag_ref', attrs: { id } }])
  })

  it('consumes a block_link token', () => {
    const id = '0123456789ABCDEFGHJKMNPQRS'
    const st = createInlineState(`[[${id}]]`, 0)
    expect(scanTokenRef(st)).toBe(true)
    expect(st.nodes).toEqual([{ type: 'block_link', attrs: { id } }])
  })

  it('returns false when no token is present at the cursor', () => {
    const st = createInlineState('plain', 0)
    expect(scanTokenRef(st)).toBe(false)
    expect(st.nodes).toHaveLength(0)
  })
})

describe('scanExternalLinkToken', () => {
  it('consumes [text](url) and emits a linked text node', () => {
    const st = createInlineState('[click](https://example.com)', 0)
    expect(scanExternalLinkToken(st)).toBe(true)
    expect(st.nodes).toHaveLength(1)
    const first = st.nodes[0]
    expect(first?.type).toBe('text')
    const marks = first?.type === 'text' ? first.marks : undefined
    expect(marks).toEqual([{ type: 'link', attrs: { href: 'https://example.com' } }])
  })

  it('returns false when cursor is not on [ (or is on [[)', () => {
    const st = createInlineState('plain', 0)
    expect(scanExternalLinkToken(st)).toBe(false)

    const st2 = createInlineState('[[not-link', 0)
    expect(scanExternalLinkToken(st2)).toBe(false)
  })
})

describe('scanBold', () => {
  it('opens bold on ** and sets boldOpenPos/NodeLen', () => {
    const st = createInlineState('**x**', 0)
    expect(scanBold(st)).toBe(true)
    expect(st.inBold).toBe(true)
    expect(st.boldOpenPos).toBe(0)
    expect(st.boldOpenNodeLen).toBe(0)
    expect(st.scanner.pos).toBe(2)
  })

  it('returns false for a single *', () => {
    const st = createInlineState('*x', 0)
    expect(scanBold(st)).toBe(false)
    expect(st.scanner.pos).toBe(0)
  })
})

describe('scanStrike', () => {
  it('opens strike on ~~', () => {
    const st = createInlineState('~~x~~', 0)
    expect(scanStrike(st)).toBe(true)
    expect(st.inStrike).toBe(true)
    expect(st.scanner.pos).toBe(2)
  })

  it('returns false for a single ~', () => {
    const st = createInlineState('~x', 0)
    expect(scanStrike(st)).toBe(false)
  })
})

describe('scanHighlight', () => {
  it('opens highlight on ==', () => {
    const st = createInlineState('==x==', 0)
    expect(scanHighlight(st)).toBe(true)
    expect(st.inHighlight).toBe(true)
    expect(st.scanner.pos).toBe(2)
  })

  it('returns false for a single =', () => {
    const st = createInlineState('=x', 0)
    expect(scanHighlight(st)).toBe(false)
  })
})

describe('scanItalic', () => {
  it('opens italic on single *', () => {
    const st = createInlineState('*x*', 0)
    expect(scanItalic(st)).toBe(true)
    expect(st.inItalic).toBe(true)
    expect(st.italicOpenPos).toBe(0)
    expect(st.scanner.pos).toBe(1)
  })

  it('returns false when cursor is not on *', () => {
    const st = createInlineState('x', 0)
    expect(scanItalic(st)).toBe(false)
  })
})
