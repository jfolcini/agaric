//! #3346 — the batch-vs-fold equivalence ORACLE.
//!
//! Every bulk command in this codebase is an optimisation of a loop. The
//! contract is always the same: running the bulk function once over
//! `[a, b, c]` must leave the world in the state the single-item sibling
//! would have left it in if called three times. Nothing enforced that
//! contract. Where a bulk path re-implements the single path's SQL instead
//! of calling it (`delete_blocks_by_ids_inner`'s combined multi-root
//! cascade, `compute_reverse_batch`'s hand-copied prior-state kernels), the
//! two bodies drift silently and the divergence surfaces as a data bug
//! months later — #3280 is exactly that: the batch reverse kernel never read
//! `payload.prev_edit`, so undo-from-a-selection restored different text than
//! undo-one-at-a-time, for a year.
//!
//! This module is the generic oracle. A scenario supplies THREE closures:
//!
//! * `seed` — build identical starting state, run once per arm;
//! * `batch` — call the bulk function ONCE;
//! * `fold`  — call the single-item sibling in a LOOP over the same inputs.
//!
//! Each arm gets its OWN pool + `Materializer` (so the two Loro engines can
//! never bleed into each other), and the harness then compares the resulting
//! observable state and reports a LOCALISED diff — table, row key, column,
//! both values — rather than an `assert_eq!` on two opaque `Vec`s.
//!
//! # The three states of the bulk inventory
//!
//! Not every bulk function needs an oracle, and the ones that do need it for
//! different reasons:
//!
//! * **Already folded** — `create_blocks_batch_inner`,
//!   `move_blocks_batch_inner` and `add_tags_by_ids_inner` loop over the very
//!   same `*_in_tx` helper the single path uses. The fold IS the
//!   implementation.
//! * **Genuinely forked** — `delete_blocks_by_ids_inner` (a documented,
//!   permanent #2325/#2250 exception: one combined multi-root cascade instead
//!   of N `apply_op_projected` calls), `restore_blocks_by_ids_inner` (the
//!   same shape, with NO such comment), `purge_blocks_by_ids_inner` (below),
//!   and `compute_reverse_batch` (six hand-copied prior-state SQL kernels).
//!   These are what this module covers.
//! * **Converged in the CASCADE but not in the MEMBER SET** — the purge
//!   family. `purge_blocks_by_ids_inner`, `purge_block_inner` and
//!   `purge_all_deleted_inner` really do run one shared
//!   `block_cleanup::purge_subtree_tables` chain, and this module's first
//!   inventory recorded the batch path `converged` on that basis. That was
//!   WRONG, and instructively so: a shared cascade is only as converged as the
//!   member set it is aimed at, and the two purge paths compute that set with
//!   two independently-written recursive CTEs (`descendants_cte_purge!()`
//!   vs a `json_each(?1)`-seeded inline copy) plus a batch-only depth guard.
//!   `converged` there did not describe a fork that could not happen — it
//!   silenced one, permanently, which is worse than recording nothing.
//!   `blocks_lifecycle` now covers it, and the first run found a live bug
//!   (`purge_blocks_by_ids_purges_a_live_block_the_single_path_refuses`).
//!
//! Deliberately NOT covered: `set_property_batch_inner` and
//! `set_todo_state_batch_inner`. Both have DOCUMENTED product-level
//! divergences from their single siblings (a restricted key allowlist;
//! skipped recurrence and `created_at`/`completed_at` transitions). An oracle
//! over those would encode the wrong invariant — it would assert an equality
//! the product deliberately does not want.
//!
//! # Engine-path guard
//!
//! An apply that cannot resolve its block's space silently degrades to
//! `apply_*_sql_only`, whose behaviour differs from production. A test that
//! ran the fallback on both arms would compare fallback-to-fallback and pass
//! while proving nothing about the production path. Every arm therefore
//! samples `agaric_engine::apply::sql_only_fallback::count()` immediately
//! before and immediately after the region under test and the harness asserts
//! the delta is ZERO on BOTH arms. (The counter is process-global and
//! monotonic; `cargo nextest` runs one process per test, which is what makes
//! the before/after sample sound. Under plain `cargo test` a concurrent test
//! could inflate the delta — the failure would be a false RED, never a false
//! green.)
//!
//! # What is compared, and what is normalised away
//!
//! The comparison surface is the SQL projection plus the durable op log:
//! `blocks`, `block_properties`, `block_tags`, `block_tag_inherited`,
//! `block_links`, `op_log` — plus whatever the arm closures return (rendered
//! to strings), which is how the read-only `compute_reverse_batch` scenario
//! gets a surface at all.
//!
//! Every normalisation is opt-in, named, and justified below, because an
//! over-broad normalisation silently disables the oracle:
//!
//! * `blocks.deleted_at` → compared as PRESENCE (`tombstoned` yes/no), not as
//!   a value. **Why:** the timestamp is the delete COHORT identity
//!   (`crate::db::next_delete_ms`, monotonic per delete *operation*). One
//!   batch call is one operation, so all its roots share one cohort id; N
//!   folded calls are N operations and get N distinct cohort ids. That
//!   difference is inherent to batching, not a bug — see
//!   `delete_blocks_by_ids_inner`'s #1549 comment. To keep the oracle from
//!   going blind on the timestamp entirely, each block row additionally
//!   carries the DERIVED, timestamp-free column
//!   `tombstone_matches_a_delete_op`: whether its `deleted_at` equals the
//!   `created_at` of some `delete_block` row in that arm's own op log. That
//!   is the invariant `reverse_delete_block` and every `deleted_at_ref`
//!   restore guard actually depend on, and a bulk path that stamped an
//!   unanchored timestamp would flip it to `false` on one arm only.
//! * `op_log.created_at` → EXCLUDED, same reason as above (and the fold arm's
//!   wall-clock reads are simply taken at different instants).
//! * `op_log.hash` → EXCLUDED. It is a content hash computed OVER
//!   `created_at`; keeping it would re-import the excluded column through the
//!   back door and make every scenario red.
//! * `op_log.payload` JSON keys named in
//!   [`Normalisation::redacted_payload_keys`] → replaced with a marker. The
//!   only default is `deleted_at_ref`, which is the same cohort timestamp
//!   carried inside a `RestoreBlock` payload. It is NOT blindly redacted: the
//!   value is replaced by the timestamp-free PREDICATE "does this ref name one
//!   of this arm's own `delete_block` ops?" (`<deleted_at_ref:anchored…>` vs
//!   `<deleted_at_ref:UNANCHORED>`). A blind marker was tried first and is a
//!   demonstrated blind spot: corrupting every emitted ref so it pointed at no
//!   delete operation at all — a peer replaying the op restores nothing — left
//!   this module GREEN. See [`redact_payload`].
//!
//! Deliberately NOT normalised: block ids (both arms are seeded with the same
//! literal ids, so a divergence in identity is a real divergence),
//! `op_log.seq`, `parent_seqs`, `origin`, `is_undo`, `is_replicated`, and
//! every non-timestamp `blocks` column including `page_id` / `space_id`.
//!
//! # Not available: per-op domain events
//!
//! There is no per-op domain-event capture helper in this tree, and this
//! module does not invent one. `op_log` rows ARE the event surface for now.
//! A bulk path that skipped a background cache dispatch but wrote identical
//! SQL would not be caught here; that is a known gap, not an oversight.

