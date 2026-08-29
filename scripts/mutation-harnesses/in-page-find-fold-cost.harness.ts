/**
 * #4507 — committed, re-runnable cost experiment for `foldForMatch`.
 *
 * Four rounds of review litigated the benchmark tables in `matcher.ts`'s
 * docblock against an experiment that existed only in a session transcript.
 * Every round found a wrong number, and no reader who doubted a row could
 * re-run it — only re-argue it. This is that experiment, committed, on the
 * #3804 convention: a re-runnable proof outside vitest's `include` globs, so
 * it never gates CI and never flakes a lane.
 *
 *   npx vitest run --config scripts/mutation-harnesses/vitest.config.ts \
 *     scripts/mutation-harnesses/in-page-find-fold-cost.harness.ts \
 *     --disable-console-intercept
 *
 * Budget about 130 s on a host matching the published figures — `greek para`
 * alone is ~112 s of that (11 reps over three variants, plus a 200k-iteration
 * warm-up against a 300k measured loop). The config allows 300 s, so a host
 * roughly 2.3x slower FAILS ON TIMEOUT and prints no table. If that happens
 * you have hit the budget, not a defect: drop `reps`, or lower the iteration
 * counts, and re-read the spread column knowing both are now noisier.
 *
 * # What it measures
 *
 * Three implementations, on the two call sites `foldForMatch` actually has:
 *
 * - `pre`   — the code BEFORE #4507. `foldCodePoint` was a bare
 *             `f === 'ς' ? 'σ' : f`; `scanLiteral` a bare `text.toLowerCase()`.
 *             These are the only honest baselines, and getting this wrong is
 *             what made three earlier versions of the docblock report a
 *             regression as a win.
 * - `naive` — `toLowerCase().replace(/ς/g, 'σ')`, the unguarded form. Useful
 *             for sizing what the `indexOf` guard buys, and NOT a baseline:
 *             it never shipped. Do not read the `naive/now` column as a
 *             regression measure.
 * - `now`   — the shipped guarded form.
 *
 * # Why the methodology is what it is
 *
 * Single runs on a shared cloud runner produced three successive wrong
 * summaries. Interleaving with rotating order cancels drift; medians over
 * eleven repetitions cancel outliers; and the per-row spread is reported as an
 * explicit noise floor because row-level verdicts are NOT stable here — the
 * `astral` row is buried under a range of 26% in the `matcher.ts` table and
 * clears against one of 5% in `session-1451`, on identical code. Both of those
 * are in the tree; open them and compare. (They are full peak-to-peak ranges,
 * not half-widths — see `spreadPct` below for why this file never writes `±`.)
 *
 * So this prints a floor beside every row and marks which rows clear it. Treat
 * any row whose delta is within about twice its floor as "direction known,
 * magnitude not".
 *
 * # The recompute check
 *
 * `assertTableIsSelfConsistent` is the part that earns this file its place.
 * Every percentage and multiplier printed is recomputed from the row's own
 * operands and compared to what the row claims. Three rounds of *trying
 * harder* to keep prose consistent with a table produced three more wrong
 * summaries; one mechanical recompute produced none. If you edit the table in
 * `matcher.ts`, run this and diff — do not eyeball it.
 *
 * Be precise about what that buys, because the PR that added this file
 * overstated it. The check re-derives THIS harness's printed figures from THIS
 * harness's operands. The four rounds of wrong ratios were in the
 * hand-transcribed table and prose in `matcher.ts`, which this file never
 * reads. What actually closes that gap is the invocation quoted in the
 * `foldForMatch` docblock: a reader at the table can now re-run rather than
 * re-argue. This check keeps the harness's own output honest, which is a
 * smaller and more tractable claim.
 *
 * `now` below is a hand-clone of the shipped `foldForMatch`, so it is pinned
 * the way every other harness in this directory pins what it clones. If the
 * real function changes, `scripts/check-mutation-harness-clones.mjs` fails
 * here until this copy is re-synced — which is the point: a cost experiment
 * measuring a stale copy of the code would be worse than no experiment.
 *
 * The `FINAL_SIGMA_RE` clone below is pinned separately (#3953). Both `naive`
 * and `now` close over it, and a pattern-only edit in `matcher.ts` does not
 * touch `foldForMatch`'s body — so without this second marker that edit would
 * leave the function pin green while this file measured the old regex.
 *
 * mutation-harness-source-pin: src/lib/in-page-find/matcher.ts#foldForMatch sha256=fd252bfb7c92699c2a335fcd43b637736d7d9e9812dd71c27ae662d22078998b
 * mutation-harness-source-pin: src/lib/in-page-find/matcher.ts#FINAL_SIGMA_RE sha256=b3551818575e60e5ae5b4b013000e0680855db365291f6058a1dade9e35b6d7e
 */

