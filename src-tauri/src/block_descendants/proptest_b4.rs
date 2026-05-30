//! B4 property tests for the `block_descendants` / `block_positions`
//! primitives (TEST-PROPTEST-B, issue #150).
//!
//! Three property families over **random valid block forests** inserted
//! directly into the `blocks` table, exercising:
//!
//! 1. **Descendant-closure exactness** — the standard recursive descendants
//!    CTE (`descendants_cte_standard!()`) returns *exactly* the set (and the
//!    correct per-node depth) that an independent BFS over the parent map
//!    yields from a random root: no missing node, no extra node, depth of
//!    every node equal to its hop-distance from the root.
//!
//! 2. **`_active` excludes soft-deleted** — after a random subset of blocks
//!    is soft-deleted, the active descendants CTE
//!    (`descendants_cte_active!()`) returns exactly the *active subtree
//!    closure*: the root (always, the base member has no `deleted_at`
//!    filter) plus every descendant reachable through a path of
//!    `deleted_at IS NULL` blocks. A soft-deleted node is neither emitted
//!    nor descended through — so its whole subtree is pruned. The depth of
//!    every emitted node still equals its hop-distance from the root.
//!
//! 3. **`next_sibling_position` never reuses an existing sibling position** —
//!    for a random parent with random existing children (some soft-deleted,
//!    some at the `NULL_POSITION_SENTINEL`, some at real positions),
//!    `next_sibling_position_excluding_sentinel` returns a position that
//!    collides with NO living non-sentinel sibling, and that is strictly
//!    greater than every such sibling's position (`MAX + 1`), per the
//!    helper's documented contract.
//!
//! ## Independent-oracle discipline
//!
//! Like B2/B3, every expected result is computed by a hand-rolled Rust
//! traversal of the generated parent map / sibling list — NOT by calling
//! the production code under test. The CTEs walk `blocks.parent_id`; the
//! oracle walks the in-memory `BTreeMap` the generator built. They are
//! independent, so a match is a genuine oracle comparison, not a tautology.
//!
//! ## Why a direct `blocks`-tree generator, not the op-log harness
//!
//! The shared `proptest_db_harness` seeds the **op_log**; it does not
//! materialise the `blocks` table that these CTEs walk. So — exactly as
//! B3 does — this file uses a self-contained random-forest generator that
//! inserts directly into `blocks`, with explicit control over `parent_id`,
//! `position`, and `deleted_at`. The shared harness is not touched.
//!
//! ## proptest case count
//!
//! 64 cases (matching B1/B3). Each case seeds a fresh TempDir SQLite pool
//! with a forest of up to ~24 blocks and runs the CTE from one or more
//! roots, comparing against the BFS oracle. Per-test wall-time stays in the
//! B2/B3 comfort zone (<~35s) at this sizing.

use crate::block_positions::next_sibling_position_excluding_sentinel;
use crate::db::init_pool;
use crate::pagination::NULL_POSITION_SENTINEL;
use crate::ulid::BlockId;
use proptest::prelude::*;
use sqlx::SqlitePool;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use tempfile::TempDir;
use tokio::runtime::Runtime;

const B4_CASES: u32 = 64;
/// Number of nodes in the generated forest.
const TREE_LEN: std::ops::RangeInclusive<usize> = 1..=24;

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

// ---------------------------------------------------------------------------
// Random valid block-forest generator.
//
// `NodeSketch` for node `i` picks its parent among the EARLIER nodes
// `0..i` (or root). Resolving in index order yields a strictly acyclic
// forest with no forward references — the create-before-use discipline
// `proptest_db_harness::ChainModel` and B3's `seed_tree` both enforce.
// Each node also carries an explicit `position` and a `deleted` flag so the
// active-CTE and sibling-position properties have something to chew on.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct NodeSketch {
    /// `None` => root; `Some(raw)` => parent is node `raw % i` (an earlier node).
    parent_choice: Option<usize>,
    /// Raw position seed; mapped to a 1-based position (or the sentinel) at
    /// seed time.
    position_raw: u8,
    /// Whether this block is soft-deleted (with a fixed timestamp).
    deleted: bool,
}

