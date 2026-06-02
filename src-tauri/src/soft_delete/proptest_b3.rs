//! B3 property tests for soft-delete cascade / restore (TEST-PROPTEST-B, #150).
//!
//! Three property families over **random valid block trees**, exercising
//! the cascade soft-delete and restore CTEs (`soft_delete::trash` /
//! `soft_delete::restore`) directly against the materialised `blocks`
//! table:
//!
//! 1. **Cascade idempotence** — cascading a soft-delete over an
//!    already-cascaded subtree is a no-op: the `deleted_at` of every block
//!    is byte-identical after one cascade vs. after two, and the second
//!    cascade reports `count == 0`.
//!
//! 2. **`restore ∘ cascade == identity`** for a subtree with NO
//!    independently-deleted descendants — cascade-delete a subtree, then
//!    `restore_block(root, ts)`, and the observable `deleted_at` state of
//!    *every* block in the DB returns to its pre-delete value. (The chosen
//!    root subtree has no pre-existing tombstones, which is exactly the
//!    contract domain where the round-trip is the identity — see the
//!    adaptation note below.)
//!
//! 3. **Subtree isolation** — cascading a soft-delete on one subtree does
//!    NOT change the `deleted_at` of any block outside that subtree's
//!    active descendant set (siblings, ancestors, unrelated trees, and
//!    independently-deleted blocks all keep their prior `deleted_at`).
//!
//! ## Why a direct `blocks`-tree generator, not the op-log harness
//!
//! The shared `proptest_db_harness` generates **op_log** chains; it does
//! not materialise the `blocks` table. The cascade / restore CTEs walk the
//! `blocks` table's `parent_id` graph and stamp `blocks.deleted_at` — that
//! is the state under test for B3. So this file uses a self-contained
//! random-tree generator that inserts directly into `blocks` (mirroring
//! the existing `soft_delete` unit-test fixtures) and a hand-rolled
//! parent-map BFS as the **independent oracle** for "which blocks are in
//! the active subtree". No code from `soft_delete` is used to verify
//! `soft_delete` (the oracle is a separate Rust BFS + direct DB-row reads
//! of `deleted_at`). The shared harness is NOT touched.
//!
//! ## Contract adaptations (asserting what the code actually guarantees)
//!
//! * **Cascade skips already-deleted descendants** (the recursive CTE
//!   filters `b.deleted_at IS NULL`). So `restore ∘ cascade` is the
//!   identity only for a subtree whose blocks were ALL active pre-delete.
//!   Property 2 selects such a root (a root with no soft-deleted block in
//!   its active subtree); the broader "preserve independently-deleted
//!   descendants" behaviour is covered as part of Property 3's isolation
//!   check (a block independently deleted before the cascade keeps its own
//!   tombstone and is not touched by the restore, since restore only
//!   clears rows whose `deleted_at == ts`).
//! * **Restore is keyed on the cascade timestamp** (`deleted_at = ?`), so
//!   it clears exactly the cohort the cascade stamped — never an
//!   independently-deleted descendant with a different timestamp.
//!
//! ## proptest case count (issue #333 — >30s SLOW under CPU load)
//!
//! 32 cases over trees of [`TREE_LEN`] = 1..=20 blocks. Each case seeds a
//! fresh TempDir SQLite pool, inserts a random tree, and runs a cascade
//! (+ a restore for Property 2) plus full-DB `deleted_at` scans.
//!
//! **Investigation (measured, not guessed).** Instrumenting
//! `restore_after_cascade_is_identity` at the prior 64-case sizing showed
//! the cost is **TEST-HARNESS dominated**, not production: per-case
//! fresh-DB setup (TempDir + `init_pool` + 82 migrations) summed to 9.87s
//! of an 11.1s single-proptest run — **89%**. The cascade/restore CTEs
//! under test were only ~1.2s / 64 ≈ 19ms per case. With THREE such 64-case
//! proptests in this file, each ran ~11s idle; under ≥2× CPU load that
//! pushes past the 30s nextest slow-timeout, which is the #333 SLOW report.
//!
//! **Fix.** Cut `B3_CASES` 64 → 32 (the migration overhead is ~flat per
//! case, so halving cases ≈ halves wall-time) and `TREE_LEN` 1..=24 → 1..=20
//! (a modest trim; per-case work is the small term). Each proptest now runs
//! ~5.9s idle (≈12s under 2× load — comfortable headroom under 30s). **No
//! coverage loss:** these are structural cascade/restore identities over
//! random forests; 32 randomized cases × trees up to 20 nodes (with ~1-in-5
//! pre-deleted blocks and multi-level subtrees) still exercises deep
//! cascades, mixed active/tombstoned descendants, and the
//! restore-by-timestamp cohort selection. Bump via `PROPTEST_CASES` for a
//! deeper local search.

