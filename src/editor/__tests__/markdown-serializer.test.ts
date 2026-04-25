import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetUnknownNodeToastsForTests, parse, serialize } from '../markdown-serializer'
import type {
  BlockquoteNode,
  DocNode,
  InlineNode,
  ParagraphNode,
  TableNode,
  TextNode,
} from '../types'
import {
  blockLink,
  blockquote,
  bold,
  boldItalic,
  callout,
  code,
  codeBlock,
  doc,
  hardBreak,
  heading,
  highlight,
  horizontalRule,
  italic,
  listItem,
  orderedList,
  paragraph,
  strike,
  table,
  tableCell,
  tableHeader,
  tableRow,
  tagRef,
  text,
} from '../types'

/** Create a text node with a link mark (and optional additional marks). */
function linked(t: string, href: string, extraMarks?: TextNode['marks']): TextNode {
  const marks: TextNode['marks'] = [
    ...(extraMarks ?? []),
    { type: 'link' as const, attrs: { href } },
  ]
  return { type: 'text', text: t, marks }
}

// -- serialize ----------------------------------------------------------------

describe('serialize', () => {
  describe('plain text', () => {
    it('empty doc', () => {
      expect(serialize(doc())).toBe('')
    })

    it('empty doc with no content field', () => {
      expect(serialize({ type: 'doc' })).toBe('')
    })

    it('empty paragraph', () => {
      expect(serialize(doc(paragraph()))).toBe('')
    })

    it('plain text', () => {
      expect(serialize(doc(paragraph(text('hello world'))))).toBe('hello world')
    })

    it('whitespace-only', () => {
      expect(serialize(doc(paragraph(text('   '))))).toBe('   ')
    })

    it('paragraph with empty content array', () => {
      const p: ParagraphNode = { type: 'paragraph', content: [] }
      expect(serialize({ type: 'doc', content: [p] })).toBe('')
    })
  })

  describe('marks', () => {
    it('bold', () => {
      expect(serialize(doc(paragraph(bold('strong'))))).toBe('**strong**')
    })

    it('italic', () => {
      expect(serialize(doc(paragraph(italic('emphasis'))))).toBe('*emphasis*')
    })

    it('code', () => {
      expect(serialize(doc(paragraph(code('fn()'))))).toBe('`fn()`')
    })

    it('strikethrough', () => {
      expect(serialize(doc(paragraph(strike('deleted'))))).toBe('~~deleted~~')
    })

    it('highlight', () => {
      expect(serialize(doc(paragraph(highlight('important'))))).toBe('==important==')
    })

    it('bold + italic (nested)', () => {
      expect(serialize(doc(paragraph(boldItalic('both'))))).toBe('***both***')
    })

    it('adjacent marks', () => {
      expect(serialize(doc(paragraph(bold('a'), text(' '), italic('b'))))).toBe('**a** *b*')
    })

    it('bold adjacent to plain text', () => {
      expect(serialize(doc(paragraph(text('before '), bold('mid'), text(' after'))))).toBe(
        'before **mid** after',
      )
    })

    it('code does not escape contents', () => {
      expect(serialize(doc(paragraph(code('**not bold**'))))).toBe('`**not bold**`')
    })

    it('bold+code marks — code wins, bold dropped', () => {
      const node = text('x', [{ type: 'bold' }, { type: 'code' }])
      expect(serialize(doc(paragraph(node)))).toBe('`x`')
    })

    it('mark ordering: italic-before-bold still produces ***text***', () => {
      const node = text('both', [{ type: 'italic' }, { type: 'bold' }])
      expect(serialize(doc(paragraph(node)))).toBe('***both***')
    })
  })

  describe('tokens', () => {
    it('tag_ref', () => {
      expect(serialize(doc(paragraph(tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'))))).toBe(
        '#[01ARZ3NDEKTSV4RRFFQ69G5FAV]',
      )
    })

    it('block_link', () => {
      expect(serialize(doc(paragraph(blockLink('01ARZ3NDEKTSV4RRFFQ69G5FAV'))))).toBe(
        '[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]',
      )
    })

    it('token adjacent to text', () => {
      expect(
        serialize(
          doc(paragraph(text('see '), tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'), text(' here'))),
        ),
      ).toBe('see #[01ARZ3NDEKTSV4RRFFQ69G5FAV] here')
    })

    it('token at start of line', () => {
      expect(serialize(doc(paragraph(tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'), text(' end'))))).toBe(
        '#[01ARZ3NDEKTSV4RRFFQ69G5FAV] end',
      )
    })

    it('token at end of line', () => {
      expect(
        serialize(doc(paragraph(text('start '), blockLink('01ARZ3NDEKTSV4RRFFQ69G5FAV')))),
      ).toBe('start [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]')
    })

    it('token adjacent to mark', () => {
      expect(serialize(doc(paragraph(bold('look: '), tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'))))).toBe(
        '**look: **#[01ARZ3NDEKTSV4RRFFQ69G5FAV]',
      )
    })
  })

  describe('special nodes', () => {
    it('hardBreak emits newline', () => {
      expect(serialize(doc(paragraph(text('a'), hardBreak(), text('b'))))).toBe('a\nb')
    })

    it('multiple paragraphs joined with newline', () => {
      expect(serialize(doc(paragraph(text('first')), paragraph(text('second'))))).toBe(
        'first\nsecond',
      )
    })

    it('unknown inline node stripped with warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const unknown = { type: 'unknown_node' } as unknown as InlineNode
      expect(serialize(doc(paragraph(text('a'), unknown, text('b'))))).toBe('ab')
      expect(warn).toHaveBeenCalledOnce()
      warn.mockRestore()
    })

    it('unknown top-level node stripped with warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const unknown = { type: 'customBlock', content: [] } as unknown as ParagraphNode
      expect(serialize(doc(unknown, paragraph(text('ok'))))).toBe('\nok')
      expect(warn).toHaveBeenCalledOnce()
      warn.mockRestore()
    })
  })

  describe('blockquote', () => {
    it('serializes blockquote with > prefix', () => {
      expect(serialize(doc(blockquote(paragraph(text('hello')))))).toBe('> hello')
    })

    it('serializes empty blockquote', () => {
      expect(serialize(doc(blockquote()))).toBe('> ')
    })

    it('serializes multi-line blockquote', () => {
      expect(serialize(doc(blockquote(paragraph(text('line 1')), paragraph(text('line 2')))))).toBe(
        '> line 1\n> line 2',
      )
    })

    it('serializes blockquote with marks', () => {
      expect(serialize(doc(blockquote(paragraph(bold('strong')))))).toBe('> **strong**')
    })

    it('serializes blockquote containing table', () => {
      expect(
        serialize(
          doc(
            blockquote(
              table(
                tableRow(tableHeader(paragraph(text('A')))),
                tableRow(tableCell(paragraph(text('1')))),
              ),
            ),
          ),
        ),
      ).toBe('> | A |\n> | --- |\n> | 1 |')
    })
  })

  describe('callout', () => {
    it('serializes info callout with [!INFO] prefix', () => {
      expect(serialize(doc(callout('info', paragraph(text('some text')))))).toBe(
        '> [!INFO] some text',
      )
    })

    it('serializes warning callout', () => {
      expect(serialize(doc(callout('warning', paragraph(text('be careful')))))).toBe(
        '> [!WARNING] be careful',
      )
    })

    it('serializes tip callout', () => {
      expect(serialize(doc(callout('tip', paragraph(text('helpful hint')))))).toBe(
        '> [!TIP] helpful hint',
      )
    })

    it('serializes error callout', () => {
      expect(serialize(doc(callout('error', paragraph(text('something broke')))))).toBe(
        '> [!ERROR] something broke',
      )
    })

    it('serializes note callout', () => {
      expect(serialize(doc(callout('note', paragraph(text('take note')))))).toBe(
        '> [!NOTE] take note',
      )
    })

    it('serializes empty callout', () => {
      expect(serialize(doc(callout('info')))).toBe('> [!INFO]')
    })

    it('serializes multi-line callout', () => {
      expect(
        serialize(doc(callout('warning', paragraph(text('line 1')), paragraph(text('line 2'))))),
      ).toBe('> [!WARNING] line 1\n> line 2')
    })

    it('serializes callout with marks', () => {
      expect(serialize(doc(callout('tip', paragraph(bold('important')))))).toBe(
        '> [!TIP] **important**',
      )
    })

    it('calloutType is uppercased in output', () => {
      expect(serialize(doc(callout('info', paragraph(text('test')))))).toBe('> [!INFO] test')
    })
  })

  describe('table', () => {
    it('serializes a simple table with header', () => {
      expect(
        serialize(
          doc(
            table(
              tableRow(tableHeader(paragraph(text('Name'))), tableHeader(paragraph(text('Age')))),
              tableRow(tableCell(paragraph(text('Alice'))), tableCell(paragraph(text('30')))),
              tableRow(tableCell(paragraph(text('Bob'))), tableCell(paragraph(text('25')))),
            ),
          ),
        ),
      ).toBe('| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |')
    })

    it('serializes table with marks', () => {
      expect(
        serialize(
          doc(
            table(
              tableRow(tableHeader(paragraph(bold('Header')))),
              tableRow(tableCell(paragraph(text('cell')))),
            ),
          ),
        ),
      ).toBe('| **Header** |\n| --- |\n| cell |')
    })

    it('serializes empty table', () => {
      expect(serialize(doc(table()))).toBe('')
    })

    it('serializes table cell with pipe character', () => {
      expect(
        serialize(
          doc(
            table(
              tableRow(tableHeader(paragraph(text('A|B')))),
              tableRow(tableCell(paragraph(text('1|2')))),
            ),
          ),
        ),
      ).toBe('| A\\|B |\n| --- |\n| 1\\|2 |')
    })

    // Defence-in-depth check: a literal backslash followed by a pipe in
    // a cell must round-trip correctly. `escapeText` (via
    // `serializeParagraph`) escapes the backslash to `\\` first, then
    // the table serializer escapes the pipe to `\|`, producing `\\\|`
    // in the output stream — which markdown parses as "escaped
    // backslash + escaped pipe" = the original `\|`. This test pins
    // the behaviour so the table-cell pipe escape stays correct under
    // any future churn in `escapeText`. Closes a CodeQL
    // `js/incomplete-sanitization` false-positive concern.
    it('survives backslash + pipe in table cells without breaking the column separator', () => {
      expect(
        serialize(
          doc(
            table(
              tableRow(tableHeader(paragraph(text('A\\B')))),
              tableRow(tableCell(paragraph(text('C\\|D')))),
            ),
          ),
        ),
      ).toBe('| A\\\\B |\n| --- |\n| C\\\\\\|D |')
    })
  })

  describe('escaping', () => {
    it('escapes literal asterisk', () => {
      expect(serialize(doc(paragraph(text('a * b'))))).toBe('a \\* b')
    })

    it('escapes literal backtick', () => {
      expect(serialize(doc(paragraph(text('a ` b'))))).toBe('a \\` b')
    })

    it('escapes literal tilde', () => {
      expect(serialize(doc(paragraph(text('a ~ b'))))).toBe('a \\~ b')
    })

    it('escapes literal equals', () => {
      expect(serialize(doc(paragraph(text('a = b'))))).toBe('a \\= b')
    })

    it('escapes literal #[', () => {
      expect(serialize(doc(paragraph(text('use #[not a tag'))))).toBe('use \\#\\[not a tag')
    })

    it('escapes literal [[', () => {
      expect(serialize(doc(paragraph(text('use [[not a link'))))).toBe('use \\[\\[not a link')
    })

    it('escapes literal backslash', () => {
      expect(serialize(doc(paragraph(text('a \\ b'))))).toBe('a \\\\ b')
    })

    it('multiple escapes in one string', () => {
      expect(serialize(doc(paragraph(text('*`#['))))).toBe('\\*\\`\\#\\[')
    })

    it('lone # without [ is not escaped', () => {
      expect(serialize(doc(paragraph(text('a # b'))))).toBe('a # b')
    })

    it('lone [ is escaped (could start external link)', () => {
      expect(serialize(doc(paragraph(text('a [ b'))))).toBe('a \\[ b')
    })

    it('lone ] is escaped (could close link text)', () => {
      expect(serialize(doc(paragraph(text('a ] b'))))).toBe('a \\] b')
    })
  })
})

// -- parse --------------------------------------------------------------------

describe('parse', () => {
  describe('plain text', () => {
    it('empty string', () => {
      expect(parse('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
    })

    it('empty string roundtrips', () => {
      const doc = parse('')
      expect(serialize(doc)).toBe('')
    })

    it('plain text', () => {
      expect(parse('hello world')).toEqual(doc(paragraph(text('hello world'))))
    })

    it('whitespace-only', () => {
      expect(parse('   ')).toEqual(doc(paragraph(text('   '))))
    })
  })

  describe('marks', () => {
    it('bold', () => {
      expect(parse('**strong**')).toEqual(doc(paragraph(bold('strong'))))
    })

    it('italic', () => {
      expect(parse('*emphasis*')).toEqual(doc(paragraph(italic('emphasis'))))
    })

    it('code', () => {
      expect(parse('`fn()`')).toEqual(doc(paragraph(code('fn()'))))
    })

    it('strikethrough', () => {
      expect(parse('~~deleted~~')).toEqual(doc(paragraph(strike('deleted'))))
    })

    it('highlight', () => {
      expect(parse('==important==')).toEqual(doc(paragraph(highlight('important'))))
    })

    it('bold + italic nested', () => {
      expect(parse('***both***')).toEqual(doc(paragraph(boldItalic('both'))))
    })

    it('bold with surrounding text', () => {
      expect(parse('before **mid** after')).toEqual(
        doc(paragraph(text('before '), bold('mid'), text(' after'))),
      )
    })

    it('italic with surrounding text', () => {
      expect(parse('before *mid* after')).toEqual(
        doc(paragraph(text('before '), italic('mid'), text(' after'))),
      )
    })

    it('code with surrounding text', () => {
      expect(parse('before `mid` after')).toEqual(
        doc(paragraph(text('before '), code('mid'), text(' after'))),
      )
    })

    it('adjacent bold and italic', () => {
      expect(parse('**a** *b*')).toEqual(doc(paragraph(bold('a'), text(' '), italic('b'))))
    })

    it('code does not parse marks inside', () => {
      expect(parse('`**not bold**`')).toEqual(doc(paragraph(code('**not bold**'))))
    })

    it('code does not parse tokens inside', () => {
      expect(parse('`#[01ARZ3NDEKTSV4RRFFQ69G5FAV]`')).toEqual(
        doc(paragraph(code('#[01ARZ3NDEKTSV4RRFFQ69G5FAV]'))),
      )
    })

    it('italic inside bold', () => {
      expect(parse('**a *b* c**')).toEqual(doc(paragraph(bold('a '), boldItalic('b'), bold(' c'))))
    })

    it('bold then italic (different marks adjacent)', () => {
      expect(parse('**a***b*')).toEqual(doc(paragraph(bold('a'), italic('b'))))
    })
  })

  describe('unclosed marks', () => {
    it('unclosed bold becomes plain text', () => {
      expect(parse('**unclosed')).toEqual(doc(paragraph(text('**unclosed'))))
    })

    it('unclosed italic becomes plain text', () => {
      expect(parse('*unclosed')).toEqual(doc(paragraph(text('*unclosed'))))
    })

    it('unclosed code becomes plain text', () => {
      expect(parse('`unclosed')).toEqual(doc(paragraph(text('`unclosed'))))
    })

    it('unclosed bold with content before', () => {
      expect(parse('before **unclosed')).toEqual(doc(paragraph(text('before **unclosed'))))
    })

    it('unclosed italic after closed bold', () => {
      expect(parse('**ok** *unclosed')).toEqual(doc(paragraph(bold('ok'), text(' *unclosed'))))
    })

    it('unclosed bold containing unclosed italic', () => {
      expect(parse('**bold *italic')).toEqual(doc(paragraph(text('**bold *italic'))))
    })

    it('unclosed italic containing unclosed bold', () => {
      expect(parse('*italic **bold')).toEqual(doc(paragraph(text('*italic **bold'))))
    })

    it('unclosed code with bold syntax inside', () => {
      expect(parse('`**stuff')).toEqual(doc(paragraph(text('`**stuff'))))
    })

    it('unclosed strikethrough becomes plain text', () => {
      expect(parse('~~unclosed')).toEqual(doc(paragraph(text('~~unclosed'))))
    })

    it('unclosed highlight becomes plain text', () => {
      expect(parse('==unclosed')).toEqual(doc(paragraph(text('==unclosed'))))
    })

    it('empty bold **** produces empty paragraph', () => {
      expect(parse('****')).toEqual(doc(paragraph()))
    })

    it('unclosed bold containing tag_ref reverts to plain text', () => {
      expect(parse('**see #[01ARZ3NDEKTSV4RRFFQ69G5FAV]')).toEqual(
        doc(paragraph(text('**see #[01ARZ3NDEKTSV4RRFFQ69G5FAV]'))),
      )
    })

    it('unclosed bold containing block_link reverts to plain text', () => {
      expect(parse('**see [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]')).toEqual(
        doc(paragraph(text('**see [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]'))),
      )
    })
  })

  describe('tokens', () => {
    it('tag_ref', () => {
      expect(parse('#[01ARZ3NDEKTSV4RRFFQ69G5FAV]')).toEqual(
        doc(paragraph(tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'))),
      )
    })

    it('block_link', () => {
      expect(parse('[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]')).toEqual(
        doc(paragraph(blockLink('01ARZ3NDEKTSV4RRFFQ69G5FAV'))),
      )
    })

    it('tag_ref with surrounding text', () => {
      expect(parse('see #[01ARZ3NDEKTSV4RRFFQ69G5FAV] here')).toEqual(
        doc(paragraph(text('see '), tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'), text(' here'))),
      )
    })

    it('block_link with surrounding text', () => {
      expect(parse('see [[01ARZ3NDEKTSV4RRFFQ69G5FAV]] here')).toEqual(
        doc(paragraph(text('see '), blockLink('01ARZ3NDEKTSV4RRFFQ69G5FAV'), text(' here'))),
      )
    })

    it('invalid ULID passes through as text', () => {
      expect(parse('#[not-a-ulid]')).toEqual(doc(paragraph(text('#[not-a-ulid]'))))
    })

    it('#[ with lowercase ulid passes through as text', () => {
      expect(parse('#[01arz3ndektsv4rrffq69g5fav]')).toEqual(
        doc(paragraph(text('#[01arz3ndektsv4rrffq69g5fav]'))),
      )
    })

    it('[[ with short content passes through as text', () => {
      expect(parse('[[short]]')).toEqual(doc(paragraph(text('[[short]]'))))
    })

    it('[[ with 26 non-ULID chars passes through as text', () => {
      expect(parse('[[abcdefghijklmnopqrstuvwxyz]]')).toEqual(
        doc(paragraph(text('[[abcdefghijklmnopqrstuvwxyz]]'))),
      )
    })

    it('token at start of line', () => {
      expect(parse('#[01ARZ3NDEKTSV4RRFFQ69G5FAV] end')).toEqual(
        doc(paragraph(tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'), text(' end'))),
      )
    })

    it('token at end of line', () => {
      expect(parse('start [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]')).toEqual(
        doc(paragraph(text('start '), blockLink('01ARZ3NDEKTSV4RRFFQ69G5FAV'))),
      )
    })

    it('token inside bold', () => {
      expect(parse('**#[01ARZ3NDEKTSV4RRFFQ69G5FAV]**')).toEqual(
        doc(paragraph(tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'))),
      )
    })

    it('consecutive tokens without separator', () => {
      expect(parse('#[01ARZ3NDEKTSV4RRFFQ69G5FAV]#[01ARZ3NDEKTSV4RRFFQ69G5FAV]')).toEqual(
        doc(paragraph(tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'), tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'))),
      )
    })

    it('token immediately after mark close', () => {
      expect(parse('**x**#[01ARZ3NDEKTSV4RRFFQ69G5FAV]')).toEqual(
        doc(paragraph(bold('x'), tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'))),
      )
    })
  })

  describe('escapes', () => {
    it('escaped asterisk', () => {
      expect(parse('a \\* b')).toEqual(doc(paragraph(text('a * b'))))
    })

    it('escaped backtick', () => {
      expect(parse('a \\` b')).toEqual(doc(paragraph(text('a ` b'))))
    })

    it('escaped backslash', () => {
      expect(parse('a \\\\ b')).toEqual(doc(paragraph(text('a \\ b'))))
    })

    it('escaped tilde', () => {
      expect(parse('a \\~ b')).toEqual(doc(paragraph(text('a ~ b'))))
    })

    it('escaped equals', () => {
      expect(parse('a \\= b')).toEqual(doc(paragraph(text('a = b'))))
    })

    it('escaped #[', () => {
      expect(parse('use \\#[not a tag')).toEqual(doc(paragraph(text('use #[not a tag'))))
    })

    it('escaped [[', () => {
      expect(parse('use \\[[not a link')).toEqual(doc(paragraph(text('use [[not a link'))))
    })

    it('backslash at end of line is literal', () => {
      expect(parse('end\\')).toEqual(doc(paragraph(text('end\\'))))
    })

    it('backslash before non-special char is literal', () => {
      expect(parse('\\a')).toEqual(doc(paragraph(text('\\a'))))
    })
  })

  describe('newlines (multi-paragraph)', () => {
    it('two lines produce two paragraphs', () => {
      expect(parse('first\nsecond')).toEqual(
        doc(paragraph(text('first')), paragraph(text('second'))),
      )
    })

    it('empty line produces empty paragraph', () => {
      expect(parse('a\n\nb')).toEqual(doc(paragraph(text('a')), paragraph(), paragraph(text('b'))))
    })

    it('trailing newline produces empty paragraph', () => {
      expect(parse('a\n')).toEqual(doc(paragraph(text('a')), paragraph()))
    })
  })

  describe('blockquote', () => {
    it('parses > blockquote lines', () => {
      expect(parse('> hello')).toEqual(doc(blockquote(paragraph(text('hello')))))
    })

    it('handles multi-line blockquote', () => {
      expect(parse('> line 1\n> line 2')).toEqual(
        doc(blockquote(paragraph(text('line 1')), paragraph(text('line 2')))),
      )
    })

    it('parses blockquote with marks', () => {
      expect(parse('> **strong**')).toEqual(doc(blockquote(paragraph(bold('strong')))))
    })

    it('blockquote followed by paragraph', () => {
      expect(parse('> quoted\nnormal')).toEqual(
        doc(blockquote(paragraph(text('quoted'))), paragraph(text('normal'))),
      )
    })
  })

  describe('callout', () => {
    it('parses > [!INFO] some text as callout blockquote', () => {
      const result = parse('> [!INFO] some text')
      expect(result).toEqual(doc(callout('info', paragraph(text('some text')))))
    })

    it('parses > [!WARNING] with content', () => {
      expect(parse('> [!WARNING] be careful')).toEqual(
        doc(callout('warning', paragraph(text('be careful')))),
      )
    })

    it('parses > [!TIP] with content', () => {
      expect(parse('> [!TIP] helpful hint')).toEqual(
        doc(callout('tip', paragraph(text('helpful hint')))),
      )
    })

    it('parses > [!ERROR] with content', () => {
      expect(parse('> [!ERROR] something broke')).toEqual(
        doc(callout('error', paragraph(text('something broke')))),
      )
    })

    it('parses > [!NOTE] with content', () => {
      expect(parse('> [!NOTE] take note')).toEqual(
        doc(callout('note', paragraph(text('take note')))),
      )
    })

    it('parses callout type case-insensitively', () => {
      expect(parse('> [!info] lower')).toEqual(doc(callout('info', paragraph(text('lower')))))
    })

    it('parses multi-line callout', () => {
      expect(parse('> [!WARNING] line 1\n> line 2')).toEqual(
        doc(callout('warning', paragraph(text('line 1')), paragraph(text('line 2')))),
      )
    })

    it('parses callout with marks', () => {
      expect(parse('> [!TIP] **important**')).toEqual(
        doc(callout('tip', paragraph(bold('important')))),
      )
    })

    it('regular blockquote without callout prefix still works', () => {
      expect(parse('> just a quote')).toEqual(doc(blockquote(paragraph(text('just a quote')))))
    })

    it('round-trip: serialize(parse(callout)) produces same output', () => {
      const input = '> [!INFO] some text'
      expect(serialize(parse(input))).toBe(input)
    })

    it('round-trip: multi-line callout', () => {
      const input = '> [!WARNING] line 1\n> line 2'
      expect(serialize(parse(input))).toBe(input)
    })

    it('round-trip: callout with marks', () => {
      const input = '> [!TIP] **important**'
      expect(serialize(parse(input))).toBe(input)
    })

    it('round-trip: empty callout body', () => {
      const input = '> [!INFO]'
      const result = parse(input)
      // An empty body after [!INFO] parses into a callout with no content
      expect(result.content?.[0]?.type).toBe('blockquote')
      expect((result.content?.[0] as BlockquoteNode | undefined)?.attrs?.calloutType).toBe('info')
      expect(serialize(result)).toBe('> [!INFO]')
    })

    it('round-trip: regular blockquote is unchanged', () => {
      const input = '> plain quote'
      expect(serialize(parse(input))).toBe(input)
    })
  })

  describe('table', () => {
    it('parses pipe-delimited table', () => {
      const input = '| Name | Age |\n| --- | --- |\n| Alice | 30 |'
      const result = parse(input)
      expect(result.content).toHaveLength(1)
      expect(result.content?.[0]?.type).toBe('table')
      const tbl = result.content?.[0] as TableNode
      expect(tbl.content).toHaveLength(2)
    })

    it('parses table with marks', () => {
      const input = '| **Bold** |\n| --- |\n| normal |'
      const result = parse(input)
      const tbl = result.content?.[0] as TableNode
      const headerCell = tbl.content?.[0]?.content?.[0]
      expect(headerCell?.type).toBe('tableHeader')
    })

    it('table followed by paragraph', () => {
      const input = '| A | B |\n| --- | --- |\n| 1 | 2 |\nNormal text'
      const result = parse(input)
      expect(result.content).toHaveLength(2)
      expect(result.content?.[0]?.type).toBe('table')
      expect(result.content?.[1]?.type).toBe('paragraph')
    })

    it('handles table rows with fewer columns than header', () => {
      const result = parse('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |')
      expect(result.content).toHaveLength(1)
      const tbl = result.content?.[0] as TableNode
      expect(tbl.content).toHaveLength(2) // header + 1 data row
      // Data row should have 2 cells (fewer than header's 3)
      expect(tbl.content?.[1]?.content?.length).toBe(2)
    })

    it('parses header-only table (no data rows)', () => {
      const result = parse('| A | B |\n| --- | --- |')
      expect(result.content).toHaveLength(1)
      const tbl = result.content?.[0] as TableNode
      expect(tbl.content).toHaveLength(1) // just the header row
      expect(tbl.content?.[0]?.content?.[0]?.type).toBe('tableHeader')
    })
  })
})

// -- round-trip ---------------------------------------------------------------

describe('round-trip: serialize(parse(s)) === s', () => {
  const cases: [string, string][] = [
    ['empty string', ''],
    ['plain text', 'hello world'],
    ['bold', '**strong**'],
    ['italic', '*emphasis*'],
    ['code', '`fn()`'],
    ['strikethrough', '~~deleted~~'],
    ['highlight', '==important=='],
    ['bold+italic', '***both***'],
    ['tag_ref', '#[01ARZ3NDEKTSV4RRFFQ69G5FAV]'],
    ['block_link', '[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]'],
    ['escaped asterisk', 'a \\* b'],
    ['escaped backtick', 'a \\` b'],
    ['escaped tilde', 'a \\~ b'],
    ['escaped equals', 'a \\= b'],
    ['escaped backslash', 'a \\\\ b'],
    ['escaped #[', 'use \\#\\[not a tag'],
    ['escaped [[', 'use \\[\\[not a link'],
    ['mixed marks and text', 'hello **bold** and *italic* and `code` end'],
    ['token with text', 'see #[01ARZ3NDEKTSV4RRFFQ69G5FAV] here'],
    ['two lines', 'first\nsecond'],
    ['whitespace-only', '   '],
    ['marks adjacent to tokens', '**look: **#[01ARZ3NDEKTSV4RRFFQ69G5FAV]'],
    ['code with special chars inside', '`**not \\* bold**`'],
    ['multiple tokens', '#[01ARZ3NDEKTSV4RRFFQ69G5FAV] and [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]'],
    ['consecutive tokens', '#[01ARZ3NDEKTSV4RRFFQ69G5FAV]#[01ARZ3NDEKTSV4RRFFQ69G5FAV]'],
    ['bold+italic with surrounding text', 'before ***both*** after'],
    ['escaped backslash before bold', '\\\\**bold**'],
    ['token after mark close', '**x**#[01ARZ3NDEKTSV4RRFFQ69G5FAV]'],
    ['bold then italic adjacent', '**a***b*'],
    ['blockquote', '> hello'],
    ['multi-line blockquote', '> line 1\n> line 2'],
    ['blockquote with marks', '> **strong**'],
    ['simple table', '| A | B |\n| --- | --- |\n| 1 | 2 |'],
    ['table with marks', '| **bold** | *italic* |\n| --- | --- |\n| a | b |'],
  ]

  for (const [name, input] of cases) {
    it(name, () => {
      expect(serialize(parse(input))).toBe(input)
    })
  }

  it('round-trips header-only table', () => {
    // Header-only table serializes as header + separator
    const md = '| A | B |\n| --- | --- |'
    expect(serialize(parse(md))).toBe(md)
  })
})

// -- mark coalescing (bold-inside-italic) -------------------------------------
// These test the fix for the data-loss bug where the serializer wrapped each
// TextNode independently, creating ambiguous delimiter sequences.
// See REVIEW-LATER.md "[2026-03-28] Serializer: bold-inside-italic mark merging"

describe('mark coalescing: nested marks across adjacent text nodes', () => {
  it('italic(a)+boldItalic(b)+italic(c) → *a**b**c*', () => {
    const input = doc(paragraph(italic('a'), boldItalic('b'), italic('c')))
    const md = serialize(input)
    expect(md).toBe('*a**b**c*')
    // Round-trip: parse should recover the original structure
    expect(parse(md)).toEqual(input)
  })

  it('bold(a)+boldItalic(b)+bold(c) → **a*b*c**', () => {
    const input = doc(paragraph(bold('a'), boldItalic('b'), bold('c')))
    const md = serialize(input)
    expect(md).toBe('**a*b*c**')
    expect(parse(md)).toEqual(input)
  })

  it('italic(a)+boldItalic(b) → *a**b***', () => {
    const input = doc(paragraph(italic('a'), boldItalic('b')))
    const md = serialize(input)
    expect(md).toBe('*a**b***')
    expect(parse(md)).toEqual(input)
  })

  it('boldItalic(a)+italic(b) → ***a**b*', () => {
    const input = doc(paragraph(boldItalic('a'), italic('b')))
    const md = serialize(input)
    expect(md).toBe('***a**b*')
    expect(parse(md)).toEqual(input)
  })

  it('boldItalic(a)+bold(b) → ***a*b**', () => {
    const input = doc(paragraph(boldItalic('a'), bold('b')))
    const md = serialize(input)
    expect(md).toBe('***a*b**')
    expect(parse(md)).toEqual(input)
  })

  it('bold(a)+boldItalic(b) → **a*b***', () => {
    const input = doc(paragraph(bold('a'), boldItalic('b')))
    const md = serialize(input)
    expect(md).toBe('**a*b***')
    expect(parse(md)).toEqual(input)
  })

  it('round-trip stability: serialize→parse→serialize is idempotent', () => {
    const input = doc(paragraph(italic('a'), boldItalic('b'), italic('c')))
    const md1 = serialize(input)
    const md2 = serialize(parse(md1))
    expect(md2).toBe(md1)
    // Third pass for extra confidence
    const md3 = serialize(parse(md2))
    expect(md3).toBe(md1)
  })

  it('empty-bold **** round-trip stabilizes to empty string', () => {
    const md1 = serialize(parse('****'))
    expect(md1).toBe('')
    const md2 = serialize(parse(md1))
    expect(md2).toBe(md1)
  })

  it('three-segment bold-inside-italic with longer text', () => {
    const input = doc(paragraph(italic('hello '), boldItalic('world'), italic(' end')))
    const md = serialize(input)
    expect(md).toBe('*hello **world** end*')
    expect(parse(md)).toEqual(input)
  })

  it('italic→bold transition (no shared marks)', () => {
    const input = doc(paragraph(italic('a'), bold('b')))
    const md = serialize(input)
    expect(md).toBe('*a***b**')
    expect(parse(md)).toEqual(input)
  })

  it('bold→italic transition (no shared marks)', () => {
    const input = doc(paragraph(bold('a'), italic('b')))
    const md = serialize(input)
    expect(md).toBe('**a***b*')
    expect(parse(md)).toEqual(input)
  })
})

// -- external links -----------------------------------------------------------

describe('external links', () => {
  describe('serialize', () => {
    it('simple link', () => {
      expect(serialize(doc(paragraph(linked('click here', 'https://example.com'))))).toBe(
        '[click here](https://example.com)',
      )
    })

    it('link with surrounding text', () => {
      expect(
        serialize(
          doc(
            paragraph(text('see '), linked('this page', 'https://example.com'), text(' for more')),
          ),
        ),
      ).toBe('see [this page](https://example.com) for more')
    })

    it('link at start of paragraph', () => {
      expect(serialize(doc(paragraph(linked('start', 'https://a.com'), text(' rest'))))).toBe(
        '[start](https://a.com) rest',
      )
    })

    it('link at end of paragraph', () => {
      expect(serialize(doc(paragraph(text('before '), linked('end', 'https://b.com'))))).toBe(
        'before [end](https://b.com)',
      )
    })

    it('bold text inside link', () => {
      const node: TextNode = {
        type: 'text',
        text: 'bold link',
        marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://x.com' } }],
      }
      expect(serialize(doc(paragraph(node)))).toBe('[**bold link**](https://x.com)')
    })

    it('italic text inside link', () => {
      const node: TextNode = {
        type: 'text',
        text: 'italic link',
        marks: [{ type: 'italic' }, { type: 'link', attrs: { href: 'https://x.com' } }],
      }
      expect(serialize(doc(paragraph(node)))).toBe('[*italic link*](https://x.com)')
    })

    it('code text inside link', () => {
      const node: TextNode = {
        type: 'text',
        text: 'code',
        marks: [{ type: 'code' }, { type: 'link', attrs: { href: 'https://x.com' } }],
      }
      expect(serialize(doc(paragraph(node)))).toBe('[`code`](https://x.com)')
    })

    it('multiple links in one paragraph', () => {
      expect(
        serialize(
          doc(
            paragraph(
              linked('first', 'https://a.com'),
              text(' and '),
              linked('second', 'https://b.com'),
            ),
          ),
        ),
      ).toBe('[first](https://a.com) and [second](https://b.com)')
    })

    it('consecutive links (no separator)', () => {
      expect(
        serialize(doc(paragraph(linked('a', 'https://a.com'), linked('b', 'https://b.com')))),
      ).toBe('[a](https://a.com)[b](https://b.com)')
    })

    it('link with balanced parentheses in URL (no escaping needed)', () => {
      expect(
        serialize(
          doc(paragraph(linked('wiki', 'https://en.wikipedia.org/wiki/Link_(disambiguation)'))),
        ),
      ).toBe('[wiki](https://en.wikipedia.org/wiki/Link_(disambiguation))')
    })

    it('link with unbalanced ) in URL escapes it', () => {
      expect(serialize(doc(paragraph(linked('broken', 'https://x.com/foo)bar'))))).toBe(
        '[broken](https://x.com/foo%29bar)',
      )
    })

    it('link adjacent to block_link token', () => {
      expect(
        serialize(
          doc(
            paragraph(
              linked('ext', 'https://x.com'),
              text(' '),
              blockLink('01ARZ3NDEKTSV4RRFFQ69G5FAV'),
            ),
          ),
        ),
      ).toBe('[ext](https://x.com) [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]')
    })

    it('multi-node link (same href grouped)', () => {
      const plain = linked('hello ', 'https://x.com')
      const boldNode: TextNode = {
        type: 'text',
        text: 'world',
        marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://x.com' } }],
      }
      expect(serialize(doc(paragraph(plain, boldNode)))).toBe('[hello **world**](https://x.com)')
    })
  })

  describe('parse', () => {
    it('simple link', () => {
      expect(parse('[click here](https://example.com)')).toEqual(
        doc(paragraph(linked('click here', 'https://example.com'))),
      )
    })

    it('link with surrounding text', () => {
      expect(parse('see [this page](https://example.com) for more')).toEqual(
        doc(paragraph(text('see '), linked('this page', 'https://example.com'), text(' for more'))),
      )
    })

    it('link at start of paragraph', () => {
      expect(parse('[start](https://a.com) rest')).toEqual(
        doc(paragraph(linked('start', 'https://a.com'), text(' rest'))),
      )
    })

    it('link at end of paragraph', () => {
      expect(parse('before [end](https://b.com)')).toEqual(
        doc(paragraph(text('before '), linked('end', 'https://b.com'))),
      )
    })

    it('bold text inside link', () => {
      expect(parse('[**bold link**](https://x.com)')).toEqual(
        doc(
          paragraph({
            type: 'text',
            text: 'bold link',
            marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://x.com' } }],
          }),
        ),
      )
    })

    it('italic text inside link', () => {
      expect(parse('[*italic link*](https://x.com)')).toEqual(
        doc(
          paragraph({
            type: 'text',
            text: 'italic link',
            marks: [{ type: 'italic' }, { type: 'link', attrs: { href: 'https://x.com' } }],
          }),
        ),
      )
    })

    it('code text inside link', () => {
      expect(parse('[`code`](https://x.com)')).toEqual(
        doc(
          paragraph({
            type: 'text',
            text: 'code',
            marks: [{ type: 'code' }, { type: 'link', attrs: { href: 'https://x.com' } }],
          }),
        ),
      )
    })

    it('multiple links in one paragraph', () => {
      expect(parse('[first](https://a.com) and [second](https://b.com)')).toEqual(
        doc(
          paragraph(
            linked('first', 'https://a.com'),
            text(' and '),
            linked('second', 'https://b.com'),
          ),
        ),
      )
    })

    it('consecutive links (no separator)', () => {
      expect(parse('[a](https://a.com)[b](https://b.com)')).toEqual(
        doc(paragraph(linked('a', 'https://a.com'), linked('b', 'https://b.com'))),
      )
    })

    it('escaped [ is not a link start', () => {
      expect(parse('a \\[not a link](url) b')).toEqual(
        doc(paragraph(text('a [not a link](url) b'))),
      )
    })

    it('incomplete link (no closing paren) falls back to text', () => {
      expect(parse('[no close paren](https://x.com')).toEqual(
        doc(paragraph(text('[no close paren](https://x.com'))),
      )
    })

    it('[ without ]( is plain text', () => {
      expect(parse('[just brackets]')).toEqual(doc(paragraph(text('[just brackets]'))))
    })

    it('[text] without (url) is plain text', () => {
      expect(parse('[text] not a link')).toEqual(doc(paragraph(text('[text] not a link'))))
    })

    it('empty display text uses URL as text', () => {
      expect(parse('[](https://x.com)')).toEqual(
        doc(paragraph(linked('https://x.com', 'https://x.com'))),
      )
    })

    it('link does not interfere with [[ block_link', () => {
      expect(parse('[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]')).toEqual(
        doc(paragraph(blockLink('01ARZ3NDEKTSV4RRFFQ69G5FAV'))),
      )
    })

    it('link adjacent to block_link token', () => {
      expect(parse('[ext](https://x.com) [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]')).toEqual(
        doc(
          paragraph(
            linked('ext', 'https://x.com'),
            text(' '),
            blockLink('01ARZ3NDEKTSV4RRFFQ69G5FAV'),
          ),
        ),
      )
    })

    it('link inside bold context', () => {
      expect(parse('**[link](https://x.com)**')).toEqual(
        doc(
          paragraph({
            type: 'text',
            text: 'link',
            marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://x.com' } }],
          }),
        ),
      )
    })

    it('URL with parentheses (depth tracking)', () => {
      expect(parse('[wiki](https://en.wikipedia.org/wiki/Link_(disambiguation))')).toEqual(
        doc(paragraph(linked('wiki', 'https://en.wikipedia.org/wiki/Link_(disambiguation)'))),
      )
    })
  })

  describe('round-trip', () => {
    const cases: [string, string][] = [
      ['simple link', '[click here](https://example.com)'],
      ['link with text', 'see [this page](https://a.com) for more'],
      ['link at start', '[start](https://a.com) rest'],
      ['link at end', 'before [end](https://b.com)'],
      ['bold inside link', '[**bold**](https://x.com)'],
      ['italic inside link', '[*italic*](https://x.com)'],
      ['code inside link', '[`code`](https://x.com)'],
      ['multiple links', '[a](https://a.com) and [b](https://b.com)'],
      ['consecutive links', '[a](https://a.com)[b](https://b.com)'],
      ['link with tokens', '[ext](https://x.com) [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]'],
      ['link with balanced parens', '[wiki](https://en.wikipedia.org/wiki/Link_(disambiguation))'],
      ['link with unbalanced paren', '[x](https://x.com/foo%29bar)'],
      ['escaped bracket', 'a \\[ b'],
      ['escaped close bracket', 'a \\] b'],
    ]

    for (const [name, input] of cases) {
      it(name, () => {
        expect(serialize(parse(input))).toBe(input)
      })
    }
  })

  describe('brackets and parens inside link label', () => {
    // Serialize: text with special chars in the label gets escaped properly
    // Round-trip: serialize → parse → serialize must be idempotent

    it('serialize: single [ in label is escaped', () => {
      expect(serialize(doc(paragraph(linked('a [ b', 'https://x.com'))))).toBe(
        '[a \\[ b](https://x.com)',
      )
    })

    it('serialize: single ] in label is escaped', () => {
      expect(serialize(doc(paragraph(linked('a ] b', 'https://x.com'))))).toBe(
        '[a \\] b](https://x.com)',
      )
    })

    it('serialize: balanced [] pair in label', () => {
      expect(serialize(doc(paragraph(linked('a [b] c', 'https://x.com'))))).toBe(
        '[a \\[b\\] c](https://x.com)',
      )
    })

    it('serialize: parens in label (not escaped)', () => {
      expect(serialize(doc(paragraph(linked('hello (world)', 'https://x.com'))))).toBe(
        '[hello (world)](https://x.com)',
      )
    })

    it('serialize: ]( sequence in label is escaped', () => {
      expect(serialize(doc(paragraph(linked('a ]( b', 'https://x.com'))))).toBe(
        '[a \\]( b](https://x.com)',
      )
    })

    it('serialize: mixed []() in label', () => {
      expect(serialize(doc(paragraph(linked('x [y] and (z)', 'https://x.com'))))).toBe(
        '[x \\[y\\] and (z)](https://x.com)',
      )
    })

    it('serialize: multiple unbalanced ] in label', () => {
      expect(serialize(doc(paragraph(linked(']]]', 'https://x.com'))))).toBe(
        '[\\]\\]\\]](https://x.com)',
      )
    })

    it('serialize: multiple unbalanced [ in label', () => {
      expect(serialize(doc(paragraph(linked('[[[', 'https://x.com'))))).toBe(
        '[\\[\\[\\[](https://x.com)',
      )
    })

    it('serialize: unbalanced parens in label', () => {
      expect(serialize(doc(paragraph(linked(')))(((', 'https://x.com'))))).toBe(
        '[)))(((](https://x.com)',
      )
    })

    // Parse: escaped brackets in label are unescaped correctly
    it('parse: escaped [ in label', () => {
      expect(parse('[a \\[ b](https://x.com)')).toEqual(
        doc(paragraph(linked('a [ b', 'https://x.com'))),
      )
    })

    it('parse: escaped ] in label', () => {
      expect(parse('[a \\] b](https://x.com)')).toEqual(
        doc(paragraph(linked('a ] b', 'https://x.com'))),
      )
    })

    it('parse: escaped ]( in label does not split link', () => {
      expect(parse('[a \\]( b](https://x.com)')).toEqual(
        doc(paragraph(linked('a ]( b', 'https://x.com'))),
      )
    })

    it('parse: multiple escaped brackets in label', () => {
      expect(parse('[\\[\\]\\[\\]](https://x.com)')).toEqual(
        doc(paragraph(linked('[][]', 'https://x.com'))),
      )
    })

    it('parse: parens in label are literal (no escaping needed)', () => {
      expect(parse('[hello (world)](https://x.com)')).toEqual(
        doc(paragraph(linked('hello (world)', 'https://x.com'))),
      )
    })

    // Round-trip: serialize(parse(s)) === s for all these edge cases
    const roundTripCases: [string, string][] = [
      ['[ in label', '[a \\[ b](https://x.com)'],
      ['] in label', '[a \\] b](https://x.com)'],
      ['balanced [] in label', '[a \\[b\\] c](https://x.com)'],
      ['parens in label', '[hello (world)](https://x.com)'],
      [']( in label', '[a \\]( b](https://x.com)'],
      ['mixed []() in label', '[x \\[y\\] and (z)](https://x.com)'],
      ['multiple ] in label', '[\\]\\]\\]](https://x.com)'],
      ['multiple [ in label', '[\\[\\[\\[](https://x.com)'],
      ['unbalanced parens in label', '[)))(((](https://x.com)'],
      ['empty brackets in label', '[\\[\\]](https://x.com)'],
      ['] [ ]( ) mixed in label', '[\\] \\[ \\]( )](https://x.com)'],
    ]

    for (const [name, input] of roundTripCases) {
      it(`round-trip: ${name}`, () => {
        expect(serialize(parse(input))).toBe(input)
      })
    }
  })
})

// -- headings -----------------------------------------------------------------

describe('headings', () => {
  it('parses # heading', () => {
    expect(parse('# Hello')).toEqual(doc(heading(1, text('Hello'))))
  })

  it('parses ## through ###### heading levels', () => {
    for (let level = 2; level <= 6; level++) {
      const prefix = '#'.repeat(level)
      expect(parse(`${prefix} Level ${level}`)).toEqual(doc(heading(level, text(`Level ${level}`))))
    }
  })

  it('parses heading with inline marks', () => {
    expect(parse('## **bold** heading')).toEqual(doc(heading(2, bold('bold'), text(' heading'))))
  })

  it('serializes heading level 1', () => {
    expect(serialize(doc(heading(1, text('Title'))))).toBe('# Title')
  })

  it('serializes heading level 3', () => {
    expect(serialize(doc(heading(3, text('Section'))))).toBe('### Section')
  })

  it('round-trips heading with marks', () => {
    const md = '## **bold** *italic*'
    expect(serialize(parse(md))).toBe(md)
  })

  it('heading followed by paragraph', () => {
    const md = '# Title\nSome text'
    const result = parse(md)
    expect(result.content).toHaveLength(2)
    expect(result.content?.[0]?.type).toBe('heading')
    expect(result.content?.[1]?.type).toBe('paragraph')
  })

  it('empty heading', () => {
    expect(serialize(doc(heading(1)))).toBe('# ')
  })
})

// -- code blocks --------------------------------------------------------------

describe('code blocks', () => {
  it('parses fenced code block', () => {
    const md = '```\nconsole.log("hi")\n```'
    expect(parse(md)).toEqual(doc(codeBlock('console.log("hi")')))
  })

  it('parses multi-line code block', () => {
    const md = '```\nline1\nline2\nline3\n```'
    expect(parse(md)).toEqual(doc(codeBlock('line1\nline2\nline3')))
  })

  it('serializes code block', () => {
    expect(serialize(doc(codeBlock('const x = 1')))).toBe('```\nconst x = 1\n```')
  })

  it('round-trips code block', () => {
    const md = '```\nfunction hello() {\n  return "world"\n}\n```'
    expect(serialize(parse(md))).toBe(md)
  })

  it('empty code block', () => {
    const md = '```\n```'
    expect(parse(md)).toEqual(doc(codeBlock('')))
  })

  it('code block with heading and paragraph', () => {
    const md = '# Title\n```\ncode\n```\nAfter'
    const result = parse(md)
    expect(result.content).toHaveLength(3)
    expect(result.content?.[0]?.type).toBe('heading')
    expect(result.content?.[1]?.type).toBe('codeBlock')
    expect(result.content?.[2]?.type).toBe('paragraph')
  })

  it('invalid code block language is sanitized to null', () => {
    const md = '```not a language!\nconsole.log("hi")\n```'
    const result = parse(md)
    expect(result.content).toHaveLength(1)
    const block = result.content?.[0]
    expect(block?.type).toBe('codeBlock')
    // Language should be stripped because it contains spaces / invalid chars
    expect((block as { attrs?: { language?: string } }).attrs?.language).toBeUndefined()
  })

  it('valid code block language is preserved', () => {
    const md = '```typescript\nconst x = 1\n```'
    const result = parse(md)
    const block = result.content?.[0]
    expect(block?.type).toBe('codeBlock')
    expect((block as { attrs?: { language?: string } }).attrs?.language).toBe('typescript')
  })

  it('code block language with special valid chars (c++, c#, .net)', () => {
    for (const lang of ['c++', 'c#', 'objective-c', 'f#', '.net']) {
      const md = `\`\`\`${lang}\ncode\n\`\`\``
      const result = parse(md)
      const block = result.content?.[0]
      expect((block as { attrs?: { language?: string } }).attrs?.language).toBe(lang)
    }
  })
})

// -- hardening: link scan depth -----------------------------------------------

describe('hardening: link scan depth', () => {
  it('unclosed [ with 20KB of text does not hang (completes < 100ms)', () => {
    const huge = `[${'a'.repeat(20_000)}`
    const start = performance.now()
    const result = parse(huge)
    const elapsed = performance.now() - start
    // Should complete quickly — the scan is capped at MAX_LINK_SCAN
    expect(elapsed).toBeLessThan(100)
    // The unclosed bracket is treated as literal text
    expect(result.content).toHaveLength(1)
    expect(result.content?.[0]?.type).toBe('paragraph')
  })
})

// -- block_ref ----------------------------------------------------------------

describe('block_ref round-trip', () => {
  it('serializes block_ref node to ((ULID))', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'see ' },
            { type: 'block_ref', attrs: { id: '01HZ00000000000000000BLOCK' } },
            { type: 'text', text: ' for details' },
          ],
        },
      ],
    }
    expect(serialize(doc as unknown as DocNode)).toBe(
      'see ((01HZ00000000000000000BLOCK)) for details',
    )
  })

  it('parses ((ULID)) to block_ref node', () => {
    const result = parse('check ((01HZ00000000000000000BLOCK)) here')
    const para = result.content?.[0]
    expect(para?.type).toBe('paragraph')
    expect(para?.content).toHaveLength(3)
    expect(para?.content?.[0]).toEqual({ type: 'text', text: 'check ' })
    expect(para?.content?.[1]).toEqual({
      type: 'block_ref',
      attrs: { id: '01HZ00000000000000000BLOCK' },
    })
    expect(para?.content?.[2]).toEqual({ type: 'text', text: ' here' })
  })

  it('round-trips block_ref through serialize → parse', () => {
    const md = 'reference ((01HZ00000000000000000BLOCK)) inline'
    const parsed = parse(md)
    expect(serialize(parsed)).toBe(md)
  })

  it('does not parse ((lowercase)) as block_ref', () => {
    const result = parse('not ((01hz00000000000000000block)) a ref')
    const para = result.content?.[0] as ParagraphNode | undefined
    // Should be plain text, not a block_ref node
    expect(para?.content?.some((c) => c.type === 'block_ref')).toBeFalsy()
  })

  it('does not parse (( with non-ULID content', () => {
    const result = parse('just ((some text)) here')
    const para = result.content?.[0] as ParagraphNode | undefined
    expect(para?.content?.some((c) => c.type === 'block_ref')).toBeFalsy()
  })
})

// -- ordered list -------------------------------------------------------------

describe('ordered list', () => {
  describe('parse', () => {
    it('parses 1. first\\n2. second produces ordered list', () => {
      expect(parse('1. first\n2. second')).toEqual(
        doc(orderedList(listItem(paragraph(text('first'))), listItem(paragraph(text('second'))))),
      )
    })

    it('parses single item ordered list', () => {
      expect(parse('1. only item')).toEqual(
        doc(orderedList(listItem(paragraph(text('only item'))))),
      )
    })

    it('parses ordered list with marks', () => {
      expect(parse('1. **bold item**\n2. *italic item*')).toEqual(
        doc(
          orderedList(
            listItem(paragraph(bold('bold item'))),
            listItem(paragraph(italic('italic item'))),
          ),
        ),
      )
    })

    it('ordered list followed by paragraph', () => {
      expect(parse('1. item\nNormal text')).toEqual(
        doc(orderedList(listItem(paragraph(text('item')))), paragraph(text('Normal text'))),
      )
    })

    it('paragraph followed by ordered list', () => {
      expect(parse('Before\n1. first\n2. second')).toEqual(
        doc(
          paragraph(text('Before')),
          orderedList(listItem(paragraph(text('first'))), listItem(paragraph(text('second')))),
        ),
      )
    })

    it('parses three-item ordered list', () => {
      expect(parse('1. a\n2. b\n3. c')).toEqual(
        doc(
          orderedList(
            listItem(paragraph(text('a'))),
            listItem(paragraph(text('b'))),
            listItem(paragraph(text('c'))),
          ),
        ),
      )
    })
  })

  describe('serialize', () => {
    it('serializes ordered list produces numbered items', () => {
      expect(
        serialize(
          doc(orderedList(listItem(paragraph(text('first'))), listItem(paragraph(text('second'))))),
        ),
      ).toBe('1. first\n2. second')
    })

    it('serializes single-item ordered list', () => {
      expect(serialize(doc(orderedList(listItem(paragraph(text('only'))))))).toBe('1. only')
    })

    it('serializes ordered list with marks', () => {
      expect(
        serialize(
          doc(
            orderedList(listItem(paragraph(bold('bold'))), listItem(paragraph(italic('italic')))),
          ),
        ),
      ).toBe('1. **bold**\n2. *italic*')
    })

    it('serializes empty ordered list', () => {
      expect(serialize(doc(orderedList()))).toBe('')
    })
  })

  describe('round-trip', () => {
    it('round-trip: two-item ordered list', () => {
      const input = '1. first\n2. second'
      expect(serialize(parse(input))).toBe(input)
    })

    it('round-trip: ordered list with marks', () => {
      const input = '1. **bold**\n2. *italic*'
      expect(serialize(parse(input))).toBe(input)
    })

    it('round-trip: single item ordered list', () => {
      const input = '1. only'
      expect(serialize(parse(input))).toBe(input)
    })

    it('round-trip: three items', () => {
      const input = '1. a\n2. b\n3. c'
      expect(serialize(parse(input))).toBe(input)
    })
  })
})

// -- horizontal rule ----------------------------------------------------------

describe('horizontal rule', () => {
  describe('parse', () => {
    it('parses --- produces horizontal rule', () => {
      expect(parse('---')).toEqual(doc(horizontalRule()))
    })

    it('parses ---- (four hyphens) as horizontal rule', () => {
      expect(parse('----')).toEqual(doc(horizontalRule()))
    })

    it('parses ----- (five hyphens) as horizontal rule', () => {
      expect(parse('-----')).toEqual(doc(horizontalRule()))
    })

    it('horizontal rule between paragraphs', () => {
      expect(parse('Before\n---\nAfter')).toEqual(
        doc(paragraph(text('Before')), horizontalRule(), paragraph(text('After'))),
      )
    })

    it('does not parse -- (two hyphens) as horizontal rule', () => {
      expect(parse('--')).toEqual(doc(paragraph(text('--'))))
    })

    it('does not parse --- with text after as horizontal rule', () => {
      expect(parse('--- text')).toEqual(doc(paragraph(text('--- text'))))
    })
  })

  describe('serialize', () => {
    it('serializes horizontal rule produces ---', () => {
      expect(serialize(doc(horizontalRule()))).toBe('---')
    })

    it('serializes horizontal rule with surrounding blocks', () => {
      expect(
        serialize(doc(paragraph(text('Before')), horizontalRule(), paragraph(text('After')))),
      ).toBe('Before\n---\nAfter')
    })
  })

  describe('round-trip', () => {
    it('round-trip: standalone horizontal rule', () => {
      const input = '---'
      expect(serialize(parse(input))).toBe(input)
    })

    it('round-trip: horizontal rule between paragraphs', () => {
      const input = 'Before\n---\nAfter'
      expect(serialize(parse(input))).toBe(input)
    })
  })
})

// -- parse recursion depth guard (MAINT-11) -----------------------------------

describe('parse recursion depth guard', () => {
  /** Extract the flattened plain-text concatenation of a parsed doc. */
  function flatText(node: DocNode | ParagraphNode | BlockquoteNode): string {
    let out = ''
    const content = node.content
    if (!content) return out
    for (const child of content) {
      if ('text' in child && typeof child.text === 'string') {
        out += child.text
      } else if ('content' in child && child.content) {
        out += flatText(child as BlockquoteNode | ParagraphNode)
      }
    }
    return out
  }

  /** Measure the actual nested blockquote depth in a parsed doc. */
  function blockquoteDepth(node: BlockquoteNode | DocNode | ParagraphNode): number {
    if (!node.content) return 0
    let max = 0
    for (const child of node.content) {
      if (child.type === 'blockquote') {
        const d = 1 + blockquoteDepth(child as BlockquoteNode)
        if (d > max) max = d
      }
    }
    return max
  }

  it('parses 10-level nested blockquote correctly (at the MAX_PARSE_DEPTH limit)', () => {
    // 10 '> ' prefixes — within the MAX_PARSE_DEPTH = 10 cap
    const input = `${'> '.repeat(10)}deep`
    const result = parse(input)
    // The deepest leaf text should still be reachable
    expect(flatText(result)).toBe('deep')
    // Structural: 10 nested blockquotes
    expect(blockquoteDepth(result)).toBe(10)
  })

  it('12-level nested blockquote does not throw and falls back to plain text at the cap', () => {
    // 12 '> ' prefixes — exceeds MAX_PARSE_DEPTH; the deepest recursion must
    // degrade to plain text rather than blowing the stack.
    const input = `${'> '.repeat(12)}very deep`
    expect(() => parse(input)).not.toThrow()
    const result = parse(input)
    // The leaf text "very deep" must still be preserved somewhere in the doc
    expect(flatText(result)).toContain('very deep')
  })

  it('pathological deeply nested blockquotes (30 levels) do not throw', () => {
    const input = `${'> '.repeat(30)}extreme`
    expect(() => parse(input)).not.toThrow()
    // Content is preserved as plain text at the cap; no stack overflow
    const result = parse(input)
    expect(flatText(result)).toContain('extreme')
  })

  it('pathological nested links in link-display-text do not throw', () => {
    // Craft a display-text string that itself opens another external link.
    // Depth-threading through consumeExternalLink bounds the recursion.
    let input = 'leaf'
    for (let i = 0; i < 20; i++) {
      input = `[${input}](https://example.com/${i})`
    }
    expect(() => parse(input)).not.toThrow()
    const result = parse(input)
    // All non-empty parse results include at least one block
    expect(result.content).toBeDefined()
    expect((result.content ?? []).length).toBeGreaterThan(0)
  })

  it('depth parameter ≤ MAX_PARSE_DEPTH still parses normally (explicit call)', () => {
    const result = parse('hello', 5)
    expect(result).toEqual(doc(paragraph(text('hello'))))
  })

  it('depth parameter > MAX_PARSE_DEPTH returns plain-text fallback (explicit call)', () => {
    // Pass depth=11 directly → exceeds MAX_PARSE_DEPTH (10) → plain-text
    // fallback returns the input verbatim as a single text node.
    const result = parse('> quoted', 11)
    expect(result).toEqual(doc(paragraph(text('> quoted'))))
  })
})

// -- inline variant dispatch --------------------------------------------------

// Exercises each per-variant branch of the inline dispatcher introduced when
// serializeInlineNodes was decomposed into serializeInlineAtom /
// serializeInlineText / serializeInlineChild. Each test pairs a happy-path
// assertion with an edge case involving surrounding marks to verify the atom
// helpers correctly close active mark state before emitting.
describe('inline variant dispatch', () => {
  const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const REF_ULID = '01HZ00000000000000000BLOCK'

  describe('text variant (happy + code exclusivity)', () => {
    it('plain text variant emits escaped text verbatim', () => {
      expect(serialize(doc(paragraph(text('hello world'))))).toBe('hello world')
    })

    it('text with only code mark emits backtick form and suppresses other marks', () => {
      const node: TextNode = {
        type: 'text',
        text: 'x',
        marks: [{ type: 'code' }, { type: 'bold' }],
      }
      // Code is exclusive — bold mark is dropped, output is plain `x`.
      expect(serialize(doc(paragraph(node)))).toBe('`x`')
    })

    it('text variant handles every escape character', () => {
      expect(serialize(doc(paragraph(text('a*b`c~d=e\\f[g]h'))))).toBe(
        'a\\*b\\`c\\~d\\=e\\\\f\\[g\\]h',
      )
    })
  })

  describe('tag_ref variant', () => {
    it('emits #[ULID] token (happy path)', () => {
      expect(serialize(doc(paragraph(tagRef(ULID))))).toBe(`#[${ULID}]`)
    })

    it('closes active bold mark before emitting tag_ref (edge: atom amid marks)', () => {
      expect(serialize(doc(paragraph(bold('strong'), tagRef(ULID), text('tail'))))).toBe(
        `**strong**#[${ULID}]tail`,
      )
    })
  })

  describe('block_link variant', () => {
    it('emits [[ULID]] token (happy path)', () => {
      expect(serialize(doc(paragraph(blockLink(ULID))))).toBe(`[[${ULID}]]`)
    })

    it('closes italic mark before emitting block_link (edge: atom amid marks)', () => {
      expect(serialize(doc(paragraph(italic('emph'), blockLink(ULID))))).toBe(`*emph*[[${ULID}]]`)
    })
  })

  describe('block_ref variant', () => {
    it('emits ((ULID)) token (happy path)', () => {
      const node: InlineNode = { type: 'block_ref', attrs: { id: REF_ULID } }
      expect(serialize(doc(paragraph(node)))).toBe(`((${REF_ULID}))`)
    })

    it('closes strike + highlight before emitting block_ref (edge: compound marks)', () => {
      const ref: InlineNode = { type: 'block_ref', attrs: { id: REF_ULID } }
      const marked: TextNode = {
        type: 'text',
        text: 'both',
        marks: [{ type: 'strike' }, { type: 'highlight' }],
      }
      // Emit open-strike, open-highlight, text, then close both (inner first:
      // highlight then strike), then the block_ref atom token.
      expect(serialize(doc(paragraph(marked, ref)))).toBe(`~~==both==~~((${REF_ULID}))`)
    })
  })

  describe('hardBreak variant', () => {
    it('emits a newline (happy path)', () => {
      expect(serialize(doc(paragraph(text('a'), hardBreak(), text('b'))))).toBe('a\nb')
    })

    it('closes active bold before emitting hardBreak (edge: atom amid marks)', () => {
      expect(serialize(doc(paragraph(bold('a'), hardBreak(), text('b'))))).toBe('**a**\nb')
    })
  })

  describe('unknown variant', () => {
    it('is stripped with a single warning (edge: plus surrounding marks close)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const unknown = { type: 'unknown_node' } as unknown as InlineNode
      expect(serialize(doc(paragraph(bold('x'), unknown, text('y'))))).toBe('**x**y')
      expect(warn).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    })
  })

  describe('all variants interleaved', () => {
    it('dispatches each variant and preserves ordering', () => {
      const ref: InlineNode = { type: 'block_ref', attrs: { id: REF_ULID } }
      const out = serialize(
        doc(
          paragraph(
            text('a '),
            tagRef(ULID),
            text(' b '),
            blockLink(ULID),
            text(' c '),
            ref,
            text(' d'),
            hardBreak(),
            text('e'),
          ),
        ),
      )
      expect(out).toBe(`a #[${ULID}] b [[${ULID}]] c ((${REF_ULID})) d\ne`)
    })
  })
})

// -- external link scan edge cases --------------------------------------------

// Exercises the scanBalancedClose helper extracted from probeExternalLink.
// These assertions target the two failure modes (unclosed bracket, unclosed
// paren) and the nesting / escape behaviors.
describe('external link scan edge cases', () => {
  it('returns a plain-text paragraph when ] has no following ( (missing url)', () => {
    const result = parse('[label] trailing')
    // No link match — every char is literal text after escape handling.
    expect(result).toEqual(doc(paragraph(text('[label] trailing'))))
  })

  it('returns plain text when url is unclosed (missing )', () => {
    const result = parse('[label](https://example.com unterminated')
    expect(result).toEqual(doc(paragraph(text('[label](https://example.com unterminated'))))
  })

  it('returns plain text when label has no closing ]', () => {
    const result = parse('[label without close (url)')
    // Unclosed `[` — scanBalancedClose returns -1 and probe rejects.
    expect(result).toEqual(doc(paragraph(text('[label without close (url)'))))
  })

  it('scans balanced parens in url without terminating early', () => {
    const result = parse('[wiki](https://en.wikipedia.org/wiki/Link_(disambiguation))')
    expect(result).toEqual(
      doc(paragraph(linked('wiki', 'https://en.wikipedia.org/wiki/Link_(disambiguation)'))),
    )
  })

  it('honors backslash escape inside url scan', () => {
    // `\)` inside url — the escape skips the `)` so paren depth does not
    // close prematurely. The url ends at the real closing `)`.
    const result = parse('[x](a\\)b)')
    const para = result.content?.[0] as ParagraphNode | undefined
    const first = para?.content?.[0] as TextNode | undefined
    expect(first?.marks?.some((m) => m.type === 'link')).toBe(true)
    // The href is the raw url slice (with the backslash preserved).
    const linkMark = first?.marks?.find((m) => m.type === 'link')
    expect(linkMark).toEqual({ type: 'link', attrs: { href: 'a\\)b' } })
  })

  it('rejects [[ULID]] as an external link (double-bracket prefix is block_link)', () => {
    const result = parse(`[[${'01ARZ3NDEKTSV4RRFFQ69G5FAV'}]]`)
    const para = result.content?.[0] as ParagraphNode | undefined
    // Treated as block_link token, not an external link attempt.
    expect(para?.content).toHaveLength(1)
    expect(para?.content?.[0]).toEqual(blockLink('01ARZ3NDEKTSV4RRFFQ69G5FAV'))
  })

  it('matches label containing escaped ] (scanner skips the escaped char)', () => {
    const result = parse('[a \\] b](https://example.com)')
    expect(result).toEqual(doc(paragraph(linked('a ] b', 'https://example.com'))))
  })
})

// -- UX-281: unknown-node user-facing toast (rate-limited) --------------------

describe('UX-281: unknown-node toast', () => {
  beforeEach(() => {
    __resetUnknownNodeToastsForTests()
    vi.mocked(toast.warning).mockClear()
  })

  it('fires toast.warning exactly once per type per session for inline nodes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unknown = { type: 'video_embed' } as unknown as InlineNode

    // First occurrence — toast fires
    serialize(doc(paragraph(text('a'), unknown, text('b'))))
    expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      "Some content (type: video_embed) couldn't be saved as Markdown and was dropped.",
    )

    // Second occurrence of the same type — rate-limited (no new toast)
    serialize(doc(paragraph(text('c'), unknown, text('d'))))
    expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1)

    // Third doc with 50 unknown inline nodes of the same type — still 1 toast
    const manyUnknowns: InlineNode[] = []
    for (let i = 0; i < 50; i++) manyUnknowns.push(unknown)
    serialize(doc(paragraph(...manyUnknowns)))
    expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1)

    warn.mockRestore()
  })

  it('fires a separate toast for each distinct unknown type', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fooNode = { type: 'foo' } as unknown as InlineNode
    const barNode = { type: 'bar' } as unknown as InlineNode

    serialize(doc(paragraph(text('a'), fooNode, text('b'))))
    serialize(doc(paragraph(text('c'), barNode, text('d'))))

    expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(toast.warning)).toHaveBeenNthCalledWith(
      1,
      "Some content (type: foo) couldn't be saved as Markdown and was dropped.",
    )
    expect(vi.mocked(toast.warning)).toHaveBeenNthCalledWith(
      2,
      "Some content (type: bar) couldn't be saved as Markdown and was dropped.",
    )

    warn.mockRestore()
  })

  it('also fires for unknown top-level (block-level) node types', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unknown = { type: 'customBlock', content: [] } as unknown as ParagraphNode

    serialize(doc(unknown, paragraph(text('ok'))))
    expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      "Some content (type: customBlock) couldn't be saved as Markdown and was dropped.",
    )

    // Subsequent same-type top-level occurrences are rate-limited
    serialize(doc(unknown))
    expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1)

    warn.mockRestore()
  })

  it('still emits logger.warn on every occurrence (toast is rate-limited, log is not)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unknown = { type: 'unknown_node' } as unknown as InlineNode

    serialize(doc(paragraph(text('a'), unknown, text('b'))))
    serialize(doc(paragraph(text('c'), unknown, text('d'))))
    serialize(doc(paragraph(text('e'), unknown, text('f'))))

    // Toast: only once per type per session
    expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1)
    // Log: once per occurrence (3 calls)
    expect(warn).toHaveBeenCalledTimes(3)

    warn.mockRestore()
  })
})
