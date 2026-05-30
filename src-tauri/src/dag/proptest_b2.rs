//! B2 property tests for [`walk_edit_chain`] and [`find_lca`]
//! (TEST-PROPTEST-B, issue #150).
//!
//! Where B1 (`reverse::proptest_b1`) exercises the *reverse* engine over
//! random VALID op chains, B2 targets the DAG-walk primitives and their
//! robustness against ADVERSARIAL input: corrupted / cyclic `prev_edit`
//! graphs that the harness's structurally-valid generator can never
//! produce. The walk must terminate and never panic on ANY such graph.
//!
//! Two generators feed the four property families:
//!
//! * [`adversarial_graph_strategy`] — an arbitrary directed `prev_edit`
//!   graph over a fixed seq range on a single device, with edges that may
//!   point forward, backward, to self, or nowhere. Inserted via raw SQL
//!   (bypassing hash verification, exactly as `dag/tests.rs`'s
//!   `find_lca_detects_cycle_in_chain` does) so cycles and dangling
//!   pointers can be constructed at will. Drives the termination and
//!   cycle-detection properties.
//! * The shared [`op_chain_strategy`] / [`seed_chain`] harness — real,
//!   structurally-valid chains. Drives the `find_lca` commutativity and
//!   the monotonic walk-order properties, which only make sense against a
//!   well-formed (acyclic, intact) chain.
//!
//! ## Contracts asserted (read from `dag.rs`, not invented)
//!
//! * **Termination.** `walk_edit_chain` issues a single recursive CTE
//!   bounded at `c.depth < MAX_LCA_STEPS`, then a Rust-side post-loop that
//!   also caps at `MAX_LCA_STEPS` and breaks on a repeated key. On ANY
//!   graph it therefore returns in bounded time — either `Ok(_)` or a
//!   bounded `Err` — never hangs, never panics. The returned ancestor
//!   `Vec` length is `< MAX_LCA_STEPS`.
//! * **Cycle handling.** The documented behaviour (dag.rs lines 202-208 +
//!   the `find_lca_detects_cycle_in_chain` / `_self_loop` unit tests) is:
//!   on revisiting an already-visited key the walk returns
//!   `WalkOutcome::Completed(prefix)` with the keys collected *before* the
//!   repeat — i.e. the visited prefix, NOT an error, NOT the repeated key.
//!   We assert the prefix has no duplicate entries and excludes the
//!   `start` anchor.
//! * **`find_lca` commutativity.** `find_lca(a, b) == find_lca(b, a)` on a
//!   valid chain. (Adapted from the issue's bare "commutativity": the
//!   public contract returns `Option<(String,i64)>`, and the algorithm is
//!   asymmetric internally — walk A fully, then walk B looking for the
//!   first hit. The property under test is that the *result* is
//!   order-independent.)
//! * **Monotonic ancestor depth / walk order.** `walk_edit_chain` returns
//!   ancestors `ORDER BY depth`. On a valid (acyclic) chain this means the
//!   returned `Vec` is exactly the `prev_edit`-pointer sequence in
//!   walk order: entry `i+1` is the `prev_edit` of entry `i`, strictly
//!   non-decreasing depth with no repeats. We assert that pointer-chain
//!   linkage directly (the strongest form of "monotonic depth" the code
//!   actually guarantees).
//!
//! ## proptest case count
//!
//! 32 cases (matching the B1/B3 siblings that stay green under full-suite
//! parallel load). Each adversarial case seeds up to ~16 raw rows and runs
//! several bounded walks; each valid-chain case seeds up to 16 harness ops
//! and runs `find_lca` over every head pair. The 64-case / 24-node sizing
//! intermittently tripped the nextest 60s wall under parallel load without
//! adding meaningful coverage for these bounded-termination properties.
//! Bump via `PROPTEST_CASES` for a deeper local search.

use super::*;
use crate::db::init_pool;
use crate::proptest_db_harness::{op_chain_strategy, seed_chain, HARNESS_DEVICE};
use proptest::prelude::*;
use std::path::PathBuf;
use tempfile::TempDir;
use tokio::runtime::Runtime;

const B2_CASES: u32 = 32;
const CHAIN_LEN: std::ops::RangeInclusive<usize> = 1..=16;

/// Device id for the adversarial raw-SQL graphs.
const ADV_DEVICE: &str = "adversarial-device";

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

