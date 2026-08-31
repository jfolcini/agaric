/**
 * Unit tests for the inline `key:: value` property parser (#2675).
 *
 * The line-level rules mirror the Logseq import parser
 * (`src-tauri/agaric-engine/src/import.rs`): split at the FIRST `":: "`, key must match
 * `^[A-Za-z0-9_-]{1,64}$`, value must be non-empty after trimming, reserved
 * keys and fenced code are skipped. Divergences (reserved keys stay literal
 * instead of being dropped) are documented in the module docstring.
 */

import { describe, expect, it } from 'vitest'

import type { PropertyDefinition } from '@/lib/tauri'

import {
  buildInlinePropertySetParams,
  INLINE_PROPERTY_RESERVED_KEYS,
  isInlinePropertyKey,
  parseInlineProperties,
  stripPropertyLines,
} from '../inline-property-parse'

/**
 * The reserved keys, spelled out independently of the constant under test.
 * Both reserved-key tests below drive off THIS literal, never off
 * `INLINE_PROPERTY_RESERVED_KEYS` — a test whose fixtures come from the value
 * it asserts over passes for any value of that constant (#3797). Mirrors
 * `FRONTMATTER_RESERVED_KEYS` in `src-tauri/agaric-engine/src/import.rs` and
 * the two `key NOT IN (…)` SQL lists in `export_page_markdown_inner`
 * (`src-tauri/src/commands/pages/markdown.rs`).
 */
const EXPECTED_RESERVED_KEYS = [
  'space',
  'is_space',
  'created_at',
  'completed_at',
  'repeat',
  'repeat-until',
  'repeat-count',
  'repeat-seq',
  'repeat-origin',
  'template',
]

function def(value_type: string, options: string | null = null): PropertyDefinition {
  return { key: 'k', value_type, options, created_at: '2026-01-01T00:00:00Z' }
}