fn node_sketch_strategy() -> impl Strategy<Value = NodeSketch> {
    (
        proptest::option::of(any::<usize>()),
        any::<u8>(),
        // ~1 in 3 nodes is soft-deleted, so the active closure routinely
        // prunes whole subtrees (and the sibling-position scan routinely
        // has to skip deleted siblings).
        proptest::bool::weighted(0.33),
    )
        .prop_map(|(parent_choice, position_raw, deleted)| NodeSketch {
            parent_choice,
            position_raw,
            deleted,
        })
}

fn forest_strategy(
    len_range: std::ops::RangeInclusive<usize>,
) -> impl Strategy<Value = Vec<NodeSketch>> {
    proptest::collection::vec(node_sketch_strategy(), len_range)
}

/// Fixed tombstone for soft-deleted blocks.
const DELETED_AT: i64 = 1_577_836_800_000;

/// A realised forest: block ids in creation order, the resolved parent
/// map, the soft-deleted set, and each block's stored position.
struct Forest {
    /// Block ids in creation order.
    ids: Vec<String>,
    /// `child id -> parent id` (absent => root).
    parent: BTreeMap<String, String>,
    /// Soft-deleted ids.
    deleted: BTreeSet<String>,
    /// `block id -> stored position` (may be the sentinel).
    position: BTreeMap<String, i64>,
}

/// Map a raw position seed to a stored position. Most nodes get a real
/// 1-based position in `1..=24`; ~1 in 13 gets the `NULL_POSITION_SENTINEL`
/// so the sibling-position scan's sentinel-exclusion is exercised. Real
/// positions intentionally COLLIDE freely across the forest (the schema
/// permits it, and a robust `next_sibling_position` must still avoid the
/// living-sibling set) — that's the whole point of property 3.
fn map_position(raw: u8) -> i64 {
    if raw.is_multiple_of(13) {
        NULL_POSITION_SENTINEL
    } else {
        (raw % 24) as i64 + 1
    }
}

/// Resolve sketches into a concrete forest and insert every block into the
/// `blocks` table. Soft-deleted nodes are inserted with `deleted_at` set.
async fn seed_forest(pool: &SqlitePool, sketches: &[NodeSketch]) -> Forest {
    let ids: Vec<String> = (0..sketches.len())
        .map(|_| BlockId::new().as_str().to_string())
        .collect();
    let mut parent = BTreeMap::new();
    let mut deleted = BTreeSet::new();
    let mut position = BTreeMap::new();

    for (i, sketch) in sketches.iter().enumerate() {
        let id = &ids[i];
        let parent_id: Option<&str> = if i == 0 {
            None
        } else {
            sketch.parent_choice.map(|raw| ids[raw % i].as_str())
        };
        if let Some(pid) = parent_id {
            parent.insert(id.clone(), pid.to_string());
        }
        let pos = map_position(sketch.position_raw);
        position.insert(id.clone(), pos);
        let deleted_at: Option<i64> = if sketch.deleted {
            deleted.insert(id.clone());
            Some(DELETED_AT)
        } else {
            None
        };
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
             VALUES (?, 'content', 'b4', ?, ?, ?)",
        )
        .bind(id)
        .bind(parent_id)
        .bind(pos)
        .bind(deleted_at)
        .execute(pool)
        .await
        .expect("insert block must succeed for a well-formed B4 forest");
    }

    Forest {
        ids,
        parent,
        deleted,
        position,
    }
}

impl Forest {
    /// `parent id -> [child ids]` adjacency, in deterministic order.
    fn children(&self) -> BTreeMap<&str, Vec<&str>> {
        let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (child, par) in &self.parent {
            children.entry(par.as_str()).or_default().push(child);
        }
        children
    }

