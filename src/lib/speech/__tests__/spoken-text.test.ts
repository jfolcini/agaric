import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  unresolvedBlockLabel,
  unresolvedBlockRefLabel,
  unresolvedTagLabel,
} from '@/lib/block-title'
import { t } from '@/lib/i18n'
import {
  MAX_UTTERANCE_CHARS,
  type SpokenBlock,
  type SpokenTextResolvers,
  splitUtteranceText,
  spokenUtterances,
} from '@/lib/speech/spoken-text'

const PAGE = '01HX4ZQ8AAAAAAAAAAAAAAAAAA'
const TAG = '01HX4ZQ8BBBBBBBBBBBBBBBBBB'
const REF = '01HX4ZQ8CCCCCCCCCCCCCCCCCC'
const GONE = '01HX4ZQ8DDDDDDDDDDDDDDDDDD'

const TITLES: Record<string, string> = {
  [PAGE]: 'Projects/Garden',
  [REF]: 'Water the tomatoes',
}
const TAGS: Record<string, string> = { [TAG]: 'urgent' }

/** Shaped like `useBlockResolve`: a miss comes back as the unresolved label. */
const resolvers: SpokenTextResolvers = {
  resolveBlockTitle: (id) => TITLES[id] ?? unresolvedBlockLabel(id),
  resolveTagName: (id) => TAGS[id] ?? unresolvedTagLabel(id),
}

function block(content: string | null, todoState: string | null = null, id = 'B1'): SpokenBlock {
  return { id, content, todo_state: todoState }
}

/** The one utterance a short block speaks. */
function spoken(content: string, using: SpokenTextResolvers = resolvers): string {
  const utterances = spokenUtterances([block(content)], using, t)
  expect(utterances).toHaveLength(1)
  return (utterances[0] as { text: string }).text
}

describe('spokenUtterances — inline content', () => {
  it('reads text with every mark dropped', () => {
    expect(spoken('**bold** *italic* ~~gone~~ ==lit== `code` <u>under</u>')).toBe(
      'bold italic gone lit code under',
    )
  })

  it('reads an external link and an attachment link by their labels', () => {
    expect(spoken('see [the docs](https://example.com) and [notes](attachment:42)')).toBe(
      'see the docs and notes',
    )
  })

  it('reads a page link by the leaf of its title, and a labelled one by its label', () => {
    expect(spoken(`go to [[${PAGE}]] or [[${PAGE}|the plot]]`)).toBe('go to Garden or the plot')
  })

  it('reads a tag by its name and a block ref by its resolved text', () => {
    expect(spoken(`#[${TAG}] ((${REF}))`)).toBe('urgent Water the tomatoes')
  })

  it('reads an image by its alt text without the width suffix', () => {
    expect(spoken('a ![sunset over hills|300](sunset.png) b')).toBe('a sunset over hills b')
  })

  it('names inline math instead of reading its source', () => {
    expect(spoken('area is $\\pi r^2$ here')).toBe('area is formula here')
  })

  it('keeps a hard break as a line break', () => {
    expect(spoken('first\nsecond')).toBe('first\nsecond')
  })
})

describe('spokenUtterances — unresolved targets (Q4)', () => {
  it('speaks a missing word for each kind when the resolver returns its unresolved label', () => {
    expect(spoken(`[[${GONE}]] #[${GONE}] ((${GONE}))`)).toBe(
      'missing page missing tag missing block',
    )
  })

  it('speaks the same missing words when a resolver returns undefined', () => {
    const none: SpokenTextResolvers = {
      resolveBlockTitle: () => undefined,
      resolveTagName: () => undefined,
    }
    expect(spoken(`[[${PAGE}]] #[${TAG}] ((${REF}))`, none)).toBe(
      'missing page missing tag missing block',
    )
  })

  it('still speaks a labelled page link by its label when the target is missing', () => {
    expect(spoken(`[[${GONE}|old plan]]`)).toBe('old plan')
  })
})

