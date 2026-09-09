//! Reconciliation-oracle command (#4886).
//!
//! Points `crate::reconciliation_oracle` — the from-base rebuild of every
//! derived artefact, diffed against the incrementally-maintained state — at
//! the live vault, and reports what diverged in a shape a user can paste into
//! a bug report. Read-and-compare only: every read goes through the reader
//! pool and nothing is written, so a divergence is data in the return value,
//! never a panic and never a repair. Twelve whole-table rebuilds is not a boot
//! cost; this runs when the user asks (an opt-in setting, the follow-up
//! commit), and the caller should let the app settle first — a run that
//! overlaps a background rebuild or an inbound sync can see a state one
//! maintainer has left and the next has not yet reached, which reads as a
//! divergence a second run will not reproduce.
//!
//! # Counts and keys, never values
//!
//! The oracle's `Divergence` carries `expected` / `actual` strings that quote
//! what the rebuild computed — a stripped FTS body, a tag's name, an
//! attachment's `fs_path`. The report drops them on purpose, for the reason
//! #609 and #4854 gave for the bug bundle: the frontend embeds bug-report
//! metadata verbatim in a prefilled PUBLIC GitHub issue body, and a row VALUE
//! is the user's content while a row KEY is an opaque ULID, hash or date the
//! maintainer cannot resolve without the vault. So each artefact reports its
//! name, how many rows diverged, and a bounded sample of keys — enough to say
//! "17 rows of `pages_cache.child_block_count` disagree, starting with these",
//! which is a bug report; a full dump is not.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::db::ReadPool;
use crate::reconciliation_oracle::{self, Divergence};
use agaric_core::error::AppError;

use super::sanitize_internal_error;

/// Row keys a report carries per artefact. Enough to name the rows a
/// maintainer will ask for first; small enough that a vault with thousands of
/// stale rows still produces a report that fits in an issue body.
pub const SAMPLE_KEYS_PER_ARTEFACT: usize = 10;

/// What [`compute_reconciliation_report`] returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ReconciliationReport {
    /// Rows in `blocks` — live and tombstoned — at the time of the run: what
    /// every rebuild folded. The non-vacuity figure: zero divergences over
    /// zero blocks describes an empty vault, not a clean one.
    pub blocks_scanned: i64,
    /// The local calendar date (`YYYY-MM-DD`) the projected-agenda rebuild
    /// was pinned to — the one artefact that is not a pure function of the
    /// database (`reconciliation_oracle::rebuild_projected_agenda_from_base`).
    /// Recorded so a run that straddled local midnight is diagnosable.
    pub today: String,
    /// Sum of `count` over `artefacts`.
    pub total_divergences: i64,
    /// One entry per artefact that diverged, in the oracle's root-cause-first
    /// order (`blocks.page_id` before the `pages_cache` counts keyed on it).
    /// An artefact that agreed with its rebuild is absent.
    pub artefacts: Vec<ArtefactDivergences>,
}

/// One derived artefact's disagreement with its from-base rebuild.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ArtefactDivergences {
    /// Derived table and column, e.g. `pages_cache.child_block_count`. The
    /// header table in `reconciliation_oracle.rs` maps it to the maintenance
    /// site that owns the arm.
    pub artefact: String,
    /// Rows that diverged.
    pub count: i64,
    /// The first [`SAMPLE_KEYS_PER_ARTEFACT`] row keys, in the oracle's stable
    /// order — a block id, a `(source -> target)` pair, a `date / block_id`
    /// agenda key, a content hash.
    pub sample_keys: Vec<String>,
}

/// Fold the oracle's flat divergence list into per-artefact counts and
/// bounded key samples, first-seen order.
fn group_by_artefact(divergences: &[Divergence]) -> Vec<ArtefactDivergences> {
    let mut groups: Vec<ArtefactDivergences> = Vec::new();
    let mut index: BTreeMap<&'static str, usize> = BTreeMap::new();
    for divergence in divergences {
        let slot = *index.entry(divergence.artefact).or_insert_with(|| {
            groups.push(ArtefactDivergences {
                artefact: divergence.artefact.to_owned(),
                count: 0,
                sample_keys: Vec::new(),
            });
            groups.len() - 1
        });
        let group = &mut groups[slot];
        group.count += 1;
        if group.sample_keys.len() < SAMPLE_KEYS_PER_ARTEFACT {
            group.sample_keys.push(divergence.key.clone());
        }
    }
    groups
}

/// Run every oracle artefact against `pool` and shape the result.
///
/// `today` is the date the projected-agenda rebuild is pinned to; the wrapper
/// passes the local clock, tests pass a constant.
#[instrument(skip(pool), err)]
pub async fn compute_reconciliation_report_inner(
    pool: &SqlitePool,
    today: chrono::NaiveDate,
) -> Result<ReconciliationReport, AppError> {
    let blocks_scanned: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(pool)
        .await?;
    let divergences = reconciliation_oracle::reconcile_all(pool, today).await?;
    Ok(ReconciliationReport {
        blocks_scanned,
        today: today.format("%Y-%m-%d").to_string(),
        total_divergences: i64::try_from(divergences.len()).unwrap_or(i64::MAX),
        artefacts: group_by_artefact(&divergences),
    })
}

