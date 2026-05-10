//! PEND-09 Phase 1 day-6 — bucket A/B/C/D classifier for parity rows.
//!
//! Day-4 + day-5 landed the data-layer scaffold: every shadow-mode op
//! lands a row in `merge_parity_log` with `bucket = NULL`.  Day-6 fills
//! that column with the four-way classification the readiness checklist
//! (SPIKE-REPORT.md §6 item 6) and the PEND-09 plan call out:
//!
//! - **A** — byte-identical results.  Loro and diffy produced the same
//!   summary string (`matched = 1` in SQLite).  Trivial agreement; the
//!   biggest bucket once shadow-mode steady state is reached.
//! - **B** — Loro merged cleanly where diffy would have produced a
//!   conflict copy.  The win we expect from CRDT semantics.  *Cannot
//!   currently fire from `merge::diffy_summary_for` output* because the
//!   diffy-side summary string never carries a literal `"conflict:"`
//!   prefix today — diffy's conflict-copy mechanism produces a normal
//!   `"create:..."` summary for the conflict-copy block on the apply
//!   path.  The B-bucket rule is encoded for forward-compat (in case
//!   the summary shape grows a `conflict:` prefix at the merge layer
//!   later) but no production row will land in B until that change.
//!   Documented here so a reader who finds zero B-bucket rows in the
//!   live table doesn't think the classifier is buggy.
//! - **C** — Loro and diffy diverged, but in ways consistent with
//!   documented CRDT semantics (RGA-CRDT identical-edit doubling,
//!   Lamport-vs-wallclock LWW tiebreak — see SPIKE-REPORT.md §3 +
//!   parity_corpus.rs categories 5-7).  Not a bug.
//! - **D** — Loro is wrong in a way that's NOT explained by CRDT
//!   semantics.  Kill criterion #2 hard floor: D bucket count must
//!   remain **zero** for Phase 2 cutover.  The classifier is
//!   conservative — only Loro-errors-where-diffy-succeeded land in D
//!   today; ambiguous content divergences fall through to C.
//!
//! ## Why a separate cadence isn't worth it
//!
//! The flush task already runs every 30 s and the classifier's work
//! per row is a string-prefix check + an indexed UPDATE.  Running it
//! on every flush tick keeps the implementation simple (one scheduler,
//! one cadence constant, no extra `tick_count` tracking) and means a
//! freshly-flushed batch is classified within the same tick that
//! flushed it.  The query is fully covered by the partial index
//! `idx_merge_parity_log_unbucketed` (migration 0054) and the
//! `WHERE bucket IS NULL` filter — over an empty pending set it's a
//! no-op.  A separate
//! cadence becomes worth it only if the classifier's wall-clock cost
//! starts dominating the flush-tick budget; today it does not.

use sqlx::{QueryBuilder, Sqlite, SqlitePool};

use crate::error::AppError;

/// The four-way parity bucket.  See module docstring for the full
/// taxonomy + kill-criterion #2 anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bucket {
    /// Byte-identical Loro and diffy results.
    A,
    /// Loro merged cleanly where diffy would have produced a conflict.
    B,
    /// CRDT-divergent but neither side is wrong.
    C,
    /// Loro is wrong (the kill-criterion bucket).
    D,
}

impl Bucket {
    /// Single-letter SQL-friendly representation.
    pub fn as_str(&self) -> &'static str {
        match self {
            Bucket::A => "A",
            Bucket::B => "B",
            Bucket::C => "C",
            Bucket::D => "D",
        }
    }
}

/// Per-bucket counts produced by [`classify_unbucketed`].  All four
/// counts default to zero; the sum equals the number of rows the
/// classifier updated in this run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ClassifyStats {
    pub a: usize,
    pub b: usize,
    pub c: usize,
    pub d: usize,
}

impl ClassifyStats {
    /// Total rows classified across all buckets.  Useful for a "did we
    /// do any work this tick" log line.
    pub fn total(&self) -> usize {
        self.a
            .saturating_add(self.b)
            .saturating_add(self.c)
            .saturating_add(self.d)
    }

