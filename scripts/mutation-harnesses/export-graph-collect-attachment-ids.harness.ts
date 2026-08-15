/**
 * #3804 — committed sweep harness backing the `collectAttachmentIds`
 * equivalence-ledger entry (494:43) in
 * `src/lib/__tests__/export-graph.test.ts`, which cited "636 real matches
 * from 1,008 ref-shaped inputs" — a sweep that was run once, never
 * committed, and therefore could not be re-run.
 *
 * NOTE on the OTHER export-graph ledger entries this harness does NOT
 * cover: the "16,119 inputs" / "44-mutant harness" citations a few lines
 * above 494:43 in that file already document their own resolution — #3798
 * DELETED the code those specific claims were about (the `.filter`/ternary
 * L2 proved dead), so there is no live mutant left to sweep there; the
 * ledger comment already says so. This harness targets the one citation in
 * that ledger that is still about LIVE code.
 *
 * #3907 — the mutant/control clones below are hand-copied from
 * `collectAttachmentIds` (not exported, so there is no live import to
 * diff against — both the "real" and "mutant" variants below are clones;
 * the source-pin hash on `collectAttachmentIds` is what ties the "real"
 * clone to production, in place of an import) and drift silently if the
 * source changes with nothing to catch it (this file is out of CI and
 * outside every tsconfig project). If a pin below fires, re-sync every
 * hand-copied clone against the current source, then recompute and update
 * the hash. See `scripts/check-mutation-harness-clones.mjs`, wired into
 * prek.toml.
 *
 * `parseAttachmentRef` is imported below, not cloned — it needs no pin
 * (there is nothing hand-copied for its source to drift out of sync with;
 * the import IS the drift protection).
 *
 * mutation-harness-source-pin: src/lib/export-graph.ts#collectAttachmentIds sha256=6fc2b9c58cb784a5907c3248d0f2e6c72c52e12aaebf5ed473748a400cfaf1cf
 *
 * KNOWN GAP in the pin coverage (documented, not silently missing — mirrors
 * the `WORD_RE` note in `in-page-find-matcher-folded-scan.harness.ts`): the
 * module-level `ATTACHMENT_REF_RE` regex constant `collectAttachmentIds`
 * reads is NOT itself pinned — the #3907 guard only tracks named `function`
 * declarations, not top-level `const`s. `ATTACHMENT_REF_RE` is hand-cloned
 * FOUR times below (`REAL_RE`, `MUTANT_RE`, `CONTROL_RE`, and the literal
 * inline in `runSweep`'s match-count line) so each sweep iteration gets its
 * own `lastIndex`; none of those four clones are pinned. The whole
 * equivalence claim above rests on group 3's structure ("neither optional
 * nor inside an alternation") — a `const`-only edit to `ATTACHMENT_REF_RE`
 * making group 3 optional would leave all four clones stale with this
 * guard green (though it would likely still trip export-graph.test.ts's
 * own assertions on attachment-ref parsing).
 *
 * Mutant this harness discriminates (verbatim Stryker `replacement`,
 * `line:col` current as of this commit — verify with
 * `grep -n 'm\[3\] ?? ' src/lib/export-graph.ts` before trusting the
 * number below):
 *
 *   EQUIVALENT (the ledger's claim under test — expect ZERO differing inputs):
 *     - 494:43 [StringLiteral] `m[3] ?? ''` -> `m[3] ?? "Stryker was here!"`
 *       (in practice: dropping the `?? ''` fallback entirely, i.e.
 *       `parseAttachmentRef(m[3] ?? '')` -> `parseAttachmentRef(m[3])`.
 *       `ATTACHMENT_REF_RE`'s group 3 — `(attachment:[^)\s]+)` — is neither
 *       optional (no `?`) nor inside an alternation, so it always
 *       participates in a match; `m[3]` is therefore never `undefined` for
 *       any match `matchAll` yields, making the `?? ''` fallback dead.)
 *
 *   VALIDATION CONTROL (a mutant with real behavioral impact — this
 *   harness's own generation proves it differs, since `collectAttachmentIds`
 *   is unexported and has no existing vitest case pinned to this exact
 *   line):
 *     - `if (id != null) ids.add(id)` -> `if (true) ids.add(id)`
 *       (adds `null` itself into the id set whenever a matched ref's URL
 *       fails `parseAttachmentRef` validation — e.g. an empty or
 *       non-ULID-shaped id — which is exactly what the `!= null` guard
 *       exists to exclude)
 *
 * Invocation (from repo root, or from scripts/mutation-harnesses/ itself):
 *   npx vitest run --config scripts/mutation-harnesses/vitest.config.ts \
 *     scripts/mutation-harnesses/export-graph-collect-attachment-ids.harness.ts
 *
 * Wall-clock: ~1s (pure in-process JS sweep, no I/O).
 */

import { describe, expect, it } from 'vitest'

import { parseAttachmentRef } from '@/lib/attachment-ref'

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

// ── Real vs. mutant clones ───────────────────────────────────────────────
//
// `collectAttachmentIds` is not exported, so there is no live import to
// serve as the oracle — the "real" clone below IS the oracle, and its
// byte-for-byte fidelity to production is what the source-pin hash above
// guarantees instead. `ATTACHMENT_REF_RE` is stateful (`g` flag): each
// clone gets its OWN regex literal so parallel calls in the same sweep
// iteration never share (and corrupt) a `lastIndex`.