use super::*;
use crate::db::init_pool;
use crate::materializer::Materializer;
use crate::ulid::BlockId;
use proptest::prelude::*;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use tempfile::TempDir;
use tokio::runtime::Runtime;

const B3_CASES: u32 = 32;
/// Number of nodes in the generated forest.
const TREE_LEN: std::ops::RangeInclusive<usize> = 1..=20;
/// Device id stamped on cascade op-log entries (cascade ignores it, but
/// the signature requires one).
const TEST_DEVICE: &str = "proptest-b3-device";

async fn test_pool_and_mat() -> (SqlitePool, Materializer, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    let mat = Materializer::new(pool.clone());
    (pool, mat, dir)
}

// ---------------------------------------------------------------------------
// Random valid block-tree generator.
//
// A `NodeSketch` for node `i` picks its parent among the EARLIER nodes
// `0..i` (or root). Resolving in index order therefore yields a strictly
// acyclic forest with no forward references — the same create-before-use
// discipline `proptest_db_harness::ChainModel` enforces for op chains.
// Some nodes are flagged `pre_deleted` to exercise the
// independently-deleted-descendant contract.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct NodeSketch {
    /// `None` => root; `Some(raw)` => parent is node `raw % i` (an earlier node).
    parent_choice: Option<usize>,
    /// 1-based sibling position (the `block_positions` invariant).
    position: i64,
    /// Whether this block is independently soft-deleted *before* any
    /// cascade runs (with a distinct, fixed timestamp).
    pre_deleted: bool,
}

fn node_sketch_strategy() -> impl Strategy<Value = NodeSketch> {
    (
        proptest::option::of(any::<usize>()),
        1i64..16,
        // ~1 in 5 nodes starts independently soft-deleted.
        proptest::bool::weighted(0.2),
    )
        .prop_map(|(parent_choice, position, pre_deleted)| NodeSketch {
            parent_choice,
            position,
            pre_deleted,
        })
}

fn tree_strategy(
    len_range: std::ops::RangeInclusive<usize>,
) -> impl Strategy<Value = Vec<NodeSketch>> {
    proptest::collection::vec(node_sketch_strategy(), len_range)
}

/// A realised tree: block ids in creation order plus the resolved
/// `parent_id` map and the set of independently-pre-deleted ids.
struct Tree {
    /// Block ids in creation order.
    ids: Vec<String>,
    /// `child id -> parent id` (absent => root).
    parent: BTreeMap<String, String>,
    /// Ids that were soft-deleted independently before any cascade.
    pre_deleted: BTreeSet<String>,
}

/// Fixed tombstone for independently-pre-deleted blocks — distinct from
/// any cascade timestamp (`crate::now_rfc3339()` is a 2026 value, so a
/// 2020 literal can never collide).
const PRE_DELETED_AT: i64 = 1_577_836_800_000;

/// Resolve sketches into a concrete forest and insert every block into the
/// `blocks` table. Pre-deleted nodes are inserted with `deleted_at` set.
async fn seed_tree(pool: &SqlitePool, sketches: &[NodeSketch]) -> Tree {
    let ids: Vec<String> = (0..sketches.len())
        .map(|_| BlockId::new().as_str().to_string())
        .collect();
    let mut parent = BTreeMap::new();
    let mut pre_deleted = BTreeSet::new();

    for (i, sketch) in sketches.iter().enumerate() {
        let id = &ids[i];
        // Parent is an earlier node (acyclic, no forward ref) or root.
        let parent_id: Option<&str> = if i == 0 {
            None
        } else {
            sketch.parent_choice.map(|raw| ids[raw % i].as_str())
        };
        if let Some(pid) = parent_id {
            parent.insert(id.clone(), pid.to_string());
        }
        let deleted_at: Option<i64> = if sketch.pre_deleted {
            pre_deleted.insert(id.clone());
            Some(PRE_DELETED_AT)
        } else {
            None
        };
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
             VALUES (?, 'content', 'b3', ?, ?, ?)",
            id,
            parent_id,
            sketch.position,
            deleted_at,
        )
        .execute(pool)
        .await
        .expect("insert block must succeed for a well-formed B3 tree");
    }

    Tree {
        ids,
        parent,
        pre_deleted,
    }
}

