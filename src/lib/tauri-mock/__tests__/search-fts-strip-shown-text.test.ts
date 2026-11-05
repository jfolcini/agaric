/**
 * #6277 B3 — the mock's `fts_blocks.stripped` stand-in indexes the text the
 * editor shows, as `strip_for_fts_with_maps` does: escapes decoded outside
 * code, code raw, a `((ULID))` as its target's first line. The table is the
 * Rust one (`strip_indexes_the_text_the_editor_shows_6277` in
 * `agaric-store/src/fts/tests.rs`), row for row.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { clearMock } from '@/lib/tauri-mock/__tests__/mock-store-helpers'
import { stripForFts } from '@/lib/tauri-mock/handlers/search'
import { blocks, makeBlock } from '@/lib/tauri-mock/seed'

const T = '01HQREFT00000000000000RT01'
const TAG = '01HQTAG000000000000000TAG1'
const PAGE = '01HQPAGE00000000000000PG01'
/** Text shaped like the strip's own placeholder for piece 0. */
const PLACEHOLDER_SHAPED = '\uE002' + '0\uE003'

const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~0123456789 \t'

describe('stripForFts — the text the editor shows (#6277 B3)', () => {
  beforeEach(() => {
    clearMock()
    blocks.set(T, makeBlock(T, 'content', 'First line\nsecond', null, 0))
  })

  it.each([
    // Every escape `isEscapableChar` decodes, left to right.
    ['arr\\[0\\]', 'arr[0]'],
    ['\\_\\_init\\_\\_', '__init__'],
    ['a\\\\b', 'a\\b'],
    ['\\#1 \\$5 \\<b\\> \\: \\! \\(x\\) \\1 \\ x', '#1 $5 <b> : ! (x) 1  x'],
    // A backslash before anything else is a backslash.
    ['C:\\dir \\é', 'C:\\dir \\é'],
    // An escaped delimiter is literal, not markup or code.
    ['\\*a\\*', '*a*'],
    ['\\`a\\`', '`a`'],
    // Code is raw: no escape, markup or reference inside. A code span closes
    // on its own line, a fence on any; an unclosed run leaves the rest of its
    // line literal.
    ['`a\\_b`', 'a\\_b'],
    ['``a`b``', 'a`b'],
    ['```\n*a* \\* x\n```', '\n*a* \\* x\n'],
    ['a `b \\* c\nd \\* e', 'a `b \\* c\nd * e'],
    ['Use `foo\nbar` here', 'Use `foo\nbar` here'],
    // A tilde fence opens at a line start and keeps its body raw, backtick
    // lines included, to its closing line or the end.
    ['~~~md\n```js\nx\n```\n~~~', 'md\n```js\nx\n```\n'],
    ['a\n~~~\n\\* b', 'a\n\n\\* b'],
    ['a ~~~ \\* b', 'a ~~~ * b'],
    ['```\n~~~\n```', '\n~~~\n'],
    ['~~~md', 'md'],
    ['~~~', ''],
    // Every char `isEscapableChar` names, written out.
    [
      ESCAPABLE.split('')
        .map((c) => `\\${c}`)
        .join(''),
      ESCAPABLE,
    ],
    [`${PLACEHOLDER_SHAPED} \`x\``, `${PLACEHOLDER_SHAPED} x`],
    // A block ref is its target's first line; a missing target is empty.
    [`see ((${T}))`, 'see First line'],
    ['see ((01HQMISS00000000000000MS01))', 'see '],
    // Its first line is text, never markup of the block around it.
    [`*see ((${T}))*`, 'see First line'],
    // An escaped opener keeps the token literal, and code keeps it raw.
    [`\\((${T}))`, `((${T}))`],
    [`\`**x** ((${T}))\``, `**x** ((${T}))`],
  ])('strips %j to %j', (raw, expected) => {
    expect(stripForFts(raw)).toBe(expected)
  })

  it('reads the first line without its `\\r`, and a blank one as empty', () => {
    blocks.set(T, makeBlock(T, 'content', 'crlf line\r\nsecond', null, 0))
    expect(stripForFts(`see ((${T}))`)).toBe('see crlf line')
    blocks.set(T, makeBlock(T, 'content', '\nbody', null, 0))
    expect(stripForFts(`see ((${T}))`)).toBe('see ')
  })

  it('keeps a soft-deleted target title, as its chip does', () => {
    const target = blocks.get(T) as Record<string, unknown>
    target['deleted_at'] = '2026-01-01T00:00:00.000Z'
    expect(stripForFts(`see ((${T}))`)).toBe('see First line')
  })

  it('indexes a placeholder-shaped name as written', () => {
    blocks.set(TAG, makeBlock(TAG, 'tag', PLACEHOLDER_SHAPED, null, 0))
    blocks.set(PAGE, makeBlock(PAGE, 'page', PLACEHOLDER_SHAPED, null, 0))
    expect(stripForFts(`\`c\` #[${TAG}] [[${PAGE}]]`)).toBe(
      `c ${PLACEHOLDER_SHAPED} ${PLACEHOLDER_SHAPED}`,
    )
  })
})
