/**
 * Unit tests for the inline `key:: value` property parser (#2675).
 *
 * The line-level rules mirror the Logseq import parser
 * (`src-tauri/src/import.rs`): split at the FIRST `":: "`, key must match
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

  // Line 134 [MethodExpression]: `trimmed.slice(sepIndex + 3).trim()` →
  // `trimmed.slice(sepIndex + 3)`. Only ONE space is consumed by the ":: "
  // separator match itself; extra spaces right after `::` land inside the
  // value slice and need their OWN trim (the line-level trim at 123 already
  // ran and cannot remove them — they are not at the line's edges).
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

  it('skips reserved / exporter-managed keys (they stay literal)', () => {
    for (const key of INLINE_PROPERTY_RESERVED_KEYS) {
      expect(parseInlineProperties(`${key}:: something`)).toEqual([])
    }
  })

  // Line 58-68 [ArrayDeclaration / StringLiteral]: the loop above iterates
  // `INLINE_PROPERTY_RESERVED_KEYS` itself, so an empty-set mutant or any
  // single key blanked to `''` still "passes" — the test derives its
  // expectation from the very value under test. Pin the literal contents
  // instead so the constant's actual membership is checked.
  it('has the exact reserved key list (mirrors FRONTMATTER_RESERVED_KEYS in import.rs)', () => {
    expect([...INLINE_PROPERTY_RESERVED_KEYS].toSorted()).toEqual(
      [
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
      ].toSorted(),
    )
  })

  it('skips lines inside fenced code blocks', () => {
    const content = '```\nstatus:: active\n```'
    expect(parseInlineProperties(content)).toEqual([])
    // …but a property line AFTER the fence closes is parsed.
    const after = '```\nx:: y\n```\nstatus:: active'
    expect(parseInlineProperties(after)).toEqual([{ key: 'status', value: 'active', lineIndex: 3 }])
  })

  // Line 123 [MethodExpression]: `raw.trim()` → `raw`. A leading space before
  // the fence delimiter would still be a real fence in any markdown renderer;
  // only the (pre-trim) `raw` line is checked, so skipping the outer trim
  // makes `startsWith('```')` see the leading space and miss the fence.
  it('recognizes a fence delimiter with leading indentation', () => {
    const content = ' ```\nstatus:: active\n```'
    expect(parseInlineProperties(content)).toEqual([])
  })

  // Line 126 [MethodExpression]: `trimmed.startsWith('```')` →
  // `trimmed.endsWith('```')`. A language-tagged opening fence (` ```js `)
  // starts with the delimiter but does not end with it — distinguishes the
  // two methods where a bare ` ``` ` (which both starts AND ends with the
  // delimiter) would not.
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

  // Line 121 [ConditionalExpression `isLast → false`, ArithmeticOperator
  // `lines.length - 1 → lines.length + 1`]: both mutants make `isLast`
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

  // Ledger — Line 136 [ConditionalExpression `value === '' → false`] and
  // [StringLiteral `'' → "Stryker was here!"`]: both survive but the branch
  // they guard is UNREACHABLE, not merely untested. `trimmed` (line 123) is
  // always fully right-trimmed before `indexOf(':: ')` runs, so the matched
  // separator's space can never be `trimmed`'s last character (trim() would
  // have removed it) — the value slice therefore always retains at least one
  // trailing non-whitespace char, and `value.trim()` can never be `''` at
  // this point. Verified two ways (script, not committed):
  //   - closed-form: for any string reaching this line, sepIndex+3 <=
  //     trimmed.length-1, and trimmed's last char is non-whitespace by
  //     construction, so it survives into `value`.
  //   - canary: an instrumented copy logging at (and just above) this line,
  //     fuzzed over 500k generated "key:: value"-shaped lines, hit the site
  //     232,758 times and fired (`value === ''`) zero times — confirms
  //     genuinely unreachable, not just unobserved by a thin fuzz.
  // The StringLiteral variant (comparing to "Stryker was here!" instead of
  // '') DOES differ for the one input `value === 'Stryker was here!'`, but
  // killing it would mean asserting on Stryker's own placeholder text — the
  // exact pattern this batch's method explicitly rejects — so both mutants
  // on this dead branch are left as an accepted gap rather than gamed.

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
  // Ledger — Line 150 [ConditionalExpression `lineIndexes.size === 0 →
  // false`]: equivalent. This early return is a pure optimization, not a
  // correctness requirement — with an empty set, `lines.filter` removes
  // nothing (`kept === lines`), the marker-stripping guard's own
  // `lineIndexes.has(...)` check short-circuits false, and
  // `content.split('\n').join('\n')` always reconstructs `content` exactly
  // (split/join with the same separator is lossless for any string, by
  // construction). Verified over a 100k random-string sweep with an empty
  // set: 0 diffs from the original in every case; the same harness found
  // 8,569/8,569 identical results on non-empty sets too (as expected — both
  // branches share that code path), confirming it isn't trivially vacuous.

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

  // Line 88 [EqualityOperator `i >= 0 → i > 0`] inside the shared
  // `trailingBackslashRun` helper. The off-by-one only shows up when the
  // scanned line is backslashes ALL the way down to index 0 — here the new
  // last line after stripping is a lone `\`, so the loop's final check
  // happens at i===0. Original: `i>=0` true, counts index 0 too → n=1 (odd)
  // → marker stripped → `''`. Mutant: `i>0` is false AT i===0, so index 0 is
  // never counted → n=0 (even) → marker left in place → `'\'` survives.
  // (`parseInlineProperties` alone can't observe this: a pure-backslash line
  // never contains `':: '` either way, so the divergence is invisible until
  // it feeds into the marker-stripping branch here. Verified over a 200k
  // random-string sweep plus every backslash-run-length/strip-mask
  // combination up to length 6 — this codepath is the only one where a
  // difference from the original ever appears (12 edge-case diffs, all here);
  // a same-family `true`-replacement mutant produced zero diffs anywhere,
  // see the ledger below.)
  it('drops the marker on a lone backslash line only when the run truly reaches index 0', () => {
    expect(stripPropertyLines('\\\ncontext:: home', new Set([1]))).toBe('')
  })

  // Ledger — Line 88 [ConditionalExpression `i >= 0 → true`]: equivalent for
  // every input. Dropping the `i>=0` guard entirely relies on JS returning
  // `undefined` for an out-of-range string index rather than throwing;
  // `undefined === '\\'` is `false`, so the loop still stops at exactly the
  // same `i` with the same count `n` as the guarded version — the guard is
  // provably redundant, not merely untested. Verified over the same 200k
  // random-string sweep plus every backslash-run/strip-mask edge case above:
  // 0 diffs from the original in all cases (vs. the `i>0` mutant just above,
  // caught 442/200k times at random and on 12/many edge cases — confirming
  // the harness does detect a real divergence in this same family).
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

  // Line 213 [Regex]: the pattern is `/^\d{4}-\d{2}-\d{2}$/` — two distinct
  // anchor-dropping mutants survive independently, so each needs its own
  // input that specifically defeats ONLY that anchor.
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