#![cfg(test)]

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use sqlx::{Row as _, SqlitePool};
use tempfile::TempDir;

use crate::db::init_pool;
use crate::materializer::Materializer;

mod blocks_lifecycle;
mod reverse_batch;

/// Device id used by every arm. Both arms use the SAME device so `op_log`
/// rows line up on `(device_id, seq)`.
pub const ARM_DEVICE: &str = "bulk-equivalence-device";

/// A boxed, owned future — the shape every arm closure returns.
///
/// The harness owns the [`ArmEnv`]s (it must, so the two arms cannot share a
/// pool by accident) and hands each closure an `Arc<ArmEnv>` BY VALUE rather
/// than a reference. That is deliberate: a `Fn(&ArmEnv) -> Future + '_` bound
/// is higher-ranked over the env's lifetime, which makes it impossible for a
/// closure to also capture anything from its enclosing scope (the captured
/// data would have to outlive an arbitrarily long universally-quantified
/// lifetime). Every real scenario needs to capture its id list, so the owned
/// handle is the shape that actually composes.
pub type ArmFuture<T> = Pin<Box<dyn Future<Output = T>>>;

// ---------------------------------------------------------------------------
// Arm environment
// ---------------------------------------------------------------------------

/// One arm's isolated world: its own on-disk SQLite database, its own
/// `Materializer`, and therefore its own per-space Loro engine registry.
///
/// The `TempDir` is held so the database outlives the arm.
pub struct ArmEnv {
    pub pool: SqlitePool,
    pub materializer: Materializer,
    _dir: TempDir,
}