describe('spokenUtterances — block-level content', () => {
  it('reads a heading and separate paragraphs as lines, dropping empty ones', () => {
    expect(spoken('# Title\n\nbody\n\n\n\nmore')).toBe('Title\nbody\nmore')
  })

  it('names a code block and a Mermaid diagram instead of reading them', () => {
    expect(spoken('before\n```js\nconst x = 1\n```\n```mermaid\ngraph TD\n```')).toBe(
      'before\ncode block\ndiagram',
    )
  })

  it('names display math', () => {
    expect(spoken('$$\nE = mc^2\n$$')).toBe('formula')
  })

  it('says nothing for a horizontal rule', () => {
    expect(spoken('above\n\n---\n\nbelow')).toBe('above\nbelow')
  })

  it('speaks no bare number for an empty ordered item', () => {
    expect(spoken('1. \n2. second')).toBe('2. second')
  })

  it('reads ordered list numbers as shown, restarting in a nested list', () => {
    expect(spoken('1. first\n2. second\n   1. inner')).toBe('1. first\n2. second\n1. inner')
  })

  it('reads bullet items, nested ones too, without a marker', () => {
    expect(spoken('- item\n  - nested')).toBe('item\nnested')
  })

  it('reads a code block inside a numbered item by its name, after the item text', () => {
    expect(spoken('1. a\n  ```\n  x\n  ```')).toBe('1. a\ncode block')
  })

  it('reads table cells row by row', () => {
    expect(spoken('| Name | Qty |\n| --- | --- |\n| Apples | 3 |')).toBe('Name, Qty\nApples, 3')
  })

  it('reads a quote and a callout by their text', () => {
    expect(spoken('> wise words')).toBe('wise words')
    expect(spoken('> [!warning] mind the gap')).toBe('mind the gap')
  })

  it('names an embed and a query block instead of reading the token', () => {
    expect(spoken(`{{embed ((${REF}))}}`)).toBe('embedded block')
    expect(spoken('{{query todo:TODO}}')).toBe('query')
  })

  it('reads text that only starts or only ends like a query block', () => {
    expect(spoken('{{query todo:TODO')).toBe('{{query todo:TODO')
    expect(spoken('see {{x}}')).toBe('see {{x}}')
  })
})

describe('spokenUtterances — task state and properties', () => {
  it.each([
    ['TODO', 'To do'],
    ['DOING', 'In progress'],
    ['DONE', 'Done'],
    ['CANCELLED', 'Cancelled'],
  ])('prefixes %s with its word', (state, word) => {
    expect(spokenUtterances([block('buy milk', state)], resolvers, t)).toEqual([
      { blockId: 'B1', text: `${word}: buy milk` },
    ])
  })

  it('speaks the state word alone for an empty task', () => {
    expect(spokenUtterances([block('', 'TODO')], resolvers, t)).toEqual([
      { blockId: 'B1', text: 'To do' },
    ])
  })

  it('ignores a todo_state that is not a task state', () => {
    expect(spokenUtterances([block('plain', 'LATER')], resolvers, t)).toEqual([
      { blockId: 'B1', text: 'plain' },
    ])
  })

  it('skips property lines and keeps the rest', () => {
    expect(spoken('buy milk\ncontext:: home\neffort:: 2h')).toBe('buy milk')
  })

  it('keeps a line that only looks like a property', () => {
    expect(spoken('use std::vector here')).toBe('use std::vector here')
  })
})

describe('spokenUtterances — blocks', () => {
  it('returns utterances in the order given and skips blocks with nothing to say', () => {
    const blocks = [
      block('first', null, 'A'),
      block(null, null, 'B'),
      block('', null, 'C'),
      block('---', null, 'D'),
      block('last', null, 'E'),
    ]
    expect(spokenUtterances(blocks, resolvers, t)).toEqual([
      { blockId: 'A', text: 'first' },
      { blockId: 'E', text: 'last' },
    ])
  })

  it('says nothing for a block of only whitespace', () => {
    expect(spokenUtterances([block('   \n\n  ')], resolvers, t)).toEqual([])
  })

  it('returns nothing for no blocks', () => {
    expect(spokenUtterances([], resolvers, t)).toEqual([])
  })

  it('splits a long block into several utterances for the same block', () => {
    const sentence = 'The quick brown fox jumps. '
    const content = sentence.repeat(Math.ceil((MAX_UTTERANCE_CHARS * 2) / sentence.length)).trim()
    const utterances = spokenUtterances([block(content)], resolvers, t)
    expect(utterances).toHaveLength(3)
    expect(utterances.every((u) => u.blockId === 'B1')).toBe(true)
    expect(utterances.every((u) => u.text.length <= MAX_UTTERANCE_CHARS)).toBe(true)
    expect(utterances.map((u) => u.text).join('')).toBe(content)
    expect(utterances[0]?.text.endsWith('jumps. ')).toBe(true)
  })
})

