/**
 * Targeted mutation-kill tests for `computeDropIndex` (issue #3142).
 *
 * Each test is built to assert an EXACT index that differs between the
 * production code and one specific surviving mutant. See inline comments
 * for which mutant each test kills.
 */

import { describe, expect, it } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { computeDropIndex, type FlatBlock, SENTINEL_ID } from '@/lib/tree-utils'

function mkFlat(id: string, parentId: string | null, depth: number): FlatBlock {
  return makeBlock({ id, parent_id: parentId, depth })
}

describe('computeDropIndex mutants (#3142)', () => {
  // Line 521 [ConditionalExpression]: `if (overId === SENTINEL_ID)`.
  // Forcing the condition to always-true makes a normal drop target be
  // treated as "append after last" — wrong insertAt/slot for a real id.
  it('does not treat a real overId as the append-after-last sentinel', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 0), mkFlat('B', null, 0), mkFlat('C', null, 0)]
    // Drag C UP onto B → before B → slot 1. A forced-true mutant would
    // instead append (slot 2).
    expect(computeDropIndex(items, null, 'B', 'C')).toBe(1)
  })
  // Note: the always-false direction of this mutant is equivalent — SENTINEL_ID
  // never matches a real item id, so the "unknown target" else-branch also
  // resolves to `without.length`, identical to the sentinel branch. Differential
  // execution over 1 082 327 generated inputs (#3765) found the only inputs that
  // separate them are lists containing a block whose OWN id is SENTINEL_ID.
  // That is unrepresentable — but NOT because of a declared "id contract":
  // `blocks.id` has no CHECK constraint and the sync ingest paths never
  // ULID-validate. What actually excludes it is (a) the client-supplied-id
  // path parsing strictly (`BlockId::from_string` → `Ulid::from_str`,
  // agaric-engine/src/block_ops.rs), and (b) every untrusted path
  // (`BlockId::from_trusted` and the lenient `Deserialize` in
  // agaric-core/src/ulid.rs) ASCII-uppercasing whatever it cannot parse, so a
  // peer-supplied `__drop-after-last__` lands as `__DROP-AFTER-LAST__` and
  // misses this case-sensitive `===`. The whole margin is one
  // `to_ascii_uppercase()` that exists for hash canonicalization (#1558), not
  // for sentinel safety: if SENTINEL_ID ever becomes uppercase, or that
  // normalization is relaxed to preserve peer bytes, this mutant becomes
  // killable and the collision becomes a real bug. Left alive deliberately
  // rather than pinned as a guard on a state today's normalization forbids.

  // Line 531 [EqualityOperator]: `overIdxInItems > activeIndex ? +1 : same`.
  it('adds one when dragging downward past the target (overIdx > activeIndex)', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 0), mkFlat('B', null, 0), mkFlat('C', null, 0)]
    // Drag A DOWN onto C: overIdxInItems(2) > activeIndex(0) → drop AFTER C → slot 2.
    expect(computeDropIndex(items, null, 'C', 'A')).toBe(2)
  })

  it('omits the +1 when dragging upward before the target (overIdx < activeIndex)', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 0), mkFlat('B', null, 0), mkFlat('C', null, 0)]
    // Drag C UP onto A: overIdxInItems(0) < activeIndex(2) → drop BEFORE A → slot 0.
    expect(computeDropIndex(items, null, 'A', 'C')).toBe(0)
  })

  // Line 538 [ConditionalExpression forced-true] and [LogicalOperator, `??`→`&&`]:
  // `parentId === null ? -1 : (find(...)?.depth ?? -1)`. Using a parent with a
  // truthy depth (1) distinguishes both: forcing -1 always, or `1 && -1` (= -1
  // since `&&` returns the right side on a truthy left), both wrongly zero out
  // childDepth and produce the wrong slot.
  it('derives childDepth from the real parent depth (non-null, non-zero)', () => {
    const items: FlatBlock[] = [
      mkFlat('A', null, 0),
      mkFlat('P', 'A', 1),
      mkFlat('C1', 'P', 2),
      mkFlat('C2', 'P', 2),
      mkFlat('dragged', 'P', 2),
    ]
    // parentDepth(P)=1 → childDepth=2. Insert before C2 → only C1 (depth 2,
    // parent P) precedes it → slot 1. Both mutants above collapse childDepth
    // to 0, matching no item → slot 0.
    expect(computeDropIndex(items, 'P', 'C2', 'dragged')).toBe(1)
  })
  // NOTE: the comment this replaces claimed the test above also kills line 543
  // [ConditionalExpression]. It doesn't — `insertAt` there stops the loop
  // before it ever reaches an item whose depth-check outcome would change.
  // See the dedicated test below.

  // Line 538 [UnaryOperator]: `find(...)?.depth ?? -1` → `?? +1`. The literal
  // fallback only fires when the parent id has no matching item at all, so a
  // parent with a real (found) depth can't distinguish it — need a *missing*
  // parentId, plus a decoy item recorded under that same missing id, so the
  // resulting childDepth actually changes which items get counted.
  it('falls back to -1 (not +1) when parentId matches no item, changing which siblings count', () => {
    const items: FlatBlock[] = [
      mkFlat('A', null, 0),
      // No item has id 'GHOST' — parentDepth must come from the `?? -1`
      // fallback, not from a found item.
      mkFlat('ghostChild', 'GHOST', 0), // real: childDepth=-1+1=0 → matches, counts
      mkFlat('dragged', 'GHOST', 0),
    ]
    // Real: parentDepth = find('GHOST')?.depth ?? -1 = -1 → childDepth = 0.
    // 'ghostChild' (parent_id='GHOST', depth=0) matches → slot 1.
    // Mutant (?? +1): parentDepth = 1 → childDepth = 2. 'ghostChild' has
    // depth 0 ≠ 2 → doesn't match → slot 0.
    expect(computeDropIndex(items, 'GHOST', SENTINEL_ID, 'dragged')).toBe(1)
  })

  // Line 543 [ConditionalExpression]: `item.depth === childDepth` forced to
  // `true` drops the depth half of the sibling predicate, so an item whose
  // `parent_id` matches but whose recorded `depth` is stale/inconsistent
  // would wrongly count as a sibling. Needs a decoy positioned *before*
  // `insertAt` so the flip is actually observed (the existing "excludes the
  // item exactly at insertAt" test never puts a depth-mismatched item inside
  // the counted range).
  it('excludes an item whose parent_id matches but whose depth does not', () => {
    const items: FlatBlock[] = [
      mkFlat('A', null, 0),
      mkFlat('P', 'A', 1),
      // Same parent as C1, but a depth that couldn't really occur under P
      // (stale/inconsistent) — must NOT count as a depth-2 sibling of P.
      mkFlat('stale', 'P', 5),
      mkFlat('C1', 'P', 2),
      mkFlat('dragged', 'P', 2),
    ]
    // Real: childDepth = 2. Only C1 (parent_id='P', depth=2) counts → slot 1.
    // Mutant (depth check forced true): both 'stale' and C1 count → slot 2.
    expect(computeDropIndex(items, 'P', SENTINEL_ID, 'dragged')).toBe(1)
  })

  // Line 538 [OptionalChaining]: removing `?.` from `find(...)?.depth` throws
  // when the parent id isn't found, instead of falling back via `?? -1`.
  it('does not throw when parentId has no matching item', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 0), mkFlat('B', null, 0)]
    expect(computeDropIndex(items, 'NOPE', 'B', 'A')).toBe(0)
  })

  // Line 541 [EqualityOperator]: `i < insertAt && i < without.length`. Picks a
  // case where `without[insertAt]` itself matches the parent/depth predicate,
  // so relaxing `i < insertAt` to `i <= insertAt` pulls in one extra match.
  it('excludes the item exactly at insertAt from the sibling count', () => {
    const items: FlatBlock[] = [
      mkFlat('A', null, 0),
      mkFlat('P', 'A', 1),
      mkFlat('C1', 'P', 2),
      mkFlat('C2', 'P', 2),
      mkFlat('C3', 'P', 2),
      mkFlat('dragged', 'P', 2),
    ]
    // Drop before C1 (insertAt=2 in `without`): no matching siblings precede
    // it → slot 0. The `i <= insertAt` mutant would also test C1 itself
    // (matches parent P, depth 2) → slot 1.
    expect(computeDropIndex(items, 'P', 'C1', 'dragged')).toBe(0)
  })
  // Note: an `i < without.length` → `i <= without.length` mutant on the same
  // line is equivalent — `insertAt` is always <= `without.length` by
  // construction, so `i < insertAt` alone already guarantees `i < without.length`
  // whenever the loop body runs; the second bound never fires more permissively.

  it('sanity: SENTINEL_ID still appends after the last matching sibling', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 0), mkFlat('B', null, 0)]
    expect(computeDropIndex(items, null, SENTINEL_ID, 'B')).toBe(1)
  })

  // Tripwire for the equivalence argument recorded above (#3794). That argument
  // is only sound while SENTINEL_ID is lowercase: the sync ingest paths accept
  // peer-supplied block ids verbatim and ASCII-uppercase whatever they cannot
  // parse as a ULID, so an injected `__drop-after-last__` arrives as
  // `__DROP-AFTER-LAST__` and misses the case-sensitive `===`. Make an uppercase
  // SENTINEL_ID fail here rather than silently invalidate a comment: the
  // survivor at tree-utils.ts:528 would become reachable from untrusted data.
  it('precondition: SENTINEL_ID is lowercase, so uppercased peer ids cannot collide', () => {
    expect(SENTINEL_ID).toBe(SENTINEL_ID.toLowerCase())
    expect(SENTINEL_ID).not.toBe(SENTINEL_ID.toUpperCase())
  })
})

