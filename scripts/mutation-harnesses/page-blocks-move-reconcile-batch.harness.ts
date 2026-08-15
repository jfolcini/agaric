/**
 * #3804 — committed sweep harness backing (what remains of) the
 * `reconcileBatchMove` equivalence ledger, originally at
 * `src/stores/__tests__/page-blocks.reorder.test.ts:1167` ("#3759 EQUIVALENCE
 * LEDGER").
 *
 * IMPORTANT — three of the four equivalence entries that ledger originally
 * described are now VOID, not merely line-shifted: #3887 (#3799) deleted the
 * code they were about outright (the `byId.has` pre-check and the vacated-
 * source dense-renumber loop, plus the dead `: (b.position ?? null)` ternary
 * arm). There is no mutant left at those positions to be equivalent about —
 * the same situation `tree-utils.mutants-drop.test.ts` already retired two
 * notes for after #3793, using near-identical wording. The ledger comment in
 * `page-blocks.reorder.test.ts` was NOT updated to say so; that correction
 * ships alongside this harness. See this harness's `npx vitest run` output
 * below and the #3804 PR description for the full account.
 *
 * The ONE equivalence claim that still describes live code:
 *   - `const updatedBag: FlatBlock[] = []` [ArrayDeclaration] ->
 *     `['Stryker was here']`, currently `page-blocks-move.ts:217:3`
 *     (verify with `grep -n 'const updatedBag' src/stores/page-blocks-move.ts`).
 *     The ledger's own claim is two-sided: 526 differing inputs when
 *     `rootParentId: null` is allowed into the sweep, 0 when restricted to
 *     the shapes `createPageBlockStore` can actually produce (a non-null
 *     `rootParentId`, immutable for the store's lifetime). Both halves are
 *     reproduced below.
 *
 * VALIDATION CONTROL (a mutant the existing vitest suite already Kills):
 *   - `if (!present.has(id)) return null` [ConditionalExpression] -> `false`,
 *     currently `page-blocks-move.ts:232:9`. Killed by
 *     `page-blocks.reorder.test.ts`'s "falls back to a reload when a moved id
 *     would fall OUT of the rebuilt tree" and by this harness's own
 *     `rootParentId`/`wantParent` mismatch generation (see below).
 *
 * Invocation (from repo root):
 *   npx vitest run --config scripts/mutation-harnesses/vitest.config.ts \
 *     scripts/mutation-harnesses/page-blocks-move-reconcile-batch.harness.ts
 *
 * Wall-clock: ~1-2s (pure in-process JS sweep, no I/O, no Zustand store).
 */

import { describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import type { MoveResponse } from '@/lib/bindings'
import { buildFlatTree, type FlatBlock } from '@/lib/tree-utils'
import { reconcileBatchMove, wouldCreateMoveCycle } from '@/stores/page-blocks-move'

// vi.mock calls are hoisted above all imports by vitest, so this applies
// before `page-blocks-move.ts`'s own `import { logger } from '@/lib/logger'`
// resolves.
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}))

// ── Deterministic PRNG ───────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Forest generator (same shape as the tree-utils harness) ────────────────

function buildForest(n: number, pageId: string, rand: () => number): FlatBlock[] {
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
  // Real callers set `parent_id: null` for a root under `rootParentId: pageId`
  // (relative-to-page addressing) — only substitute the literal page id when
  // this sweep is exercising the `rootParentId: null` (non-factory) shape.
  return order.map((i) =>
    makeBlock({
      id: ids[i] as string,
      parent_id:
        parent[i] === null ? (pageId === '' ? null : pageId) : (ids[parent[i] as number] as string),
      depth: depth[i] as number,
      position: i + 1,
    }),
  )
}

// ── Mutant / control clones ─────────────────────────────────────────────
//
// Hand-copied `reconcileBatchMove`, byte-identical to the current
// `src/stores/page-blocks-move.ts` except at exactly one point.

interface State {
  blocks: FlatBlock[]
  rootParentId: string | null
}

