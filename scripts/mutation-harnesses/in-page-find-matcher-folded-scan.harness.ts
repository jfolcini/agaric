/**
 * #3804 — committed sweep harness backing the "301:9 / 301:32" equivalence
 * cluster in `src/lib/in-page-find/__tests__/matcher.test.ts` (section D,
 * "The folded (length-changing case fold) path's index guards"), which
 * cited "4,422,600 (text, needle, wholeWord) cases ... produced zero
 * undefined lookups" plus a validation control detecting "1,160
 * differences" — a sweep that was run once, never committed, and therefore
 * could not be re-run.
 *
 * #3804 — line-drift note: the ledger cites `301:9` / `301:32` / `327:19` /
 * `363:27`. Current source has the cited `if (start !== undefined && end
 * !== undefined ...)` condition at line 430, not 301 — drifted by 129
 * lines (verify with `grep -n 'start !== undefined && end !== undefined'
 * src/lib/in-page-find/matcher.ts`). This harness does not attempt to fix
 * every citation in that large, multi-part ledger comment (327:19 and
 * 363:27 are separate, purely-deductive claims in section E, not the
 * empirical sweep this issue is about) — it backs the one section D
 * explicitly names as having an uncommitted 4.4M-case sweep behind it.
 *
 * SCOPE — this harness covers only `scanLiteralFolded`'s index-guard
 * equivalence claims (section D). It does NOT attempt the module's other
 * empirical claims (the exhaustive 0x110000 code-point scan for "U+0130 is
 * the only expanding fold", or section E's `327:19`/`363:27`) — those
 * are either a one-time enumeration better re-run standalone than folded
 * into a differential sweep, or already closed-form/deductive arguments
 * that don't cite an uncommitted script.
 *
 * #3907 — the mutant/control clones below are hand-copied from
 * `scanLiteralFolded` and its private helpers (none exported, so — as with
 * the export-graph harness — both the "real" and "mutant" variants here
 * are clones; the source-pin hashes below are what ties the "real" clone
 * to production, in place of an import). They drift silently if the source
 * changes with nothing to catch it (this file is out of CI and outside
 * every tsconfig project). If a pin fires, re-sync every hand-copied clone
 * against the current source, then recompute and update the hash. See
 * `scripts/check-mutation-harness-clones.mjs`, wired into prek.toml.
 *
 * KNOWN GAP in the pin coverage (documented, not silently missing): the
 * module-level `WORD_RE` regex constant `isWordCodePoint` reads is NOT
 * itself pinned — the #3907 guard only tracks named `function`
 * declarations, not top-level `const`s. A `WORD_RE`-only edit would not
 * trip this harness's gate (though it would very likely trip the existing
 * unit tests in matcher.test.ts, which assert on whole-word behavior
 * directly). `isWordCodePoint` inlines the same pattern text below so the
 * CLONE stays byte-faithful to what `WORD_RE` currently is; that inlining
 * is itself unpinned.
 *
 * mutation-harness-source-pin: src/lib/in-page-find/matcher.ts#foldCodePoint sha256=191d915338117d9bae421defafb4f44a5c6d74c12ad5515d66ef875f18cf87ab
 * mutation-harness-source-pin: src/lib/in-page-find/matcher.ts#scanLiteralFolded sha256=19936901acd33de798e09ebf9c575186576784b3c57cc21b81b3f8fb16bd52a0
 * mutation-harness-source-pin: src/lib/in-page-find/matcher.ts#isWordCodePoint sha256=1187f44517fcbf5a2ffd1e10a8518fc0e20e2b458faa3e784a488fb074ebaf7c
 * mutation-harness-source-pin: src/lib/in-page-find/matcher.ts#codePointBefore sha256=4818b6d6cee92197cc0aee47214a24927fc99b0bb6662bb640bb08d178ff31d5
 * mutation-harness-source-pin: src/lib/in-page-find/matcher.ts#isWholeWord sha256=dbfed2675929f078adb8227a307839684ad55995426ac61d604d4a5141bca1c7
 *
 * Mutants this harness discriminates (verbatim Stryker `replacement`;
 * `line:col` current as of this commit — verify with `grep -n 'start !==
 * undefined && end !== undefined' src/lib/in-page-find/matcher.ts`):
 *
 *   EQUIVALENT (the ledger's claims under test — expect ZERO differing inputs):
 *     - `start !== undefined && end !== undefined` -> `true` (both operands
 *       replaced by the literal `true`, collapsing the whole conjunction)
 *     - `start !== undefined` (leftmost operand alone) -> `true`
 *     - `end !== undefined` (second operand alone) -> `true`
 *     - the INNER reassociated reading of the `&&`->`||` edit: `(start !==
 *       undefined || end !== undefined) && (!wholeWord || isWholeWord(...))`
 *       — per the ledger's AST-level argument, this is what Stryker's node
 *       replacement actually produces (not the naive textual splice)
 *
 *   VALIDATION CONTROLS (expected to differ — proves the harness has power):
 *     - the OUTER reassociated reading, i.e. the actual Stryker node
 *       replacement on the outer `&&`: `(start !== undefined && end !==
 *       undefined) || (!wholeWord || isWholeWord(...))` — the ledger itself
 *       says this one IS killed, by the folded-path wholeWord test
 *     - `from = idx + 1` -> `from = idx + foldedNeedle.length` (the loop
 *       advance after a match) — the ledger cites this control detecting
 *       "1,160 differences"
 *
 * Invocation (from repo root, or from scripts/mutation-harnesses/ itself):
 *   npx vitest run --config scripts/mutation-harnesses/vitest.config.ts \
 *     scripts/mutation-harnesses/in-page-find-matcher-folded-scan.harness.ts
 *
 * Wall-clock: a few seconds (pure in-process JS sweep, no I/O, no DOM).
 */

