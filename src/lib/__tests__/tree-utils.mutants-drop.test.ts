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
  // Line 533 [ConditionalExpression]: `if (overIdxInWithout < 0)`. Forcing
  // the condition to always-true makes a normal drop target be treated as
  // "unknown target → append" — wrong insertAt/slot for a real id.
  it('does not treat a real overId as an unknown/sentinel target', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 0), mkFlat('B', null, 0), mkFlat('C', null, 0)]
    // Drag C UP onto B → before B → slot 1. A forced-true mutant would
    // instead append (slot 2).
    expect(computeDropIndex(items, null, 'B', 'C')).toBe(1)
  })

  // Line 539 [EqualityOperator]: `overIdxInItems > activeIndex ? +1 : same`.
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
  // Note: `overIdxInItems > activeIndex` -> `>=` is an equivalent mutant
  // (survives the mutation run; tree-utils.ts:537). The extra case needs
  // `overIdxInItems === activeIndex`. Two distinct ids can never share a
  // first *found* index, so that requires either `overId === activeId` or
  // both indices being -1 (neither id present in `items`). Both are excluded
  // before this line: `without` has every `activeId` row filtered out, and
  // an `overId` absent from `items` is absent from `without` too — so either
  // way `overIdxInWithout` is -1 and control takes the "unknown target"
  // branch above (line 533). Line 539 is never reached with the two indices
  // equal. Confirmed empirically, not just by argument (#3765): a canary
  // returning early on `overIdxInItems === activeIndex` fires 4 679 times
  // when spliced just before the `overIdxInWithout < 0` test, and zero times
  // at this line.

  // Line 545 [ConditionalExpression forced-true] and [LogicalOperator, `??`→`&&`]:
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
  // Note: `parentId === null` -> `false` is an equivalent mutant (survives
  // the mutation run; tree-utils.ts:543). When `parentId` IS null, forcing
  // the condition false just makes the mutant evaluate the else-arm instead:
  // `items.find((i) => i.id === null)` matches nothing (`FlatBlock['id']` is
  // a string), so `?? -1` yields the very -1 the then-arm would have
  // returned directly.
  // NOTE: the comment this replaces claimed the test above also kills line 554
  // [ConditionalExpression]. It doesn't — `insertAt` there stops the loop
  // before it ever reaches an item whose depth-check outcome would change.
  // See the dedicated test below.

  // Line 545 [UnaryOperator]: `find(...)?.depth ?? -1` → `?? +1`. The literal
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

  // Line 554 [ConditionalExpression]: `item.depth === childDepth` forced to
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

  // Line 545 [OptionalChaining]: removing `?.` from `find(...)?.depth` throws
  // when the parent id isn't found, instead of falling back via `?? -1`.
  it('does not throw when parentId has no matching item', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 0), mkFlat('B', null, 0)]
    expect(computeDropIndex(items, 'NOPE', 'B', 'A')).toBe(0)
  })

  // Line 552 [EqualityOperator]: `i < insertAt`. Picks a case where
  // `without[insertAt]` itself matches the parent/depth predicate, so
  // relaxing `i < insertAt` to `i <= insertAt` pulls in one extra match.
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

  it('sanity: SENTINEL_ID still appends after the last matching sibling', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 0), mkFlat('B', null, 0)]
    expect(computeDropIndex(items, null, SENTINEL_ID, 'B')).toBe(1)
  })
})