function reconcileBatchMoveVariant(
  state: State,
  resp: MoveResponse[],
  orderedIds: string[],
  requestedParentId: string | null,
  newIndex: number,
  variant: 'sentinel' | 'controlPresence',
): FlatBlock[] | null {
  const { blocks, rootParentId } = state
  const wantParent = requestedParentId ?? null

  if (resp.length !== orderedIds.length) return null
  for (const r of resp) {
    if ((r.new_parent_id ?? null) !== wantParent) return null
  }

  if (wouldCreateMoveCycle(blocks, orderedIds, wantParent)) return null

  const movedSet = new Set(orderedIds)
  const oldParentOf = new Map<string, string | null>(blocks.map((b) => [b.id, b.parent_id ?? null]))
  const parentOf = new Map<string, string | null>(oldParentOf)
  const posOf = new Map<string, number | null>()

  const remainingChildren = (parent: string | null): string[] =>
    blocks
      .filter((b) => !movedSet.has(b.id) && (oldParentOf.get(b.id) ?? null) === parent)
      .map((b) => b.id)

  const base = remainingChildren(wantParent)
  const p = Math.max(0, Math.min(newIndex, base.length))
  const destGroup = [...base.slice(0, p), ...orderedIds, ...base.slice(p)]
  for (const id of orderedIds) parentOf.set(id, wantParent)
  destGroup.forEach((bid, i) => posOf.set(bid, i + 1))

  const remainingByParent = new Map<string | null, string[]>()
  for (const b of blocks) {
    if (posOf.has(b.id)) continue
    const par = parentOf.get(b.id) ?? null
    let group = remainingByParent.get(par)
    if (!group) {
      group = []
      remainingByParent.set(par, group)
    }
    group.push(b.id)
  }
  for (const group of remainingByParent.values()) {
    group.forEach((bid, i) => posOf.set(bid, i + 1))
  }

  // MUTATED (ArrayDeclaration, `sentinel` variant only): `[]` -> `['Stryker was here']`.
  const updatedBag: FlatBlock[] =
    variant === 'sentinel' ? (['Stryker was here'] as unknown as FlatBlock[]) : []
  for (const b of blocks) {
    const par = parentOf.get(b.id) ?? null
    const pos = posOf.get(b.id) ?? null
    updatedBag.push(
      par === (b.parent_id ?? null) && pos === (b.position ?? null)
        ? b
        : { ...b, parent_id: par, position: pos },
    )
  }
  const flat = buildFlatTree(updatedBag, rootParentId)

  const present = new Set(flat.map((b) => b.id))
  if (variant !== 'controlPresence') {
    // MUTATED (ConditionalExpression, `controlPresence` variant): skip this
    // catch-all entirely.
    for (const id of orderedIds) {
      if (!present.has(id)) return null
    }
  }
  return flat
}

// ── Comparator ───────────────────────────────────────────────────────────

interface Outcome {
  threw: boolean
  value: string | null // null result, or a canonical JSON of the flat array
}

function canonicalize(flat: FlatBlock[] | null): Outcome {
  if (flat === null) return { threw: false, value: null }
  return {
    threw: false,
    value: JSON.stringify(
      flat.map((b) => [b.id, b.parent_id ?? null, b.position ?? null, b.depth]),
    ),
  }
}

function runVariant(
  state: State,
  resp: MoveResponse[],
  orderedIds: string[],
  requestedParentId: string | null,
  newIndex: number,
  variant: 'real' | 'sentinel' | 'controlPresence',
): Outcome {
  try {
    if (variant === 'real') {
      return canonicalize(
        reconcileBatchMove(state as never, resp, orderedIds, requestedParentId, newIndex),
      )
    }
    return canonicalize(
      reconcileBatchMoveVariant(state, resp, orderedIds, requestedParentId, newIndex, variant),
    )
  } catch {
    return { threw: true, value: null }
  }
}

function outcomesDiffer(a: Outcome, b: Outcome): boolean {
  return a.threw !== b.threw || a.value !== b.value
}

// ── Sweep ─────────────────────────────────────────────────────────────────

interface SweepResult {
  total: number
  reachedSplice: number
  diffSentinel: number
  diffControlPresence: number
}