    /// Independent oracle for `descendants_cte_standard!()`: the closure of
    /// `root` (inclusive) over the parent map, with each node's BFS depth
    /// (root = 0). Plain BFS — no `deleted_at` awareness, matching the
    /// standard CTE which ignores `deleted_at` entirely.
    fn descendant_depths(&self, root: &str) -> BTreeMap<String, i64> {
        let children = self.children();
        let mut depth = BTreeMap::new();
        depth.insert(root.to_string(), 0i64);
        // FIFO BFS so the first depth assigned to a node is the minimal hop
        // distance — in an acyclic forest each node is reachable by exactly
        // one path, so depth is unambiguous regardless of traversal order.
        let mut frontier = std::collections::VecDeque::new();
        frontier.push_back(root.to_string());
        while let Some(node) = frontier.pop_front() {
            let d = depth[&node];
            if let Some(kids) = children.get(node.as_str()) {
                for &kid in kids {
                    if !depth.contains_key(kid) {
                        depth.insert(kid.to_string(), d + 1);
                        frontier.push_back(kid.to_string());
                    }
                }
            }
        }
        depth
    }

    /// Independent oracle for `descendants_cte_active!()`: the closure of
    /// `root` (inclusive) reachable through a path of NON-deleted blocks,
    /// with BFS depth. The root is ALWAYS included even if soft-deleted
    /// (the CTE's base member `WHERE id = ?` has no `deleted_at` filter);
    /// the recursive member only descends INTO and emits children whose
    /// `deleted_at IS NULL`, so a deleted child is neither emitted nor
    /// descended through (its whole subtree is pruned).
    fn active_descendant_depths(&self, root: &str) -> BTreeMap<String, i64> {
        let children = self.children();
        let mut depth = BTreeMap::new();
        depth.insert(root.to_string(), 0i64);
        let mut frontier = std::collections::VecDeque::new();
        frontier.push_back(root.to_string());
        while let Some(node) = frontier.pop_front() {
            let d = depth[&node];
            if let Some(kids) = children.get(node.as_str()) {
                for &kid in kids {
                    // Recursive member filters `b.deleted_at IS NULL`: skip
                    // deleted children entirely (no emit, no descent).
                    if self.deleted.contains(kid) {
                        continue;
                    }
                    if !depth.contains_key(kid) {
                        depth.insert(kid.to_string(), d + 1);
                        frontier.push_back(kid.to_string());
                    }
                }
            }
        }
        depth
    }

    /// Independent oracle for `next_sibling_position_excluding_sentinel`:
    /// `MAX(position) + 1` over LIVING (non-deleted), NON-sentinel children
    /// of `parent` (None => top-level), or `1` when there are none.
    fn expected_next_sibling_position(&self, parent: Option<&str>) -> i64 {
        let max = self
            .ids
            .iter()
            .filter(|id| {
                // Same parent (NULL parent for top-level).
                let p = self.parent.get(*id).map(String::as_str);
                p == parent
            })
            .filter(|id| !self.deleted.contains(*id))
            .filter_map(|id| self.position.get(id).copied())
            .filter(|&pos| pos != NULL_POSITION_SENTINEL)
            .max();
        max.unwrap_or(0) + 1
    }
}

/// Run the standard descendants CTE for `root` and return `id -> depth`.
async fn query_descendants_standard(pool: &SqlitePool, root: &str) -> BTreeMap<String, i64> {
    let rows: Vec<(String, i64)> = sqlx::query_as(concat!(
        crate::descendants_cte_standard!(),
        "SELECT id, depth FROM descendants"
    ))
    .bind(root)
    .fetch_all(pool)
    .await
    .expect("standard descendants CTE must execute");
    rows.into_iter().collect()
}

/// Run the active descendants CTE for `root` and return `id -> depth`.
async fn query_descendants_active(pool: &SqlitePool, root: &str) -> BTreeMap<String, i64> {
    let rows: Vec<(String, i64)> = sqlx::query_as(concat!(
        crate::descendants_cte_active!(),
        "SELECT id, depth FROM descendants"
    ))
    .bind(root)
    .fetch_all(pool)
    .await
    .expect("active descendants CTE must execute");
    rows.into_iter().collect()
}

