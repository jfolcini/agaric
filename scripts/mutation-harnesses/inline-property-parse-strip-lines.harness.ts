/**
 * #3804 — committed sweep harness backing two `stripPropertyLines` /
 * `trailingBackslashRun` equivalence-ledger entries in
 * `src/lib/__tests__/inline-property-parse.test.ts`, both of which cited a
 * sweep that was run once, never committed, and therefore could not be
 * re-run — see the ledger comments there (marked `#3804 — re-verified with
 * a committed, re-runnable harness` alongside this file).
 *
 * #3907 — the mutant/control clones below are hand-copied from
 * `stripPropertyLines` (and its private helpers `trailingBackslashRun` /
 * `endsWithHardBreakMarker`, inlined here since they aren't exported) and
 * drift silently if the source changes with nothing to catch it (this file
 * is out of CI and outside every tsconfig project). The source-pin markers
 * below are a gate against exactly that: they hash each real function's
 * current text and fail if it no longer matches (see
 * `scripts/check-mutation-harness-clones.mjs` — UNWIRED by #4556, so
 * nothing enforces these pins today; run it by hand after touching the
 * source, until #4556 Phase 2 restages it). If
 * this fires, re-sync every hand-copied clone below against the current
 * source, then recompute and update the hashes.
 *
 * mutation-harness-source-pin: src/lib/inline-property-parse.ts#stripPropertyLines sha256=e28f91d79484b562a1737c8d5ed5bfe73eddc8d22354a2e475d73c8dc11fbbb6
 * mutation-harness-source-pin: src/lib/inline-property-parse.ts#trailingBackslashRun sha256=1cdc5baa9b43283616bfd4dc244515a2f92eed482cd2fd877935c2093eaca214
 * mutation-harness-source-pin: src/lib/inline-property-parse.ts#endsWithHardBreakMarker sha256=114c93272c600acd8ee20584bcb84fb97d9b4175bc39ef081b6dc73cf671a09c
 *
 * Mutants this harness discriminates (verbatim Stryker `replacement`,
 * `line:col` current as of this commit — verify with
 * `grep -n 'lineIndexes.size === 0\|i >= 0 &&' src/lib/inline-property-parse.ts`
 * before trusting the numbers below):
 *
 *   EQUIVALENT (the ledger's claims under test — expect ZERO differing inputs):
 *     - 175:6 [ConditionalExpression] `lineIndexes.size === 0` -> `false`
 *       (the early-return optimization in `stripPropertyLines`)
 *     - 107:26 [ConditionalExpression] `i >= 0` -> `true`
 *       (the loop guard in `trailingBackslashRun`, dropped entirely)
 *
 *   VALIDATION CONTROL (a mutant the existing vitest suite already Kills —
 *   used to prove this harness has the power to detect a real difference):
 *     - 107:26 [EqualityOperator] `i >= 0` -> `i > 0`
 *       (killed by "drops the marker on a lone backslash line only when the
 *       run truly reaches index 0")
 *
 * Invocation (from repo root, or from scripts/mutation-harnesses/ itself —
 * #3907 fixed `vitest.config.ts` to be location-independent):
 *   npx vitest run --config scripts/mutation-harnesses/vitest.config.ts \
 *     scripts/mutation-harnesses/inline-property-parse-strip-lines.harness.ts
 *
 * Wall-clock: ~1s (pure in-process JS sweep, no I/O).
 */

import { describe, expect, it } from 'vitest'

import { stripPropertyLines } from '@/lib/inline-property-parse'

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

// ── Mutant / control clones ─────────────────────────────────────────────
//
// Each variant is a hand-copied `stripPropertyLines` (with its private
// helpers inlined), byte-identical to the current
// `src/lib/inline-property-parse.ts` except at exactly one point.

/** 175:6 [ConditionalExpression] `lineIndexes.size === 0` -> `false`. */
function trailingBackslashRun(line: string): number {
  let n = 0
  for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) n++
  return n
}
function endsWithHardBreakMarker(line: string): boolean {
  return trailingBackslashRun(line) % 2 === 1
}
function mutantSizeGuardForcedFalse(content: string, lineIndexes: ReadonlySet<number>): string {
  // MUTATED: `if (lineIndexes.size === 0) return content` -> dropped entirely.
  const lines = content.split('\n')
  const kept = lines.filter((_, i) => !lineIndexes.has(i))
  const last = kept.at(-1)
  if (last !== undefined && lineIndexes.has(lines.length - 1) && endsWithHardBreakMarker(last)) {
    kept[kept.length - 1] = last.slice(0, -1)
  }
  return kept.join('\n')
}

/** 107:26 [ConditionalExpression] `i >= 0` -> `true` (guard dropped entirely). */
function trailingBackslashRunGuardDropped(line: string): number {
  let n = 0
  // MUTATED: `i >= 0 && line[i] === '\\'` -> `true && line[i] === '\\'`.
  // JS returns `undefined` for an out-of-range string index, and
  // `undefined === '\\'` is `false`, so the loop still stops at the same `i`.
  for (let i = line.length - 1; line[i] === '\\'; i--) n++
  return n
}
function endsWithHardBreakMarkerGuardDropped(line: string): boolean {
  return trailingBackslashRunGuardDropped(line) % 2 === 1
}
function mutantIGuardDropped(content: string, lineIndexes: ReadonlySet<number>): string {
  if (lineIndexes.size === 0) return content
  const lines = content.split('\n')
  const kept = lines.filter((_, i) => !lineIndexes.has(i))
  const last = kept.at(-1)
  if (
    last !== undefined &&
    lineIndexes.has(lines.length - 1) &&
    endsWithHardBreakMarkerGuardDropped(last)
  ) {
    kept[kept.length - 1] = last.slice(0, -1)
  }
  return kept.join('\n')
}