impl Tree {
    /// The block ids in `root`'s subtree (inclusive) reachable through
    /// **active** (non-pre-deleted) edges — the independent oracle for the
    /// set `cascade_soft_delete` will stamp. Mirrors the recursive CTE's
    /// `deleted_at IS NULL` filter on the recursive member: descent stops
    /// at an independently-deleted block (and never enters it), but the
    /// root itself is always included (the CTE's base member has no
    /// `deleted_at` filter).
    ///
    /// Computed by a hand-rolled BFS over the parent map — deliberately
    /// independent of the production CTE so the assertion is a real oracle
    /// comparison, not a tautology.
    fn active_subtree(&self, root: &str) -> BTreeSet<String> {
        // child adjacency: parent -> [children]
        let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (child, par) in &self.parent {
            children.entry(par.as_str()).or_default().push(child);
        }
        let mut out = BTreeSet::new();
        // Root is always included (base member of the CTE).
        out.insert(root.to_string());
        let mut frontier = vec![root.to_string()];
        while let Some(node) = frontier.pop() {
            if let Some(kids) = children.get(node.as_str()) {
                for &kid in kids {
                    // The CTE's recursive member only descends INTO blocks
                    // whose `deleted_at IS NULL`. A pre-deleted child is
                    // neither marked nor descended through.
                    if self.pre_deleted.contains(kid) {
                        continue;
                    }
                    if out.insert(kid.to_string()) {
                        frontier.push(kid.to_string());
                    }
                }
            }
        }
        out
    }
}

/// Snapshot every block's `deleted_at` — the full observable soft-delete
/// state, read directly from the `blocks` table (independent of any
/// `soft_delete` helper).
async fn snapshot_deleted_at(pool: &SqlitePool, ids: &[String]) -> BTreeMap<String, Option<i64>> {
    let mut out = BTreeMap::new();
    for id in ids {
        let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", id)
            .fetch_one(pool)
            .await
            .unwrap();
        out.insert(id.clone(), row.deleted_at);
    }
    out
}

