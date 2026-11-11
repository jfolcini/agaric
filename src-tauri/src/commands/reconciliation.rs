//! Reconciliation-oracle command (#4886).
//!
//! Points `crate::reconciliation_oracle` — the from-base rebuild of every
//! derived artefact, diffed against the incrementally-maintained state — at
//! the live vault, and reports what diverged in a shape a user can paste into
//! a bug report. Read-and-compare only: every read goes through the reader
//! pool or an export of the engines, and the only writes are the queued work
//! it waits for, so a divergence is data in the return value, never a panic
//! and never a repair. Rebuilding every
//! artefact whole-table is not a boot cost; this runs when the user asks (an
//! opt-in setting, the follow-up commit), and the command lets the materializer
//! settle first ([`settled_reconciliation_report`]) — a run that overlaps a
//! background rebuild or an inbound sync can see a state one maintainer has
//! left and the next has not yet reached, which reads as a divergence a second
//! run will not reproduce.
//!
//! # Counts and keys in the bug report, one value on the screen
//!
//! The oracle's `Divergence` carries `expected` / `actual` strings that quote
//! what the rebuild computed — a stripped FTS body, a tag's name, an
//! attachment's `fs_path`. A row VALUE is the user's content while a row KEY
//! is an opaque ULID, hash or date the maintainer cannot resolve without the
//! vault, and the frontend embeds the copied report verbatim in a prefilled
//! PUBLIC GitHub issue body (#609, #4854). So each artefact reports its name,
//! how many rows diverged, and a bounded sample of keys — enough to say "17
//! rows of `pages_cache.child_block_count` disagree, starting with these",
//! which is a bug report — and the copied text carries nothing else.
//!
//! The one value the report does carry is [`ReconciliationReport::samples`]:
//! one truncated expected-versus-actual pair per artefact, for the screen
//! alone, so the user can see what is wrong before they decide to rebuild or
//! report it (#6488). The copy and the bug report leave it out.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::db::{ReadPool, WriteCtx};
use crate::materializer::Materializer;
use crate::reconciliation_oracle::{self, Divergence};
use agaric_core::error::AppError;
use agaric_engine::loro::shared::LoroState;

use super::sanitize_internal_error;

/// Row keys a report carries per artefact. Enough to name the rows a
/// maintainer will ask for first; small enough that a vault with thousands of
/// stale rows still produces a report that fits in an issue body.
pub const SAMPLE_KEYS_PER_ARTEFACT: usize = 10;

/// Characters a [`DivergenceSample`] keeps of each side before it cuts.
pub const SAMPLE_CHARS: usize = 120;

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
    /// The first divergence of each artefact, `artefacts` order, its values
    /// cut to [`SAMPLE_CHARS`]. For the screen only: the copied report and the
    /// bug report never carry it (module docs).
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub samples: Option<Vec<DivergenceSample>>,
}

/// One divergence as the screen shows it (#6488).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DivergenceSample {
    /// The artefact it belongs to, as in [`ArtefactDivergences::artefact`].
    pub artefact: String,
    pub key: String,
    /// What the rebuild from the base tables computed.
    pub expected: String,
    /// What the maintained state holds.
    pub actual: String,
}

/// `text` cut to [`SAMPLE_CHARS`] characters, on a character boundary, with
/// an ellipsis when it was longer.
fn truncate_sample(text: &str) -> String {
    match text.char_indices().nth(SAMPLE_CHARS) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_owned(),
    }
}