import { describe, expect, it } from 'vitest'

const FINAL_SIGMA_RE = /ς/g

/** Pre-#4507 `foldCodePoint`: one string equality, no regex. */
const preCodePoint = (ch: string): string => {
  const f = ch.toLowerCase()
  return f === 'ς' ? 'σ' : f
}
/** Pre-#4507 `scanLiteral`: bare whole-string fold, no sigma collapse at all. */
const preWholeNode = (s: string): string => s.toLowerCase()
/** The unguarded form. Never shipped; sizes what the guard buys. */
const naive = (s: string): string => s.toLowerCase().replace(FINAL_SIGMA_RE, 'σ')
/** The shipped form — kept in lockstep with `foldForMatch` in matcher.ts. */
const now = (s: string): string => {
  const lowered = s.toLowerCase()
  return lowered.indexOf('ς') === -1 ? lowered : lowered.replace(FINAL_SIGMA_RE, 'σ')
}

interface Row {
  label: string
  pre: number
  naive: number
  now: number
  noisePct: number
}

type VariantName = 'pre' | 'naive' | 'now'
type Variants = Record<VariantName, (s: string) => string>

const VARIANT_ORDER: readonly VariantName[] = ['pre', 'naive', 'now']

function timeOnce(fn: (s: string) => string, inputs: string[], iterations: number): number {
  const n = inputs.length
  for (let i = 0; i < Math.min(iterations, 200_000); i++) fn(inputs[i % n] ?? '')
  const start = process.hrtime.bigint()
  let sink = 0
  for (let i = 0; i < iterations; i++) sink += fn(inputs[i % n] ?? '').length
  if (sink < 0) throw new Error('unreachable; defeats dead-code elimination')
  return Number(process.hrtime.bigint() - start) / 1e6
}

const median = (xs: number[]): number => {
  const sorted = xs.toSorted((a, b) => a - b)
  const mid = sorted.length >> 1
  if (sorted.length === 0) return Number.NaN
  // `reps` is a parameter, so even-length input is reachable; taking the
  // upper-middle element there would bias every figure upward.
  if (sorted.length % 2 === 1) return sorted[mid] ?? Number.NaN
  return ((sorted[mid - 1] ?? Number.NaN) + (sorted[mid] ?? Number.NaN)) / 2
}

/**
 * Full peak-to-peak spread as a percentage of the median — NOT a half-width.
 * Rendered below as `range`, not `±`, because calling a full range `±` would
 * overstate the band by about 2x, and this file exists to stop numbers being
 * presented as more precise than they are.
 */
const spreadPct = (xs: number[], mid: number): number =>
  ((Math.max(...xs) - Math.min(...xs)) / mid) * 100

/**
 * Interleaved with ROTATING ORDER: variant k runs in a different position each
 * repetition, so a runner that drifts over the measurement window cannot
 * systematically favour whichever variant happens to go first.
 */
function measure(
  label: string,
  variants: Variants,
  inputs: string[],
  iterations: number,
  reps = 11,
): Row {
  const samples: Record<VariantName, number[]> = { pre: [], naive: [], now: [] }
  for (let r = 0; r < reps; r++) {
    const shift = r % VARIANT_ORDER.length
    const order = [...VARIANT_ORDER.slice(shift), ...VARIANT_ORDER.slice(0, shift)]
    for (const k of order) samples[k].push(timeOnce(variants[k], inputs, iterations))
  }
  const pre = median(samples.pre)
  const naiveMs = median(samples.naive)
  const nowMs = median(samples.now)
  const noisePct = Math.max(
    spreadPct(samples.pre, pre),
    spreadPct(samples.naive, naiveMs),
    spreadPct(samples.now, nowMs),
  )
  return { label, pre, naive: naiveMs, now: nowMs, noisePct }
}

