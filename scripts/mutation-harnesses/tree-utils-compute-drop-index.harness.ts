/**
 * #3804 — committed sweep harness backing the `computeDropIndex` equivalence
 * ledger in `src/lib/__tests__/tree-utils.mutants-drop.test.ts`.
 *
 * #3907 — the mutant clones below are hand-copied from `computeDropIndex`
 * and drift silently if the source changes with nothing to catch it (this
 * file is out of CI and outside every tsconfig project). The source-pin
 * marker on the next line is a gate against exactly that: it hashes the
 * real function's current text and fails if it no longer matches (see
 * `scripts/check-mutation-harness-clones.mjs` — UNWIRED by #4556, so
 * nothing enforces these pins today; run it by hand after touching the
 * source, until #4556 Phase 2 restages it). If
 * this fires, re-sync every hand-copied clone below against the current
 * `computeDropIndex`, then recompute and update the hash.
 *
 * mutation-harness-source-pin: src/lib/tree-utils.ts#computeDropIndex sha256=e951054ec08ef59bdeea2a1fd94984241dd366836711ee6e575edb3fc626b334
 *
 * Module under test: `computeDropIndex` in `src/lib/tree-utils.ts` (currently
 * starts at line 513; verify with
 * `grep -n '^export function computeDropIndex' src/lib/tree-utils.ts` before
 * trusting any line number below — see the "line drift" finding in the PR
 * description for #3804 for why that check matters).
 *
 * Mutants this harness discriminates (verbatim Stryker `replacement`,
 * `line:col` current as of commit 525138ec7 / #3887 — re-verified against
 * `git show 525138ec7^:src/lib/tree-utils.ts` vs the current file; the ledger
 * comment itself was off by +2 lines even after #3887's update, corrected
 * alongside this harness):
 *
 *   EQUIVALENT (the ledger's claim under test — expect ZERO differing inputs):
 *     - 539:16 [EqualityOperator]   `overIdxInItems > activeIndex` -> `>=`
 *     - 545:23 [ConditionalExpression] `parentId === null` -> `false`
 *
 *   VALIDATION CONTROLS (mutants the existing vitest suite already Kills —
 *   used to prove this harness has the power to detect a real difference,
 *   not just report zero because it's too weak to find one):
 *     - 533:7  [ConditionalExpression] `overIdxInWithout < 0` -> `true`
 *       (killed by "does not treat a real overId as an unknown/sentinel
 *       target")
 *     - 552:19 [EqualityOperator]     `i < insertAt` -> `<=`
 *       (killed by "excludes the item exactly at insertAt from the sibling
 *       count")
 *     - 554:50 [ConditionalExpression] `item.depth === childDepth` -> `true`
 *       (killed by "excludes an item whose parent_id matches but whose depth
 *       does not")
 *
 * Invocation (from repo root):
 *   npx vitest run --config scripts/mutation-harnesses/vitest.config.ts \
 *     scripts/mutation-harnesses/tree-utils-compute-drop-index.harness.ts
 *
 * Wall-clock: ~1s (pure in-process JS sweep, no I/O).
 */

import { describe, expect, it } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { computeDropIndex, type FlatBlock, SENTINEL_ID } from '@/lib/tree-utils'

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

// ── Forest generator ─────────────────────────────────────────────────────
//
// Builds a small random forest of `n` blocks (ids 'A'..) as an already
// DFS-flattened `FlatBlock[]`, matching the shape `buildFlatTree` would hand
// `computeDropIndex` in production: parent before child, depth = parent's
// depth + 1, siblings in a (randomized) rendered order.

function buildForest(n: number, rand: () => number): FlatBlock[] {
  const ids = Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i))
  const parent: (number | null)[] = [null]
  for (let i = 1; i < n; i++) {
    const r = rand()
    if (r < 0.3) parent.push(null)
    else if (r < 0.65) parent.push(i - 1)
    else parent.push(Math.floor(rand() * i))
  }
  const depth: number[] = Array.from({ length: n }, () => 0)
  for (let i = 1; i < n; i++) {
    const p = parent[i] as number | null
    depth[i] = p === null ? 0 : (depth[p] as number) + 1
  }
  const childrenOf: number[][] = Array.from({ length: n }, () => [])
  const roots: number[] = []
  for (let i = 0; i < n; i++) {
    const p = parent[i] as number | null
    if (p === null) roots.push(i)
    else (childrenOf[p] as number[]).push(i)
  }
  const shuffle = (arr: number[]): void => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      const tmp = arr[i] as number
      arr[i] = arr[j] as number
      arr[j] = tmp
    }
  }
  shuffle(roots)
  for (const c of childrenOf) shuffle(c)
  const order: number[] = []
  const dfs = (i: number): void => {
    order.push(i)
    for (const c of childrenOf[i] as number[]) dfs(c)
  }
  for (const r of roots) dfs(r)
  return order.map((i) =>
    makeBlock({
      id: ids[i] as string,
      parent_id: parent[i] === null ? null : (ids[parent[i] as number] as string),
      depth: depth[i] as number,
      position: i + 1,
    }),
  )
}