describe('SENTINEL_ID preconditions (#3794)', () => {
  // Issue #3793 (finding 3) removed the dedicated `overId === SENTINEL_ID`
  // branch: the sentinel never appears in `without` (it isn't a real block
  // id), so it always falls into the generic "unknown target → append"
  // path, which computes the identical `insertAt = without.length`. That
  // fold is only sound while SENTINEL_ID stays a value no *real* block id
  // can ever equal. Two ways that could break:
  //
  // 1. A block whose own id literally equals SENTINEL_ID. `blocks.id` has no
  //    CHECK constraint and sync ingest never ULID-validates, so this is NOT
  //    excluded by any declared, enforced id contract — it is excluded only
  //    in practice, by the same two mechanisms as (2) below: a
  //    locally-created block's id is always a freshly generated, strictly
  //    parsed ULID (`BlockId::from_string` → `Ulid::from_str`,
  //    agaric-engine/src/block_ops.rs), and a peer-supplied block's own id
  //    goes through the same untrusted-path ASCII-uppercasing described in
  //    (2), so an injected lowercase `__drop-after-last__` id would land
  //    uppercase and never collide. The uppercasing half of that is now
  //    pinned Rust-side by
  //    `sentinel_id_does_not_survive_untrusted_ingest_verbatim_3794`
  //    (src-tauri/agaric-core/src/ulid/tests.rs, #3794); the
  //    locally-generated-ULID half is still unasserted — it holds by
  //    construction, not by a fixture.
  // 2. A peer-supplied id that COLLIDES with SENTINEL_ID after normalization
  //    — the sync ingest paths accept peer-supplied block ids verbatim and
  //    ASCII-uppercase whatever they cannot parse as a ULID, so an injected
  //    `__drop-after-last__` arrives as `__DROP-AFTER-LAST__` and misses the
  //    case-sensitive `===` in `without.findIndex((i) => i.id === overId)`.
  //
  // Make an uppercase SENTINEL_ID fail here rather than silently invalidate
  // that fold.
  //
  // This covers only half the stated precondition: SENTINEL_ID itself
  // staying lowercase. The other half — the Rust normalization being relaxed
  // to preserve peer bytes verbatim — cannot be asserted from here, and is
  // pinned on the Rust side by
  // `sentinel_id_does_not_survive_untrusted_ingest_verbatim_3794`
  // (src-tauri/agaric-core/src/ulid/tests.rs, #3794). The two tests are a
  // pair; neither is sufficient alone.
  it('SENTINEL_ID is lowercase, so uppercased peer ids cannot collide', () => {
    expect(SENTINEL_ID).toBe(SENTINEL_ID.toLowerCase())
    expect(SENTINEL_ID).not.toBe(SENTINEL_ID.toUpperCase())
  })
})

/*
 * Issue #3793 retired two equivalence notes that used to live here:
 *
 * - The `overId === SENTINEL_ID` branch [ConditionalExpression] equivalence
 *   (previously tree-utils.ts:528, always-false direction): the branch
 *   itself is gone (finding 3) — the sentinel now falls through to the same
 *   "unknown target → append" code the equivalence argument described, so
 *   there is no separate mutant to be equivalent about.
 *
 * - The `i < insertAt && i < without.length` second bound
 *   [ConditionalExpression] equivalence (previously tree-utils.ts:548): the
 *   clause itself is gone (finding 2) — the loop is now just `i < insertAt`.
 *
 * Confirmed by the `tree-utils` mutation re-run: neither mutant exists in
 * the regenerated mutant population any more (fewer total mutants), and the
 * two equivalent mutants documented above (tree-utils.ts:539, :545) are the
 * only survivors left in this function.
 *
 * #3804 — every `Line N` citation throughout this file was itself off by +2
 * as of the #3887 commit that last touched them (verified by grepping the
 * literal expressions in the current file and in
 * `git show 525138ec7^:src/lib/tree-utils.ts`; the drift traces to
 * `computeDropIndex` gaining more lines internally, in its own doc comments,
 * than its start position lost from `simulateProjection`'s edit above it).
 * Corrected above. This is exactly the fragility #3804 was filed about — line
 * numbers drift even in the SAME commit that supposedly re-derived them, with
 * no gate to catch it. The fix there is a committed, re-runnable harness, not
 * another one-off hand count:
 * `scripts/mutation-harnesses/tree-utils-compute-drop-index.harness.ts`
 * reproduces both "0 differing inputs" claims (539:16, 545:23) over 352,000
 * generated inputs, with three known-Killed mutants (533:7, 552:19, 554:50)
 * firing as controls, and the 539 canary confirmed reachable (52,000 hits)
 * but never at the line itself (0 hits) — see that file's header for the
 * exact numbers and how they compare to this ledger's original figures (a
 * different generator, so the raw counts differ; the verdicts agree).
 */
