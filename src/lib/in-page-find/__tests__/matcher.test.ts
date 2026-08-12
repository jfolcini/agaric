/**
 * Unit tests for the in-page find matcher.
 *
 * Covers:
 *  - Literal scanning with case sensitivity and whole-word toggles.
 *  - Regex compilation, error surfacing, and pattern-length cap.
 *  - Text-node skipping at 10 KB in regex mode.
 *  - Cooperative chunked walker (`runWalker`) — completion path,
 *    progress callback emission, and cancellation.
 *  - Text-node collection ignores `<script>` / `<style>` and respects
 *    `data-find-skip`.
 *
 * Runs under happy-dom — no browser APIs beyond DOM are touched.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CHUNK_SIZE,
  type CompiledQuery,
  collectTextNodes,
  compileQuery,
  type FindMatch,
  REGEX_NODE_MAX,
  REGEX_NODE_SCAN_MAX,
  REGEX_PATTERN_MAX,
  REGEX_TIME_BUDGET_MS,
  runWalker,
  walkSync,
} from '@/lib/in-page-find/matcher'

const defaultOpts = { caseSensitive: false, wholeWord: false, isRegex: false }

function makeHost(html: string): HTMLDivElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.append(host)
  return host
}

let attachedHosts: HTMLElement[] = []
afterEach(() => {
  for (const el of attachedHosts) el.remove()
  attachedHosts = []
  vi.unstubAllGlobals()
})
beforeEach(() => {
  attachedHosts = []
})

function attach(html: string): HTMLDivElement {
  const host = makeHost(html)
  attachedHosts.push(host)
  return host
}

describe('compileQuery', () => {
  it('returns `empty` for an empty string', () => {
    expect(compileQuery('', defaultOpts).kind).toBe('empty')
  })

  it('literal mode is case-insensitive by default', () => {
    const compiled = compileQuery('ALPHA', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    expect(compiled.kind).toBe('literal')
    expect(compiled.matcher('alpha bravo Alpha')).toEqual([
      { start: 0, end: 5 },
      { start: 12, end: 17 },
    ])
  })

  it('literal mode honours caseSensitive', () => {
    const compiled = compileQuery('Alpha', { ...defaultOpts, caseSensitive: true }) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    expect(compiled.matcher('alpha Alpha ALPHA')).toEqual([{ start: 6, end: 11 }])
  })

  it('literal mode surfaces overlapping matches', () => {
    const compiled = compileQuery('aa', defaultOpts) as Extract<CompiledQuery, { kind: 'literal' }>
    // "aaaa" contains 3 overlapping "aa" substrings (indices 0, 1, 2).
    expect(compiled.matcher('aaaa').map((m) => m.start)).toEqual([0, 1, 2])
  })

  it('wholeWord filters partial matches', () => {
    const compiled = compileQuery('cat', { ...defaultOpts, wholeWord: true }) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    // `cat` matches; `catalog` and `bobcat` do not.
    expect(compiled.matcher('cat catalog bobcat cat.')).toEqual([
      { start: 0, end: 3 },
      { start: 19, end: 22 },
    ])
  })

  it('regex compiles with case-insensitive flag by default', () => {
    const compiled = compileQuery('al\\w+', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    expect(compiled.kind).toBe('regex')
    expect(compiled.matcher('alpha ALPHA aleph')).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ])
  })

  it('regex returns `error` with the `invalid` arm + raw compile message on a bad pattern', () => {
    const compiled = compileQuery('[abc', { ...defaultOpts, isRegex: true })
    expect(compiled.kind).toBe('error')
    if (compiled.kind === 'error') {
      expect(compiled.error.kind).toBe('invalid')
      // The `invalid` arm carries the raw `new RegExp(...)` throw message so
      // the toolbar can surface it verbatim; assert it's populated.
      if (compiled.error.kind === 'invalid') {
        expect(compiled.error.message.length).toBeGreaterThan(0)
      }
    }
  })

  it('regex enforces pattern length cap', () => {
    const huge = 'a'.repeat(REGEX_PATTERN_MAX + 1)
    const compiled = compileQuery(huge, { ...defaultOpts, isRegex: true })
    expect(compiled.kind).toBe('error')
    if (compiled.kind === 'error') {
      expect(compiled.error).toEqual({ kind: 'tooLong' })
    }
  })

  it('regex accepts a pattern of exactly REGEX_PATTERN_MAX (cap is exclusive)', () => {
    // Kills matcher.ts:179:9 [EqualityOperator] `>` → `>=`: at exactly the cap
    // the pattern must still compile; only *longer* patterns reject.
    const atCap = 'a'.repeat(REGEX_PATTERN_MAX)
    expect(compileQuery(atCap, { ...defaultOpts, isRegex: true }).kind).toBe('regex')
  })

  it('case-sensitive regex mode keeps the `g` and `u` flags and drops `i`', () => {
    // Kills matcher.ts:188:42 [StringLiteral] `'gu'` → `''`. `\u{41}` is the
    // code-point escape for 'A' and *requires* the `u` flag — without it,
    // `{41}` is read as a decimal quantifier, so the pattern means a literal
    // 'u' repeated 41 times and matches nothing. The two hits also prove `g`
    // is set (the scan loop relies on `lastIndex`), and the untouched
    // lowercase 'a' proves `i` is NOT set.
    const compiled = compileQuery('\\u{41}', {
      ...defaultOpts,
      isRegex: true,
      caseSensitive: true,
    }) as Extract<CompiledQuery, { kind: 'regex' }>
    expect(compiled.matcher('A a A')).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
    ])
  })

  it('regex zero-width matches are dropped, not emitted (exact output)', () => {
    const compiled = compileQuery('a*', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    // `a*` is greedy: on `aaa` the FIRST exec consumes the whole run as one
    // non-empty match {0,3}; the next exec (lastIndex=3, end of string) is a
    // zero-width match that the scanner must DROP and advance past, not emit.
    // The exact set is therefore a single {0,3} span — assert it precisely so
    // the regression is actually caught: if zero-width matches were emitted the
    // set would contain extra {3,3}/{4,…} spans, and if the lastIndex bump were
    // dropped the scan would loop forever (test would hang) instead of passing.
    expect(compiled.matcher('aaa')).toEqual([{ start: 0, end: 3 }])

    // And a leading zero-width hit must not bleed into a phantom match: `a*`
    // at offset 0 of `baaab` matches the empty string before `b` (must be
    // dropped), then the real run `aaa` at {1,4}. Exactly one non-empty span.
    expect(compiled.matcher('baaab')).toEqual([{ start: 1, end: 4 }])
  })
})

describe('compileQuery — Unicode correctness (#756)', () => {
  // Every İ-based test below assumes the runtime's default locale folds
  // U+0130 to two units. That is NOT universal: under tr/az it folds to a
  // single 'i', and these tests would fail or — worse — pass while exercising
  // a different code path. Assert it once here so the cause is named rather
  // than debugged. The underlying production dependence on the ambient locale
  // is #3800; when that is fixed to use toLowerCase(), this guard can go.
  beforeAll(() => {
    expect(
      'İ'.toLocaleLowerCase(),
      'default locale does not fold U+0130 to two units (tr/az?) — see #3800',
    ).toHaveLength(2)
  })

  it('literal offsets stay aligned after a length-changing case fold (İ)', () => {
    const compiled = compileQuery('bravo', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    // 'İ' (U+0130) lowercases to 'i' + U+0307 — two code units. Computing
    // indexOf offsets on the folded haystack used to shift every later
    // span by +1 per preceding 'İ' ("bravo" starts at 9 in the original
    // but at 10 in the folded string).
    expect(compiled.matcher('İstanbul bravo')).toEqual([{ start: 9, end: 14 }])
  })

  it('literal span covers the fold-expanding character itself', () => {
    // Needle typed with an explicit combining dot — folds identically to
    // the single-code-unit 'İ'. The original span is 8 units, not 9.
    const compiled = compileQuery('i̇stanbul', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    expect(compiled.matcher('İstanbul')).toEqual([{ start: 0, end: 8 }])
  })

  it('case-sensitive literal mode is unaffected by fold expansion', () => {
    const compiled = compileQuery('bravo', { ...defaultOpts, caseSensitive: true }) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    expect(compiled.matcher('İstanbul bravo')).toEqual([{ start: 9, end: 14 }])
  })

  it('wholeWord treats non-Latin letters as word characters', () => {
    const compiled = compileQuery('мир', { ...defaultOpts, wholeWord: true }) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    // ASCII-only \w used to treat every Cyrillic letter as a boundary,
    // so "мир" also matched inside "мирный".
    expect(compiled.matcher('мир мирный')).toEqual([{ start: 0, end: 3 }])
  })

  it('wholeWord classifies astral-plane letters whole (surrogate pairs)', () => {
    const compiled = compileQuery('x', { ...defaultOpts, wholeWord: true }) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    // '𝐀' (U+1D400, MATHEMATICAL BOLD CAPITAL A) is a letter; an 'x'
    // glued to either side of it is not a whole word. Code-unit indexing
    // saw only an unpaired surrogate half and called it a boundary.
    expect(compiled.matcher('𝐀x y x')).toEqual([{ start: 6, end: 7 }])
    expect(compiled.matcher('x𝐀 x')).toEqual([{ start: 4, end: 5 }])
  })

  it('length-preserving folds use whole-string folding, not per-code-point folding', () => {
    // Kills matcher.ts:231:7 [ConditionalExpression → false] and 231:40
    // [BlockStatement → {}], i.e. "always take the slow per-code-point path".
    // Greek final sigma is the discriminator: `'ΑΣ'.toLocaleLowerCase()` is
    // 'ας' (context-sensitive ς), while folding code point by code point
    // yields 'ασ'. Both are 2 units long, so the fast path is the one that
    // must run — and a query must always find itself.
    const compiled = compileQuery('ΑΣ', defaultOpts) as Extract<CompiledQuery, { kind: 'literal' }>
    expect(compiled.matcher('ΑΣ')).toEqual([{ start: 0, end: 2 }])
  })

  it('wholeWord filters partial matches on the length-changing fold path', () => {
    // Kills the whole-word arm of matcher.ts:301 (the folded-path emit guard):
    // 301:9 [ConditionalExpression → true], 301:9 [LogicalOperator `&&` → `||`],
    // 301:54 [ConditionalExpression → true], 301:54 [BooleanLiteral `!wholeWord`
    // → `wholeWord`] and 301:54 [LogicalOperator `||` → `&&`]. The leading 'İ'
    // (U+0130 → 'i' + U+0307) forces the slow folded path, which had no
    // wholeWord coverage at all: mutants that ignore the filter emit the
    // 'bravo' inside 'bravocado' too, and the `&&` mutant emits nothing.
    // Precondition, not decoration: `toLocaleLowerCase()` is locale-sensitive
    // and under a tr/az default locale 'İ' folds to a single 'i', which is
    // length-preserving — the fast path would run, the assertion below would
    // still pass, and this test would silently stop covering anything. Fail
    // loudly instead.
    expect('İ'.toLocaleLowerCase()).toHaveLength(2)
    const compiled = compileQuery('bravo', { ...defaultOpts, wholeWord: true }) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    expect(compiled.matcher('İstanbul bravo bravocado')).toEqual([{ start: 9, end: 14 }])
  })

  it('wholeWord regex post-filter uses the same Unicode word classes', () => {
    const compiled = compileQuery('мир', {
      ...defaultOpts,
      wholeWord: true,
      isRegex: true,
    }) as Extract<CompiledQuery, { kind: 'regex' }>
    expect(compiled.matcher('мир мирный')).toEqual([{ start: 0, end: 3 }])
  })
})

/**
 * `codePointBefore` steps back over a *complete* surrogate pair before
 * classifying the character preceding a match. Every branch of that step-back
 * is only observable through `wholeWord`, and only with strings that mix
 * paired and UNPAIRED surrogates — DOM text is UTF-16 and is not validated, so
 * a `Text` node can legitimately hold a lone surrogate (e.g. a string sliced
 * mid-pair upstream). Each test below is built so the two candidate "character
 * before the match" readings differ in word-ness, which flips the whole-word
 * verdict and is therefore observable in the emitted spans.
 */