// ── Real vs. mutant clones ───────────────────────────────────────────────
//
// Each mutant clone is a hand-copied `computeDropIndex` with exactly one
// line changed to the cited Stryker `replacement`, so a differential run
// against the real (imported) function isolates that single mutation.

/** 539:16 [EqualityOperator] `overIdxInItems > activeIndex` -> `>=` */
function mutantGTE(
  items: readonly FlatBlock[],
  parentId: string | null,
  overId: string,
  activeId: string,
): number {
  const activeIndex = items.findIndex((i) => i.id === activeId)
  const without = items.filter((i) => i.id !== activeId)
  let insertAt: number
  const overIdxInWithout = without.findIndex((i) => i.id === overId)
  if (overIdxInWithout < 0) {
    insertAt = without.length
  } else {
    const overIdxInItems = items.findIndex((i) => i.id === overId)
    insertAt = overIdxInItems >= activeIndex ? overIdxInWithout + 1 : overIdxInWithout // MUTATED: > -> >=
  }
  const parentDepth = parentId === null ? -1 : (items.find((i) => i.id === parentId)?.depth ?? -1)
  const childDepth = parentDepth + 1
  let slot = 0
  for (let i = 0; i < insertAt; i++) {
    const item = without[i] as FlatBlock
    if ((item.parent_id ?? null) === parentId && item.depth === childDepth) slot += 1
  }
  return slot
}

/** 545:23 [ConditionalExpression] `parentId === null` -> `false` */
function mutantParentNullForcedFalse(
  items: readonly FlatBlock[],
  parentId: string | null,
  overId: string,
  activeId: string,
): number {
  const activeIndex = items.findIndex((i) => i.id === activeId)
  const without = items.filter((i) => i.id !== activeId)
  let insertAt: number
  const overIdxInWithout = without.findIndex((i) => i.id === overId)
  if (overIdxInWithout < 0) {
    insertAt = without.length
  } else {
    const overIdxInItems = items.findIndex((i) => i.id === overId)
    insertAt = overIdxInItems > activeIndex ? overIdxInWithout + 1 : overIdxInWithout
  }
  // MUTATED: `parentId === null ? -1 : (...)` -> always the else-arm.
  const parentDepth = items.find((i) => i.id === parentId)?.depth ?? -1
  const childDepth = parentDepth + 1
  let slot = 0
  for (let i = 0; i < insertAt; i++) {
    const item = without[i] as FlatBlock
    if ((item.parent_id ?? null) === parentId && item.depth === childDepth) slot += 1
  }
  return slot
}

/** 533:7 [ConditionalExpression] `overIdxInWithout < 0` -> `true` — CONTROL (known Killed). */
function controlSentinelForcedTrue(
  items: readonly FlatBlock[],
  parentId: string | null,
  overId: string,
  activeId: string,
): number {
  const without = items.filter((i) => i.id !== activeId)
  // `overIdxInWithout` is still computed (the real source computes it in the
  // statement BEFORE the mutated `if`, so Stryker's condition-only mutation
  // leaves this line untouched) but no longer read: the mutated condition
  // `if (overIdxInWithout < 0)` -> `if (true)` makes the else-branch (the
  // real index/comparison math) unreachable, so it's dropped here rather
  // than written as dead code behind a literal `true`.
  void without.findIndex((i) => i.id === overId)
  const insertAt = without.length
  const parentDepth = parentId === null ? -1 : (items.find((i) => i.id === parentId)?.depth ?? -1)
  const childDepth = parentDepth + 1
  let slot = 0
  for (let i = 0; i < insertAt; i++) {
    const item = without[i] as FlatBlock
    if ((item.parent_id ?? null) === parentId && item.depth === childDepth) slot += 1
  }
  return slot
}