describe('parseInlineProperties', () => {
  it('parses a single property line', () => {
    expect(parseInlineProperties('status:: active')).toEqual([
      { key: 'status', value: 'active', lineIndex: 0 },
    ])
  })

  it('parses multiple property lines and keeps their line indexes', () => {
    const content = 'some text\nstatus:: active\ncontext:: @office'
    expect(parseInlineProperties(content)).toEqual([
      { key: 'status', value: 'active', lineIndex: 1 },
      { key: 'context', value: '@office', lineIndex: 2 },
    ])
  })

  it('trims surrounding whitespace on the line, key, and value (import.rs parity)', () => {
    // import.rs trims the line, then trims each side of split_once(":: ").
    expect(parseInlineProperties('  status :: active  ')).toEqual([
      { key: 'status', value: 'active', lineIndex: 0 },
    ])
  })

  // #3804 — line refreshed (was 134/123, drifted): `trimmed.slice(sepIndex +
  // 3).trim()` → `trimmed.slice(sepIndex + 3)`, currently
  // inline-property-parse.ts:160 (verify with `grep -n 'trimmed.slice(sepIndex'
  // src/lib/inline-property-parse.ts`). Only ONE space is consumed by the ":: "
  // separator match itself; extra spaces right after `::` land inside the
  // value slice and need their OWN trim (the line-level trim, now at line 142,
  // already ran and cannot remove them — they are not at the line's edges).
  it('trims extra whitespace between the separator and the value', () => {
    expect(parseInlineProperties('status::   active')).toEqual([
      { key: 'status', value: 'active', lineIndex: 0 },
    ])
  })

  it('splits at the FIRST ":: " — the remainder stays in the value', () => {
    expect(parseInlineProperties('note:: this has :: inside')).toEqual([
      { key: 'note', value: 'this has :: inside', lineIndex: 0 },
    ])
  })

  it('accepts keys with digits, dashes, and underscores', () => {
    expect(parseInlineProperties('due-date_2:: tomorrow')).toEqual([
      { key: 'due-date_2', value: 'tomorrow', lineIndex: 0 },
    ])
  })

  it('rejects an invalid key (spaces / punctuation before ::)', () => {
    // Mid-sentence `:: ` — the LHS is not a valid key, so the line is content.
    expect(parseInlineProperties('see also:: the manual')).toEqual([])
    expect(parseInlineProperties('a URL https://x.test :: note')).toEqual([])
  })

  it('rejects `::` without a following space (std::vector never matches)', () => {
    expect(parseInlineProperties('std::vector<int> usage')).toEqual([])
    expect(parseInlineProperties('key::value')).toEqual([])
  })

  it('rejects a key longer than 64 chars', () => {
    const longKey = 'k'.repeat(65)
    expect(parseInlineProperties(`${longKey}:: v`)).toEqual([])
    const maxKey = 'k'.repeat(64)
    expect(parseInlineProperties(`${maxKey}:: v`)).toHaveLength(1)
  })

  it('rejects an empty value — `key:: ` then blur stays literal', () => {
    // The trimmed line is `key::`, which has no ":: " separator — exactly how
    // import.rs falls through to the content branch. The backend rejects
    // empty values, so the text must stay literal.
    expect(parseInlineProperties('status:: ')).toEqual([])
    expect(parseInlineProperties('status::')).toEqual([])
  })

  // Behavioural half: the parser actually SKIPS each reserved key. Kept
  // alongside the membership pin below because only this test fails if the
  // `INLINE_PROPERTY_RESERVED_KEYS.has(key)` guard is deleted from
  // `parseInlineProperties`. It iterates the independent literal, not the
  // constant, so it can no longer pass vacuously (#3797).
  it('skips reserved / exporter-managed keys (they stay literal)', () => {
    for (const key of EXPECTED_RESERVED_KEYS) {
      expect(parseInlineProperties(`${key}:: something`)).toEqual([])
    }
  })

  // Membership half — line 58-68 [ArrayDeclaration / StringLiteral]: pins the
  // constant's actual contents against the independent literal, so an
  // empty-set mutant or any single key blanked to `''` fails here.
  it('has the exact reserved key list (mirrors FRONTMATTER_RESERVED_KEYS in src-tauri/agaric-engine/src/import.rs)', () => {
    expect([...INLINE_PROPERTY_RESERVED_KEYS].toSorted()).toEqual(EXPECTED_RESERVED_KEYS.toSorted())
  })

  // #4552 slice 4 — `listStyle` is DELIBERATELY absent from this list: the
  // markdown-export exclusion (`export_page_markdown_inner`'s two
  // `key NOT IN (…)` SQL lists, `src-tauri/src/commands/pages/markdown.rs`)
  // must exclude it so a styled block's marker (`- ` / `N. `) isn't ALSO
  // exported as a raw `listStyle:: ordered` property line — but the inline
  // `key:: value` picker/typing path should keep working, so `listStyle`
  // must stay OUT of this reserved set, unlike the export-side lists. This
  // pins the intended asymmetry so a future "just add listStyle everywhere"
  // edit doesn't silently break inline `listStyle:: bullet`.
  it('does NOT reserve `listStyle` — inline `listStyle:: value` must keep working', () => {
    expect(INLINE_PROPERTY_RESERVED_KEYS.has('listStyle')).toBe(false)
    expect(parseInlineProperties('listStyle:: bullet')).toEqual([
      { key: 'listStyle', value: 'bullet', lineIndex: 0 },
    ])
  })

  it('skips lines inside fenced code blocks', () => {
    const content = '```\nstatus:: active\n```'
    expect(parseInlineProperties(content)).toEqual([])
    // …but a property line AFTER the fence closes is parsed.
    const after = '```\nx:: y\n```\nstatus:: active'
    expect(parseInlineProperties(after)).toEqual([{ key: 'status', value: 'active', lineIndex: 3 }])
  })

  // #3804 — line refreshed (was 123, drifted): `raw.trim()` → `raw`,
  // currently inline-property-parse.ts:142 (verify with `grep -n 'const
  // trimmed = raw.trim' src/lib/inline-property-parse.ts`). A leading space
  // before the fence delimiter would still be a real fence in any markdown
  // renderer; only the (pre-trim) `raw` line is checked, so skipping the
  // outer trim makes `startsWith('```')` see the leading space and miss the
  // fence.
  it('recognizes a fence delimiter with leading indentation', () => {
    const content = ' ```\nstatus:: active\n```'
    expect(parseInlineProperties(content)).toEqual([])
  })

  // #3804 — line refreshed (was 126, drifted): `trimmed.startsWith('```')` →
  // `trimmed.endsWith('```')`, currently inline-property-parse.ts:145 (verify
  // with `grep -n "startsWith('\`\`\`')" src/lib/inline-property-parse.ts`).
  // A language-tagged opening fence (` ```js `) starts with the delimiter but
  // does not end with it — distinguishes the two methods where a bare
  // ` ``` ` (which both starts AND ends with the delimiter) would not.
  it('recognizes a language-tagged fence delimiter (```js)', () => {
    const content = '```js\nstatus:: active\n```'
    expect(parseInlineProperties(content)).toEqual([])
  })

  it('drops the hard-break marker `\\` from a non-final property line (serialized Shift+Enter)', () => {
    // `context:: home` + Shift+Enter + `notes` serializes to
    // `context:: home\` + '\n' + `notes` (markdown-serialize hardBreak).
    // The trailing `\` is the break marker, never part of the value.
    expect(parseInlineProperties('context:: home\\\nnotes')).toEqual([
      { key: 'context', value: 'home', lineIndex: 0 },
    ])
    // Two property lines joined by a hard break.
    expect(parseInlineProperties('a:: 1\\\nb:: 2')).toEqual([
      { key: 'a', value: '1', lineIndex: 0 },
      { key: 'b', value: '2', lineIndex: 1 },
    ])
  })

  it('keeps a LITERAL trailing backslash (escaped `\\\\`) in the value, minus the break marker', () => {
    // User-typed value `v\` serializes to `v\\`; with a following hard break
    // the line is `k:: v\\\` — only the final (odd) marker is dropped.
    expect(parseInlineProperties('k:: v\\\\\\\nnext')).toEqual([
      { key: 'k', value: 'v\\\\', lineIndex: 0 },
    ])
    // On the LAST line there is no break marker: `v\\` stays intact.
    expect(parseInlineProperties('k:: v\\\\')).toEqual([{ key: 'k', value: 'v\\\\', lineIndex: 0 }])
  })

  // #3804 — line refreshed (was 121, drifted): [ConditionalExpression
  // `isLast → false`, ArithmeticOperator `lines.length - 1 → lines.length +
  // 1`], currently inline-property-parse.ts:140 (verify with `grep -n 'const
  // isLast =' src/lib/inline-property-parse.ts`). Both mutants make `isLast`
  // always false — even a single-line ("real last line") input would then
  // have its ODD trailing backslash wrongly treated as a hard-break marker
  // and stripped, instead of kept as literal text.
  it('keeps a single trailing backslash literal on the actual last line (not a hard-break marker)', () => {
    expect(parseInlineProperties('context:: home\\')).toEqual([
      { key: 'context', value: 'home\\', lineIndex: 0 },
    ])
  })

  it('an empty-value property line before a hard break stays literal', () => {
    // `context:: ` + Shift+Enter → line `context:: \` → marker dropped →
    // `context::` → no ':: ' separator → not a property line.
    expect(parseInlineProperties('context:: \\\nmore text')).toEqual([])
  })

  // Ledger — the former `if (value === '') continue` guard (old line 136) was
  // REMOVED in #3797, together with the two permanent mutation survivors it
  // carried [ConditionalExpression `value === '' → false`, StringLiteral
  // `'' → "Stryker was here!"`]. The branch was unreachable, not merely
  // untested: `trimmed` is fully right-trimmed before `indexOf(':: ')` runs,
  // so the matched separator's trailing space can never be `trimmed`'s last
  // character, so the value slice always keeps a trailing non-whitespace char
  // and `value.trim()` can never be `''` there. Established three ways:
  //   - closed-form: sepIndex + 3 <= trimmed.length - 1 for any string that
  //     reaches the line, and trimmed's last char is non-whitespace by
  //     construction, so it survives into `value`;
  //   - canary: an instrumented copy fuzzed over 500k generated lines hit the
  //     site 232,758 times and fired zero times;
  //   - adversarial re-check before deletion: an exhaustive sweep over every
  //     BMP code point as the trailing character, plus all 0-3 char suffixes
  //     drawn from the Unicode-whitespace/near-whitespace alphabet (TAB, VT,
  //     FF, NBSP, all Zs, U+2028/29, U+FEFF, U+200B, U+180E, lone surrogates)
  //     and 400k random fuzz — 390,096 reaches, still zero fires.
  // The empty-value BEHAVIOUR is unaffected and still covered by the "rejects
  // an empty value" test above: `key:: ` trims to `key::`, which has no
  // `':: '` separator and falls out at the `sepIndex === -1` check.

  it('returns an empty list for plain content', () => {
    expect(parseInlineProperties('just a normal block')).toEqual([])
    expect(parseInlineProperties('')).toEqual([])
  })
})