    /// Bump the appropriate counter for `bucket`.
    fn add(&mut self, bucket: Bucket) {
        match bucket {
            Bucket::A => self.a = self.a.saturating_add(1),
            Bucket::B => self.b = self.b.saturating_add(1),
            Bucket::C => self.c = self.c.saturating_add(1),
            Bucket::D => self.d = self.d.saturating_add(1),
        }
    }
}

/// Pure-function bucket assignment from the same `(diffy_result,
/// loro_result, matched)` triple that lives in `merge_parity_log`.
///
/// The rules — see module docstring for prose:
///
/// 1. `matched == true` → **A**.  Byte-identical summaries are A by
///    definition; we don't even look at the strings.
/// 2. `loro_result.starts_with("error:")` → **D**.  Loro raised an
///    error where diffy succeeded (diffy_result is non-error because
///    the parity row was only logged after diffy applied cleanly —
///    see `merge::shadow_apply`).  This is the only path that lands
///    in D today; conservative-by-design per kill-criterion #2.
/// 3. `diffy_result.starts_with("conflict:")` AND
///    `!loro_result.starts_with("conflict:")` AND
///    `!loro_result.starts_with("error:")` → **B**.  The forward-compat
///    rule for the day when the diffy summary shape grows a
///    `conflict:` prefix.  Today no production row matches this case
///    because `merge::diffy_summary_for` does not emit `conflict:`.
/// 4. Otherwise → **C**.  Both sides produced a non-error,
///    non-identical result; Loro's deterministic CRDT outcome diverged
///    from diffy's deterministic merge outcome but neither lost data.
///    Conservative-by-default — see plan PEND-09 §"Bucket taxonomy"
///    note "when in doubt, use C, not D".
pub fn classify(diffy_result: &str, loro_result: &str, matched: bool) -> Bucket {
    if matched {
        return Bucket::A;
    }
    if loro_result.starts_with("error:") {
        return Bucket::D;
    }
    let diffy_is_conflict = diffy_result.starts_with("conflict:");
    let loro_is_conflict = loro_result.starts_with("conflict:");
    if diffy_is_conflict && !loro_is_conflict {
        return Bucket::B;
    }
    Bucket::C
}

/// Number of `(id, bucket)` pairs grouped per UPDATE statement.  The
/// per-bucket UPDATE binds one variable per id plus the bucket value,
/// so a 200-id chunk binds 201 placeholders — comfortably below
/// SQLite's `SQLITE_LIMIT_VARIABLE_NUMBER` (999).
const UPDATE_CHUNK_IDS: usize = 200;

/// Number of rows pulled from SQLite per SELECT round-trip.  The
/// classifier is bounded — it processes rows in chunks rather than
/// streaming one cursor across the whole UNCLASSIFIED set — so a
/// crash mid-classify simply leaves the unprocessed tail with
/// `bucket IS NULL` and the next tick picks them up.  4 000 rows per
/// SELECT is a balance between round-trip overhead and per-tick wall
/// time; the per-row work is a string prefix check, so larger chunks
/// don't hurt CPU.
const SELECT_CHUNK_ROWS: i64 = 4_000;

/// The classifier's production SELECT.  Centralised so the
/// `classify_unbucketed_uses_partial_index_for_query` regression test
/// can EXPLAIN-plan the *exact* string the production code runs —
/// ensuring any drift in predicate shape (e.g. a refactor to
/// `IFNULL(bucket, NULL) IS NULL`) is caught by the test rather than
/// silently bypassing the partial index `idx_merge_parity_log_unbucketed`
/// (migration 0054).  Predicate shape (`WHERE bucket IS NULL`) must
/// match the index's predicate textually for the SQLite planner to
/// pick it up.
const SELECT_UNBUCKETED_SQL: &str = "SELECT id, diffy_result, loro_result, matched \
     FROM merge_parity_log \
     WHERE bucket IS NULL \
     LIMIT ?";