// ---------------------------------------------------------------------------
// Adversarial `prev_edit` graph generator.
//
// A graph over seqs 1..=N on a single device. Each node carries an
// optional `prev_edit` pointer to ANY seq in 1..=N (or None). This admits
// forward edges, back edges, self-loops, and multi-node cycles — the exact
// corruption shapes a valid chain can never contain. Rows are inserted via
// raw SQL so no hash/structural validation rejects them.
// ---------------------------------------------------------------------------

/// One adversarial node: its `prev_edit` target seq (None ⇒ genesis edit
/// with `prev_edit = null`, terminating the chain cleanly).
#[derive(Debug, Clone)]
struct AdvNode {
    /// `Some(target_seq)` ⇒ `prev_edit = [ADV_DEVICE, target_seq]`.
    /// Target may equal this node's own seq (self-loop) or point forward.
    prev_target: Option<usize>,
}

/// A whole adversarial graph: node `i` has seq `i + 1`.
#[derive(Debug, Clone)]
struct AdvGraph {
    nodes: Vec<AdvNode>,
}

impl AdvGraph {
    fn len(&self) -> usize {
        self.nodes.len()
    }

    /// Insert all nodes into `op_log` via raw SQL. Node 0 (seq 1) is a
    /// `create_block` so a chain that walks back to it can terminate
    /// cleanly; every other node is an `edit_block` whose `prev_edit`
    /// follows `prev_target` (reduced modulo N so it always names a real
    /// seq, which is what makes back-edges/cycles reachable rather than
    /// dangling). A node with `prev_target = None` is a genesis edit
    /// (`prev_edit = null`).
    async fn insert(&self, pool: &SqlitePool) {
        let n = self.len();
        for (i, node) in self.nodes.iter().enumerate() {
            let seq = (i + 1) as i64;
            let (op_type, payload) = if i == 0 {
                (
                    "create_block",
                    r#"{"block_id":"B00000000000000000000000001","block_type":"content","parent_id":null,"position":1,"content":"genesis"}"#
                        .to_string(),
                )
            } else {
                let prev_json = match node.prev_target {
                    // Reduce modulo N so the pointer always names a real
                    // row in 1..=N (enables cycles); only `None` dangles
                    // off the end (clean genesis termination).
                    Some(t) => format!("[\"{ADV_DEVICE}\",{}]", (t % n) + 1),
                    None => "null".to_string(),
                };
                (
                    "edit_block",
                    format!(
                        r#"{{"block_id":"B00000000000000000000000001","to_text":"v{seq}","prev_edit":{prev_json}}}"#
                    ),
                )
            };
            // Hash is irrelevant to walk_edit_chain / find_lca (only
            // insert_remote_op verifies it); a placeholder keeps the row
            // well-typed for the schema.
            let hash = format!("advhash_{seq:08}");
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                 VALUES (?, ?, NULL, ?, ?, ?, 1736942400000)",
            )
            .bind(ADV_DEVICE)
            .bind(seq)
            .bind(&hash)
            .bind(op_type)
            .bind(&payload)
            .execute(pool)
            .await
            .expect("raw adversarial insert must succeed");
        }
    }
}

/// Strategy: graphs of 1..=16 nodes, each with an arbitrary (possibly
/// self/forward/back) `prev_edit` target or none.
fn adversarial_graph_strategy() -> impl Strategy<Value = AdvGraph> {
    let node = proptest::option::of(any::<usize>()).prop_map(|prev_target| AdvNode { prev_target });
    proptest::collection::vec(node, 1..=16).prop_map(|nodes| AdvGraph { nodes })
}

// ---------------------------------------------------------------------------
// Valid linear chain generator (for the monotonic-depth property).
//
// The shared harness emits every `edit_block` with `prev_edit = None`
// (genesis edits), so a harness chain's edit ancestry is always empty —
// useless for exercising multi-step walk order. To get a non-trivial,
// STRUCTURALLY VALID (acyclic, intact, properly back-pointing) edit chain
// we build one directly: a `create_block` at seq 1 followed by `len-1`
// `edit_block` ops each pointing `prev_edit` at the immediately preceding
// seq. Inserted via raw SQL (the harness cannot thread prev_edit), but the
// graph is fully well-formed — exactly the shape `find_lca` walks in
// production after a real edit history.
async fn insert_valid_linear_chain(pool: &SqlitePool, len: usize) {
    for seq in 1..=len as i64 {
        let (op_type, payload) = if seq == 1 {
            (
                "create_block",
                r#"{"block_id":"B00000000000000000000000001","block_type":"content","parent_id":null,"position":1,"content":"v1"}"#
                    .to_string(),
            )
        } else {
            let prev = seq - 1;
            (
                "edit_block",
                format!(
                    r#"{{"block_id":"B00000000000000000000000001","to_text":"v{seq}","prev_edit":["{ADV_DEVICE}",{prev}]}}"#
                ),
            )
        };
        let hash = format!("linhash_{seq:08}");
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES (?, ?, NULL, ?, ?, ?, 1736942400000)",
        )
        .bind(ADV_DEVICE)
        .bind(seq)
        .bind(&hash)
        .bind(op_type)
        .bind(&payload)
        .execute(pool)
        .await
        .expect("valid linear chain insert must succeed");
    }
}