/** 107:26 [EqualityOperator] `i >= 0` -> `i > 0` — CONTROL (known Killed). */
function trailingBackslashRunOffByOne(line: string): number {
  let n = 0
  // MUTATED: `i >= 0` -> `i > 0`.
  for (let i = line.length - 1; i > 0 && line[i] === '\\'; i--) n++
  return n
}
function endsWithHardBreakMarkerOffByOne(line: string): boolean {
  return trailingBackslashRunOffByOne(line) % 2 === 1
}
function controlOffByOne(content: string, lineIndexes: ReadonlySet<number>): string {
  if (lineIndexes.size === 0) return content
  const lines = content.split('\n')
  const kept = lines.filter((_, i) => !lineIndexes.has(i))
  const last = kept.at(-1)
  if (
    last !== undefined &&
    lineIndexes.has(lines.length - 1) &&
    endsWithHardBreakMarkerOffByOne(last)
  ) {
    kept[kept.length - 1] = last.slice(0, -1)
  }
  return kept.join('\n')
}

// ── Input generation ─────────────────────────────────────────────────────

const ALPHABET = ['\\', 'a', 'b', ':', ' ', '\n']

/** Random content string drawn from a backslash-heavy alphabet, plus a random strip set. */
function randomCase(rand: () => number): { content: string; lineIndexes: Set<number> } {
  const len = 1 + Math.floor(rand() * 24)
  let content = ''
  for (let i = 0; i < len; i++) {
    content += ALPHABET[Math.floor(rand() * ALPHABET.length)] as string
  }
  const lineCount = content.split('\n').length
  const lineIndexes = new Set<number>()
  for (let i = 0; i < lineCount; i++) {
    if (rand() < 0.35) lineIndexes.add(i)
  }
  return { content, lineIndexes }
}

/**
 * Exhaustive backslash-run-length x strip-mask sweep, run length 0..6, over
 * a fixed 3-line skeleton with the run at each of the 3 possible positions
 * and every one of the 8 strip-mask subsets of {0,1,2}. This is the
 * "run-length/strip-mask combination" claim the original (uncommitted)
 * ledger cited — reproduced independently here, not replayed from a stored
 * log, so the count below is this harness's own, not the historical one.
 */
function* exhaustiveCases(): Generator<{ content: string; lineIndexes: Set<number> }> {
  const RUN_LENGTHS = [0, 1, 2, 3, 4, 5, 6]
  const FILLER = ['head', 'k:: v']
  for (const runLen of RUN_LENGTHS) {
    const run = '\\'.repeat(runLen)
    for (let pos = 0; pos < 3; pos++) {
      const parts = [FILLER[0] as string, FILLER[1] as string]
      parts.splice(pos, 0, run)
      const content = parts.slice(0, 3).join('\n')
      for (let mask = 0; mask < 8; mask++) {
        const lineIndexes = new Set<number>()
        for (let bit = 0; bit < 3; bit++) if (mask & (1 << bit)) lineIndexes.add(bit)
        yield { content, lineIndexes }
      }
    }
  }
}

// ── Sweep ─────────────────────────────────────────────────────────────────

interface SweepResult {
  total: number
  diffSizeGuard: number
  diffIGuardDropped: number
  diffOffByOne: number
}

function runSweep(): SweepResult {
  const rand = mulberry32(0x51de11)
  const result: SweepResult = { total: 0, diffSizeGuard: 0, diffIGuardDropped: 0, diffOffByOne: 0 }

  const cases: { content: string; lineIndexes: Set<number> }[] = [...exhaustiveCases()]
  const RANDOM_CASES = 200_000
  for (let i = 0; i < RANDOM_CASES; i++) cases.push(randomCase(rand))

  for (const { content, lineIndexes } of cases) {
    result.total++
    const real = stripPropertyLines(content, lineIndexes)
    if (mutantSizeGuardForcedFalse(content, lineIndexes) !== real) result.diffSizeGuard++
    if (mutantIGuardDropped(content, lineIndexes) !== real) result.diffIGuardDropped++
    if (controlOffByOne(content, lineIndexes) !== real) result.diffOffByOne++
  }

  return result
}

describe('stripPropertyLines equivalence-ledger sweep (#3804 harness for inline-property-parse.test.ts)', () => {
  it('reproduces the ledger claims and proves the harness detects a real mutant', () => {
    const r = runSweep()
    console.log(`
[inline-property-parse stripPropertyLines sweep]
  total generated inputs (exhaustive run-length/strip-mask + random):  ${r.total}

  EQUIVALENT mutants under test (expect 0):
    175:6  lineIndexes.size === 0 -> false (guard dropped)   differing: ${r.diffSizeGuard} / ${r.total}
    107:26 i >= 0 -> true (guard dropped)                    differing: ${r.diffIGuardDropped} / ${r.total}

  VALIDATION CONTROL (known-Killed; expect >0 — proves the harness has power):
    107:26 i >= 0 -> i > 0 (off-by-one)                      differing: ${r.diffOffByOne} / ${r.total}
`)

    // The control MUST fire — otherwise this harness has no discriminating
    // power and a "0 differences" verdict below would be worthless.
    expect(r.diffOffByOne).toBeGreaterThan(0)

    // The ledger's equivalence claims.
    expect(r.diffSizeGuard).toBe(0)
    expect(r.diffIGuardDropped).toBe(0)
  })
})