describe('splitUtteranceText', () => {
  it('keeps text that fits as one chunk, and empty text as none', () => {
    expect(splitUtteranceText('short')).toEqual(['short'])
    expect(splitUtteranceText('x'.repeat(MAX_UTTERANCE_CHARS))).toHaveLength(1)
    expect(splitUtteranceText('ab cd', 5)).toEqual(['ab cd'])
    expect(splitUtteranceText('')).toEqual([])
  })

  it('cuts after the last sentence end in reach', () => {
    expect(splitUtteranceText('One two. Three four. Five', 13)).toEqual([
      'One two. ',
      'Three four. ',
      'Five',
    ])
  })

  it('treats ! ? … and a line break as sentence ends', () => {
    expect(splitUtteranceText('Hey! you there', 8)).toEqual(['Hey! ', 'you ', 'there'])
    expect(splitUtteranceText('Why? because', 8)).toEqual(['Why? ', 'because'])
    expect(splitUtteranceText('So… then more', 8)).toEqual(['So… ', 'then ', 'more'])
    expect(splitUtteranceText('ab cd\nef gh', 10)).toEqual(['ab cd\n', 'ef gh'])
  })

  it('prefers a sentence end over a later word break', () => {
    expect(splitUtteranceText('Ab. cd ef gh', 10)).toEqual(['Ab. ', 'cd ef gh'])
  })

  it('does not take a period inside a word for a sentence end', () => {
    expect(splitUtteranceText('a.b cd ef', 6)).toEqual(['a.b ', 'cd ef'])
  })

  it('cuts after the last whitespace when no sentence ends in reach', () => {
    expect(splitUtteranceText('alpha beta gamma', 12)).toEqual(['alpha beta ', 'gamma'])
  })

  it('cuts a word longer than the limit at the limit', () => {
    expect(splitUtteranceText('abcdefgh', 3)).toEqual(['abc', 'def', 'gh'])
  })

  it('moves a hard cut back rather than split a surrogate pair', () => {
    expect(splitUtteranceText('ab😀cd', 3)).toEqual(['ab', '😀c', 'd'])
    // The two ends of the high-surrogate range: U+10000 and U+10FFFF.
    expect(splitUtteranceText('ab\u{10000}', 3)).toEqual(['ab', '\u{10000}'])
    expect(splitUtteranceText('ab\u{10FFFF}', 3)).toEqual(['ab', '\u{10FFFF}'])
  })
})

// -- Properties --------------------------------------------------------------

const ULID_SHAPE = /[0-9A-HJKMNP-TV-Z]{26}/
const arbUlid = fc.stringMatching(new RegExp(`^${ULID_SHAPE.source}$`))
const arbWord = fc.stringMatching(/^[a-z]{1,8}$/)

/** One fragment of block markdown; refs only appear as tokens, never inside code. */
function arbFragment(ids: readonly string[]): fc.Arbitrary<string> {
  const id = fc.constantFrom(...ids)
  return fc.oneof(
    arbWord,
    id.map((x) => `[[${x}]]`),
    fc.tuple(id, arbWord).map(([x, label]) => `[[${x}|${label}]]`),
    id.map((x) => `#[${x}]`),
    id.map((x) => `((${x}))`),
    id.map((x) => `{{embed ((${x}))}}`),
    arbWord.map((w) => `**${w}**`),
    arbWord.map((w) => `\`${w}\``),
    arbWord.map((w) => `[${w}](https://example.com/${w})`),
    arbWord.map((w) => `![${w}](${w}.png)`),
    fc.constant('$x^2$'),
  )
}