import { describe, expect, it } from 'vitest'

// ── Deterministic PRNG (mulberry32) — fixed seed for reproducible counts ────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Real (byte-faithful clones of unexported helpers, per KNOWN GAP note) ──

function foldCodePoint(ch: string): string {
  const f = ch.toLowerCase()
  return f === 'ς' ? 'σ' : f
}

function isWordCodePoint(cp: number | undefined): boolean {
  if (cp === undefined) return false
  return /[\p{L}\p{N}_]/u.test(String.fromCodePoint(cp))
}

function codePointBefore(text: string, index: number): number | undefined {
  if (index <= 0) return undefined
  const low = text.charCodeAt(index - 1)
  if (low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(index - 2)
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(index - 2)
  }
  return low
}

function isWholeWord(text: string, start: number, end: number): boolean {
  const before = codePointBefore(text, start)
  const after = text.codePointAt(end)
  return !isWordCodePoint(before) && !isWordCodePoint(after)
}

interface Span {
  start: number
  end: number
}

/** Byte-for-byte clone of the real (unmutated) `scanLiteralFolded`. */
function realScan(text: string, foldedNeedle: string, wholeWord: boolean): Span[] {
  const foldedStart: number[] = []
  const foldedEnd: number[] = []
  let folded = ''
  let oi = 0
  for (const ch of text) {
    const f = foldCodePoint(ch)
    for (let k = 0; k < f.length; k++) {
      foldedStart.push(oi)
      foldedEnd.push(oi + ch.length)
    }
    folded += f
    oi += ch.length
  }
  const out: Span[] = []
  let from = 0
  while (from <= folded.length) {
    const idx = folded.indexOf(foldedNeedle, from)
    if (idx === -1) break
    const start = foldedStart[idx]
    const end = foldedEnd[idx + foldedNeedle.length - 1]
    if (start !== undefined && end !== undefined && (!wholeWord || isWholeWord(text, start, end))) {
      out.push({ start, end })
    }
    from = idx + 1
  }
  return out
}

// ── Mutant clones ────────────────────────────────────────────────────────
//
// Each is `realScan` with exactly the cited node(s) replaced.