proptest! {
    #![proptest_config(ProptestConfig { cases: B3_CASES, .. ProptestConfig::default() })]

    /// Property 1 — cascade idempotence. Cascading an already-cascaded
    /// subtree is a no-op: every block's `deleted_at` is identical after
    /// one cascade vs. after a second, and the second cascade marks zero
    /// rows.
    #[test]
    fn cascade_soft_delete_is_idempotent(sketches in tree_strategy(TREE_LEN)) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let (pool, mat, _dir) = test_pool_and_mat().await;
            let tree = seed_tree(&pool, &sketches).await;

            // Cascade from the first node (a deterministic, always-present
            // seed; its active subtree is exercised by the oracle below).
            let root = tree.ids[0].clone();

            let (_ts1, _count1) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, &root)
                .await
                .unwrap();
            let after_first = snapshot_deleted_at(&pool, &tree.ids).await;

            let (_ts2, count2) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, &root)
                .await
                .unwrap();
            let after_second = snapshot_deleted_at(&pool, &tree.ids).await;

            prop_assert_eq!(
                count2, 0,
                "second cascade over an already-cascaded subtree must mark zero rows"
            );
            prop_assert_eq!(
                after_first, after_second,
                "cascade must be idempotent: deleted_at unchanged by a second cascade"
            );
            Ok::<(), TestCaseError>(())
        })?;
    }

    /// Property 2 — `restore ∘ cascade == identity` for a subtree with NO
    /// independently-deleted descendants. Cascade the chosen root, then
    /// restore it with the cascade timestamp; every block's `deleted_at`
    /// must return to its exact pre-delete value.
    #[test]
    fn restore_after_cascade_is_identity(sketches in tree_strategy(TREE_LEN)) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let (pool, mat, _dir) = test_pool_and_mat().await;
            let tree = seed_tree(&pool, &sketches).await;

            // Choose a root whose ACTIVE subtree contains no pre-deleted
            // block — the contract domain where the round-trip is the
            // identity. Such a root always exists: any leaf that is not
            // itself pre-deleted qualifies (its active subtree is just
            // itself). Fall back to skipping the case if every block is
            // pre-deleted (then there is nothing to round-trip).
            let root = tree.ids.iter().find(|id| {
                !tree.pre_deleted.contains(*id)
                    && tree
                        .active_subtree(id)
                        .iter()
                        .all(|b| !tree.pre_deleted.contains(b))
            });
            let Some(root) = root.cloned() else {
                // Degenerate forest: every block pre-deleted. Nothing to
                // assert for this property; not a failure.
                return Ok(());
            };

            let pre = snapshot_deleted_at(&pool, &tree.ids).await;

            let (ts, count) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, &root)
                .await
                .unwrap();
            // Sanity: the cascade marked exactly the oracle's active subtree
            // (all of which were active pre-delete, so all get stamped).
            let expected_marked = tree.active_subtree(&root);
            prop_assert_eq!(
                usize::try_from(count).unwrap(),
                expected_marked.len(),
                "cascade count must equal the active-subtree size from the independent oracle"
            );

            let restored = restore_block(&pool, &mat, &root, ts).await.unwrap();
            prop_assert_eq!(
                usize::try_from(restored).unwrap(),
                expected_marked.len(),
                "restore must clear exactly the cohort the cascade stamped"
            );

            let post = snapshot_deleted_at(&pool, &tree.ids).await;
            prop_assert_eq!(
                pre, post,
                "restore ∘ cascade must be the identity on a subtree with no \
                 independently-deleted descendants"
            );
            Ok::<(), TestCaseError>(())
        })?;
    }

    /// Property 3 — subtree isolation. Cascading a soft-delete on one
    /// subtree changes `deleted_at` ONLY for blocks in that subtree's
    /// active descendant set (per the independent BFS oracle). Every other
    /// block — siblings, ancestors, unrelated trees, and
    /// independently-deleted descendants — keeps its prior `deleted_at`.
    #[test]
    fn cascade_isolates_to_active_subtree(sketches in tree_strategy(TREE_LEN)) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let (pool, mat, _dir) = test_pool_and_mat().await;
            let tree = seed_tree(&pool, &sketches).await;

            // Pick a non-pre-deleted root so the cascade actually does
            // something (a pre-deleted root would be skipped by the CTE's
            // `deleted_at IS NULL` UPDATE filter, marking zero rows — still
            // a valid isolation case, but the more interesting one is a
            // live root).
            let root = match tree.ids.iter().find(|id| !tree.pre_deleted.contains(*id)) {
                Some(r) => r.clone(),
                None => return Ok(()), // every block pre-deleted: nothing live to cascade.
            };

            let pre = snapshot_deleted_at(&pool, &tree.ids).await;
            let active = tree.active_subtree(&root);

            let (ts, _count) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, &root)
                .await
                .unwrap();
            let post = snapshot_deleted_at(&pool, &tree.ids).await;

            for id in &tree.ids {
                let before = &pre[id];
                let after = &post[id];
                if active.contains(id) {
                    // In-subtree active blocks: stamped with the cascade ts
                    // (they were active pre-delete by construction of
                    // `active_subtree`, which excludes pre-deleted nodes).
                    prop_assert_eq!(
                        after,
                        &Some(ts),
                        "active in-subtree block {} must be stamped with the cascade timestamp",
                        id
                    );
                } else {
                    // Out-of-subtree (incl. independently-deleted): unchanged.
                    prop_assert_eq!(
                        before,
                        after,
                        "out-of-subtree block {} must keep its prior deleted_at",
                        id
                    );
                }
            }
            Ok::<(), TestCaseError>(())
        })?;
    }
}