/// The first divergence of each artefact, first-seen order.
fn first_of_each_artefact(divergences: &[Divergence]) -> Vec<DivergenceSample> {
    let mut seen = std::collections::BTreeSet::new();
    divergences
        .iter()
        .filter(|d| seen.insert(d.artefact))
        .map(|d| DivergenceSample {
            artefact: d.artefact.to_owned(),
            key: d.key.clone(),
            expected: truncate_sample(&d.expected),
            actual: truncate_sample(&d.actual),
        })
        .collect()
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

/// Run every oracle artefact against `pool` and the engines in `engines`, and
/// shape the result.
///
/// `app_data_dir` is where attachment files live, `None` where there are none
/// to look at. `today` is the date the projected-agenda rebuild is pinned to;
/// the wrapper passes the local clock, tests pass a constant.
#[instrument(skip(pool, engines), err)]
pub async fn compute_reconciliation_report_inner(
    pool: &SqlitePool,
    engines: &LoroState,
    app_data_dir: Option<&std::path::Path>,
    today: chrono::NaiveDate,
) -> Result<ReconciliationReport, AppError> {
    let blocks_scanned: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(pool)
        .await?;
    let divergences =
        reconciliation_oracle::reconcile_all(pool, engines, app_data_dir, today).await?;
    Ok(ReconciliationReport {
        blocks_scanned,
        today: today.format("%Y-%m-%d").to_string(),
        total_divergences: i64::try_from(divergences.len()).unwrap_or(i64::MAX),
        artefacts: group_by_artefact(&divergences),
        samples: Some(first_of_each_artefact(&divergences)),
    })
}

/// [`compute_reconciliation_report_inner`] once the materializer has settled
/// (#6488): an op still in the foreground queue, a background reindex not yet
/// run, or an inbound-sync rebuild waiting out its debounce leaves a cache
/// behind its base tables for a moment, and reporting that moment names a
/// divergence a second run would not reproduce.
#[instrument(skip(pool, materializer), err)]
pub async fn settled_reconciliation_report(
    pool: &SqlitePool,
    materializer: &Materializer,
    app_data_dir: Option<&std::path::Path>,
    today: chrono::NaiveDate,
) -> Result<ReconciliationReport, AppError> {
    materializer.flush_foreground().await?;
    materializer.flush_inbound_rebuilds().await?;
    compute_reconciliation_report_inner(pool, materializer.loro_state(), app_data_dir, today).await
}

/// Tauri command: let the materializer settle, rebuild every derived artefact
/// from base tables, compare `blocks` with the Loro engine, and report where
/// the live vault disagrees. Reads through the reader pool and engine exports;
/// the only writes are the queued work it waits for.
#[tauri::command]
#[specta::specta]
pub async fn compute_reconciliation_report(
    pool: State<'_, ReadPool>,
    materializer: State<'_, Materializer>,
) -> Result<ReconciliationReport, AppError> {
    // The clock production's `rebuild_projected_agenda_cache` reads, so the
    // rebuild is pinned to the same day the cache was built for.
    let today = chrono::Local::now().date_naive();
    settled_reconciliation_report(
        &pool.0,
        &materializer,
        materializer.app_data_dir().as_deref(),
        today,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Rebuild every derived cache from the base tables, then report what still
/// disagrees (#6488). What it rebuilds is every artefact the report lists
/// outside `engine.*`: those are caches, and a rebuild loses nothing the base
/// tables do not still hold. It never touches `blocks` against the engine,
/// which no rebuild can repair. The user copies the report first, so the
/// evidence outlives the rebuild.
///
/// The two passes with no materializer task (the link graph and the Pages
/// title keys) run here on the writer; everything else goes through the
/// background queue, page ids first since the page caches read them, and the
/// report waits for it to drain.
#[instrument(skip(write_pool, read_pool, materializer), err)]
pub async fn rebuild_derived_state_inner(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
    materializer: &Materializer,
    app_data_dir: Option<&std::path::Path>,
    today: chrono::NaiveDate,
) -> Result<ReconciliationReport, AppError> {
    use crate::materializer::{FULL_CACHE_REBUILD_TASKS, MaterializeTask};

    materializer.flush_foreground().await?;
    materializer
        .enqueue_background(MaterializeTask::RebuildPageIds)
        .await?;
    materializer.flush_background().await?;
    agaric_store::cache::rederive_block_links(write_pool).await?;
    agaric_store::cache::rekey_title_sort_keys(write_pool).await?;
    for task in FULL_CACHE_REBUILD_TASKS {
        materializer.enqueue_background(task).await?;
    }
    materializer
        .enqueue_background(MaterializeTask::RebuildFtsIndex)
        .await?;
    settled_reconciliation_report(read_pool, materializer, app_data_dir, today).await
}

/// Tauri command: rebuild every derived cache, then return a fresh
/// integrity report.
#[tauri::command]
#[specta::specta]
pub async fn rebuild_derived_state(
    ctx: State<'_, WriteCtx>,
    read_pool: State<'_, ReadPool>,
) -> Result<ReconciliationReport, AppError> {
    let today = chrono::Local::now().date_naive();
    let materializer = ctx.materializer();
    rebuild_derived_state_inner(
        ctx.pool(),
        &read_pool.0,
        materializer,
        materializer.app_data_dir().as_deref(),
        today,
    )
    .await
    .map_err(sanitize_internal_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::commands::blocks::crud::create_block_inner;
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

        let report =
            compute_reconciliation_report_inner(&pool, mat.loro_state(), None, pinned_today())
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

    /// #6488 — an inbound-sync rebuild still waiting out its debounce is work
    /// in flight, not a divergence: the report waits for it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_pending_inbound_rebuild_lands_before_the_report_6488() {
        let (pool, _dir, mat, page_id) = settled_vault().await;
        // dynamic-sql: test-only corruption of one derived row, which the
        // armed inbound rebuild's `RebuildPagesCacheCounts` rewrites.
        sqlx::query(
            "UPDATE pages_cache SET child_block_count = child_block_count + 5 WHERE page_id = ?",
        )
        .bind(&page_id)
        .execute(&pool)
        .await
        .expect("corrupt the count");
        mat.enqueue_inbound_sync_rebuilds(&[BlockId::from_trusted(page_id.as_str())], &[])
            .await
            .expect("arm the inbound rebuild");

        let report = settled_reconciliation_report(&pool, &mat, None, pinned_today())
            .await
            .expect("report");

        assert_eq!(
            report.artefacts,
            Vec::new(),
            "the pending rebuild landed first"
        );
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

        let report =
            compute_reconciliation_report_inner(&pool, mat.loro_state(), None, pinned_today())
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

    /// #5371 — the Pages sort keys: a title key that is not the key of the
    /// cached title, and a last edit below the newest op on the page, each
    /// report as their own artefact.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stale_title_key_and_a_lowered_last_edit_are_each_reported_5371() {
        let (pool, _dir, mat, page_id) = settled_vault().await;
        // dynamic-sql: test-only corruption of one derived row.
        sqlx::query(
            "UPDATE pages_cache SET title_sort_key = 'zzz', last_edited_ms = 1 WHERE page_id = ?",
        )
        .bind(&page_id)
        .execute(&pool)
        .await
        .expect("corrupt the sort keys");

        let report =
            compute_reconciliation_report_inner(&pool, mat.loro_state(), None, pinned_today())
                .await
                .expect("report");

        assert_eq!(
            report.artefacts,
            vec![
                ArtefactDivergences {
                    artefact: "pages_cache.title_sort_key".to_owned(),
                    count: 1,
                    sample_keys: vec![page_id.clone()],
                },
                ArtefactDivergences {
                    artefact: "pages_cache.last_edited_ms".to_owned(),
                    count: 1,
                    sample_keys: vec![page_id],
                },
            ],
            "each corrupted key names its artefact and the page"
        );
        mat.shutdown();
    }

    /// #5371 — a cache row whose space is not its page's reports as its own
    /// artefact: the Pages list would show the page in the wrong space.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cache_row_in_the_wrong_space_is_reported_5371() {
        let (pool, _dir, mat, page_id) = settled_vault().await;
        // dynamic-sql: test-only corruption of one derived row.
        sqlx::query("UPDATE pages_cache SET space_id = 'ELSEWHERE' WHERE page_id = ?")
            .bind(&page_id)
            .execute(&pool)
            .await
            .expect("corrupt the space");

        let report =
            compute_reconciliation_report_inner(&pool, mat.loro_state(), None, pinned_today())
                .await
                .expect("report");

        assert_eq!(
            report.artefacts,
            vec![ArtefactDivergences {
                artefact: "pages_cache.space_id".to_owned(),
                count: 1,
                sample_keys: vec![page_id],
            }],
            "the row in the wrong space, nothing else"
        );
        mat.shutdown();
    }

    /// A user space holding a page with four children, built through the
    /// command path, so the engine and SQL hold what production writes.
    /// Returns the space, the page and the children, in that order.
    async fn vault_in_a_space() -> (SqlitePool, TempDir, Materializer, Vec<String>) {
        let dir = TempDir::new().expect("tempdir");
        let pool = crate::db::init_pool(&dir.path().join("engine.db"))
            .await
            .expect("init_pool");
        let mat = Materializer::new(pool.clone());
        mat.set_app_data_dir(dir.path().to_path_buf());
        let space = crate::commands::spaces::create_space_inner(
            &pool,
            DEV,
            &mat,
            "Oracle space".to_owned(),
            None,
        )
        .await
        .expect("create space");
        let page = crate::commands::spaces::create_page_in_space_inner(
            &pool,
            DEV,
            &mat,
            None,
            "Engine page".to_owned(),
            space.to_string(),
        )
        .await
        .expect("create page");
        let mut ids = vec![space.to_string(), page.to_string()];
        for text in ["first child", "second child", "third child", "fourth child"] {
            let child = create_block_inner(
                &pool,
                DEV,
                &mat,
                "content".to_owned(),
                text.to_owned(),
                Some(page.clone()),
                None,
            )
            .await
            .expect("create child");
            ids.push(child.id.to_string());
        }
        mat.flush_background().await.expect("flush_background");
        (pool, dir, mat, ids)
    }

    /// #5628 — `blocks` against the Loro engine on a vault the command path
    /// built: it agrees as built, then each engine-owned column written behind
    /// the engine's back reports as its own artefact, on its own block, and so
    /// does a row on either side only.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sql_written_behind_the_engine_is_reported_per_column_5628() {
        const SQL_ONLY: &str = "01SQLONLY56280000000000000";
        let (pool, _dir, mat, ids) = vault_in_a_space().await;
        let [space, page, first, second, third, fourth] = ids.as_slice() else {
            panic!("the fixture returns six ids");
        };

        let report =
            compute_reconciliation_report_inner(&pool, mat.loro_state(), None, pinned_today())
                .await
                .expect("report");
        assert_eq!(
            report.artefacts,
            Vec::new(),
            "a vault built through commands agrees with its engine and its caches"
        );

        // dynamic-sql: test-only writes behind the engine's back.
        for (sql, binds) in [
            (
                "UPDATE blocks SET content = 'edited in SQL' WHERE id = ?",
                vec![first.as_str()],
            ),
            (
                "UPDATE blocks SET position = 9 WHERE id = ?",
                vec![first.as_str()],
            ),
            (
                "UPDATE blocks SET block_type = 'tag', parent_id = ?, deleted_at = 1 WHERE id = ?",
                vec![first.as_str(), second.as_str()],
            ),
            // A rank gap with the order kept, as a purged sibling leaves: no divergence.
            (
                "UPDATE blocks SET priority = '1', position = position + 10 WHERE id = ?",
                vec![page.as_str()],
            ),
            ("DELETE FROM blocks WHERE id = ?", vec![third.as_str()]),
            (
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, \
                 space_id) VALUES (?, 'content', 'SQL only', ?, 4, ?, ?)",
                vec![SQL_ONLY, page.as_str(), page.as_str(), space.as_str()],
            ),
        ] {
            let mut query = sqlx::query(sql);
            for bind in binds {
                query = query.bind(bind);
            }
            query.execute(&pool).await.expect("write behind the engine");
        }

        let report =
            compute_reconciliation_report_inner(&pool, mat.loro_state(), None, pinned_today())
                .await
                .expect("report");
        let mut engine: Vec<(String, Vec<String>)> = report
            .artefacts
            .into_iter()
            .filter(|a| a.artefact.starts_with("engine."))
            .map(|a| {
                let mut keys = a.sample_keys;
                keys.sort();
                (a.artefact, keys)
            })
            .collect();
        engine.sort();
        let at = |ids: &[&str]| {
            let mut keys: Vec<String> = ids.iter().map(|id| format!("{space} / {id}")).collect();
            keys.sort();
            keys
        };
        assert_eq!(
            engine,
            vec![
                ("engine.blocks.block_type".to_owned(), at(&[second])),
                ("engine.blocks.content".to_owned(), at(&[first])),
                ("engine.blocks.deleted_at".to_owned(), at(&[second])),
                ("engine.blocks.parent_id".to_owned(), at(&[second])),
                ("engine.blocks.position".to_owned(), at(&[first, fourth])),
                ("engine.blocks.priority".to_owned(), at(&[page])),
                ("engine.blocks.row".to_owned(), at(&[SQL_ONLY, third])),
            ],
            "each column names its block, a reorder names both swapped siblings, and a \
             rank gap that keeps the order names none"
        );
        mat.shutdown();
    }

    /// #5728: a peer's attachment row lands before its bytes, and has no blob
    /// until they do. With the attachments directory to look in, the report
    /// leaves out a hash whose file is absent, and still names one whose file
    /// is on disk with no blob.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_peer_attachment_whose_bytes_have_not_landed_is_not_a_divergence_5728() {
        let (pool, dir, mat, page_id) = settled_vault().await;
        std::fs::create_dir_all(dir.path().join("attachments")).expect("attachments dir");
        std::fs::write(dir.path().join("attachments/landed"), b"bytes").expect("landed bytes");
        for (id, name, hash) in [
            ("01PENDINGATTACHMENT572800", "pending", "PENDINGHASH5728"),
            ("01LANDEDATTACHMENT5728000", "landed", "LANDEDHASH5728"),
        ] {
            let fs_path = format!("attachments/{name}");
            sqlx::query(
                "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, \
                 fs_path, created_at, content_hash) VALUES (?, ?, 'image/png', ?, 5, ?, 1, ?)",
            )
            .bind(id)
            .bind(&page_id)
            .bind(name)
            .bind(&fs_path)
            .bind(hash)
            .execute(&pool)
            .await
            .expect("a synced attachment row with no blob");
        }

        let report = compute_reconciliation_report_inner(
            &pool,
            mat.loro_state(),
            Some(dir.path()),
            pinned_today(),
        )
        .await
        .expect("report");

        assert_eq!(
            report.artefacts,
            vec![ArtefactDivergences {
                artefact: "attachment_blobs.refcount".to_owned(),
                count: 1,
                sample_keys: vec!["LANDEDHASH5728".to_owned()],
            }],
            "only the hash whose bytes are on disk lacks a blob"
        );
        mat.shutdown();
    }

    /// #5608 — `attachments` against the engine on a vault the commands built:
    /// it agrees as built, then a row deleted, a row written and a row edited
    /// behind the engine, and an entry deleted in the engine alone, each report
    /// on their own attachment. A row repointed at other bytes' path with no
    /// hash, as a dedup link and a legacy row leave it, reports nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn attachment_rows_behind_the_engine_are_reported_5608() {
        const SQL_ONLY: &str = "01SQLONLYATTACHMENT5608000";
        let (pool, dir, mat, ids) = vault_in_a_space().await;
        let [space, _page, first, ..] = ids.as_slice() else {
            panic!("the fixture returns six ids");
        };
        let mut att = Vec::new();
        for (name, bytes) in [
            ("one.txt", "one"),
            ("two.txt", "two"),
            ("three.txt", "three"),
            ("four.txt", "four"),
        ] {
            let row = crate::commands::attachments::add_attachment_with_bytes_inner(
                &pool,
                DEV,
                &mat,
                dir.path(),
                BlockId::from_trusted(first),
                name.to_owned(),
                "text/plain".to_owned(),
                bytes.as_bytes().to_vec(),
            )
            .await
            .expect("add attachment");
            att.push(row.id.to_string());
        }
        mat.flush_background().await.expect("flush_background");

        let report =
            compute_reconciliation_report_inner(&pool, mat.loro_state(), None, pinned_today())
                .await
                .expect("report");
        assert_eq!(
            report.artefacts,
            Vec::new(),
            "attachments added through the commands agree with the engine"
        );

        // dynamic-sql: test-only writes behind the engine's back.
        for (sql, binds) in [
            (
                "DELETE FROM attachments WHERE id = ?",
                vec![att[0].as_str()],
            ),
            (
                "UPDATE attachments SET filename = 'edited.txt', size_bytes = 99 WHERE id = ?",
                vec![att[1].as_str()],
            ),
            (
                "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, \
                 created_at) VALUES (?, ?, 'text/plain', 'sql.txt', 1, 'attachments/sql', 1)",
                vec![SQL_ONLY, first.as_str()],
            ),
            (
                "UPDATE attachments SET fs_path = 'attachments/linked', content_hash = NULL \
                 WHERE id = ?",
                vec![att[3].as_str()],
            ),
        ] {
            let mut query = sqlx::query(sql);
            for bind in binds {
                query = query.bind(bind);
            }
            query.execute(&pool).await.expect("write behind the engine");
        }
        {
            let space_id = agaric_store::space::SpaceId::from_trusted(space);
            let mut guard = mat
                .loro_state()
                .registry
                .for_space(&space_id, DEV)
                .expect("the space's engine");
            guard
                .engine_mut()
                .apply_delete_attachment(first, &att[2], 1)
                .expect("delete in the engine alone");
        }

        let report =
            compute_reconciliation_report_inner(&pool, mat.loro_state(), None, pinned_today())
                .await
                .expect("report");
        let mut found: Vec<(String, Vec<String>)> = report
            .artefacts
            .into_iter()
            .filter(|a| a.artefact.starts_with("engine."))
            .map(|a| {
                let mut keys = a.sample_keys;
                keys.sort();
                (a.artefact, keys)
            })
            .collect();
        found.sort();
        let at = |ids: &[&str]| {
            let mut keys: Vec<String> = ids.iter().map(|id| format!("{space} / {id}")).collect();
            keys.sort();
            keys
        };
        assert_eq!(
            found,
            vec![
                ("engine.attachments.deleted_at".to_owned(), at(&[&att[2]])),
                ("engine.attachments.filename".to_owned(), at(&[&att[1]])),
                (
                    "engine.attachments.row".to_owned(),
                    at(&[&att[0], SQL_ONLY])
                ),
                ("engine.attachments.size_bytes".to_owned(), at(&[&att[1]])),
            ],
            "a missing row, an extra row, each edited field and a delete SQL never saw \
             name their attachment, and no other engine artefact diverges"
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

        let err =
            compute_reconciliation_report_inner(&pool, &LoroState::new(), None, pinned_today())
                .await
                .expect_err("a missing derived table is an error, not zero divergences");

        assert!(
            matches!(err, AppError::Database(_)),
            "the sqlx error surfaces as AppError::Database, got {err:?}"
        );
    }

    /// #6488 — the screen's sample: the first divergence of each artefact,
    /// each side cut to `SAMPLE_CHARS` characters on a character boundary.
    #[test]
    fn each_artefact_samples_its_first_divergence_cut_to_length_6488() {
        let long = "é".repeat(SAMPLE_CHARS + 5);
        let mut divergences: Vec<Divergence> = (0..3)
            .map(|i| divergence("pages_cache.child_block_count", &format!("PAGE{i:02}")))
            .collect();
        divergences.push(Divergence {
            artefact: "fts_blocks.stripped",
            key: "BLOCK00".to_owned(),
            expected: long.clone(),
            actual: "short".to_owned(),
            owner: "test",
        });

        let samples = first_of_each_artefact(&divergences);

        assert_eq!(
            samples
                .iter()
                .map(|s| (s.artefact.as_str(), s.key.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("pages_cache.child_block_count", "PAGE00"),
                ("fts_blocks.stripped", "BLOCK00")
            ],
            "one per artefact, its first, first-seen order"
        );
        assert_eq!(
            samples[1].expected,
            format!("{}…", "é".repeat(SAMPLE_CHARS)),
            "a long side is cut, on a character boundary"
        );
        assert_eq!(samples[1].actual, "short", "a short side is whole");
    }

    /// #6488 — a block a sync import left awaiting its purge is expected to be
    /// out of its doc, so the membership check does not report it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_block_awaiting_its_purge_is_not_missing_from_the_engine_6488() {
        const AWAITING: &str = "01AWAITING6488000000000000";
        let (pool, _dir, mat, ids) = vault_in_a_space().await;
        let [space, page, ..] = ids.as_slice() else {
            panic!("the fixture returns six ids");
        };
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'content', 'leaving', ?, 4, ?, ?)",
            AWAITING,
            page,
            page,
            space,
        )
        .execute(&pool)
        .await
        .expect("a row its doc no longer holds");
        sqlx::query!(
            "INSERT INTO sync_deferred_purges (block_id) VALUES (?)",
            AWAITING
        )
        .execute(&pool)
        .await
        .expect("awaiting its purge");

        let report =
            compute_reconciliation_report_inner(&pool, mat.loro_state(), None, pinned_today())
                .await
                .expect("report");

        let engine: Vec<&str> = report
            .artefacts
            .iter()
            .map(|a| a.artefact.as_str())
            .filter(|a| a.starts_with("engine."))
            .collect();
        assert_eq!(
            engine,
            Vec::<&str>::new(),
            "nothing disagrees with the engine"
        );
        mat.shutdown();
    }

    /// #6488 — Rebuild rewrites every stale cache and returns the report it
    /// leaves: a count, a search row and a title key, each written stale.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rebuild_rewrites_every_stale_cache_6488() {
        let (pool, _dir, mat, page_id) = settled_vault().await;
        sqlx::query!(
            "UPDATE pages_cache SET child_block_count = child_block_count + 5, \
             title_sort_key = 'zzz'"
        )
        .execute(&pool)
        .await
        .expect("corrupt the page row");
        // dynamic-sql: `fts_blocks` is an FTS5 virtual table, which
        // sqlx-macros' describe cannot read (#4886).
        sqlx::query("UPDATE fts_blocks SET stripped = 'an older strip' WHERE block_id != ?")
            .bind(&page_id)
            .execute(&pool)
            .await
            .expect("corrupt the child's search row");
        let before =
            compute_reconciliation_report_inner(&pool, mat.loro_state(), None, pinned_today())
                .await
                .expect("report");
        let mut stale: Vec<String> = before.artefacts.into_iter().map(|a| a.artefact).collect();
        stale.sort();
        assert_eq!(
            stale,
            vec![
                "fts_blocks.stripped".to_owned(),
                "pages_cache.child_block_count".to_owned(),
                "pages_cache.title_sort_key".to_owned(),
            ],
            "the three caches are stale before the rebuild"
        );

        let after = rebuild_derived_state_inner(&pool, &pool, &mat, None, pinned_today())
            .await
            .expect("rebuild");

        assert_eq!(after.artefacts, Vec::new(), "nothing is left stale");
        mat.shutdown();
    }

    /// #6488 — a block stored under a lowercase id, or naming a lowercase
    /// parent, is reported under its own artefact, by its stored id.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_block_id_in_a_non_standard_form_is_reported_6488() {
        let (pool, _dir, mat, page_id) = settled_vault().await;
        let lower = page_id.to_ascii_lowercase();
        // Older data predates the parent foreign key it would fail now; one
        // connection, so the pragma covers the insert.
        let mut conn = pool.acquire().await.expect("a connection");
        // dynamic-sql: a pragma, which sqlx-macros cannot describe.
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&mut *conn)
            .await
            .expect("let a lowercase parent stand");
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
             VALUES ('01lowercase000000000000000', 'content', NULL, ?, ?)",
            lower,
            page_id,
        )
        .execute(&mut *conn)
        .await
        .expect("a row from older data");
        drop(conn);

        let report =
            compute_reconciliation_report_inner(&pool, mat.loro_state(), None, pinned_today())
                .await
                .expect("report");

        let id_form: Vec<&ArtefactDivergences> = report
            .artefacts
            .iter()
            .filter(|a| a.artefact == "blocks.id_form")
            .collect();
        assert_eq!(
            id_form,
            vec![&ArtefactDivergences {
                artefact: "blocks.id_form".to_owned(),
                count: 1,
                sample_keys: vec!["01lowercase000000000000000".to_owned()],
            }],
            "one block, by its stored id"
        );
        let sample = report
            .samples
            .unwrap_or_default()
            .into_iter()
            .find(|s| s.artefact == "blocks.id_form")
            .expect("its sample");
        assert_eq!(
            sample.actual,
            format!("id = 01lowercase000000000000000, parent_id = {lower}")
        );
        mat.shutdown();
    }
}