describe('compileQuery — surrogate-aware word boundaries', () => {
  function wholeWordLiteral(query: string) {
    return compileQuery(query, { ...defaultOpts, wholeWord: true }) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
  }

  it('reads the immediately preceding unit when it is not a low surrogate', () => {
    // Kills matcher.ts:361:7 [ConditionalExpression → true], 361:7
    // [LogicalOperator `(low>=0xdc00 && low<=0xdfff) && index>=2` → `|| index>=2`],
    // 361:7-37 [ConditionalExpression → true], 361:7-37 [LogicalOperator `&&` →
    // `||`] and 361:7-20 [ConditionalExpression → true] — every mutant that
    // lets the step-back run when the preceding unit is NOT a trailing
    // surrogate. Here 'bc' is preceded by the letter 'a', so it is not a whole
    // word; the mutants instead read the lone LEAD surrogate at index 0 (not a
    // word character) and wrongly emit the match.
    expect(wholeWordLiteral('bc').matcher('\uD800abc')).toEqual([])
  })

  it('does not step back for a preceding BMP character above U+DFFF', () => {
    // Kills matcher.ts:361:24 [ConditionalExpression `low <= 0xdfff` → true].
    // U+FF41 (fullwidth 'a') is ≥ 0xdc00 but > 0xdfff, so it is NOT a trailing
    // surrogate and must be classified as itself — a letter, so 'bc' is not a
    // whole word. The mutant steps back to the lone lead surrogate at index 0
    // and emits.
    expect(wholeWordLiteral('bc').matcher('\uD800ａbc')).toEqual([])
  })

  it('steps back over a pair whose trailing unit is exactly U+DFFF', () => {
    // Kills matcher.ts:361:24 [EqualityOperator `low <= 0xdfff` → `<`]. U+1D7FF
    // (MATHEMATICAL MONOSPACE DIGIT NINE) encodes as U+D835 U+DFFF — the trail
    // unit sits exactly on the inclusive bound. It is a \p{N} word character,
    // so 'abc' is not a whole word; the mutant excludes 0xdfff, reads the bare
    // trail surrogate (not a word character) and emits.
    expect(wholeWordLiteral('abc').matcher('\u{1D7FF}abc')).toEqual([])
  })

  it('keeps the trailing surrogate when the unit before it is not a lead', () => {
    // Kills matcher.ts:363:9 [ConditionalExpression → true], 363:9
    // [LogicalOperator `high>=0xd800 && high<=0xdbff` → `||`], 363:9-23
    // [ConditionalExpression → true] and 363:27 [ConditionalExpression
    // `high <= 0xdbff` → true]. In both fixtures the unit at index 1 is an
    // UNPAIRED trail surrogate (not a word character), so 'xyz' IS a whole
    // word. The mutants complete a pair that does not exist and classify
    // index 0 instead — 'a' and fullwidth 'a' are both letters, so they drop
    // the match. The two fixtures separate the lower bound (0x61 < 0xd800)
    // from the upper bound (0xff41 > 0xdbff).
    expect(wholeWordLiteral('xyz').matcher('a\uDC00xyz')).toEqual([{ start: 2, end: 5 }])
    expect(wholeWordLiteral('xyz').matcher('ａ\uDC00xyz')).toEqual([{ start: 2, end: 5 }])
  })

  it('steps back over a pair whose leading unit is exactly U+D800', () => {
    // Kills matcher.ts:363:9-23 [EqualityOperator `high >= 0xd800` → `>`] and
    // 363:67 [ArithmeticOperator `index - 2` → `index + 2`]. U+10000 (LINEAR B
    // SYLLABLE B008 A) encodes as U+D800 U+DC00 — the lead unit sits exactly on
    // the inclusive bound — and is a \p{L} letter, so 'ab' is not a whole word.
    // The `>` mutant reads the bare trail surrogate; the `index + 2` mutant
    // reads past the end of the string (undefined). Neither is a word
    // character, so both wrongly emit.
    expect(wholeWordLiteral('ab').matcher('\u{10000}ab')).toEqual([])
  })
})

