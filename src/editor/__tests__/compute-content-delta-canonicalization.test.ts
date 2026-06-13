/**
 * Focused tests for `computeContentDelta` canonicalization (T5 / #1026, #711).
 *
 * `computeContentDelta` compares the new markdown against
 * `serialize(parse(original))` rather than the RAW original, so a zero-edit
 * focus/blur on content the serializer canonicalizes (`3.`→`1.`, `_em_`→`*em*`,
 * underscore escaping, mark-order normalization) is NOT flagged as `changed`.
 * Without that, an idle focus+blur would silently rewrite stored content and
 * pollute the op log / undo history.
 *
 * Existing coverage (use-roving-editor.test.ts) hits the high-level flag, list
 * renumbering, and single emphasis. These add the combinations the review
 * called out: combined marks, underscore-escaping contexts, mixed mark order,
 * a large-doc perf floor, and a generative property check.
 */

import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { parse, serialize } from '../markdown-serializer'
import type { DocNode } from '../types'
import { computeContentDelta } from '../use-roving-editor'

/** No-edit blur: the live doc is exactly `parse(original)`. */
function noEditDelta(original: string) {
  return computeContentDelta(original, parse(original) as DocNode)
}

describe('computeContentDelta — combined formatting is not an edit', () => {
  // Each input canonicalizes (delimiter swap / nesting) but a zero-edit blur
  // must stay `changed:false`; `newMarkdown` is the canonical form.
  it.each([
    ['**bold _italic_**', '**bold *italic***'],
    ['a `code` and **bold**', 'a `code` and **bold**'],
    ['**_combined_**', '***combined***'],
    ['==hl== and ~~strike~~', '==hl== and ~~strike~~'],
  ])('no-edit blur on %j stays unchanged (canonical: %j)', (original, canonical) => {
    const delta = noEditDelta(original)
    expect(delta.changed).toBe(false)
    expect(delta.newMarkdown).toBe(canonical)
    // Sanity: the canonical form is the serializer's own fixed point.
    expect(serialize(parse(original))).toBe(canonical)
  })

  it('a REAL edit inside combined marks IS flagged', () => {
    const original = '**bold _italic_**'
    const delta = computeContentDelta(original, parse('**bold _italics_**') as DocNode)
    expect(delta.changed).toBe(true)
    expect(delta.newMarkdown).toBe('**bold *italics***')
  })
})

describe('computeContentDelta — underscore escaping contexts', () => {
  it('snake_case is NOT treated as emphasis and stays unchanged on a no-edit blur', () => {
    const delta = noEditDelta('a snake_case_word here')
    expect(delta.changed).toBe(false)
    expect(delta.newMarkdown).toBe('a snake_case_word here')
  })

  it('`_em_` canonicalizes to `*em*` but a no-edit blur is unchanged', () => {
    const delta = noEditDelta('some _emphasis_ here')
    expect(delta.changed).toBe(false)
    expect(delta.newMarkdown).toBe('some *emphasis* here')
  })

  it('an escaped underscore round-trips and is unchanged', () => {
    const original = 'escaped \\_underscore\\_'
    const delta = noEditDelta(original)
    expect(delta.changed).toBe(false)
    expect(delta.newMarkdown).toBe(original)
  })
})

describe('computeContentDelta — list canonicalization with marks', () => {
  it('`3. **item**` renumbers to `1. **item**` without being flagged as an edit', () => {
    const delta = noEditDelta('3. **item**')
    expect(delta.changed).toBe(false)
    expect(delta.newMarkdown).toBe('1. **item**')
  })

  it('a real text edit within a renumbered list item IS flagged', () => {
    const delta = computeContentDelta('3. **item**', parse('3. **items**') as DocNode)
    expect(delta.changed).toBe(true)
    expect(delta.newMarkdown).toBe('1. **items**')
  })
})