// ---------------------------------------------------------------------------
// Shared assertions on a single walk outcome.
// ---------------------------------------------------------------------------

/// Assert a `WalkOutcome::Completed` chain obeys the termination + cycle
/// contract: bounded length, no `start` anchor, no duplicate keys (the
/// cycle-break guarantees each key is visited at most once).
fn assert_completed_invariants(
    start: &(String, i64),
    chain: &[(String, i64)],
) -> Result<(), TestCaseError> {
    // Bounded by the step cap (the Rust loop pushes at most
    // MAX_LCA_STEPS - 1 entries before the `steps >= MAX_LCA_STEPS` Err).
    prop_assert!(
        chain.len() < MAX_LCA_STEPS,
        "completed chain length {} must be < MAX_LCA_STEPS {}",
        chain.len(),
        MAX_LCA_STEPS
    );
    // The anchor `start` is never part of the returned ancestor list.
    prop_assert!(
        !chain.contains(start),
        "returned chain must exclude the start anchor {start:?}"
    );
    // Cycle-break ⇒ every visited key appears at most once.
    let mut seen = std::collections::HashSet::new();
    for key in chain {
        prop_assert!(
            seen.insert(key.clone()),
            "completed chain must contain no duplicate keys (cycle prefix); \
             duplicate {key:?} in {chain:?}"
        );
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: B2_CASES, .. ProptestConfig::default() })]

    /// Termination + cycle handling on ANY adversarial graph.
    ///
    /// For every node as a walk start, `walk_edit_chain` must return in
    /// bounded time with EITHER:
    ///   * `Ok(WalkOutcome::Completed(prefix))` — terminated cleanly, hit
    ///     a `create_block`/genesis, OR broke on a cycle; `prefix` obeys
    ///     [`assert_completed_invariants`] (bounded, no anchor, no dup), OR
    ///   * `Err(_)` — bounded fail-fast (missing-op error, op-type
    ///     corruption, or the explicit step-cap message).
    /// It must NEVER hang and NEVER panic. Running this over self-loop and
    /// multi-node-cycle graphs is exactly the cycle-detection property:
    /// the walk yields the visited prefix without looping forever.
    #[test]
    fn walk_edit_chain_terminates_on_any_graph(graph in adversarial_graph_strategy()) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let (pool, _dir) = test_pool().await;
            graph.insert(&pool).await;

            let n = graph.len();
            for i in 0..n {
                let start = (ADV_DEVICE.to_string(), (i + 1) as i64);
                // No early-exit predicate: walk the whole chain.
                let outcome = walk_edit_chain(&pool, &start, false, |_, _| false).await;
                match outcome {
                    Ok(WalkOutcome::Completed(chain)) => {
                        assert_completed_invariants(&start, &chain)?;
                    }
                    Ok(WalkOutcome::Stopped(_)) => {
                        // Predicate is constant-false; Stopped is impossible.
                        return Err(TestCaseError::fail(
                            "constant-false predicate must never Stop the walk",
                        ));
                    }
                    // A bounded error (missing op / corruption / step cap)
                    // is an acceptable terminating outcome — the contract is
                    // "terminates", not "always Ok".
                    Err(_) => {}
                }
            }
            Ok::<(), TestCaseError>(())
        })?;
    }

    /// `find_lca` is total + terminating on ANY adversarial graph: every
    /// ordered pair of nodes returns `Ok(_)`/`Err(_)` in bounded time,
    /// never hangs, never panics. (Mirrors the `find_lca_detects_cycle_*`
    /// unit tests, generalised over random cyclic/corrupt graphs.)
    #[test]
    fn find_lca_terminates_on_any_graph(graph in adversarial_graph_strategy()) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let (pool, _dir) = test_pool().await;
            graph.insert(&pool).await;

            let n = graph.len();
            // Bound the pair count so a 16-node graph stays well under the
            // nextest slow-timeout: sample a diagonal + a shifted diagonal.
            for i in 0..n {
                for j in [i, (i + 1) % n, (i + n / 2) % n] {
                    let a = (ADV_DEVICE.to_string(), (i + 1) as i64);
                    let b = (ADV_DEVICE.to_string(), (j + 1) as i64);
                    // Just assert it returns (does not hang / panic). The
                    // commutativity property is asserted on valid chains
                    // below, where the result is well-defined.
                    let _ = find_lca(&pool, &a, &b).await;
                }
            }
            Ok::<(), TestCaseError>(())
        })?;
    }

    /// `find_lca` commutativity on real, structurally-valid chains:
    /// `find_lca(a, b) == find_lca(b, a)` for every pair of edit/create
    /// ops in the seeded chain.
    #[test]
    fn find_lca_is_commutative_on_valid_chains(sketches in op_chain_strategy(CHAIN_LEN)) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let (pool, _dir) = test_pool().await;
            let chain = seed_chain(&pool, &sketches).await;

            // Only create_block / edit_block ops have a walkable edit
            // chain; find_lca rejects other op_types. Collect their seqs.
            let walkable: Vec<i64> = chain
                .records
                .iter()
                .filter(|r| r.op_type == "edit_block" || r.op_type == "create_block")
                .map(|r| r.seq)
                .collect();

            for (idx, &sa) in walkable.iter().enumerate() {
                for &sb in walkable.iter().skip(idx) {
                    let a = (HARNESS_DEVICE.to_string(), sa);
                    let b = (HARNESS_DEVICE.to_string(), sb);
                    let ab = find_lca(&pool, &a, &b).await;
                    let ba = find_lca(&pool, &b, &a).await;
                    match (ab, ba) {
                        (Ok(x), Ok(y)) => prop_assert_eq!(
                            x, y,
                            "find_lca must be commutative for ({}, {})", sa, sb
                        ),
                        (Err(ea), Err(eb)) => prop_assert_eq!(
                            ea.to_string(), eb.to_string(),
                            "find_lca error must be order-independent for ({}, {})", sa, sb
                        ),
                        (x, y) => return Err(TestCaseError::fail(format!(
                            "find_lca Ok/Err asymmetry for ({sa}, {sb}): {x:?} vs {y:?}"
                        ))),
                    }
                }
            }
            Ok::<(), TestCaseError>(())
        })?;
    }

    /// Monotonic ancestor depth / walk order on valid linear edit chains.
    ///
    /// `walk_edit_chain` returns ancestors `ORDER BY depth`. On a valid
    /// (acyclic, intact) linear chain `create(1) ← edit(2) ← … ← edit(L)`,
    /// walking from the head must yield ancestors in STRICTLY DECREASING
    /// seq order `L-1, L-2, …, 1` — which, because depth increases as seq
    /// decreases along this chain, is exactly "monotonically non-decreasing
    /// ancestor depth". We assert both halves: (a) the seq sequence is
    /// strictly decreasing (monotone depth, no repeats), and (b) it is the
    /// full back-pointer chain down to the genesis create, i.e. the walk
    /// neither stops early nor overshoots.
    #[test]
    fn walk_order_is_monotonic_on_valid_chain(len in 1usize..=16) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let (pool, _dir) = test_pool().await;
            insert_valid_linear_chain(&pool, len).await;

            // Walk from each node; ancestors of seq s are s-1, s-2, …, 1.
            for s in 1..=len as i64 {
                let start = (ADV_DEVICE.to_string(), s);
                let outcome = walk_edit_chain(&pool, &start, false, |_, _| false)
                    .await
                    .expect("valid intact linear chain must walk without error");
                let WalkOutcome::Completed(walked) = outcome else {
                    return Err(TestCaseError::fail("valid chain walk must Complete"));
                };

                // Structural invariants (bounded, no anchor, no dup).
                assert_completed_invariants(&start, &walked)?;

                // (a) Strictly decreasing seq == monotone increasing depth.
                let seqs: Vec<i64> = walked.iter().map(|(_, seq)| *seq).collect();
                for w in seqs.windows(2) {
                    prop_assert!(
                        w[0] > w[1],
                        "ancestor depth must be monotone (strictly decreasing seq along \
                         a linear chain); got {seqs:?}"
                    );
                }

                // (b) Full back-pointer chain: exactly s-1, s-2, …, 1.
                let expected: Vec<i64> = (1..s).rev().collect();
                prop_assert_eq!(
                    &seqs,
                    &expected,
                    "walk from seq {} must yield the complete ancestor chain", s
                );
            }
            Ok::<(), TestCaseError>(())
        })?;
    }
}