const deltaPct = (r: Row): number => (r.now / r.pre - 1) * 100
const guardX = (r: Row): number => r.naive / r.now
const clearsNoise = (r: Row): boolean => Math.abs(deltaPct(r)) > r.noisePct

function renderTable(title: string, rows: Row[]): string {
  const head = `${title}\n${'row'.padEnd(22)}${'pre'.padStart(9)}${'naive'.padStart(10)}${'now'.padStart(10)}${'now/pre'.padStart(10)}${'naive/now'.padStart(11)}${'range'.padStart(8)}   verdict`
  const body = rows.map((r) => {
    const delta = `${deltaPct(r) >= 0 ? '+' : ''}${deltaPct(r).toFixed(0)}%`
    const verdict = clearsNoise(r) ? 'clears' : 'INSIDE NOISE'
    return `${r.label.padEnd(22)}${r.pre.toFixed(1).padStart(9)}${r.naive.toFixed(1).padStart(10)}${r.now.toFixed(1).padStart(10)}${delta.padStart(10)}${`${guardX(r).toFixed(1)}x`.padStart(11)}${`${r.noisePct.toFixed(0)}%`.padStart(8)}   ${verdict}`
  })
  return [head, ...body].join('\n')
}

/**
 * Recompute every derived figure from the row's own operands. This is the
 * check whose absence let four successive versions of the docblock publish
 * ratios that did not follow from the numbers printed beside them.
 */
function assertTableIsSelfConsistent(rows: Row[]): void {
  for (const r of rows) {
    expect(r.pre, `${r.label}: pre must be positive`).toBeGreaterThan(0)
    expect(r.naive, `${r.label}: naive must be positive`).toBeGreaterThan(0)
    expect(r.now, `${r.label}: now must be positive`).toBeGreaterThan(0)
    // The rendered percentage must be recoverable from the rendered operands,
    // to within the rounding the renderer itself applies.
    // The tolerance must scale with the operands: `toFixed(1)` loses up to
    // 0.05 ms on each, and that is a larger RELATIVE error on a 4 ms row than
    // on a 1500 ms one. A fixed 1pp bound false-fails the fastest rows on a
    // quick host — reporting "does not follow" about a table that is fine.
    const fromOperands = (Number(r.now.toFixed(1)) / Number(r.pre.toFixed(1)) - 1) * 100
    const roundingSlackPct = 0.5 + 100 * (0.05 / r.pre + (0.05 * r.now) / r.pre ** 2)
    expect(
      Math.abs(fromOperands - deltaPct(r)),
      `${r.label}: printed now/pre does not follow from printed pre and now`,
    ).toBeLessThan(roundingSlackPct)
    // Same argument as above, propagated through a ratio rather than a
    // difference: the error is `0.05 * (1 + naive/now) / now`, so a flat 0.05
    // bound false-fails once `now` drops to a few ms — reachable on a host
    // four or five times quicker than this one.
    const guardFromOperands = Number(r.naive.toFixed(1)) / Number(r.now.toFixed(1))
    const guardSlack = 0.01 + (0.05 * (1 + r.naive / r.now)) / r.now
    expect(
      Math.abs(guardFromOperands - guardX(r)),
      `${r.label}: printed naive/now does not follow from printed naive and now`,
    ).toBeLessThan(guardSlack)
  }
}