const REAL_RE = /(!?)\[([^\]]*)\]\((attachment:[^)\s]+)\)/g

/** Byte-for-byte clone of the real (unmutated) `collectAttachmentIds`. */
function realCollectAttachmentIds(md: string): Set<string> {
  const ids = new Set<string>()
  for (const m of md.matchAll(REAL_RE)) {
    const id = parseAttachmentRef(m[3] ?? '')
    if (id != null) ids.add(id)
  }
  return ids
}

const MUTANT_RE = /(!?)\[([^\]]*)\]\((attachment:[^)\s]+)\)/g

/** 494:43 [StringLiteral]: `m[3] ?? ''` -> `m[3]` (fallback dropped). */
function mutantDropFallback(md: string): Set<string> {
  const ids = new Set<string>()
  for (const m of md.matchAll(MUTANT_RE)) {
    // MUTATED: `m[3] ?? ''` -> `m[3]`.
    const id = parseAttachmentRef(m[3] as string)
    if (id != null) ids.add(id)
  }
  return ids
}

const CONTROL_RE = /(!?)\[([^\]]*)\]\((attachment:[^)\s]+)\)/g

/** `if (id != null) ids.add(id)` -> `if (true) ids.add(id)` — CONTROL. */
function controlAlwaysAdd(md: string): Set<string> {
  const ids = new Set<string>()
  for (const m of md.matchAll(CONTROL_RE)) {
    const id = parseAttachmentRef(m[3] ?? '')
    // MUTATED: `id != null` -> `true` — the guard is gone, so every match adds
    // unconditionally, including a `null` id from a failed validation.
    ids.add(id as unknown as string)
  }
  return ids
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

// ── Input generation ─────────────────────────────────────────────────────

const VALID_ID = '01J8QK7ZFAKEULID0000001'
const BAD_IDS = ['', 'has space', 'has)paren', 'a/b', 'quéry?x', '../../etc']

/** A random ref-shaped fragment: a well-formed ref, a bad-id ref, or plain prose. */
function randomFragment(rand: () => number): string {
  const r = rand()
  const bang = rand() < 0.5 ? '!' : ''
  const alt = rand() < 0.5 ? '' : 'alt text'
  if (r < 0.4) {
    return `${bang}[${alt}](attachment:${VALID_ID})`
  }
  if (r < 0.7) {
    const badId = BAD_IDS[Math.floor(rand() * BAD_IDS.length)] as string
    // A bad id containing `)`/whitespace may make the OUTER regex not match
    // at all (its class is `[^)\s]+`) — that's fine, it just exercises the
    // "no match here" path instead of the "match with invalid id" path;
    // both are real, legitimate inputs to generate.
    return `${bang}[${alt}](attachment:${badId})`
  }
  if (r < 0.85) {
    return 'plain prose with no ref at all, maybe a [link](https://example.test) too'
  }
  return '[almost](attachment)' // no colon-id at all — no match
}

function randomCase(rand: () => number): string {
  const fragCount = 1 + Math.floor(rand() * 4)
  const parts: string[] = []
  for (let i = 0; i < fragCount; i++) parts.push(randomFragment(rand))
  return parts.join(rand() < 0.5 ? ' ' : '\n')
}

// ── Sweep ─────────────────────────────────────────────────────────────────

interface SweepResult {
  total: number
  totalMatches: number
  diffDropFallback: number
  diffControl: number
}

function runSweep(): SweepResult {
  const rand = mulberry32(0xa77ac4)
  const result: SweepResult = { total: 0, totalMatches: 0, diffDropFallback: 0, diffControl: 0 }

  const CASES = 50_000
  for (let i = 0; i < CASES; i++) {
    const md = randomCase(rand)
    result.total++
    result.totalMatches += [...md.matchAll(/(!?)\[([^\]]*)\]\((attachment:[^)\s]+)\)/g)].length

    const real = realCollectAttachmentIds(md)
    if (!setsEqual(mutantDropFallback(md), real)) result.diffDropFallback++
    if (!setsEqual(controlAlwaysAdd(md), real)) result.diffControl++
  }

  return result
}

describe('collectAttachmentIds equivalence-ledger sweep (#3804 harness for export-graph.test.ts:494)', () => {
  it('reproduces the ledger claim and proves the harness detects a real mutant', () => {
    const r = runSweep()
    console.log(`
[export-graph collectAttachmentIds sweep]
  total generated inputs:                    ${r.total}
  total attachment-shaped regex matches:      ${r.totalMatches}

  EQUIVALENT mutant under test (expect 0):
    494:43 m[3] ?? '' -> m[3] (fallback dropped)   differing: ${r.diffDropFallback} / ${r.total}

  VALIDATION CONTROL (expect >0 — proves the harness has power):
    id != null -> true (always add)                differing: ${r.diffControl} / ${r.total}
`)

    // The control MUST fire — otherwise this harness has no discriminating
    // power and a "0 differences" verdict below would be worthless.
    expect(r.diffControl).toBeGreaterThan(0)
    // And the sweep must actually be generating matches at all — otherwise
    // "0 differences" would just mean "never reached the code under test".
    expect(r.totalMatches).toBeGreaterThan(0)

    // The ledger's equivalence claim.
    expect(r.diffDropFallback).toBe(0)
  })
})