impl ArmEnv {
    async fn new() -> Self {
        let dir = TempDir::new().expect("tempdir for bulk-equivalence arm");
        let pool = init_pool(&dir.path().join("arm.db"))
            .await
            .expect("init_pool for bulk-equivalence arm");
        let materializer = Materializer::new(pool.clone());
        Self {
            pool,
            materializer,
            _dir: dir,
        }
    }

    /// Drain the materializer's background queue so derived caches
    /// (`block_links`, tag inheritance rebuilds, page counts) have landed
    /// before the snapshot is taken. Without this the comparison races the
    /// fan-out and the oracle flakes.
    pub async fn settle(&self) {
        self.materializer
            .flush_background()
            .await
            .expect("flush_background");
    }
}

// ---------------------------------------------------------------------------
// Normalisation policy
// ---------------------------------------------------------------------------

/// Which legitimately-varying fields are excluded from the comparison.
///
/// Every field here is a deliberate hole in the oracle; see the module docs
/// for the justification of each default. Widening this struct is how you
/// blind the oracle, so a scenario that needs a new hole should say why in a
/// comment at its construction site.
#[derive(Debug, Clone)]
pub struct Normalisation {
    /// JSON keys whose values are replaced inside `op_log.payload` before
    /// comparison. Default: `deleted_at_ref` (a delete-cohort timestamp).
    ///
    /// Every key listed here gets a BLIND marker and is therefore a real hole
    /// — except `deleted_at_ref`, which [`redact_payload`] normalises to an
    /// anchored/unanchored predicate instead. Adding a key here removes that
    /// column from the oracle's reach entirely; prefer a predicate.
    pub redacted_payload_keys: Vec<&'static str>,
    /// Block ids excluded from the `blocks` comparison entirely. Intended for
    /// fixture scaffolding, and normally EMPTY: both arms run the same seed,
    /// so scaffolding rows compare equal for free and excluding them only
    /// removes coverage.
    pub ignored_block_ids: Vec<String>,
}