proptest! {
    #![proptest_config(ProptestConfig { cases: B4_CASES, .. ProptestConfig::default() })]

    /// Property 1 — descendant-closure exactness. For a random forest and
    /// EVERY block as a root, `descendants_cte_standard!()` returns exactly
    /// the BFS closure (inclusive of the root) with the correct per-node
    /// depth. No missing node, no extra node, correct depth.
    #[test]
    fn descendants_standard_matches_bfs_closure(sketches in forest_strategy(TREE_LEN)) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let (pool, _dir) = test_pool().await;
            let forest = seed_forest(&pool, &sketches).await;

            for root in &forest.ids {
                let expected = forest.descendant_depths(root);
                let actual = query_descendants_standard(&pool, root).await;
                prop_assert_eq!(
                    actual,
                    expected,
                    "standard descendants CTE from root {} must equal the BFS \
                     closure (ids AND depths)",
                    root
                );
            }
            Ok::<(), TestCaseError>(())
        })?;
    }

    /// Property 2 — `_active` excludes soft-deleted descendants. For a
    /// forest with a random soft-deleted subset and EVERY block as a root,
    /// `descendants_cte_active!()` returns exactly the active-subtree
    /// closure: the root (always) plus every descendant reachable through a
    /// path of non-deleted blocks, with correct depth. Soft-deleted nodes
    /// AND their subtrees are pruned.
    #[test]
    fn descendants_active_excludes_soft_deleted_subtrees(sketches in forest_strategy(TREE_LEN)) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let (pool, _dir) = test_pool().await;
            let forest = seed_forest(&pool, &sketches).await;

            for root in &forest.ids {
                let expected = forest.active_descendant_depths(root);
                let actual = query_descendants_active(&pool, root).await;

                // Exact id+depth match against the independent active-BFS.
                prop_assert_eq!(
                    &actual,
                    &expected,
                    "active descendants CTE from root {} must equal the active-BFS \
                     closure (ids AND depths)",
                    root
                );

                // Cross-check the defining contract directly: no emitted
                // node other than the root is soft-deleted, and the result
                // is a subset of the standard closure (active only ever
                // prunes, never adds).
                let standard = forest.descendant_depths(root);
                for id in actual.keys() {
                    prop_assert!(
                        standard.contains_key(id),
                        "active result {id} must be a subset of the standard closure"
                    );
                    if id != root {
                        prop_assert!(
                            !forest.deleted.contains(id),
                            "active descendants CTE must never emit a soft-deleted \
                             non-root node {id}"
                        );
                    }
                }
            }
            Ok::<(), TestCaseError>(())
        })?;
    }

    /// Property 3 — `next_sibling_position` never reuses an existing sibling
    /// position. For a random forest and EVERY distinct parent (including
    /// the top-level NULL parent), the computed next position collides with
    /// NO living non-sentinel sibling, and equals `MAX(living non-sentinel
    /// sibling position) + 1` (the helper's documented `MAX + 1`/fallback-1
    /// contract).
    #[test]
    fn next_sibling_position_never_collides(sketches in forest_strategy(TREE_LEN)) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let (pool, _dir) = test_pool().await;
            let forest = seed_forest(&pool, &sketches).await;

            // The set of parents to probe: every block (as a potential
            // parent of its children) plus the top-level NULL parent.
            let mut parents: Vec<Option<&str>> = vec![None];
            for id in &forest.ids {
                parents.push(Some(id.as_str()));
            }

            for parent in parents {
                let next = next_sibling_position_excluding_sentinel(&pool, parent)
                    .await
                    .expect("next_sibling_position helper must execute");

                // (a) Matches the independent MAX+1 / fallback-1 oracle.
                let expected = forest.expected_next_sibling_position(parent);
                prop_assert_eq!(
                    next,
                    expected,
                    "next_sibling_position for parent {:?} must equal the independent \
                     MAX(living non-sentinel sibling)+1 oracle",
                    parent
                );

                // (b) Always >= 1 (1-based positions only).
                prop_assert!(
                    next >= 1,
                    "next_sibling_position must be 1-based, got {next}"
                );

                // (c) Collides with NO living non-sentinel sibling.
                for id in &forest.ids {
                    let p = forest.parent.get(id).map(String::as_str);
                    if p != parent {
                        continue;
                    }
                    if forest.deleted.contains(id) {
                        continue;
                    }
                    let pos = forest.position[id];
                    if pos == NULL_POSITION_SENTINEL {
                        continue;
                    }
                    prop_assert!(
                        next != pos,
                        "next_sibling_position {next} for parent {parent:?} collides \
                         with living non-sentinel sibling {id} at position {pos}"
                    );
                }
            }
            Ok::<(), TestCaseError>(())
        })?;
    }
}