/*
 * Further equivalent mutants in `computeDropIndex` (issue #3765). No fixture
 * can distinguish these, so no test is added for them:
 *
 * - tree-utils.ts:538:18 [EqualityOperator]
 *   `overIdxInItems > activeIndex` -> `>=`. The extra case needs
 *   `overIdxInItems === activeIndex`. Two distinct ids can never share a first
 *   *found* index, so that requires either `overId === activeId` or both
 *   indices being -1 (neither id present in `items`). Both are excluded before
 *   line 538: `without` has every `activeId` row filtered out, and an `overId`
 *   absent from `items` is absent from `without` too — so either way
 *   `overIdxInWithout` is -1 and control takes the "unknown target" branch
 *   above. Line 538 is never reached with the two indices equal. Confirmed
 *   empirically, not just by argument: a canary returning early on
 *   `overIdxInItems === activeIndex` fires 4 679 times when spliced just
 *   before the `overIdxInWithout < 0` test, and zero times at line 538.
 *
 * - tree-utils.ts:545:23 [ConditionalExpression]
 *   `parentId === null` -> `false`. When `parentId` IS null the mutant merely
 *   evaluates the else-arm instead: `items.find((i) => i.id === null)` matches
 *   nothing (`FlatBlock['id']` is a string), so `?? -1` yields the very -1 the
 *   then-arm returns.
 *
 * - tree-utils.ts:548:35 [ConditionalExpression] `i < without.length` -> `true`:
 *   the same reasoning as the `i <= without.length` note above — `insertAt` is
 *   always <= `without.length`, so `i < insertAt` is the binding bound and the
 *   second clause cannot change the iteration count.
 *
 * Verified by differential execution over 1 082 327 generated inputs: zero
 * output differences.
 */