/// Tauri command: rebuild every derived artefact from base tables and report
/// where the live vault disagrees. Reader pool; writes nothing.
#[tauri::command]
#[specta::specta]
pub async fn compute_reconciliation_report(
    pool: State<'_, ReadPool>,
) -> Result<ReconciliationReport, AppError> {
    // The clock production's `rebuild_projected_agenda_cache` reads, so the
    // rebuild is pinned to the same day the cache was built for.
    let today = chrono::Local::now().date_naive();
    compute_reconciliation_report_inner(&pool.0, today)
        .await
        .map_err(sanitize_internal_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::commands::blocks::crud::create_block_inner;
    use crate::materializer::Materializer;
    use agaric_core::ulid::BlockId;
    use tempfile::TempDir;

    const DEV: &str = "reconciliation-report-device";

    fn pinned_today() -> chrono::NaiveDate {
        chrono::NaiveDate::from_ymd_opt(2026, 1, 15).expect("valid fixture date")
    }

    fn divergence(artefact: &'static str, key: &str) -> Divergence {
        Divergence {
            artefact,
            key: key.to_owned(),
            expected: "x".to_owned(),
            actual: "y".to_owned(),
            owner: "test",
        }
    }

    /// A page with one child block, driven through the real command path and
    /// settled, so every derived artefact holds what production maintains.
    async fn settled_vault() -> (SqlitePool, TempDir, Materializer, String) {
        let dir = TempDir::new().expect("tempdir");
        let pool = crate::db::init_pool(&dir.path().join("report.db"))
            .await
            .expect("init_pool");
        let mat = Materializer::new(pool.clone());
        mat.set_app_data_dir(dir.path().to_path_buf());
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".to_owned(),
            "Oracle page".to_owned(),
            None,
            None,
        )
        .await
        .expect("create page");
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".to_owned(),
            "a child block".to_owned(),
            Some(BlockId::from_trusted(page.id.as_str())),
            None,
        )
        .await
        .expect("create child");
        mat.flush_background().await.expect("flush_background");
        let page_id = page.id.to_string();
        (pool, dir, mat, page_id)
    }

    #[test]
    fn group_by_artefact_counts_every_row_and_bounds_the_sample() {
        let mut divergences: Vec<Divergence> = (0..12)
            .map(|i| divergence("pages_cache.child_block_count", &format!("PAGE{i:02}")))
            .collect();
        divergences.push(divergence("fts_blocks.row", "BLOCK00"));

        let groups = group_by_artefact(&divergences);

        assert_eq!(groups.len(), 2, "one group per artefact, first-seen order");
        assert_eq!(groups[0].artefact, "pages_cache.child_block_count");
        assert_eq!(groups[0].count, 12, "count is every row, not the sample");
        assert_eq!(
            groups[0].sample_keys.len(),
            SAMPLE_KEYS_PER_ARTEFACT,
            "the sample is bounded"
        );
        assert_eq!(groups[0].sample_keys[0], "PAGE00");
        assert_eq!(groups[0].sample_keys[9], "PAGE09");
        assert_eq!(groups[1].artefact, "fts_blocks.row");
        assert_eq!(groups[1].count, 1);
        assert_eq!(groups[1].sample_keys, vec!["BLOCK00".to_owned()]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_settled_vault_reports_no_divergences() {
        let (pool, _dir, mat, _page_id) = settled_vault().await;

        let report = compute_reconciliation_report_inner(&pool, pinned_today())
            .await
            .expect("report");

        assert_eq!(
            report.blocks_scanned, 2,
            "the page and its child were folded"
        );
        assert_eq!(report.today, "2026-01-15", "the pinned date is recorded");
        assert_eq!(report.total_divergences, 0, "a settled vault reconciles");
        assert_eq!(report.artefacts, Vec::new(), "no artefact diverged");
        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_corrupted_count_is_reported_as_exactly_that_divergence() {
        let (pool, _dir, mat, page_id) = settled_vault().await;
        // dynamic-sql: test-only corruption of one derived row.
        sqlx::query(
            "UPDATE pages_cache SET child_block_count = child_block_count + 5 WHERE page_id = ?",
        )
        .bind(&page_id)
        .execute(&pool)
        .await
        .expect("corrupt the count");

        let report = compute_reconciliation_report_inner(&pool, pinned_today())
            .await
            .expect("report");

        assert_eq!(
            report.total_divergences, 1,
            "the one corrupted row, nothing else"
        );
        assert_eq!(
            report.artefacts,
            vec![ArtefactDivergences {
                artefact: "pages_cache.child_block_count".to_owned(),
                count: 1,
                sample_keys: vec![page_id],
            }],
            "named artefact, exact count, the corrupted row's key"
        );
        mat.shutdown();
    }

    #[tokio::test]
    async fn a_read_failure_propagates_instead_of_reporting_a_clean_vault() {
        let dir = TempDir::new().expect("tempdir");
        let pool = crate::db::init_pool(&dir.path().join("report.db"))
            .await
            .expect("init_pool");
        // dynamic-sql: test-only fixture — remove a table the oracle dumps.
        sqlx::query("DROP TABLE agenda_cache")
            .execute(&pool)
            .await
            .expect("drop agenda_cache");

        let err = compute_reconciliation_report_inner(&pool, pinned_today())
            .await
            .expect_err("a missing derived table is an error, not zero divergences");

        assert!(
            matches!(err, AppError::Database(_)),
            "the sqlx error surfaces as AppError::Database, got {err:?}"
        );
    }
}