/** `start !== undefined && end !== undefined` -> `true` (whole conjunction). */
function mutantBothForcedTrue(text: string, foldedNeedle: string, wholeWord: boolean): Span[] {
  const foldedStart: number[] = []
  const foldedEnd: number[] = []
  let folded = ''
  let oi = 0
  for (const ch of text) {
    const f = foldCodePoint(ch)
    for (let k = 0; k < f.length; k++) {
      foldedStart.push(oi)
      foldedEnd.push(oi + ch.length)
    }
    folded += f
    oi += ch.length
  }
  const out: Span[] = []
  let from = 0
  while (from <= folded.length) {
    const idx = folded.indexOf(foldedNeedle, from)
    if (idx === -1) break
    const start = foldedStart[idx]
    const end = foldedEnd[idx + foldedNeedle.length - 1]
    // MUTATED: `start !== undefined && end !== undefined` -> `true`.
    if (!wholeWord || isWholeWord(text, start as number, end as number)) {
      out.push({ start: start as number, end: end as number })
    }
    from = idx + 1
  }
  return out
}

/** `start !== undefined` (leftmost operand alone) -> `true`. */
function mutantStartForcedTrue(text: string, foldedNeedle: string, wholeWord: boolean): Span[] {
  const foldedStart: number[] = []
  const foldedEnd: number[] = []
  let folded = ''
  let oi = 0
  for (const ch of text) {
    const f = foldCodePoint(ch)
    for (let k = 0; k < f.length; k++) {
      foldedStart.push(oi)
      foldedEnd.push(oi + ch.length)
    }
    folded += f
    oi += ch.length
  }
  const out: Span[] = []
  let from = 0
  while (from <= folded.length) {
    const idx = folded.indexOf(foldedNeedle, from)
    if (idx === -1) break
    const start = foldedStart[idx]
    const end = foldedEnd[idx + foldedNeedle.length - 1]
    // MUTATED: `start !== undefined` -> `true`.
    if (end !== undefined && (!wholeWord || isWholeWord(text, start as number, end))) {
      out.push({ start: start as number, end })
    }
    from = idx + 1
  }
  return out
}

/** `end !== undefined` (second operand alone) -> `true`. */
function mutantEndForcedTrue(text: string, foldedNeedle: string, wholeWord: boolean): Span[] {
  const foldedStart: number[] = []
  const foldedEnd: number[] = []
  let folded = ''
  let oi = 0
  for (const ch of text) {
    const f = foldCodePoint(ch)
    for (let k = 0; k < f.length; k++) {
      foldedStart.push(oi)
      foldedEnd.push(oi + ch.length)
    }
    folded += f
    oi += ch.length
  }
  const out: Span[] = []
  let from = 0
  while (from <= folded.length) {
    const idx = folded.indexOf(foldedNeedle, from)
    if (idx === -1) break
    const start = foldedStart[idx]
    const end = foldedEnd[idx + foldedNeedle.length - 1]
    // MUTATED: `end !== undefined` -> `true`.
    if (start !== undefined && (!wholeWord || isWholeWord(text, start, end as number))) {
      out.push({ start, end: end as number })
    }
    from = idx + 1
  }
  return out
}

/**
 * INNER reassociation of `&&` -> `||`: `(start !== undefined || end !==
 * undefined) && (!wholeWord || isWholeWord(...))`. Per the ledger, this is
 * the AST-faithful reading of Stryker's LogicalOperator replacement on the
 * inner `&&` node, and it is EQUIVALENT.
 */
function mutantInnerOrReassociated(text: string, foldedNeedle: string, wholeWord: boolean): Span[] {
  const foldedStart: number[] = []
  const foldedEnd: number[] = []
  let folded = ''
  let oi = 0
  for (const ch of text) {
    const f = foldCodePoint(ch)
    for (let k = 0; k < f.length; k++) {
      foldedStart.push(oi)
      foldedEnd.push(oi + ch.length)
    }
    folded += f
    oi += ch.length
  }
  const out: Span[] = []
  let from = 0
  while (from <= folded.length) {
    const idx = folded.indexOf(foldedNeedle, from)
    if (idx === -1) break
    const start = foldedStart[idx]
    const end = foldedEnd[idx + foldedNeedle.length - 1]
    // MUTATED (inner &&->||): `(start !== undefined || end !== undefined)`.
    if (
      (start !== undefined || end !== undefined) &&
      (!wholeWord || isWholeWord(text, start as number, end as number))
    ) {
      out.push({ start: start as number, end: end as number })
    }
    from = idx + 1
  }
  return out
}