describe('computeContentDelta — mark-order normalization', () => {
  it('the same marks authored in a different delimiter order canonicalize identically', () => {
    // `_**x**_` and `**_x_**` denote the same bold+italic run; the serializer
    // normalizes both to one canonical nesting, so a no-edit blur on either is
    // not an edit, and a blur whose doc matches the OTHER ordering is likewise
    // not an edit (it's the same document).
    const a = '_**mixed**_'
    const b = '**_mixed_**'
    const canonical = serialize(parse(a))
    expect(serialize(parse(b))).toBe(canonical)

    // Original authored as `a`; the live doc parsed from `b` is structurally
    // identical → not changed.
    const delta = computeContentDelta(a, parse(b) as DocNode)
    expect(delta.changed).toBe(false)
    expect(delta.newMarkdown).toBe(canonical)
  })
})

describe('computeContentDelta — large-doc performance', () => {
  it('handles a 500-block document without an algorithmic blow-up (steady-state median)', () => {
    // 500 ordered-list items, each authored with a non-canonical number so the
    // canonical compare path (serialize(parse(original))) is always exercised.
    const lines: string[] = []
    for (let i = 0; i < 500; i++) {
      lines.push(`${i + 3}. item **${i}** with _emphasis_`)
    }
    const original = lines.join('\n')
    const doc = parse(original) as DocNode

    // It IS a no-edit blur (doc === parse(original)), so unchanged.
    expect(computeContentDelta(original, doc).changed).toBe(false)

    // Warm up to discount one-time JIT/module-init cost (the first call can be
    // ~20x the steady-state cost), then take the MEDIAN of many samples. The
    // median is robust to the descheduling spikes a loaded box produces — under
    // full 16-core CPU saturation individual SAMPLES were seen >100ms while the
    // median stayed ~30ms, so a single hiccup can't flake the run.
    for (let w = 0; w < 3; w++) computeContentDelta(original, doc)
    const samples: number[] = []
    for (let r = 0; r < 15; r++) {
      const start = performance.now()
      computeContentDelta(original, doc)
      samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY

    // This is a REGRESSION ceiling, not a tight perf bound — wall-clock medians
    // are load-sensitive and the test runs alongside the full parallel suite.
    // Measured medians: ~4ms idle/isolated, up to ~32ms under full 16-core CPU
    // saturation, with one observed full-suite run at 54ms (the 50ms ceiling
    // this replaces flaked there). 250ms is ~4.6x over that worst observed
    // loaded median yet still ~8x below the hundreds-of-ms / seconds an actual
    // algorithmic regression (e.g. an accidental O(n²) over the 500 blocks)
    // would produce. So it catches a real blow-up without flaking on a busy CI box.
    expect(median).toBeLessThan(250)
  })
})

describe('computeContentDelta — property: parse(s) is never a phantom edit', () => {
  it('for arbitrary text, a no-edit blur is unchanged and equals serialize(parse(s))', () => {
    // Mirror the markdown-serializer property generators: a small alphabet that
    // includes markdown-significant characters, so we hit escaping/canonical
    // edge cases without generating ambiguous multi-block structures.
    const arbText = fc
      .array(fc.constantFrom(...'abcXY 012*`#[]_~='.split('')), { minLength: 1, maxLength: 12 })
      .map((chars) => chars.join(''))
      // Single-line only: newlines would split into multiple blocks, which is a
      // separate code path (shouldSplitOnBlur), not computeContentDelta's domain.
      .filter((s) => !s.includes('\n'))

    fc.assert(
      fc.property(arbText, (s) => {
        const canonical = serialize(parse(s))
        const delta = computeContentDelta(s, parse(s) as DocNode)
        // A zero-edit blur is never flagged as changed…
        expect(delta.changed).toBe(false)
        // …and reports the canonical serialization.
        expect(delta.newMarkdown).toBe(canonical)
      }),
      { numRuns: 500 },
    )
  })
})