function arbLine(ids: readonly string[]): fc.Arbitrary<string> {
  const inline = fc
    .array(arbFragment(ids), { minLength: 1, maxLength: 6 })
    .map((parts) => parts.join(' '))
  return fc.oneof(
    inline,
    inline.map((s) => `# ${s}`),
    inline.map((s) => `- ${s}`),
    inline.map((s) => `1. ${s}`),
    inline.map((s) => `> ${s}`),
    inline.map((s) => `> [!tip] ${s}`),
    // A `|` in a cell is a column separator, so a labelled link cannot sit in a table.
    fc
      .tuple(inline, inline)
      .filter(([a, b]) => !`${a}${b}`.includes('|'))
      .map(([a, b]) => `| ${a} | ${b} |\n| --- | --- |\n| ${b} | ${a} |`),
    arbWord.map((w) => `${w}:: ${w}`),
    fc.constant('```\ncode\n```'),
    fc.constant('$$\nx\n$$'),
  )
}

/** Resolvers that give some ids ULID-free titles and miss the rest, each way a miss comes back. */
function arbResolvers(ids: readonly string[]): fc.Arbitrary<SpokenTextResolvers> {
  const outcome = fc.oneof(
    arbWord.map((w) => ({ kind: 'title' as const, w })),
    fc.constant({ kind: 'label' as const }),
    fc.constant({ kind: 'undefined' as const }),
  )
  return fc.array(outcome, { minLength: ids.length, maxLength: ids.length }).map((outcomes) => {
    const pick = (id: string, label: (id: string) => string): string | undefined => {
      const o = outcomes[ids.indexOf(id)]
      if (o?.kind === 'title') return o.w
      return o?.kind === 'label' ? label(id) : undefined
    }
    return {
      resolveBlockTitle: (id) => pick(id, unresolvedBlockLabel),
      resolveTagName: (id) => pick(id, unresolvedTagLabel),
    }
  })
}

describe('spokenUtterances — properties', () => {
  it('never speaks a ULID, a truncated one, or an unresolved-label shape', () => {
    const arbCase = fc.array(arbUlid, { minLength: 1, maxLength: 4 }).chain((ids) =>
      fc.record({
        ids: fc.constant(ids),
        resolvers: arbResolvers(ids),
        lines: fc.array(arbLine(ids), { minLength: 1, maxLength: 5 }),
        state: fc.constantFrom(null, 'TODO', 'DONE'),
      }),
    )
    fc.assert(
      fc.property(arbCase, ({ ids, resolvers: using, lines, state }) => {
        const text = spokenUtterances([block(lines.join('\n'), state)], using, t)
          .map((u) => u.text)
          .join('')
        expect(text).not.toMatch(ULID_SHAPE)
        for (const id of ids) {
          expect(text).not.toContain(id.slice(0, 8))
          expect(text).not.toContain(unresolvedBlockLabel(id))
          expect(text).not.toContain(unresolvedTagLabel(id))
          expect(text).not.toContain(unresolvedBlockRefLabel(id))
        }
      }),
    )
  })
})

describe('splitUtteranceText — properties', () => {
  const arbText = fc
    .array(
      fc.oneof(
        fc.constantFrom(' ', '\n', '. ', '! ', '…', '😀', '𝄞', 'é'),
        fc.stringMatching(/^[a-z]{1,12}$/),
      ),
      { maxLength: 60 },
    )
    .map((parts) => parts.join(''))

  it('rejoins to the input, keeps every chunk within the limit and every pair whole', () => {
    fc.assert(
      fc.property(arbText, fc.integer({ min: 2, max: 16 }), (text, max) => {
        const chunks = splitUtteranceText(text, max)
        expect(chunks.join('')).toBe(text)
        for (const chunk of chunks) {
          expect(chunk.length).toBeGreaterThan(0)
          expect(chunk.length).toBeLessThanOrEqual(max)
          expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false)
          expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false)
        }
      }),
    )
  })

  it('holds at the real limit', () => {
    const arbLong = fc
      .array(fc.oneof(fc.constantFrom(' ', '. ', '😀'), fc.stringMatching(/^[a-z]{1,400}$/)), {
        maxLength: 60,
      })
      .map((parts) => parts.join(''))
    fc.assert(
      fc.property(arbLong, (text) => {
        const chunks = splitUtteranceText(text)
        expect(chunks.join('')).toBe(text)
        expect(chunks.every((c) => c.length > 0 && c.length <= MAX_UTTERANCE_CHARS)).toBe(true)
      }),
      { numRuns: 50 },
    )
  })
})