/// Scan `merge_parity_log` for rows where `bucket IS NULL`, classify
/// each one with [`classify`], and write the result back to the
/// `bucket` column.  Returns per-bucket counts.
///
/// Idempotent: re-running on already-classified rows is a no-op
/// because the SELECT filter is `WHERE bucket IS NULL`.  Mutates only
/// the `bucket` column — every other column round-trips unchanged.
///
/// ## Failure semantics
///
/// On a SQL error mid-classify (transient lock contention, full disk),
/// the partial UPDATE that caused the error is rolled back via the
/// per-batch transaction.  Already-committed batches keep their
/// classifications.  The next tick's call retries the unclassified
/// remainder via the same `WHERE bucket IS NULL` filter — so a flaky
/// flush tick costs at most one batch's worth of progress, never
/// produces a wrong bucket assignment.
pub async fn classify_unbucketed(pool: &SqlitePool) -> Result<ClassifyStats, AppError> {
    let mut stats = ClassifyStats::default();

    loop {
        // SELECT a bounded chunk.  We don't `ORDER BY id` because the
        // classifier doesn't care about order — each row is classified
        // independently — and an unordered scan lets SQLite walk the
        // partial index `idx_merge_parity_log_unbucketed` (migration
        // 0054) directly without a sort step.  Query string lives in
        // `SELECT_UNBUCKETED_SQL` so the day-10 EXPLAIN-plan test
        // exercises the same literal string this loop runs.
        let rows: Vec<(i64, String, String, i64)> = sqlx::query_as(SELECT_UNBUCKETED_SQL)
            .bind(SELECT_CHUNK_ROWS)
            .fetch_all(pool)
            .await?;

        if rows.is_empty() {
            break;
        }

        // Group ids by bucket so each UPDATE batches every id that
        // takes the same `SET bucket = ?` value.  Four buckets → at
        // most four UPDATE chains per SELECT chunk.
        let mut by_bucket: [(Bucket, Vec<i64>); 4] = [
            (Bucket::A, Vec::new()),
            (Bucket::B, Vec::new()),
            (Bucket::C, Vec::new()),
            (Bucket::D, Vec::new()),
        ];
        let chunk_len = rows.len();
        for (id, diffy_result, loro_result, matched) in rows {
            let bucket = classify(&diffy_result, &loro_result, matched != 0);
            stats.add(bucket);
            // Linear scan over a 4-element array is cheaper than a
            // HashMap lookup at this size.
            for (b, ids) in by_bucket.iter_mut() {
                if *b == bucket {
                    ids.push(id);
                    break;
                }
            }
        }

        // One transaction per SELECT chunk so a partial-progress crash
        // either lands the whole chunk or rolls it all back.  Inner
        // chunked UPDATE keeps the placeholder count under SQLite's
        // 999-variable limit.
        let mut tx = pool.begin().await?;
        for (bucket, ids) in by_bucket.iter() {
            if ids.is_empty() {
                continue;
            }
            for id_chunk in ids.chunks(UPDATE_CHUNK_IDS) {
                let mut qb: QueryBuilder<'_, Sqlite> =
                    QueryBuilder::new("UPDATE merge_parity_log SET bucket = ");
                qb.push_bind(bucket.as_str());
                qb.push(" WHERE id IN (");
                let mut sep = qb.separated(", ");
                for id in id_chunk {
                    sep.push_bind(*id);
                }
                qb.push(")");
                qb.build().execute(&mut *tx).await?;
            }
        }
        tx.commit().await?;

        // If the SELECT returned fewer than the chunk size, we've
        // drained the unclassified set.  Saves one extra round-trip
        // on every call.
        if chunk_len < usize::try_from(SELECT_CHUNK_ROWS).unwrap_or(usize::MAX) {
            break;
        }
    }

    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    // -----------------------------------------------------------------
    // Pure-function tests — no DB.
    // -----------------------------------------------------------------

    #[test]
    fn classify_byte_identical_returns_a() {
        let bucket = classify("create:BLK1", "create:BLK1", true);
        assert_eq!(bucket, Bucket::A);
    }

    #[test]
    fn classify_byte_identical_returns_a_even_for_strings_that_could_match_other_rules() {
        // matched=true short-circuits — even if the strings start with
        // "error:" or "conflict:" the row is byte-identical, so A.
        // Defensive guard: the classifier must never demote an
        // already-matched row to D / B / C.
        let bucket = classify("error:foo", "error:foo", true);
        assert_eq!(bucket, Bucket::A);
    }

    #[test]
    fn classify_loro_error_returns_d() {
        let bucket = classify("create:BLK1", "error:Validation(bad block)", false);
        assert_eq!(bucket, Bucket::D);
    }

    #[test]
    fn classify_different_non_errors_returns_c() {
        // Different summaries, neither starts with `error:` or
        // `conflict:` — falls through to C (CRDT-divergent).
        let bucket = classify(
            "set_property:BLK1.priority=low",
            "set_property:BLK1.priority=high",
            false,
        );
        assert_eq!(bucket, Bucket::C);
    }

    #[test]
    fn classify_edit_summaries_with_different_heads_returns_c() {
        // The most common real-world C case: two edits land different
        // resolved content (Lamport vs wallclock LWW tiebreak, RGA-CRDT
        // identical-edit doubling).  Both summaries are well-formed,
        // both non-error, just different.
        let bucket = classify("edit:BLK1:hello world", "edit:BLK1:goodbye world", false);
        assert_eq!(bucket, Bucket::C);
    }

    #[test]
    fn classify_loro_error_short_circuits_even_if_diffy_is_conflict() {
        // Edge case for the rule order: D fires before B.  If Loro
        // errored, we don't care that diffy flagged a conflict — Loro
        // didn't merge, it failed.  D, not B.
        let bucket = classify("conflict:BLK1", "error:OutOfBounds", false);
        assert_eq!(bucket, Bucket::D);
    }

    // -----------------------------------------------------------------
    // DB-backed tests.  Mirror the `parity_sink::tests` fixture so the
    // classifier exercises the real migrated schema (column types,
    // indexes, NOT NULL constraints all in play).
    // -----------------------------------------------------------------

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("classifier_test.db");
        let pool = crate::db::init_pool(&db_path)
            .await
            .expect("init_pool migrations");
        (pool, dir)
    }

    /// Insert one row directly via SQL.  `bucket` is `Option<&str>` so
    /// tests can seed pre-classified rows alongside fresh `NULL`-bucket
    /// rows.  All other columns get plausible literal values.
    async fn insert_row(
        pool: &SqlitePool,
        op_id: &str,
        diffy_result: &str,
        loro_result: &str,
        matched: bool,
        bucket: Option<&str>,
        ts: i64,
    ) {
        sqlx::query(
            "INSERT INTO merge_parity_log \
             (op_id, space_id, op_type, diffy_result, loro_result, matched, bucket, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(op_id)
        .bind("01ARZ3NDEKTSV4RRFFQ69G5FAV")
        .bind("edit_block")
        .bind(diffy_result)
        .bind(loro_result)
        .bind(if matched { 1i64 } else { 0i64 })
        .bind(bucket)
        .bind(ts)
        .execute(pool)
        .await
        .expect("insert seed row");
    }

    /// Insert four rows: one already-classified-as-A, three with
    /// `bucket IS NULL` covering the A/C/D rules.  Run the classifier;
    /// verify only the three NULL rows were updated and the
    /// pre-existing `bucket = 'A'` row was NOT mutated (e.g. its
    /// `op_id` survives unchanged).
    #[tokio::test]
    async fn classify_unbucketed_updates_only_null_rows() {
        let (pool, _dir) = fresh_pool().await;

        // Pre-classified row (must NOT be re-touched).
        insert_row(
            &pool,
            "PRE/A",
            "create:BLK1",
            "create:BLK1",
            true,
            Some("A"),
            1_000,
        )
        .await;

        // NULL bucket — matched → A.
        insert_row(
            &pool,
            "NEW/A",
            "create:BLK2",
            "create:BLK2",
            true,
            None,
            2_000,
        )
        .await;

        // NULL bucket — Loro error → D.
        insert_row(
            &pool,
            "NEW/D",
            "create:BLK3",
            "error:Validation(bad)",
            false,
            None,
            3_000,
        )
        .await;

        // NULL bucket — different non-errors → C.
        insert_row(
            &pool,
            "NEW/C",
            "set_property:BLK4.k=lo",
            "set_property:BLK4.k=hi",
            false,
            None,
            4_000,
        )
        .await;

        let stats = classify_unbucketed(&pool)
            .await
            .expect("classifier should succeed");

        assert_eq!(stats.a, 1, "NEW/A must land in bucket A");
        assert_eq!(stats.c, 1, "NEW/C must land in bucket C");
        assert_eq!(stats.d, 1, "NEW/D must land in bucket D");
        assert_eq!(stats.b, 0);
        assert_eq!(stats.total(), 3);

        // Verify the pre-classified row was untouched.  We compare the
        // full `(op_id, bucket)` pair to make sure neither column
        // drifted.
        let pre: (String, String) =
            sqlx::query_as("SELECT op_id, bucket FROM merge_parity_log WHERE op_id = ?")
                .bind("PRE/A")
                .fetch_one(&pool)
                .await
                .expect("PRE/A row should exist");
        assert_eq!(pre, ("PRE/A".to_string(), "A".to_string()));

        // Verify each NULL row was assigned the expected bucket.
        for (op_id, expected) in [("NEW/A", "A"), ("NEW/C", "C"), ("NEW/D", "D")] {
            let bucket: Option<String> =
                sqlx::query_scalar("SELECT bucket FROM merge_parity_log WHERE op_id = ?")
                    .bind(op_id)
                    .fetch_one(&pool)
                    .await
                    .expect("row should exist");
            assert_eq!(
                bucket.as_deref(),
                Some(expected),
                "{op_id} should be classified as {expected}",
            );
        }

        // Re-running the classifier is a no-op (idempotent — every row
        // has a bucket now, so the SELECT returns zero rows).
        let stats2 = classify_unbucketed(&pool).await.expect("idempotent run");
        assert_eq!(stats2, ClassifyStats::default());
    }

    /// Stats sanity: insert a known mix of A/C/D rows and verify the
    /// returned counts match.  No B row because the production summary
    /// shape doesn't emit `conflict:` — we exercise B via a
    /// separate test below that bypasses the production summary writer.
    #[tokio::test]
    async fn classify_unbucketed_returns_correct_stats() {
        let (pool, _dir) = fresh_pool().await;

        // Three matched rows → A.
        for seq in 0..3 {
            insert_row(
                &pool,
                &format!("DEV/A{seq}"),
                &format!("create:BLK{seq}"),
                &format!("create:BLK{seq}"),
                true,
                None,
                100 + seq,
            )
            .await;
        }
        // Two D rows.
        for seq in 0..2 {
            insert_row(
                &pool,
                &format!("DEV/D{seq}"),
                &format!("create:BLK{seq}"),
                "error:Validation(boom)",
                false,
                None,
                200 + seq,
            )
            .await;
        }
        // Five C rows.
        for seq in 0..5 {
            insert_row(
                &pool,
                &format!("DEV/C{seq}"),
                &format!("set_property:BLK{seq}.k=v1"),
                &format!("set_property:BLK{seq}.k=v2"),
                false,
                None,
                300 + seq,
            )
            .await;
        }

        let stats = classify_unbucketed(&pool).await.expect("classify");

        assert_eq!(stats.a, 3);
        assert_eq!(stats.b, 0);
        assert_eq!(stats.c, 5);
        assert_eq!(stats.d, 2);
        assert_eq!(stats.total(), 10);
    }

    /// B-bucket exercise via the forward-compat `conflict:` prefix.
    /// Production `merge::diffy_summary_for` does not emit `conflict:`
    /// today, but the rule is encoded in the classifier so a future
    /// summary-shape change lands the right bucket.  We test it
    /// directly by inserting a synthetic row.
    #[tokio::test]
    async fn classify_unbucketed_recognises_conflict_resolved_by_loro_as_b() {
        let (pool, _dir) = fresh_pool().await;
        insert_row(
            &pool,
            "DEV/B",
            "conflict:BLK1",
            "create:BLK1",
            false,
            None,
            500,
        )
        .await;

        let stats = classify_unbucketed(&pool).await.expect("classify");
        assert_eq!(stats.b, 1);
        assert_eq!(stats.total(), 1);

        let bucket: Option<String> =
            sqlx::query_scalar("SELECT bucket FROM merge_parity_log WHERE op_id = ?")
                .bind("DEV/B")
                .fetch_one(&pool)
                .await
                .expect("row");
        assert_eq!(bucket.as_deref(), Some("B"));
    }

    /// Phase-2 day-10 regression: the day-6 classifier's
    /// `WHERE bucket IS NULL` SELECT must use the partial index
    /// `idx_merge_parity_log_unbucketed` (migration 0054), not fall
    /// back to a full table scan.  Without the index the query is
    /// O(N_total_events) per flush tick — unacceptable at Phase-2
    /// cutover write rates.  We assert against the planner's output
    /// because that's the only signal SQLite gives that the
    /// partial-index predicate matched the query predicate; if a
    /// future refactor rewrites the SELECT to use `IFNULL(bucket,
    /// NULL) IS NULL` or any other predicate shape that doesn't
    /// match the index's literal `WHERE bucket IS NULL`, this test
    /// fails loudly.
    ///
    /// Seed 1000 rows with a mix of bucketed / unbucketed states so
    /// the planner's row-count heuristic has a realistic table
    /// shape to reason about (a 1-row table sometimes triggers the
    /// "just full-scan it" shortcut even when an index exists).
    #[tokio::test]
    async fn classify_unbucketed_uses_partial_index_for_query() {
        let (pool, _dir) = fresh_pool().await;

        // 980 already-classified rows + 20 unclassified.  Mix is
        // representative of steady state — most rows have a bucket,
        // a small tail does not.  Chosen to ensure the partial
        // index has a meaningfully smaller cardinality than the
        // table itself, which is the planner's incentive to use it.
        for seq in 0..980 {
            insert_row(
                &pool,
                &format!("DEV/SEEDED{seq}"),
                &format!("create:BLK{seq}"),
                &format!("create:BLK{seq}"),
                true,
                Some("A"),
                10_000 + seq,
            )
            .await;
        }
        for seq in 0..20 {
            insert_row(
                &pool,
                &format!("DEV/PENDING{seq}"),
                &format!("set_property:BLK{seq}.k=v1"),
                &format!("set_property:BLK{seq}.k=v2"),
                false,
                None,
                20_000 + seq,
            )
            .await;
        }

        // Run EXPLAIN QUERY PLAN against the *literal* production
        // SELECT (`SELECT_UNBUCKETED_SQL`).  Building the EXPLAIN
        // string by prepending to the constant guarantees the test
        // tracks any future predicate-shape drift in the classifier;
        // duplicating the SQL inline here would let a refactor to
        // e.g. `IFNULL(bucket, NULL) IS NULL` silently bypass the
        // partial index without failing this test.
        let explain_sql = format!("EXPLAIN QUERY PLAN {SELECT_UNBUCKETED_SQL}");
        let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(&explain_sql)
            .bind(SELECT_CHUNK_ROWS)
            .fetch_all(&pool)
            .await
            .expect("explain query plan");

        let detail = plan
            .iter()
            .map(|(_, _, _, d)| d.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        // SQLite's planner output for this query is exactly:
        //   SCAN merge_parity_log USING INDEX idx_merge_parity_log_unbucketed
        // — "SCAN" (not "SEARCH") because the partial-index predicate
        // pre-filtered the rows so the planner walks the full index;
        // that index already contains only the rows we want.  The
        // index name in the plan is the load-bearing assertion: it
        // proves the planner matched the partial-index predicate
        // against the query's `WHERE bucket IS NULL` literally.
        assert!(
            detail.contains("idx_merge_parity_log_unbucketed"),
            "classify_unbucketed SELECT must use partial index \
             idx_merge_parity_log_unbucketed; plan was:\n{detail}",
        );
    }
}