/** 552:19 [EqualityOperator] `i < insertAt` -> `<=` — CONTROL (known Killed). */
function controlLoopLTE(
  items: readonly FlatBlock[],
  parentId: string | null,
  overId: string,
  activeId: string,
): number {
  const activeIndex = items.findIndex((i) => i.id === activeId)
  const without = items.filter((i) => i.id !== activeId)
  let insertAt: number
  const overIdxInWithout = without.findIndex((i) => i.id === overId)
  if (overIdxInWithout < 0) {
    insertAt = without.length
  } else {
    const overIdxInItems = items.findIndex((i) => i.id === overId)
    insertAt = overIdxInItems > activeIndex ? overIdxInWithout + 1 : overIdxInWithout
  }
  const parentDepth = parentId === null ? -1 : (items.find((i) => i.id === parentId)?.depth ?? -1)
  const childDepth = parentDepth + 1
  let slot = 0
  for (let i = 0; i <= insertAt; i++) {
    // MUTATED: < -> <=
    // NOT byte-identical to Stryker's mutant: the `item &&` guard is ours. When
    // insertAt === without.length the real mutant reads past the end and throws a
    // TypeError, which Stryker counts as a kill; this clone silently skips instead.
    // So the control UNDERCOUNTS, in the safe direction — every difference it does
    // report is real, and the `> 0` assertion is if anything conservative.
    const item = without[i]
    if (item && (item.parent_id ?? null) === parentId && item.depth === childDepth) slot += 1
  }
  return slot
}

/** 554:50 [ConditionalExpression] `item.depth === childDepth` -> `true` — CONTROL (known Killed). */
function controlDepthForcedTrue(
  items: readonly FlatBlock[],
  parentId: string | null,
  overId: string,
  activeId: string,
): number {
  const activeIndex = items.findIndex((i) => i.id === activeId)
  const without = items.filter((i) => i.id !== activeId)
  let insertAt: number
  const overIdxInWithout = without.findIndex((i) => i.id === overId)
  if (overIdxInWithout < 0) {
    insertAt = without.length
  } else {
    const overIdxInItems = items.findIndex((i) => i.id === overId)
    insertAt = overIdxInItems > activeIndex ? overIdxInWithout + 1 : overIdxInWithout
  }
  const parentDepth = parentId === null ? -1 : (items.find((i) => i.id === parentId)?.depth ?? -1)
  const childDepth = parentDepth + 1
  let slot = 0
  for (let i = 0; i < insertAt; i++) {
    const item = without[i] as FlatBlock
    if ((item.parent_id ?? null) === parentId && true) slot += 1 // MUTATED: item.depth === childDepth -> true
    void childDepth
  }
  return slot
}

/**
 * Canary variant of `computeDropIndex`, instrumented at the two splice
 * points the ledger cites: "just before the `overIdxInWithout < 0` test"
 * (early) and "at [539]" (atLine, only reachable inside the else-branch).
 * Control flow and return value are byte-identical to the real function —
 * the counters are pure side effects.
 */
function canaryVariant(
  items: readonly FlatBlock[],
  parentId: string | null,
  overId: string,
  activeId: string,
  counters: { early: number; atLine: number },
): number {
  const activeIndex = items.findIndex((i) => i.id === activeId)
  const without = items.filter((i) => i.id !== activeId)

  // Splice point 1: "just before the overIdxInWithout < 0 test".
  if (items.findIndex((i) => i.id === overId) === activeIndex) counters.early++

  let insertAt: number
  const overIdxInWithout = without.findIndex((i) => i.id === overId)
  if (overIdxInWithout < 0) {
    insertAt = without.length
  } else {
    const overIdxInItems = items.findIndex((i) => i.id === overId)
    // Splice point 2: "at 539", i.e. inside the else-branch.
    if (overIdxInItems === activeIndex) counters.atLine++
    insertAt = overIdxInItems > activeIndex ? overIdxInWithout + 1 : overIdxInWithout
  }
  const parentDepth = parentId === null ? -1 : (items.find((i) => i.id === parentId)?.depth ?? -1)
  const childDepth = parentDepth + 1
  let slot = 0
  for (let i = 0; i < insertAt; i++) {
    const item = without[i] as FlatBlock
    if ((item.parent_id ?? null) === parentId && item.depth === childDepth) slot += 1
  }
  return slot
}

// ── Sweep ─────────────────────────────────────────────────────────────────

interface SweepResult {
  total: number
  diffGTE: number
  diffParentNull: number
  diffControlSentinel: number
  diffControlLoop: number
  diffControlDepth: number
  canaryEarly: number
  canaryAtLine: number
}