/**
 * OUTER reassociation of `&&` -> `||`: Stryker's node replacement on the
 * outer `&&` node turns `(A && B) && C` into `(A && B) || C`, i.e. `(start
 * !== undefined && end !== undefined) || (!wholeWord || isWholeWord(...))`
 * — CONTROL. The ledger says this reading IS killed by the folded-path
 * wholeWord test.
 */
function controlOuterOrReassociated(
  text: string,
  foldedNeedle: string,
  wholeWord: boolean,
): Span[] {
  const foldedStart: number[] = []
  const foldedEnd: number[] = []
  let folded = ''
  let oi = 0
  for (const ch of text) {
    const f = foldCodePoint(ch)
    for (let k = 0; k < f.length; k++) {
      foldedStart.push(oi)
      foldedEnd.push(oi + ch.length)
    }
    folded += f
    oi += ch.length
  }
  const out: Span[] = []
  let from = 0
  while (from <= folded.length) {
    const idx = folded.indexOf(foldedNeedle, from)
    if (idx === -1) break
    const start = foldedStart[idx]
    const end = foldedEnd[idx + foldedNeedle.length - 1]
    // MUTATED (outer &&->||): `(start !== undefined && end !== undefined) || C`.
    // The `end as unknown as number` casts below deliberately reproduce the
    // mutant's real (buggy) runtime behavior: when `end` IS `undefined`, the
    // left disjunct is false but `C` is still evaluated/can still be true,
    // still pushing a span with an `undefined` end — that's the whole reason
    // this reading differs from the original.
    if (
      (start !== undefined && end !== undefined) ||
      !wholeWord ||
      isWholeWord(text, start as number, end as unknown as number)
    ) {
      out.push({ start: start as number, end: end as unknown as number })
    }
    from = idx + 1
  }
  return out
}

/** `from = idx + 1` -> `from = idx + foldedNeedle.length` — CONTROL (known Killed). */
function controlAdvanceByNeedleLength(
  text: string,
  foldedNeedle: string,
  wholeWord: boolean,
): Span[] {
  const foldedStart: number[] = []
  const foldedEnd: number[] = []
  let folded = ''
  let oi = 0
  for (const ch of text) {
    const f = foldCodePoint(ch)
    for (let k = 0; k < f.length; k++) {
      foldedStart.push(oi)
      foldedEnd.push(oi + ch.length)
    }
    folded += f
    oi += ch.length
  }
  const out: Span[] = []
  let from = 0
  while (from <= folded.length) {
    const idx = folded.indexOf(foldedNeedle, from)
    if (idx === -1) break
    const start = foldedStart[idx]
    const end = foldedEnd[idx + foldedNeedle.length - 1]
    if (start !== undefined && end !== undefined && (!wholeWord || isWholeWord(text, start, end))) {
      out.push({ start, end })
    }
    // MUTATED: `from = idx + 1` -> `from = idx + foldedNeedle.length`.
    from = idx + foldedNeedle.length
  }
  return out
}

function spansEqual(a: Span[], b: Span[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.start !== b[i]?.start || a[i]?.end !== b[i]?.end) return false
  }
  return true
}

// ── Input generation ─────────────────────────────────────────────────────
//
// An alphabet saturated with the length-changing fold ('İ' U+0130 -> 'i' +
// U+0307), its expansion products, and astral (surrogate-pair) letters, so
// the folded path's index bookkeeping is exercised under exactly the
// conditions the ledger's underlying fact depends on.

const ALPHABET = [
  'İ', // U+0130 — the one length-changing fold (-> 'i' + U+0307)
  'i',
  'I',
  '̇', // combining dot above (what İ expands into)
  'a',
  'b',
  ' ',
  '𝐀', // astral letter (surrogate pair), U+1D400
  '𝐁', // astral letter, U+1D401
  'ς', // final sigma (folds to σ — the other special case in foldCodePoint)
  'σ',
  'Σ',
]