describe('walkSync', () => {
  it('collects matches across multiple text nodes', () => {
    const host = attach('<p>alpha bravo</p><p>charlie alpha delta</p>')
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('alpha', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    const result = walkSync(nodes, compiled)
    expect(result.matches).toHaveLength(2)
    expect(result.matches[0]?.node.nodeValue).toBe('alpha bravo')
    expect(result.matches[1]?.node.nodeValue).toBe('charlie alpha delta')
  })

  it('matches do not span block boundaries', () => {
    // Locked-in edge case from the plan — same as VSCode.
    const host = attach('<p>end of paragraph 1</p><p>start of paragraph 2</p>')
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('paragraph 1 start', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    expect(walkSync(nodes, compiled).matches).toHaveLength(0)
  })

  it('skips >10 KB text nodes in regex mode and counts them', () => {
    const host = attach('<p></p><p>short</p>')
    const longText = 'x'.repeat(REGEX_NODE_MAX + 1)
    // Mutate the first paragraph's text node directly to bypass innerHTML
    // limits on large strings; happy-dom handles long Text values.
    const p = host.querySelector('p')
    p?.append(document.createTextNode(longText))

    const nodes = collectTextNodes(host)
    const compiled = compileQuery('x', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    const result = walkSync(nodes, compiled)
    expect(result.skippedLongNodes).toBe(1)
    // The "short" node carries no `x`, so no matches collected.
    expect(result.matches).toHaveLength(0)
  })

  it('literal mode scans text nodes longer than REGEX_NODE_MAX', () => {
    // Kills matcher.ts:452:9 [ConditionalExpression `compiled.kind === 'regex'`
    // → true]: the long-node cap is a regex-only guard (literal scanning is
    // linear), so a literal walk must still find a match past the cap.
    const host = attach('<p></p>')
    host
      .querySelector('p')
      ?.append(document.createTextNode(`${'x'.repeat(REGEX_NODE_MAX + 1)}needle`))
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('needle', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    const result = walkSync(nodes, compiled)
    expect(result.skippedLongNodes).toBe(0)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.start).toBe(REGEX_NODE_MAX + 1)
  })

  it('regex mode scans a node of exactly REGEX_NODE_MAX (the cap is exclusive)', () => {
    // Kills matcher.ts:452:38 [EqualityOperator `>` → `>=`]: a node sitting
    // exactly on the cap is scanned, not skipped.
    const host = attach('<p></p>')
    const text = `zz${'x'.repeat(REGEX_NODE_MAX - 2)}`
    host.querySelector('p')?.append(document.createTextNode(text))
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('zz', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    const result = walkSync(nodes, compiled)
    expect(result.skippedLongNodes).toBe(0)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.end).toBe(2)
  })
})

describe('regex ReDoS / catastrophic-backtracking guard (#2030)', () => {
  // CRITICAL: a JS regex engine cannot be interrupted mid-`exec`. A
  // wall-clock check *between* nodes does NOT stop a single catastrophic
  // `exec` on one large node. So these tests must NEVER hand a real
  // pathological pattern a large enough input to actually hang — doing so
  // would freeze CI. Two independent guards are exercised here:
  //
  //   (a) per-node input cap (REGEX_NODE_SCAN_MAX) — bounds a single exec
  //       by slicing the node text before it ever reaches the engine, and
  //   (b) an aggregate wall-clock budget (REGEX_TIME_BUDGET_MS) checked at
  //       node boundaries to abort a long scan across many nodes.
  //
  // The budget tests below use an INJECTED clock so they are deterministic
  // and run exactly one (cheap, capped) exec — no test relies on a real
  // exponential exec completing.
  const EVIL_PATTERN = '(a+)+$'

  function makeNodes(text: string, count: number): Text[] {
    const host = attach('<p></p>')
    const p = host.querySelector('p')
    const nodes: Text[] = []
    for (let i = 0; i < count; i++) {
      const t = document.createTextNode(text)
      p?.append(t)
      nodes.push(t)
    }
    return nodes
  }

  it('caps per-node regex input at REGEX_NODE_SCAN_MAX so a single exec is bounded', () => {
    // A node well under REGEX_NODE_MAX (so it is NOT skipped) but longer
    // than REGEX_NODE_SCAN_MAX. Pattern `xyz$` would match only the tail
    // beyond the cap — proving the engine never saw past the cap. This runs
    // instantly because the slice handed to exec is bounded and `a*` is
    // linear, so the test can use a real (non-pathological) regex safely.
    const text = `${'a'.repeat(REGEX_NODE_SCAN_MAX + 500)}xyz`
    expect(text.length).toBeLessThan(REGEX_NODE_MAX) // not skipped as "long node"
    const nodes = makeNodes(text, 1)
    const compiled = compileQuery('xyz$', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    const result = walkSync(nodes, compiled)
    // The "xyz" lives beyond REGEX_NODE_SCAN_MAX, so the capped scan can't
    // see it: zero matches, and crucially the node was NOT skipped.
    expect(result.matches).toHaveLength(0)
    expect(result.skippedLongNodes).toBe(0)
    expect(result.timedOut).toBeFalsy()
  })

  it('matches within the scanned slice but not beyond the per-node cap', () => {
    const text = `${'before '.padEnd(10, ' ')}target${'z'.repeat(REGEX_NODE_SCAN_MAX)}target`
    const nodes = makeNodes(text, 1)
    const compiled = compileQuery('target', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    const result = walkSync(nodes, compiled)
    // First "target" is inside the slice; the second is pushed past the cap.
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.start).toBe(text.indexOf('target'))
  })

  it('aborts and flags timedOut when the regex scan exceeds the time budget', () => {
    // Deterministic via an injected clock: only one (capped, cheap) exec
    // runs before the budget trips at the next node boundary.
    const nodes = makeNodes(`${'a'.repeat(20)}!`, 5)
    const compiled = compileQuery(EVIL_PATTERN, { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >

    // `walkSync` calls now() once for `startedAt`, then once per node at the
    // boundary check. Calls 1 (start) and 2 (node 0) read 0 → under budget,
    // so node 0 runs; call 3 (node 1) reads past the budget → abort.
    let ticks = 0
    const now = () => {
      ticks += 1
      return ticks <= 2 ? 0 : REGEX_TIME_BUDGET_MS + 1
    }

    const result = walkSync(nodes, compiled, { timeBudgetMs: REGEX_TIME_BUDGET_MS, now })
    expect(result.timedOut).toBe(true)
    // Aborted at node 1, so only node 0's match (if any) was collected.
    expect(result.matches.length).toBeLessThan(5)
  })

  it('does not flag timedOut for a well-behaved regex within budget', () => {
    const host = attach('<p>alpha</p><p>beta</p>')
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('alpha|beta', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    const result = walkSync(nodes, compiled)
    expect(result.timedOut).toBeFalsy()
    expect(result.matches).toHaveLength(2)
  })

  it('returns within a bounded time on a real pathological pattern (no hang)', () => {
    // No fake clock, REAL `(a+)+$` backtracking — but each node is only 20
    // chars of 'a', a few ms per exec, and the per-node cap guarantees no
    // single exec ever sees more than REGEX_NODE_SCAN_MAX chars. With a tiny
    // budget the walk aborts almost immediately. This proves the guard caps
    // wall-clock time WITHOUT ever running an unbounded exec.
    const nodes = makeNodes(`${'a'.repeat(20)}!`, 50)
    const compiled = compileQuery(EVIL_PATTERN, { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >

    // `timedOut` deterministically proves the guard fired and aborted the walk
    // at a node boundary rather than scanning all 50 nodes — that IS the
    // "no hang" guarantee. A raw `Date.now()` wall-clock ceiling was removed
    // here: it could not distinguish a guarded run (~few ms) from an unguarded
    // one (~hundreds of ms) — only this assertion does — so its lone failure
    // mode was a >1 s stall on a loaded CI runner (a flake with no diagnostic
    // value). A genuine hang is still caught by the ambient test timeout.
    const result = walkSync(nodes, compiled, { timeBudgetMs: 1 })

    expect(result.timedOut).toBe(true)
  })

  it('literal mode never consults the clock or the budget', () => {
    // Kills matcher.ts:440:21 [ConditionalExpression `compiled.kind === 'regex'`
    // → true]. The budget exists only because `re.exec` cannot be interrupted;
    // literal scanning is linear, so `now()` must not be called at all — and a
    // clock that races past a zero budget must not abort the walk.
    const nodes = makeNodes('alpha', 4)
    const compiled = compileQuery('alpha', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    let clockCalls = 0
    const now = () => {
      clockCalls += 1
      return clockCalls * 1000
    }

    const result = walkSync(nodes, compiled, { timeBudgetMs: 0, now })

    expect(clockCalls).toBe(0)
    expect(result.timedOut).toBeFalsy()
    expect(result.matches).toHaveLength(4)
  })

  it('falls back to REGEX_TIME_BUDGET_MS when the caller passes no budget', () => {
    // Kills matcher.ts:442:18 [LogicalOperator `??` → `&&`]: with `&&` an
    // absent `timeBudgetMs` yields `undefined`, every `elapsed > undefined`
    // comparison is false and the guard silently never fires.
    const nodes = makeNodes(`${'a'.repeat(20)}!`, 5)
    const compiled = compileQuery(EVIL_PATTERN, { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    let ticks = 0
    const now = () => {
      ticks += 1
      return ticks <= 2 ? 0 : REGEX_TIME_BUDGET_MS + 1
    }

    const result = walkSync(nodes, compiled, { now })

    expect(result.timedOut).toBe(true)
    expect(result.matches.length).toBeLessThan(5)
  })

  it('does not abort when the elapsed time exactly equals the budget', () => {
    // Kills matcher.ts:448:22 [EqualityOperator `>` → `>=`]. The clock reads
    // exactly `startedAt + budget` at every node boundary: strictly-greater
    // never trips, so the whole walk completes.
    const nodes = makeNodes('alpha', 4)
    const compiled = compileQuery('alpha', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    let calls = 0
    const now = () => {
      calls += 1
      return calls === 1 ? 0 : 10
    }

    const result = walkSync(nodes, compiled, { timeBudgetMs: 10, now })

    expect(result.timedOut).toBeFalsy()
    expect(result.matches).toHaveLength(4)
  })
})

describe('collectTextNodes', () => {
  it('ignores script and style elements', () => {
    const host = attach('<p>visible</p><script>hidden</script><style>.x{}</style>')
    expect(collectTextNodes(host).map((n) => n.nodeValue)).toEqual(['visible'])
  })

  it('honours data-find-skip', () => {
    const host = attach('<p>visible</p><div data-find-skip><p>hidden</p></div>')
    expect(collectTextNodes(host).map((n) => n.nodeValue)).toEqual(['visible'])
  })

  it('skips an element that holds no text nodes at all', () => {
    // NB this fixture does NOT reach the zero-length-text filter: `<p></p>` has
    // no child nodes, so the TreeWalker is never offered anything to reject.
    // (It was named 'skips empty text nodes' and believed to cover
    // matcher.ts:396 — it never did. The test below is the one that does.)
    const host = attach('<p></p><p>visible</p>')
    expect(collectTextNodes(host).map((n) => n.nodeValue)).toEqual(['visible'])
  })

  it('rejects a zero-length text node that actually exists in the tree', () => {
    // Kills matcher.ts:396:11 [ConditionalExpression → false], 396:11
    // [LogicalOperator `||` → `&&`] and 396:24 [ConditionalExpression
    // `v.length === 0` → false]. `<p></p>` above has NO child nodes at all, so
    // it never exercises the filter; an explicitly created empty `Text` does.
    const host = attach('<p>visible</p><p></p>')
    const emptyParent = host.querySelectorAll('p')[1]
    emptyParent?.append(document.createTextNode(''))
    // Guard against this test going vacuous the way its predecessor did: the
    // zero-length `Text` must really be in the tree for the filter to see it.
    expect(emptyParent?.childNodes).toHaveLength(1)
    expect(collectTextNodes(host).map((n) => n.nodeValue)).toEqual(['visible'])
  })

  it('ignores text parented by a TEMPLATE element', () => {
    // Kills matcher.ts:390:50 [ConditionalExpression `tag === 'TEMPLATE'` →
    // false] and 390:58 [StringLiteral `'TEMPLATE'` → ''].
    //
    // Fixture note: the production filter inspects nothing but `parent.tagName`,
    // and the natural fixture is unbuildable under happy-dom. Per the DOM spec
    // `HTMLTemplateElement` does not override the mutation methods — only the
    // HTML *parser* diverts markup into `template.content` — so in a real
    // browser a template populated through `appendChild` (what React does for
    // `<template>{text}</template>`) keeps that text as a DIRECT CHILD that the
    // TreeWalker walks. That is where this filter earns its keep. happy-dom
    // diverts the `appendChild` path into `.content` as well (pinned by the
    // deviation tripwire test below), so a foreign-namespace element named
    // TEMPLATE is the only way to present the walker with the tagName the
    // filter is written against.
    const host = attach('<p>visible</p>')
    const tpl = document.createElementNS('http://www.w3.org/2000/svg', 'TEMPLATE')
    tpl.append(document.createTextNode('hidden'))
    host.append(tpl)
    expect(tpl.tagName).toBe('TEMPLATE')
    expect(collectTextNodes(host).map((n) => n.nodeValue)).toEqual(['visible'])
  })

  it.fails('ENVIRONMENT TRIPWIRE (happy-dom bug, not production): appendChild into a <template> is diverted into .content', () => {
    // This test asserts the SPEC-CORRECT behaviour of appendChild into a
    // <template>, wrapped in `it.fails` — it exists only so the workaround
    // in the test above is retired once it is no longer needed; it makes no
    // claim about production.
    //
    // Spec: only the HTML parser redirects into `template.content`; DOM
    // insertion keeps the node as a direct child. A real browser therefore
    // reports `tpl.childNodes.length === 1` and `tpl.content.childNodes.length
    // === 0`. happy-dom (20.11.1) reports the reverse, so the spec-correct
    // assertions below currently fail — which `it.fails` turns into a green
    // run — and the failure is what documents the deviation.
    //
    // WHEN THIS TEST FAILS (vitest reports "expected test to fail but it
    // passed"), happy-dom has been fixed. That is NOT a regression: delete
    // the `it.fails` wrapper (and this comment) and rewrite 'ignores text
    // parented by a TEMPLATE element' to use a real `<template>` plus
    // `appendChild`, dropping the SVG-namespace fixture.
    const tpl = document.createElement('template')
    tpl.append(document.createTextNode('hidden'))
    expect(tpl.childNodes).toHaveLength(1) // spec; happy-dom (bug): 0
    expect(tpl.content.childNodes).toHaveLength(0) // spec; happy-dom (bug): 1

    // The *parser* path, by contrast, is spec-conformant in happy-dom, so
    // asserting it would prove nothing about the deviation — which is why it
    // is not part of the tripwire assertions above.
    const parsed = attach('<template>diverted</template>')
    expect(collectTextNodes(parsed)).toHaveLength(0)
  })
})

describe('runWalker', () => {
  it('emits onComplete with the full result for small docs', async () => {
    const host = attach('<p>alpha bravo</p><p>charlie alpha</p>')
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('alpha', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    const result = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(nodes, compiled, { onComplete: resolve })
    })
    expect(result.matches).toHaveLength(2)
  })

  it('chunks long docs and fires onProgress between chunks', async () => {
    // Build CHUNK_SIZE + 5 paragraphs each holding a match.
    const paragraphs = Array(CHUNK_SIZE + 5)
      .fill(null)
      .map(() => '<p>alpha</p>')
      .join('')
    const host = attach(paragraphs)
    const nodes = collectTextNodes(host)
    expect(nodes.length).toBeGreaterThan(CHUNK_SIZE)

    const compiled = compileQuery('alpha', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    let progressCalls = 0
    const final = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(nodes, compiled, {
        onProgress: () => {
          progressCalls += 1
        },
        onComplete: resolve,
      })
    })
    expect(final.matches.length).toBe(nodes.length)
    expect(progressCalls).toBeGreaterThanOrEqual(1)
  })

  it('aborts an in-flight chunk on the ReDoS time budget and flags timedOut (#2030)', async () => {
    // A chunk full of pathological nodes would freeze the UI thread without
    // the guard. We prove the abort fires deterministically via an INJECTED
    // clock that trips the budget at the second node boundary — exactly one
    // (capped, cheap) exec runs, so the test never relies on a real
    // exponential exec completing and can never hang CI.
    const host = attach('<p></p>')
    const p = host.querySelector('p')
    const evil: Text[] = []
    for (let i = 0; i < 30; i++) {
      const t = document.createTextNode(`${'a'.repeat(20)}!`)
      p?.append(t)
      evil.push(t)
    }
    const compiled = compileQuery('(a+)+$', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >

    // First chunk: now() reads 0 for startedAt and node 0's check, then jumps
    // past the budget for node 1's check → abort with timedOut.
    let ticks = 0
    const now = () => {
      ticks += 1
      return ticks <= 2 ? 0 : REGEX_TIME_BUDGET_MS + 1
    }

    const final = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(
        evil,
        compiled,
        { onComplete: resolve },
        { timeBudgetMs: REGEX_TIME_BUDGET_MS, now },
      )
    })

    expect(final.timedOut).toBe(true)
    expect(final.matches.length).toBeLessThan(evil.length)
  })

  it('cancellation aborts the walk', async () => {
    const paragraphs = Array(CHUNK_SIZE * 4)
      .fill(null)
      .map(() => '<p>alpha</p>')
      .join('')
    const host = attach(paragraphs)
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('alpha', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >

    let completed = false
    const handle = runWalker(nodes, compiled, {
      onComplete: () => {
        completed = true
      },
    })
    handle.cancel()
    // Give the scheduler enough idle ticks to drain.
    await new Promise((r) => setTimeout(r, 20))
    expect(completed).toBe(false)
  })

  function longNodeHost(text: string): Text[] {
    const host = attach('<p></p>')
    host.querySelector('p')?.append(document.createTextNode(text))
    return collectTextNodes(host)
  }

  it('completes a regex walk inside the budget and emits full match objects', async () => {
    // Kills five mutants at once, all of which turn a healthy regex walk into
    // something else:
    //  - 526:24 [ConditionalExpression → true], 526:24 [EqualityOperator `>` →
    //    `<=`] and 526:24 [ArithmeticOperator `now() - startedAt` → `+`, whose
    //    epoch-scale sum always exceeds the budget] → the walk aborts on the
    //    first node with `timedOut`.
    //  - 503:15 [LogicalOperator `??` → `&&`] → `now` becomes `undefined` and
    //    `now()` throws, so `onComplete` never fires.
    //  - 534:40 [ConditionalExpression → true], 534:40 [EqualityOperator `>` →
    //    `<=`] and 534:11 [LogicalOperator `&&` → `||`] → every node is
    //    counted as an over-long node and skipped.
    //  - 540:22 [ObjectLiteral → {}] → the emitted matches lose node/offsets.
    // No `options` are passed, so the real `Date.now` and the real default
    // budget are exercised.
    const host = attach('<p>alpha</p><p>beta</p>')
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('alpha|beta', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    const result = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(nodes, compiled, { onComplete: resolve })
    })
    expect(result.timedOut).toBeFalsy()
    expect(result.skippedLongNodes).toBe(0)
    expect(result.matches).toHaveLength(2)
    expect(result.matches[0]?.node).toBe(nodes[0])
    expect(result.matches[0]?.start).toBe(0)
    expect(result.matches[0]?.end).toBe(5)
    expect(result.matches[1]?.node).toBe(nodes[1])
    expect(result.matches[1]?.end).toBe(4)
  })

  it('literal mode never consults the clock or the budget', async () => {
    // Kills matcher.ts:502:21 [ConditionalExpression `compiled.kind === 'regex'`
    // → true] — the walker's copy of the same regex-only guard as walkSync.
    const host = attach('<p>alpha</p><p>alpha</p>')
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('alpha', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    let clockCalls = 0
    const now = () => {
      clockCalls += 1
      return clockCalls * 1000
    }
    const result = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(nodes, compiled, { onComplete: resolve }, { timeBudgetMs: 0, now })
    })
    expect(clockCalls).toBe(0)
    expect(result.timedOut).toBeFalsy()
    expect(result.matches).toHaveLength(2)
  })

  it('falls back to REGEX_TIME_BUDGET_MS when the caller passes no budget', async () => {
    // Kills matcher.ts:504:18 [LogicalOperator `??` → `&&`] (budget becomes
    // `undefined`, so no comparison ever trips) and, again, 503:15
    // [LogicalOperator `??` → `&&`] (an injected clock is present, so the
    // mutant swaps in the real `Date.now` and the abort never happens).
    const host = attach('<p>aaaa!</p><p>aaaa!</p><p>aaaa!</p>')
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('(a+)+$', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    let ticks = 0
    const now = () => {
      ticks += 1
      return ticks <= 2 ? 0 : REGEX_TIME_BUDGET_MS + 1
    }
    const result = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(nodes, compiled, { onComplete: resolve }, { now })
    })
    expect(result.timedOut).toBe(true)
    expect(result.matches.length).toBeLessThan(3)
  })

  it('does not abort when the elapsed time exactly equals the budget', async () => {
    // Kills matcher.ts:526:24 [EqualityOperator `>` → `>=`]. The clock reads
    // exactly `startedAt + budget` at every node boundary.
    const host = attach('<p>alpha</p><p>alpha</p><p>alpha</p>')
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('alpha', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    let calls = 0
    const now = () => {
      calls += 1
      return calls === 1 ? 0 : 10
    }
    const result = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(nodes, compiled, { onComplete: resolve }, { timeBudgetMs: 10, now })
    })
    expect(result.timedOut).toBeFalsy()
    expect(result.matches).toHaveLength(3)
  })

  it('regex mode skips and counts a node longer than REGEX_NODE_MAX', async () => {
    // Kills matcher.ts:534:11 [ConditionalExpression → false], 534:11
    // [EqualityOperator `===` → `!==`], 534:29 [StringLiteral `'regex'` → ''],
    // 534:70 [BlockStatement → {}] and 535:9 [AssignmentOperator `+=` → `-=`].
    const nodes = longNodeHost('x'.repeat(REGEX_NODE_MAX + 1))
    const compiled = compileQuery('x', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    const result = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(nodes, compiled, { onComplete: resolve })
    })
    expect(result.skippedLongNodes).toBe(1)
    expect(result.matches).toHaveLength(0)
  })

  it('literal mode scans text nodes longer than REGEX_NODE_MAX', async () => {
    // Kills matcher.ts:534:11 [ConditionalExpression `compiled.kind === 'regex'`
    // → true] and, from the other side, 534:11 [EqualityOperator `===` → `!==`].
    const nodes = longNodeHost(`${'x'.repeat(REGEX_NODE_MAX + 1)}needle`)
    const compiled = compileQuery('needle', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    const result = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(nodes, compiled, { onComplete: resolve })
    })
    expect(result.skippedLongNodes).toBe(0)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.start).toBe(REGEX_NODE_MAX + 1)
  })

  it('regex mode scans a node of exactly REGEX_NODE_MAX (the cap is exclusive)', async () => {
    // Kills matcher.ts:534:40 [EqualityOperator `>` → `>=`].
    const nodes = longNodeHost(`zz${'x'.repeat(REGEX_NODE_MAX - 2)}`)
    const compiled = compileQuery('zz', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    const result = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(nodes, compiled, { onComplete: resolve })
    })
    expect(result.skippedLongNodes).toBe(0)
    expect(result.matches).toHaveLength(1)
  })

  it('chunks a long doc when the caller supplies no onProgress callback', async () => {
    // Kills matcher.ts:548:5 [OptionalChaining `?.` → `.`]: `onProgress` is
    // optional, and a multi-chunk walk without one must still complete instead
    // of throwing "onProgress is not a function" inside the scheduled step.
    const host = attach(
      Array(CHUNK_SIZE + 5)
        .fill(null)
        .map(() => '<p>alpha</p>')
        .join(''),
    )
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('alpha', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    const result = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(nodes, compiled, { onComplete: resolve })
    })
    expect(result.matches).toHaveLength(nodes.length)
  })

  it('hands onProgress a populated, frozen-in-time snapshot of the running totals', async () => {
    // Kills matcher.ts:548:28 [ObjectLiteral → {}] (the payload carries the
    // running totals, not an empty object) and 548:39 [MethodExpression
    // `matches.slice()` → `matches`] (the payload must be a COPY: the mutant
    // hands out the live array, which keeps growing behind the caller's back
    // and would already hold every match by the time the walk finishes).
    const host = attach(
      Array(CHUNK_SIZE * 2 + 5)
        .fill(null)
        .map(() => '<p>alpha</p>')
        .join(''),
    )
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('alpha', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    const snapshots: Array<{ arr: FindMatch[]; lenAtCall: number; skipped: number }> = []
    const final = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(nodes, compiled, {
        onProgress: (partial) => {
          snapshots.push({
            arr: partial.matches,
            lenAtCall: partial.matches.length,
            skipped: partial.skippedLongNodes,
          })
        },
        onComplete: resolve,
      })
    })
    expect(snapshots.length).toBeGreaterThanOrEqual(1)
    const first = snapshots[0]
    expect(first?.lenAtCall).toBe(CHUNK_SIZE)
    expect(first?.skipped).toBe(0)
    // Still CHUNK_SIZE after the walk finished → it really was a snapshot.
    expect(first?.arr).toHaveLength(CHUNK_SIZE)
    expect(first?.arr).not.toBe(final.matches)
    expect(final.matches).toHaveLength(nodes.length)
  })

  it('schedules chunks through requestIdleCallback when the host provides one', async () => {
    // Kills matcher.ts:509:9 [ConditionalExpression → false], 509:24
    // [StringLiteral `'function'` → ''] — both of which force the `setTimeout`
    // fallback even when `requestIdleCallback` exists — and 509:36
    // [BlockStatement → {}], which drops the `ric(fn)` call so nothing is ever
    // scheduled and `onComplete` never fires. happy-dom has no
    // `requestIdleCallback`, so the preferred branch was previously dead.
    let ricCalls = 0
    // Model the real contract rather than a convenient subset: a host
    // `requestIdleCallback` invokes its callback with an `IdleDeadline` and
    // returns a handle. Production ignores both today, so a stub that omitted
    // them would let this branch look exercised while any deadline-aware
    // scheduling stayed untested.
    vi.stubGlobal('requestIdleCallback', (cb: (deadline: IdleDeadline) => void) => {
      ricCalls += 1
      return setTimeout(() => {
        cb({ didTimeout: false, timeRemaining: () => 50 })
      }, 0)
    })
    const host = attach('<p>alpha</p><p>alpha</p>')
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('alpha', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    const result = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(nodes, compiled, { onComplete: resolve })
    })
    expect(ricCalls).toBeGreaterThanOrEqual(1)
    expect(result.matches).toHaveLength(2)
  })
})