describe('#4507 — foldForMatch cost, per call site', () => {
  it('measures both call sites and reports a self-consistent table', () => {
    const perCodePoint = [
      { label: 'latin (no sigma)', text: 'the quick brown fox jumps over the lazy dog 0123456789' },
      { label: 'turkish (İ)', text: 'İstanbul Işık İçin ĞÜŞÖÇ ıi şğ üö çÇ İİİ' },
      { label: 'greek (has sigma)', text: 'ΟΔΟΣ ΤΙΣ ΣΣ ςσΣ ΑΣΦΑΛΕΙΑ ΕΛΛΗΝΙΚΑ' },
      { label: 'astral (pairs)', text: '😀𝔘𝔫𝔦𝔠𝔬𝔡𝔢🎉' },
    ].map(({ label, text }) =>
      measure(label, { pre: preCodePoint, naive, now }, [...text], 1_000_000),
    )

    const perTextNode = [
      { label: 'short heading (15)', text: 'Getting started' },
      {
        label: 'english para (540)',
        text: 'The quick brown fox jumps over the lazy dog. '.repeat(12),
      },
      {
        label: 'greek para (504)',
        text: 'Η ΟΔΟΣ ΕΙΝΑΙ ΜΑΚΡΙΑ ΚΑΙ ΤΙΣ ΝΥΧΤΕΣ ΨΥΧΡΗ. '.repeat(12),
      },
    ].map(({ label, text }) => measure(label, { pre: preWholeNode, naive, now }, [text], 300_000))

    const all = [...perCodePoint, ...perTextNode]
    console.log(
      `\n${renderTable('per CODE POINT (1M iterations x 11 interleaved reps)', perCodePoint)}\n\n` +
        `${renderTable('per WHOLE TEXT NODE (300k iterations x 11 interleaved reps)', perTextNode)}\n\n` +
        `Rows clearing their own noise floor: ${all.filter(clearsNoise).length} of ${all.length}\n`,
    )

    assertTableIsSelfConsistent(all)

    // The two structural claims the docblock makes. Asserted with generous
    // tolerance because the magnitudes are not stable here — only the
    // DIRECTION is, and that is all the docblock claims.
    //
    // Read the three thresholds below (0.95, 1.2, 1.5) as CALIBRATED, not
    // derived: nothing in the code implies them. They are margins drawn wide
    // around the three runs published in this repo — the `matcher.ts` docblock
    // table, `session-1447` and `session-1451`. Over those: latin 2.3-2.5x,
    // greek para 0.98-1.01x (0.980, 1.0039, 0.9965 — note the middle one is
    // above 1.0, so the band is NOT bounded by unity), per-row deltas +9% to
    // +66%. Runs before the harness was committed exist only in transcripts
    // and are not cited: closing that gap is why this file is here.
    // This file is outside CI, so a failure here is a message to whoever ran
    // it — "this machine does not behave like the ones these were drawn on",
    // not "the shipped code is wrong". Check the printed table before
    // believing either.
    for (const r of all) {
      expect(
        r.now,
        `${r.label}: shipped fold should be within 5% of, or slower than, pre-#4507`,
      ).toBeGreaterThan(r.pre * 0.95)
    }
    // The guard never costs more than a few percent, and pays substantially
    // where it can skip the replace. Greek corpora are the "cannot skip" case.
    const greekPara = perTextNode.find((r) => r.label.startsWith('greek para'))
    expect(greekPara, 'greek para row must exist').toBeDefined()
    if (greekPara) {
      expect(guardX(greekPara), 'guard cannot help on a long sigma-bearing string').toBeLessThan(
        1.2,
      )
    }
    const latin = perCodePoint.find((r) => r.label.startsWith('latin'))
    expect(latin, 'latin row must exist').toBeDefined()
    if (latin) {
      expect(guardX(latin), 'guard should pay on sigma-free input').toBeGreaterThan(1.5)
    }
  })

  it('the shipped fold agrees with pre-#4507 AND with naive, over every scalar value', () => {
    // Both directions, because the docblock claims both. `preWholeNode` is
    // deliberately absent: it never collapsed sigma at all, so it cannot agree
    // by construction — that difference IS #4507.
    let vsPre = 0
    let vsNaive = 0
    for (let cp = 0; cp < 0x110000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const ch = String.fromCodePoint(cp)
      if (preCodePoint(ch) !== now(ch)) vsPre++
      if (naive(ch) !== now(ch)) vsNaive++
    }
    expect(vsPre, 'shipped fold must agree with pre-#4507 foldCodePoint').toBe(0)
    expect(vsNaive, 'the indexOf guard must not change the result').toBe(0)
  })
})