function runSweep(): SweepResult {
  const rand = mulberry32(0xc0ffee)
  const result: SweepResult = {
    total: 0,
    diffGTE: 0,
    diffParentNull: 0,
    diffControlSentinel: 0,
    diffControlLoop: 0,
    diffControlDepth: 0,
    canaryEarly: 0,
    canaryAtLine: 0,
  }
  const canaryCounters = { early: 0, atLine: 0 }

  const FORESTS_PER_SIZE = 400
  for (let n = 2; n <= 6; n++) {
    for (let f = 0; f < FORESTS_PER_SIZE; f++) {
      let items = buildForest(n, rand)
      // Occasionally corrupt one item's `depth` to a value inconsistent with
      // its `parent_id` chain (a "stale" decoy, matching the dedicated
      // `excludes an item whose parent_id matches but whose depth does not`
      // vitest case) — needed for the 554:50 control to have any power at
      // all: a STRUCTURALLY VALID forest (the un-corrupted default) can never
      // separate `item.depth === childDepth` from `true`, because a real
      // child's depth always already equals its parent's depth + 1.
      if (rand() < 0.5 && items.length > 1) {
        const idx = Math.floor(rand() * items.length)
        const orig = items[idx] as FlatBlock
        const corrupted = items.slice()
        corrupted[idx] = { ...orig, depth: orig.depth + 1 + Math.floor(rand() * 3) }
        items = corrupted
      }
      const ids = items.map((b) => b.id)
      const overCandidates = [...ids, SENTINEL_ID, 'GHOST']
      const parentCandidates: (string | null)[] = [...ids, null, 'GHOST']

      for (const activeId of ids) {
        for (const overId of overCandidates) {
          for (const parentId of parentCandidates) {
            result.total++
            const real = computeDropIndex(items, parentId, overId, activeId)
            if (mutantGTE(items, parentId, overId, activeId) !== real) result.diffGTE++
            if (mutantParentNullForcedFalse(items, parentId, overId, activeId) !== real)
              result.diffParentNull++
            if (controlSentinelForcedTrue(items, parentId, overId, activeId) !== real)
              result.diffControlSentinel++
            if (controlLoopLTE(items, parentId, overId, activeId) !== real) result.diffControlLoop++
            if (controlDepthForcedTrue(items, parentId, overId, activeId) !== real)
              result.diffControlDepth++
            canaryVariant(items, parentId, overId, activeId, canaryCounters)
          }
        }
      }
    }
  }
  result.canaryEarly = canaryCounters.early
  result.canaryAtLine = canaryCounters.atLine
  return result
}

describe('computeDropIndex equivalence-ledger sweep (#3804 harness for #3765/#3793)', () => {
  it('reproduces the ledger claims and proves the harness detects real mutants', () => {
    const r = runSweep()
    console.log(`
[tree-utils computeDropIndex sweep]
  total generated inputs:                    ${r.total}

  EQUIVALENT mutants under test (expect 0):
    539:16 overIdxInItems > activeIndex -> >=   differing: ${r.diffGTE} / ${r.total}
    545:23 parentId === null -> false           differing: ${r.diffParentNull} / ${r.total}

  VALIDATION CONTROLS (known-Killed; expect >0 — proves the harness has power):
    533:7  overIdxInWithout < 0 -> true          differing: ${r.diffControlSentinel} / ${r.total}
    552:19 i < insertAt -> <=                    differing: ${r.diffControlLoop} / ${r.total}
    554:50 item.depth === childDepth -> true     differing: ${r.diffControlDepth} / ${r.total}

  Canary (539 reachability, ledger cites 4 679 / 0 on a different generator):
    overIdxInItems === activeIndex, spliced early:        ${r.canaryEarly}
    overIdxInItems === activeIndex, spliced at line 539:   ${r.canaryAtLine}
`)

    // The controls MUST fire — otherwise this harness has no discriminating
    // power and a "0 differences" verdict below would be worthless.
    expect(r.diffControlSentinel).toBeGreaterThan(0)
    expect(r.diffControlLoop).toBeGreaterThan(0)
    expect(r.diffControlDepth).toBeGreaterThan(0)

    // The ledger's equivalence claims.
    expect(r.diffGTE).toBe(0)
    expect(r.diffParentNull).toBe(0)

    // The reachability half of the canary argument: the equality condition
    // IS reached somewhere in the sweep (so "0 at line 539" isn't just "the
    // sweep never generated the shape"), but NEVER at the point 539 itself
    // reads it — confirming the earlier branch always shadows it.
    expect(r.canaryEarly).toBeGreaterThan(0)
    expect(r.canaryAtLine).toBe(0)
  })
})