describe('isInlinePropertyKey', () => {
  it('matches the validate_set_property alphabet', () => {
    expect(isInlinePropertyKey('status')).toBe(true)
    expect(isInlinePropertyKey('a-b_C9')).toBe(true)
    expect(isInlinePropertyKey('')).toBe(false)
    expect(isInlinePropertyKey('has space')).toBe(false)
    expect(isInlinePropertyKey('émoji')).toBe(false)
    expect(isInlinePropertyKey('k'.repeat(65))).toBe(false)
  })
})

describe('stripPropertyLines', () => {
  it('removes only the given line indexes', () => {
    const content = 'text\nstatus:: active\nmore text'
    expect(stripPropertyLines(content, new Set([1]))).toBe('text\nmore text')
  })

  it('returns content unchanged for an empty index set', () => {
    const content = 'text\nstatus:: active'
    expect(stripPropertyLines(content, new Set())).toBe(content)
  })
  // Ledger — #3804 — line refreshed (was 150, drifted): [ConditionalExpression
  // `lineIndexes.size === 0 → false`], currently inline-property-parse.ts:175
  // (verify with `grep -n 'lineIndexes.size === 0'
  // src/lib/inline-property-parse.ts`): equivalent. This early return is a
  // pure optimization, not a correctness requirement — with an empty set,
  // `lines.filter` removes nothing (`kept === lines`), the marker-stripping
  // guard's own `lineIndexes.has(...)` check short-circuits false, and
  // `content.split('\n').join('\n')` always reconstructs `content` exactly
  // (split/join with the same separator is lossless for any string, by
  // construction). Originally verified over a 100k random-string sweep (0
  // diffs from the original with an empty set; 8,569/8,569 identical results
  // on non-empty sets too, confirming it isn't trivially vacuous) that was
  // never committed. #3804 — re-verified with a committed, re-runnable
  // harness:
  // `scripts/mutation-harnesses/inline-property-parse-strip-lines.harness.ts`.

  it('stripping the only line yields an empty string', () => {
    expect(stripPropertyLines('status:: active', new Set([0]))).toBe('')
  })

  it('supports stripping several lines while keeping the rest', () => {
    const content = 'a:: 1\nkeep me\nb:: 2'
    expect(stripPropertyLines(content, new Set([0, 2]))).toBe('keep me')
  })

  it('removes the dangling hard-break marker when the original LAST line is stripped', () => {
    // `notes` + Shift+Enter + `context:: home` serializes to
    // `notes\` + '\n' + `context:: home`; stripping line 1 must not leave the
    // now-final line as `notes\` (a stray literal backslash on reparse).
    expect(stripPropertyLines('notes\\\ncontext:: home', new Set([1]))).toBe('notes')
  })

  it('keeps an interior hard-break marker intact when a middle line is stripped', () => {
    // `a\` + `k:: v\` + `b` → strip line 1 → `a\` + `b`: the surviving marker
    // still has a following line, so it remains a valid hard break.
    expect(stripPropertyLines('a\\\nk:: v\\\nb', new Set([1]))).toBe('a\\\nb')
  })

  it('does not touch a literal double-backslash when the last line is stripped', () => {
    // `end\\` is an ESCAPED literal backslash (even run) — not a break marker.
    expect(stripPropertyLines('end\\\\\nk:: v', new Set([1]))).toBe('end\\\\')
  })

  // #3804 — line refreshed (was 88, drifted): [EqualityOperator `i >= 0 → i >
  // 0`] inside the shared `trailingBackslashRun` helper, currently
  // inline-property-parse.ts:107 (verify with `grep -n 'i >= 0 &&'
  // src/lib/inline-property-parse.ts`). The off-by-one only shows up when the
  // scanned line is backslashes ALL the way down to index 0 — here the new
  // last line after stripping is a lone `\`, so the loop's final check
  // happens at i===0. Original: `i>=0` true, counts index 0 too → n=1 (odd)
  // → marker stripped → `''`. Mutant: `i>0` is false AT i===0, so index 0 is
  // never counted → n=0 (even) → marker left in place → `'\'` survives.
  // (`parseInlineProperties` alone can't observe this: a pure-backslash line
  // never contains `':: '` either way, so the divergence is invisible until
  // it feeds into the marker-stripping branch here. Originally verified over
  // a 200k random-string sweep plus every backslash-run-length/strip-mask
  // combination up to length 6 that was never committed (12 edge-case diffs,
  // all here — this codepath was the only one where a difference from the
  // original ever appeared; a same-family `true`-replacement mutant produced
  // zero diffs anywhere, see the ledger below). #3804 — re-verified with a
  // committed, re-runnable harness:
  // `scripts/mutation-harnesses/inline-property-parse-strip-lines.harness.ts`.)
  it('drops the marker on a lone backslash line only when the run truly reaches index 0', () => {
    expect(stripPropertyLines('\\\ncontext:: home', new Set([1]))).toBe('')
  })

  // Ledger — #3804 — line refreshed (was 88, drifted): [ConditionalExpression
  // `i >= 0 → true`], currently inline-property-parse.ts:107 (same site as
  // the control above): equivalent for every input. Dropping the `i>=0`
  // guard entirely relies on JS returning `undefined` for an out-of-range
  // string index rather than throwing; `undefined === '\\'` is `false`, so
  // the loop still stops at exactly the same `i` with the same count `n` as
  // the guarded version — the guard is provably redundant, not merely
  // untested. Originally verified over the same 200k random-string sweep
  // plus every backslash-run/strip-mask edge case above that was never
  // committed (0 diffs from the original in all cases, vs. the `i>0` mutant
  // just above, caught 442/200k times at random and on 12/many edge cases —
  // confirming the harness does detect a real divergence in this same
  // family). #3804 — re-verified with a committed, re-runnable harness:
  // `scripts/mutation-harnesses/inline-property-parse-strip-lines.harness.ts`.
})