impl Default for Normalisation {
    fn default() -> Self {
        Self {
            redacted_payload_keys: vec!["deleted_at_ref"],
            ignored_block_ids: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Snapshot model
// ---------------------------------------------------------------------------

/// One table, rendered as `row key -> (column -> value)`.
///
/// Values are rendered to `String` (with `NULL` distinguished from the
/// literal text `"NULL"` by rendering NULL as `∅`) so a single generic differ
/// handles every table and can name the exact column that moved.
#[derive(Debug, Clone)]
pub struct TableSnapshot {
    pub name: &'static str,
    pub columns: Vec<&'static str>,
    pub rows: BTreeMap<String, Vec<String>>,
}

const NULL: &str = "∅";

fn render(v: Option<String>) -> String {
    v.unwrap_or_else(|| NULL.to_owned())
}

/// The full observable state of one arm.
#[derive(Debug, Clone)]
pub struct DbSnapshot {
    pub tables: Vec<TableSnapshot>,
}

/// One arm's complete outcome: what the calls returned, what the database
/// looks like, and whether the engine path actually ran.
pub struct ArmRun {
    pub name: &'static str,
    /// Rendered return values of the arm's call(s). For a mutating scenario
    /// this is usually the affected-count; for the read-only reverse scenario
    /// it is the whole answer.
    pub output: Vec<String>,
    pub snapshot: DbSnapshot,
    pub fallback_delta: u64,
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

async fn read_table(
    pool: &SqlitePool,
    name: &'static str,
    sql: &'static str,
    key_columns: &[&str],
    columns: &[&'static str],
) -> TableSnapshot {
    // dynamic-sql: test-only oracle readback (not a production query path)
    let rows = sqlx::query(sql)
        .fetch_all(pool)
        .await
        .unwrap_or_else(|e| panic!("bulk-equivalence readback of `{name}` failed: {e}"));

    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in rows {
        let key = key_columns
            .iter()
            .map(|c| render(row.try_get::<Option<String>, _>(*c).unwrap_or(None)))
            .collect::<Vec<_>>()
            .join("/");
        let values = columns
            .iter()
            .map(|c| render(row.try_get::<Option<String>, _>(*c).unwrap_or(None)))
            .collect::<Vec<_>>();
        out.insert(key, values);
    }
    TableSnapshot {
        name,
        columns: columns.to_vec(),
        rows: out,
    }
}

/// Read every comparison table from `pool` and apply `norm`.
///
/// All columns are `CAST(... AS TEXT)`ed in SQL so one reader handles INTEGER,
/// REAL and TEXT storage classes uniformly; SQLite's NULL survives the cast,
/// so `∅` still means "absent", never "the string 'NULL'".
pub async fn capture(pool: &SqlitePool, norm: &Normalisation) -> DbSnapshot {
    // The set of `created_at` values stamped by `delete_block` ops in THIS
    // arm — the anchor set for BOTH the `tombstone_matches_a_delete_op` column
    // and the `deleted_at_ref` payload normalisation below. Read FIRST because
    // the payload normalisation needs it.
    // dynamic-sql: test-only oracle readback (not a production query path)
    let delete_op_times: BTreeSet<String> = sqlx::query(
        "SELECT CAST(created_at AS TEXT) AS t FROM op_log WHERE op_type = 'delete_block'",
    )
    .fetch_all(pool)
    .await
    .expect("read delete_block op timestamps")
    .into_iter()
    .filter_map(|r| r.try_get::<Option<String>, _>("t").unwrap_or(None))
    .collect();

    // --- op_log first: the `blocks` reader derives a column from it. ------
    let mut op_log = read_table(
        pool,
        "op_log",
        "SELECT device_id, CAST(seq AS TEXT) AS seq_t, op_type, payload, \
                parent_seqs, block_id, origin, attachment_id, \
                CAST(is_undo AS TEXT) AS is_undo, \
                CAST(is_replicated AS TEXT) AS is_replicated, \
                reverses_device_id, CAST(reverses_seq AS TEXT) AS reverses_seq \
         FROM op_log ORDER BY device_id, seq",
        &["device_id", "seq_t"],
        &[
            "op_type",
            "payload",
            "parent_seqs",
            "block_id",
            "origin",
            "attachment_id",
            "is_undo",
            "is_replicated",
            "reverses_device_id",
            "reverses_seq",
        ],
    )
    .await;

    // Normalise the configured JSON keys inside `payload` (column index 1).
    for values in op_log.rows.values_mut() {
        values[1] = redact_payload(&values[1], &norm.redacted_payload_keys, &delete_op_times);
    }

    // --- blocks ----------------------------------------------------------
    let mut blocks = read_table(
        pool,
        "blocks",
        "SELECT id, block_type, content, parent_id, CAST(position AS TEXT) AS position, \
                CAST(deleted_at AS TEXT) AS deleted_at, todo_state, priority, due_date, \
                scheduled_date, page_id, space_id \
         FROM blocks ORDER BY id",
        &["id"],
        &[
            "block_type",
            "content",
            "parent_id",
            "position",
            "deleted_at",
            "todo_state",
            "priority",
            "due_date",
            "scheduled_date",
            "page_id",
            "space_id",
        ],
    )
    .await;

    // Replace the raw `deleted_at` (index 4) with the two normalised columns
    // described in the module docs.
    blocks.columns[4] = "tombstoned";
    blocks.columns.insert(5, "tombstone_matches_a_delete_op");
    for values in blocks.rows.values_mut() {
        let raw = values[4].clone();
        let tombstoned = raw != NULL;
        values[4] = tombstoned.to_string();
        values.insert(
            5,
            if tombstoned {
                delete_op_times.contains(&raw).to_string()
            } else {
                NULL.to_owned()
            },
        );
    }
    for ignored in &norm.ignored_block_ids {
        blocks.rows.remove(ignored);
    }

    let properties = read_table(
        pool,
        "block_properties",
        "SELECT block_id, key, value_text, CAST(value_num AS TEXT) AS value_num, value_date, \
                value_ref, CAST(value_bool AS TEXT) AS value_bool \
         FROM block_properties ORDER BY block_id, key",
        &["block_id", "key"],
        &[
            "value_text",
            "value_num",
            "value_date",
            "value_ref",
            "value_bool",
        ],
    )
    .await;

    let tags = read_table(
        pool,
        "block_tags",
        "SELECT block_id, tag_id FROM block_tags ORDER BY block_id, tag_id",
        &["block_id", "tag_id"],
        &[],
    )
    .await;

    let inherited = read_table(
        pool,
        "block_tag_inherited",
        "SELECT block_id, tag_id, inherited_from FROM block_tag_inherited \
         ORDER BY block_id, tag_id",
        &["block_id", "tag_id"],
        &["inherited_from"],
    )
    .await;

    let links = read_table(
        pool,
        "block_links",
        "SELECT source_id, target_id FROM block_links ORDER BY source_id, target_id",
        &["source_id", "target_id"],
        &[],
    )
    .await;

    DbSnapshot {
        tables: vec![blocks, properties, tags, inherited, links, op_log],
    }
}

/// The marker substituted for a `deleted_at_ref` that names one of this arm's
/// own `delete_block` ops, and the one for a ref that names NOTHING.
///
/// Keeping these DISTINCT is what stops the normalisation from turning into a
/// blind spot — see [`redact_payload`].
const REF_ANCHORED: &str = "<deleted_at_ref:anchored-to-a-delete-op>";
const REF_UNANCHORED: &str = "<deleted_at_ref:UNANCHORED>";

/// The one payload key whose normalisation is anchor-aware rather than blind.
const DELETED_AT_REF: &str = "deleted_at_ref";

/// Normalise the value of each `key` in a JSON object payload.
///
/// `deleted_at_ref` is the only key that legitimately varies between arms (it
/// is a delete-COHORT id, and the fold arm's deletes get later cohort ids from
/// the process-global monotonic `crate::db::next_delete_ms`). A BLIND
/// redaction of it is not safe, though: a bulk path that emitted a ref
/// pointing at no delete operation at all — which a peer replaying the op
/// would resolve to an empty cohort, restoring nothing — would then compare
/// EQUAL to a correct fold and the oracle would pass on a live sync bug
/// (verified by mutation: corrupting every emitted ref left this module green).
///
/// So the value is replaced by a PREDICATE over it instead: does it name one
/// of THIS arm's own `delete_block` op timestamps? That is exactly the
/// property `reverse_delete_block` and every `deleted_at = deleted_at_ref`
/// restore guard depend on, it is invariant across the arms' differing cohort
/// ids, and it flips to [`REF_UNANCHORED`] the moment a ref stops meaning
/// anything. Every OTHER configured key still gets the blind marker.
///
/// Non-object / unparseable payloads pass through untouched — the comparison
/// then runs on the raw text, which is the conservative choice.
fn redact_payload(
    payload: &str,
    keys: &[&'static str],
    delete_anchors: &BTreeSet<String>,
) -> String {
    if keys.is_empty() {
        return payload.to_owned();
    }
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(payload) else {
        return payload.to_owned();
    };
    let Some(obj) = v.as_object_mut() else {
        return payload.to_owned();
    };
    let mut touched = false;
    for key in keys {
        let Some(current) = obj.get(*key) else {
            continue;
        };
        let marker = if *key == DELETED_AT_REF {
            // Render the ref the way SQL renders `CAST(created_at AS TEXT)` so
            // the two sides of the membership test are comparable.
            let rendered = match current {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            if delete_anchors.contains(&rendered) {
                REF_ANCHORED.to_owned()
            } else {
                REF_UNANCHORED.to_owned()
            }
        } else {
            format!("<redacted:{key}>")
        };
        obj.insert((*key).to_owned(), serde_json::Value::String(marker));
        touched = true;
    }
    if touched {
        v.to_string()
    } else {
        payload.to_owned()
    }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/// One localised difference between the two arms.
#[derive(Debug, Clone)]
pub struct Divergence {
    pub table: String,
    pub row: String,
    pub column: String,
    pub batch: String,
    pub fold: String,
}

impl std::fmt::Display for Divergence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "[{}] row {} column `{}`\n        batch = {}\n        fold  = {}",
            self.table, self.row, self.column, self.batch, self.fold
        )
    }
}

const MISSING: &str = "<row absent>";

fn diff_tables(batch: &TableSnapshot, fold: &TableSnapshot, out: &mut Vec<Divergence>) {
    let keys: BTreeSet<&String> = batch.rows.keys().chain(fold.rows.keys()).collect();
    for key in keys {
        match (batch.rows.get(key), fold.rows.get(key)) {
            (Some(b), Some(f)) => {
                for (i, column) in batch.columns.iter().enumerate() {
                    let bv = b.get(i).map_or(MISSING, String::as_str);
                    let fv = f.get(i).map_or(MISSING, String::as_str);
                    if bv != fv {
                        out.push(Divergence {
                            table: batch.name.to_owned(),
                            row: key.clone(),
                            column: (*column).to_owned(),
                            batch: bv.to_owned(),
                            fold: fv.to_owned(),
                        });
                    }
                }
                // A table with no non-key columns (block_tags, block_links)
                // still diffs meaningfully on row presence, handled below.
            }
            (Some(b), None) => out.push(Divergence {
                table: batch.name.to_owned(),
                row: key.clone(),
                column: "<row presence>".to_owned(),
                batch: format!("present {}", render_row(&batch.columns, b)),
                fold: MISSING.to_owned(),
            }),
            (None, Some(f)) => out.push(Divergence {
                table: batch.name.to_owned(),
                row: key.clone(),
                column: "<row presence>".to_owned(),
                batch: MISSING.to_owned(),
                fold: format!("present {}", render_row(&fold.columns, f)),
            }),
            (None, None) => unreachable!("key came from one of the two maps"),
        }
    }
}

fn render_row(columns: &[&'static str], values: &[String]) -> String {
    if columns.is_empty() {
        return "(key-only row)".to_owned();
    }
    let mut s = String::from("{");
    for (i, c) in columns.iter().enumerate() {
        if i > 0 {
            s.push_str(", ");
        }
        let _ = write!(s, "{c}={}", values.get(i).map_or(MISSING, String::as_str));
    }
    s.push('}');
    s
}

/// Compare two arms and return every localised divergence (DB + returned
/// output). Empty result == the bulk path is equivalent to the fold.
pub fn diff(batch: &ArmRun, fold: &ArmRun) -> Vec<Divergence> {
    let mut out = Vec::new();

    let n = batch.output.len().max(fold.output.len());
    for i in 0..n {
        let b = batch.output.get(i).map_or(MISSING, String::as_str);
        let f = fold.output.get(i).map_or(MISSING, String::as_str);
        if b != f {
            out.push(Divergence {
                table: "output".to_owned(),
                row: format!("index {i}"),
                column: "<returned value>".to_owned(),
                batch: b.to_owned(),
                fold: f.to_owned(),
            });
        }
    }

    for (b, f) in batch
        .snapshot
        .tables
        .iter()
        .zip(fold.snapshot.tables.iter())
    {
        debug_assert_eq!(b.name, f.name, "snapshot tables must line up");
        diff_tables(b, f, &mut out);
    }

    out
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/// Run one arm: fresh env, seed, sample the fallback counter, run the arm's
/// call(s), sample again, settle, snapshot.
async fn run_arm<S, A>(name: &'static str, norm: &Normalisation, seed: &S, arm: &A) -> ArmRun
where
    S: Fn(Arc<ArmEnv>) -> ArmFuture<()>,
    A: Fn(Arc<ArmEnv>) -> ArmFuture<Vec<String>>,
{
    let env = Arc::new(ArmEnv::new().await);
    seed(Arc::clone(&env)).await;
    env.settle().await;

    // Sampled AFTER the seed so ONLY the region under test is measured — a
    // seed that legitimately runs sql_only (e.g. raw-SQL fixture inserts)
    // must not be able to mask a fallback in the bulk call itself.
    let fallback_before = agaric_engine::apply::sql_only_fallback::count();
    let output = arm(Arc::clone(&env)).await;
    let fallback_delta = agaric_engine::apply::sql_only_fallback::count() - fallback_before;

    env.settle().await;
    let snapshot = capture(&env.pool, norm).await;

    ArmRun {
        name,
        output,
        snapshot,
        fallback_delta,
    }
}

/// **The oracle.** Drive the same inputs two ways and assert the observable
/// state is identical.
///
/// `seed` runs once per arm against that arm's own env — sharing ONE closure
/// is load-bearing: it makes asymmetric setup (the classic way a
/// batch-vs-fold test lies) unrepresentable.
///
/// Panics with a localised, per-column diff on any divergence, and with an
/// explicit false-green message if either arm degraded to the SQL-only
/// fallback.
pub async fn assert_batch_equals_fold<S, B, F>(
    scenario: &str,
    norm: &Normalisation,
    seed: S,
    batch: B,
    fold: F,
) where
    S: Fn(Arc<ArmEnv>) -> ArmFuture<()>,
    B: Fn(Arc<ArmEnv>) -> ArmFuture<Vec<String>>,
    F: Fn(Arc<ArmEnv>) -> ArmFuture<Vec<String>>,
{
    let batch_run = run_arm("batch", norm, &seed, &batch).await;
    let fold_run = run_arm("fold", norm, &seed, &fold).await;

    // ENGINE-PATH GUARD. Checked BEFORE the diff: two arms that both ran the
    // SQL-only fallback would compare equal and prove nothing.
    for run in [&batch_run, &fold_run] {
        assert_eq!(
            run.fallback_delta, 0,
            "bulk-equivalence scenario `{scenario}`: the `{}` arm took the SQL-only \
             FALLBACK {} time(s) — this arm did NOT run the production engine path, so a \
             green comparison here would be false. Fix the fixture's space/engine seeding \
             (see `blocks_lifecycle::seed_space_and_page`), do not relax this assertion.",
            run.name, run.fallback_delta,
        );
    }

    let divergences = diff(&batch_run, &fold_run);
    assert!(
        divergences.is_empty(),
        "{}",
        report(scenario, &divergences, &batch_run, &fold_run)
    );
}

fn report(
    scenario: &str,
    divergences: &[Divergence],
    batch_run: &ArmRun,
    fold_run: &ArmRun,
) -> String {
    let mut s = format!(
        "\nBATCH-VS-FOLD EQUIVALENCE VIOLATION (#3346) in scenario `{scenario}`\n\
         \n  The bulk path and the per-item fold left DIFFERENT observable state.\n\
         \n  {} divergence(s):\n\n",
        divergences.len()
    );
    // Cap the body so a wholesale divergence stays readable; the count above
    // is always exact.
    const MAX: usize = 40;
    for d in divergences.iter().take(MAX) {
        let _ = writeln!(s, "    {d}\n");
    }
    if divergences.len() > MAX {
        let _ = writeln!(s, "    ... and {} more\n", divergences.len() - MAX);
    }
    let _ = writeln!(
        s,
        "  arm outputs:\n    batch = {:?}\n    fold  = {:?}",
        batch_run.output, fold_run.output
    );
    s
}

// ---------------------------------------------------------------------------
// Self-tests for the oracle itself.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod harness_self_tests {
    use super::*;

    fn table(
        name: &'static str,
        columns: Vec<&'static str>,
        rows: &[(&str, Vec<&str>)],
    ) -> TableSnapshot {
        TableSnapshot {
            name,
            columns,
            rows: rows
                .iter()
                .map(|(k, v)| {
                    (
                        (*k).to_owned(),
                        v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>(),
                    )
                })
                .collect(),
        }
    }

    fn run(name: &'static str, output: &[&str], tables: Vec<TableSnapshot>) -> ArmRun {
        ArmRun {
            name,
            output: output.iter().map(|s| (*s).to_owned()).collect(),
            snapshot: DbSnapshot { tables },
            fallback_delta: 0,
        }
    }

    /// The differ must NAME the column that moved, not just say "not equal".
    #[test]
    fn diff_localises_a_changed_column() {
        let b = run(
            "batch",
            &["1"],
            vec![table(
                "blocks",
                vec!["content", "tombstoned"],
                &[("B1", vec!["hi", "false"])],
            )],
        );
        let f = run(
            "fold",
            &["1"],
            vec![table(
                "blocks",
                vec!["content", "tombstoned"],
                &[("B1", vec!["hi", "true"])],
            )],
        );
        let d = diff(&b, &f);
        assert_eq!(d.len(), 1, "exactly one column moved: {d:?}");
        assert_eq!(d[0].table, "blocks");
        assert_eq!(d[0].row, "B1");
        assert_eq!(d[0].column, "tombstoned");
        assert_eq!(d[0].batch, "false");
        assert_eq!(d[0].fold, "true");
    }

    /// A row present on only one arm must be reported with its contents, so
    /// the reader can see WHAT is missing without re-running.
    #[test]
    fn diff_reports_row_presence_with_contents() {
        let b = run(
            "batch",
            &[],
            vec![table("block_links", vec![], &[("A/B", vec![])])],
        );
        let f = run("fold", &[], vec![table("block_links", vec![], &[])]);
        let d = diff(&b, &f);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].column, "<row presence>");
        assert_eq!(d[0].fold, MISSING);
    }

    /// The returned-value surface is compared too — that is the ONLY surface
    /// the read-only `compute_reverse_batch` scenario has.
    #[test]
    fn diff_compares_arm_output() {
        let b = run("batch", &["a", "b"], vec![]);
        let f = run("fold", &["a", "c"], vec![]);
        let d = diff(&b, &f);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].table, "output");
        assert_eq!(d[0].row, "index 1");
    }

    fn anchors(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|s| (*s).to_owned()).collect()
    }

    /// Redaction must hit ONLY the named key. A blanket redaction would
    /// silently disable the payload comparison.
    #[test]
    fn redact_payload_touches_only_named_keys() {
        let out = redact_payload(
            r#"{"block_id":"B1","deleted_at_ref":1736899200000}"#,
            &["deleted_at_ref"],
            &anchors(&["1736899200000"]),
        );
        assert!(out.contains(r#""block_id":"B1""#), "{out}");
        assert!(out.contains(REF_ANCHORED), "{out}");
        assert!(!out.contains("1736899200000"), "{out}");
    }

    /// **The hole this normalisation exists to avoid.** A `deleted_at_ref`
    /// that names one of the arm's own `delete_block` ops and one that names
    /// NOTHING must not normalise to the same string — otherwise a bulk path
    /// emitting a ref a peer cannot resolve compares equal to a correct fold
    /// and the oracle passes on a live sync bug. (Reproduced by mutation
    /// before this was added: corrupting every emitted ref kept the module
    /// green.)
    #[test]
    fn redact_payload_distinguishes_an_unanchored_deleted_at_ref() {
        let anchor_set = anchors(&["1736899200000"]);
        let good = redact_payload(
            r#"{"block_id":"B1","deleted_at_ref":1736899200000}"#,
            &["deleted_at_ref"],
            &anchor_set,
        );
        let corrupt = redact_payload(
            r#"{"block_id":"B1","deleted_at_ref":1736899200001}"#,
            &["deleted_at_ref"],
            &anchor_set,
        );
        assert!(good.contains(REF_ANCHORED), "{good}");
        assert!(corrupt.contains(REF_UNANCHORED), "{corrupt}");
        assert_ne!(good, corrupt, "an unresolvable ref must still diff");
    }

    /// Two arms whose refs are both anchored still compare EQUAL despite
    /// naming DIFFERENT cohort ids — the legitimate variation the
    /// normalisation exists to absorb. Without this the oracle would be
    /// permanently red on every restore scenario.
    #[test]
    fn redact_payload_absorbs_differing_but_anchored_cohort_ids() {
        let batch = redact_payload(
            r#"{"block_id":"B1","deleted_at_ref":100}"#,
            &["deleted_at_ref"],
            &anchors(&["100"]),
        );
        let fold = redact_payload(
            r#"{"block_id":"B1","deleted_at_ref":200}"#,
            &["deleted_at_ref"],
            &anchors(&["200"]),
        );
        assert_eq!(batch, fold);
    }

    /// A NON-anchor key keeps the blind marker — the anchor-aware branch is
    /// scoped to `deleted_at_ref` only.
    #[test]
    fn redact_payload_uses_the_blind_marker_for_other_keys() {
        let out = redact_payload(
            r#"{"block_id":"B1","hash":"abc"}"#,
            &["hash"],
            &anchors(&[]),
        );
        assert!(out.contains("<redacted:hash>"), "{out}");
    }

    /// An unparseable payload passes through unchanged rather than being
    /// silently dropped from the comparison.
    #[test]
    fn redact_payload_passes_through_non_json() {
        assert_eq!(
            redact_payload("not json", &["deleted_at_ref"], &anchors(&[])),
            "not json"
        );
    }

    /// Identical arms produce no divergences — the oracle must not be
    /// permanently red.
    #[test]
    fn identical_arms_produce_no_divergence() {
        let t = || table("blocks", vec!["content"], &[("B1", vec!["hi"])]);
        assert!(
            diff(
                &run("batch", &["1"], vec![t()]),
                &run("fold", &["1"], vec![t()])
            )
            .is_empty()
        );
    }
}