/** @param allowNullRoot Whether `rootParentId: null` is included in the sweep. */
function runSweep(allowNullRoot: boolean): SweepResult {
  const rand = mulberry32(0x5eed01)
  const result: SweepResult = {
    total: 0,
    reachedSplice: 0,
    diffSentinel: 0,
    diffControlPresence: 0,
  }

  const rootParentIdCandidates: string[] = allowNullRoot ? ['', 'PAGE_1'] : ['PAGE_1']
  const FORESTS_PER_SIZE = 120

  for (const rootParentIdRaw of rootParentIdCandidates) {
    const rootParentId = rootParentIdRaw === '' ? null : rootParentIdRaw
    for (let n = 2; n <= 5; n++) {
      for (let f = 0; f < FORESTS_PER_SIZE; f++) {
        const blocks = buildForest(n, rootParentIdRaw, rand)
        const ids = blocks.map((b) => b.id)
        const state: State = { blocks, rootParentId }

        const orderedIdChoices: string[][] = [
          [ids[0] as string],
          ids.slice(0, Math.min(2, ids.length)),
        ]
        const wantParentChoices: (string | null)[] = [...ids, null, 'GHOST']
        const newIndexChoices = [0, 1, 2, 5]

        for (const orderedIds of orderedIdChoices) {
          for (const wantParent of wantParentChoices) {
            for (const newIndex of newIndexChoices) {
              // Happy-echo response (matches wantParent) most of the time,
              // occasionally a mismatched-length response to exercise the
              // early backend-echo guard too (mirrors the ledger's
              // "3,068 generated / 722 reaching the splice" ratio).
              const echoOk = rand() > 0.15
              const resp: MoveResponse[] = echoOk
                ? orderedIds.map((id, i) => ({
                    block_id: id,
                    new_parent_id: wantParent,
                    new_position: i + 1,
                  }))
                : orderedIds.slice(0, Math.max(0, orderedIds.length - 1)).map((id, i) => ({
                    block_id: id,
                    new_parent_id: wantParent,
                    new_position: i + 1,
                  }))

              result.total++
              const real = runVariant(state, resp, orderedIds, wantParent, newIndex, 'real')
              // "Reached the splice" proxy: the backend-echo guard passed
              // (well-formed, full-length, all-matching response) — the
              // cycle guard and presence check further downstream may still
              // reject, same as the ledger's own 3,068/722 count includes
              // only the length+echo guard, not every downstream bail.
              if (resp.length === orderedIds.length && echoOk) result.reachedSplice++

              const sentinel = runVariant(state, resp, orderedIds, wantParent, newIndex, 'sentinel')
              if (outcomesDiffer(real, sentinel)) result.diffSentinel++

              const controlPresence = runVariant(
                state,
                resp,
                orderedIds,
                wantParent,
                newIndex,
                'controlPresence',
              )
              if (outcomesDiffer(real, controlPresence)) result.diffControlPresence++
            }
          }
        }
      }
    }
  }
  return result
}

describe('reconcileBatchMove equivalence-ledger sweep (#3804 harness for #3759/#3799)', () => {
  it('reproduces the ledger claim two ways and proves the harness detects a real mutant', () => {
    const restricted = runSweep(false)
    const unrestricted = runSweep(true)

    console.log(`
[page-blocks-move reconcileBatchMove sweep]
  EQUIVALENT mutant under test (ArrayDeclaration, updatedBag = [] -> ['Stryker was here'], now page-blocks-move.ts:217):
    restricted to rootParentId: 'PAGE_1' only (factory-producible shape):
      total: ${restricted.total}  reached-splice: ${restricted.reachedSplice}  differing: ${restricted.diffSentinel}
    unrestricted (rootParentId: null allowed too):
      total: ${unrestricted.total}  reached-splice: ${unrestricted.reachedSplice}  differing: ${unrestricted.diffSentinel}
    ledger claims: 0 differing (restricted) / 526 differing (unrestricted) — on a different generator.

  VALIDATION CONTROL (ConditionalExpression, !present.has(id) -> false, now page-blocks-move.ts:232):
    restricted:   differing: ${restricted.diffControlPresence} / ${restricted.total}
    unrestricted: differing: ${unrestricted.diffControlPresence} / ${unrestricted.total}
`)

    // The control must fire — proves this harness can detect a real
    // divergence, not just report zero because it's too weak to find one.
    expect(restricted.diffControlPresence).toBeGreaterThan(0)
    expect(unrestricted.diffControlPresence).toBeGreaterThan(0)

    // The ledger's claim, restricted half: the shapes the real store factory
    // can produce (rootParentId always non-null) never distinguish the
    // sentinel mutant.
    expect(restricted.diffSentinel).toBe(0)

    // The ledger's claim, unrestricted half: allowing rootParentId: null
    // makes the sentinel block reachable from the DFS root and it DOES show
    // up as an observable difference (a thrown TypeError from `'depth' in
    // 'Stryker was here'`, or an extra id in the flat output — either way,
    // not the real function's result).
    expect(unrestricted.diffSentinel).toBeGreaterThan(0)
  })
})