describe('buildInlinePropertySetParams', () => {
  it('stores value_text when there is no definition', () => {
    expect(buildInlinePropertySetParams('B', 'status', 'active', null)).toEqual({
      blockId: 'B',
      key: 'status',
      valueText: 'active',
    })
  })

  it('stores value_text for text and select definitions', () => {
    expect(buildInlinePropertySetParams('B', 'k', 'v', def('text'))).toEqual({
      blockId: 'B',
      key: 'k',
      valueText: 'v',
    })
    expect(buildInlinePropertySetParams('B', 'k', 'alpha', def('select', '["alpha"]'))).toEqual({
      blockId: 'B',
      key: 'k',
      valueText: 'alpha',
    })
  })

  it('parses numbers for number definitions and rejects unparseable values', () => {
    expect(buildInlinePropertySetParams('B', 'k', '42.5', def('number'))).toEqual({
      blockId: 'B',
      key: 'k',
      valueNum: 42.5,
    })
    expect(buildInlinePropertySetParams('B', 'k', 'not-a-number', def('number'))).toBeNull()
  })

  it('accepts only the YYYY-MM-DD storage shape for date definitions', () => {
    expect(buildInlinePropertySetParams('B', 'k', '2026-07-17', def('date'))).toEqual({
      blockId: 'B',
      key: 'k',
      valueDate: '2026-07-17',
    })
    // The backend only rejects EMPTY value_date (validate_set_property), so
    // free text must be rejected HERE or a garbage date reaches agenda code.
    expect(buildInlinePropertySetParams('B', 'k', 'tomorrow', def('date'))).toBeNull()
    expect(buildInlinePropertySetParams('B', 'k', '17/07/2026', def('date'))).toBeNull()
  })

  // #3804 — line refreshed (was 213, drifted): [Regex] the pattern is
  // `/^\d{4}-\d{2}-\d{2}$/`, currently inline-property-parse.ts:238 (verify
  // with `grep -n '\\\\d{4}-\\\\d{2}-\\\\d{2}' src/lib/inline-property-parse.ts`) —
  // two distinct anchor-dropping mutants survive independently, so each
  // needs its own input that specifically defeats ONLY that anchor.
  it('rejects a date with leading junk before the YYYY-MM-DD shape (the `^` anchor matters)', () => {
    // Without `^`, `/\d{4}-\d{2}-\d{2}$/` still matches because the string
    // ENDS with a valid date — `^` is what rejects a prefixed value.
    expect(buildInlinePropertySetParams('B', 'k', 'garbage2026-07-17', def('date'))).toBeNull()
  })

  it('rejects a date with trailing junk after the YYYY-MM-DD shape (the `$` anchor matters)', () => {
    // Without `$`, `/^\d{4}-\d{2}-\d{2}/` still matches because the string
    // STARTS with a valid date — `$` is what rejects a suffixed value.
    expect(buildInlinePropertySetParams('B', 'k', '2026-07-17garbage', def('date'))).toBeNull()
  })

  it('accepts only exact true/false for boolean definitions', () => {
    expect(buildInlinePropertySetParams('B', 'k', 'true', def('boolean'))).toEqual({
      blockId: 'B',
      key: 'k',
      valueBool: true,
    })
    expect(buildInlinePropertySetParams('B', 'k', 'false', def('boolean'))).toEqual({
      blockId: 'B',
      key: 'k',
      valueBool: false,
    })
    expect(buildInlinePropertySetParams('B', 'k', 'yes', def('boolean'))).toBeNull()
  })

  it('rejects ref definitions (inline text cannot express a page ref)', () => {
    expect(buildInlinePropertySetParams('B', 'k', 'Some Page', def('ref'))).toBeNull()
  })
})