/*
 * ─────────────────────── EQUIVALENT-MUTANT LEDGER (#3757) ───────────────────
 *
 * Mutants of `matcher.ts` that survive by construction: each was spliced in at
 * its exact Stryker offsets and the suite stayed green *because the mutated
 * program computes the same thing*, not because coverage is missing. Recorded
 * so the next triage pass does not re-derive them. Format: line:col [mutator]
 * verbatim replacement — argument.
 *
 * A. Guards over states the DOM/type contract cannot produce. TypeScript types
 *    `Node.ownerDocument`, `Node.nodeValue` and indexed access as nullable, so
 *    these branches exist to satisfy the compiler; no input reaches them.
 *
 *    193:81 [StringLiteral] `''` → "Stryker was here!" — the `err instanceof
 *      Error ? err.message : ''` fallback. `new RegExp(...)` rejects only with
 *      a SyntaxError, so the else arm is unreachable.
 *    383:18 [OptionalChaining] `host.ownerDocument?.createTreeWalker` →
 *      `host.ownerDocument.createTreeWalker`, and 400:7 [ConditionalExpression]
 *      `!walker` → false — per the DOM spec only a Document has a null
 *      `ownerDocument`; for an Element it is always present, so the walker is
 *      always constructed and the `?.` / `!walker` pair is dead. (Killable only
 *      by fabricating a non-Element "host", which production never passes.)
 *    385:11 [ConditionalExpression] `!(node instanceof Text)` → false — the
 *      walker is created with `NodeFilter.SHOW_TEXT`, so `acceptNode` is only
 *      ever offered Text nodes.
 *    387:11 [ConditionalExpression] `!parent` → false — the walker is rooted at
 *      an element and the root itself is not SHOW_TEXT, so every visited text
 *      node has an element parent.
 *    396:11 [ConditionalExpression] `v == null` → false — `Text.nodeValue` is
 *      always a string (`''` at worst), never null. (The `v.length === 0` half
 *      of the same condition IS covered — see the zero-length-text-node test.)
 *    451:36 and 533:38 [StringLiteral] `''` → "Stryker was here!" — the
 *      `node.nodeValue ?? ''` fallbacks, same reason as 396:11.
 *    532:11 [ConditionalExpression] `!node` → false — `textNodes[i]` is read
 *      under `i < Math.min(cursor + CHUNK_SIZE, textNodes.length)`.
 *
 * B. 221:7 [ConditionalExpression] `needle.length === 0` → false, and
 *    221:35 [ArrayDeclaration] `[]` → ["Stryker was here"] — `scanLiteral` is
 *    reached only through `compileQuery`, which returns `{kind:'empty'}` for
 *    `query.length === 0`; and no case fold shrinks a string (verified over all
 *    0x110000 code points, in every locale checked — en, el, tr, az, lt: zero
 *    mappings with `f.length < ch.length`). So the needle is never empty and
 *    the early return never runs.
 *
 * C. 251:10 and 296:10 [EqualityOperator] `from <= haystack.length` /
 *    `from <= folded.length` → `<`. The two differ only on the final iteration
 *    where `from === length`; with a non-empty needle (see B) `indexOf` then
 *    returns -1 and the loop breaks without emitting, which is exactly what the
 *    mutant's loop test does. Same output either way.
 *
 * D. The folded (length-changing case fold) path's index guards and its
 *    duplicate-span filter.
 *
 *    CAVEAT ON THE UNDERLYING FACT. Under the default locale U+0130 'İ' →
 *    'i' + U+0307 is the only code point whose lowercase mapping expands
 *    (verified over 0x110000 code points). That is NOT a universal Unicode
 *    fact: `matcher.ts` folds with `toLocaleLowerCase()` and passes no locale,
 *    so the expanding set follows the runtime's default locale — tr/az expand
 *    NOTHING (the folded path is dead there), and lt expands FOUR (U+00CC,
 *    U+00CD, U+0128, U+0130, e.g. 'Ì' → 'i' + U+0307 + U+0300). The verdicts
 *    below hold in all three cases, because what they actually need is weaker:
 *    (i) `idx <= folded.length - needle.length` bounds every lookup whatever
 *    the fold widths are, and (ii) no fold in any of these locales contains two
 *    ADJACENT IDENTICAL code units, which is what a duplicate span would
 *    require. Do not restate the one-expanding-code-point figure as universal.
 *
 *    Both defences are therefore unreachable:
 *      - `foldedStart`/`foldedEnd` have exactly `folded.length` entries and the
 *        indices used are bounded by `idx <= folded.length - needle.length`, so
 *        neither lookup is ever `undefined`;
 *      - a duplicate span needs two match offsets inside one code point's fold
 *        at BOTH ends, which forces the needle to be periodic with period 1
 *        while its first two folded units are 'i' and U+0307 — a contradiction.
 *    Confirmed by differential sweep: 4,422,600 (text, needle, wholeWord) cases
 *    over an alphabet saturated with İ / i / U+0307 / astral letters produced
 *    zero undefined lookups, zero duplicate spans, and — the near-miss canaries
 *    that matter for the sub-expression mutants — zero cases where only the
 *    start or only the end repeated. The same harness detects 1,160 differences
 *    for a mutant the suite already kills (`from = idx + 1` → `+ needle.length`),
 *    so it is not blind.
 *      301:9  [ConditionalExpression] `start !== undefined && end !== undefined`
 *             → true
 *      301:9  [LogicalOperator] `start !== undefined && end !== undefined` →
 *             `start !== undefined || end !== undefined`. NB this one must be
 *             judged as an AST edit, not a textual splice: pasting the
 *             replacement in place reassociates the enclosing condition to
 *             `A || (B && C)` (because `&&` binds tighter than `||`) and the
 *             whole-word arm stops being enforced, which the folded-path
 *             wholeWord test above does catch. Stryker replaces the node, so
 *             the real mutant is `(A || B) && C`; with A and B both invariably
 *             true that is `true && C`, i.e. the original.
 *             Careful, though: `A && B && C` parses as `(A && B) && C`, and
 *             BOTH `&&` nodes start at column 9, so "301:9 [LogicalOperator]"
 *             names two distinct mutants, not one. Only the inner one is
 *             equivalent. The outer one, `(A && B) || C`, disables the
 *             whole-word arm and IS killed by the folded-path wholeWord test.
 *             Verified by splicing each reading separately.
 *      301:9  [ConditionalExpression] `start !== undefined` → true
 *      301:32 [ConditionalExpression] `end !== undefined` → true
 *      304:27 [UnaryOperator] `-1` → `+1` (`out.at(-1)` → `out.at(+1)`): the
 *             guard's verdict is "push" for every reachable input, so which
 *             element it inspects cannot change the output.
 *      305:11 [ConditionalExpression] `!last || last.start !== start ||
 *             last.end !== end` → true
 *      305:20 [ConditionalExpression] `last.start !== start` → false
 *      305:20 [EqualityOperator] `last.start !== start` → `last.start === start`
 *      305:44 [ConditionalExpression] `last.end !== end` → false
 *      305:44 [EqualityOperator] `last.end !== end` → `last.end === end`
 *
 * E. Rewrites that are value-identical rather than merely untested.
 *      327:19 [ConditionalExpression] `text.length > REGEX_NODE_SCAN_MAX` → true,
 *      327:19 [EqualityOperator] same → `>=` — `text.slice(0, N)` returns a
 *        string equal to `text` whenever `text.length <= N`, so both the
 *        always-slice mutant and the boundary shift hand `re.exec` the same
 *        input, including at exactly `REGEX_NODE_SCAN_MAX`.
 *      361:41 [ConditionalExpression] `index >= 2` → true — `codePointBefore`
 *        already returned for `index <= 0`, so the only extra case is
 *        `index === 1`, where `charCodeAt(-1)` is NaN and `NaN >= 0xd800` is
 *        false; the block falls through to the same `return low`.
 *      363:27 [EqualityOperator] `high <= 0xdbff` → `high < 0xdbff` — differs
 *        only at `high === 0xdbff`, i.e. code points U+10FC00…U+10FFFF. That
 *        whole plane-16 range is Private Use / noncharacter: exhaustively
 *        checked, none of the 1,024 code points matches `/[\p{L}\p{N}_]/u`, and
 *        the bare trailing surrogate the mutant returns instead is not a word
 *        character either. Both readings classify as "not a word char".
 *      370:17 [ConditionalExpression] `end >= text.length` → false,
 *      370:17 [EqualityOperator] same → `>` — `String.prototype.codePointAt`
 *        already returns `undefined` for any index at or past the end, so the
 *        ternary's guard is redundant with the call it guards.
 *
 * Follow-up-worthy (redundant / unreachable production code, not test gaps):
 * the whole of group A, the `needle.length === 0` early return (B), the folded
 * path's duplicate-span filter (D), and the redundant guards in E (361:41,
 * 370:17).
 *
 * Also follow-up-worthy, and a behaviour question rather than dead code:
 * `compileQuery` / `scanLiteralFolded` fold with `toLocaleLowerCase()` and pass
 * no locale, so case-insensitive find silently changes meaning with the user's
 * locale — under tr/az 'i' no longer matches 'I', and under lt the fold grows
 * combining dots. VSCode uses `toLowerCase()` for exactly this reason. Several
 * tests in this file (both the U+0130 ones) assume a non-tr/az default locale;
 * the folded-path wholeWord test asserts that assumption up front so it fails
 * loudly instead of going quietly vacuous.
 *
 * Note on 385:11 (`!(node instanceof Text)` → false, listed under A): the guard
 * is redundant under `SHOW_TEXT` and would additionally misfire across realms,
 * since `instanceof` is realm-scoped. That is not reachable here: the walker is
 * built from `host.ownerDocument`, so it only ever yields nodes from the host's
 * own tree, and a same-window *different document* (e.g. template contents)
 * still shares the realm. Reaching it needs a host from another realm — an
 * iframe's `contentDocument` — and `collectTextNodes` is called from exactly
 * one production site, `InPageFind.tsx`, with a same-document React ref; the
 * app renders no iframe anywhere. Left unkilled deliberately: a test would pin
 * an accident as intended behaviour.
 */