function randomString(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * (maxLen + 1))
  let s = ''
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)] as string
  return s
}

/** Fold `s` the same code-point-by-code-point way `compileQuery` folds a needle. */
function foldWhole(s: string): string {
  let out = ''
  for (const ch of s) out += foldCodePoint(ch)
  return out
}

// ── Sweep ─────────────────────────────────────────────────────────────────

interface SweepResult {
  total: number
  matchesFound: number
  diffBoth: number
  diffStart: number
  diffEnd: number
  diffInnerOr: number
  diffOuterOr: number
  diffAdvance: number
}

function runSweep(): SweepResult {
  const rand = mulberry32(0xfa1d5)
  const result: SweepResult = {
    total: 0,
    matchesFound: 0,
    diffBoth: 0,
    diffStart: 0,
    diffEnd: 0,
    diffInnerOr: 0,
    diffOuterOr: 0,
    diffAdvance: 0,
  }

  const CASES = 60_000
  for (let i = 0; i < CASES; i++) {
    const text = randomString(rand, 12)
    const needleRaw = randomString(rand, 4)
    const foldedNeedle = foldWhole(needleRaw)
    const wholeWord = rand() < 0.5
    if (foldedNeedle.length === 0) continue

    result.total++
    const real = realScan(text, foldedNeedle, wholeWord)
    result.matchesFound += real.length

    if (!spansEqual(mutantBothForcedTrue(text, foldedNeedle, wholeWord), real)) result.diffBoth++
    if (!spansEqual(mutantStartForcedTrue(text, foldedNeedle, wholeWord), real)) result.diffStart++
    if (!spansEqual(mutantEndForcedTrue(text, foldedNeedle, wholeWord), real)) result.diffEnd++
    if (!spansEqual(mutantInnerOrReassociated(text, foldedNeedle, wholeWord), real))
      result.diffInnerOr++
    if (!spansEqual(controlOuterOrReassociated(text, foldedNeedle, wholeWord), real))
      result.diffOuterOr++
    if (!spansEqual(controlAdvanceByNeedleLength(text, foldedNeedle, wholeWord), real))
      result.diffAdvance++
  }

  return result
}

describe('scanLiteralFolded equivalence-ledger sweep (#3804 harness for matcher.test.ts section D)', () => {
  it('reproduces the ledger claims and proves the harness detects real mutants', () => {
    const r = runSweep()
    console.log(`
[in-page-find matcher scanLiteralFolded sweep]
  total generated (text, needle, wholeWord) cases:   ${r.total}
  total match spans found across all cases:           ${r.matchesFound}

  EQUIVALENT mutants under test (expect 0):
    start !== undefined && end !== undefined -> true      differing: ${r.diffBoth} / ${r.total}
    start !== undefined (alone) -> true                    differing: ${r.diffStart} / ${r.total}
    end !== undefined (alone) -> true                       differing: ${r.diffEnd} / ${r.total}
    inner && -> || reassociation                            differing: ${r.diffInnerOr} / ${r.total}

  VALIDATION CONTROLS (expect >0 — proves the harness has power):
    outer && -> || reassociation (ledger: killed)            differing: ${r.diffOuterOr} / ${r.total}
    from = idx + 1 -> idx + foldedNeedle.length (ledger: 1,160 diffs)  differing: ${r.diffAdvance} / ${r.total}
`)

    // The controls MUST fire — otherwise this harness has no discriminating
    // power and the "0 differences" verdicts below would be worthless.
    expect(r.diffOuterOr).toBeGreaterThan(0)
    expect(r.diffAdvance).toBeGreaterThan(0)
    // And the sweep must actually be exercising real matches, not just
    // generating inputs that never reach the code under test.
    expect(r.matchesFound).toBeGreaterThan(0)

    // The ledger's equivalence claims.
    expect(r.diffBoth).toBe(0)
    expect(r.diffStart).toBe(0)
    expect(r.diffEnd).toBe(0)
    expect(r.diffInnerOr).toBe(0)
  })
})
