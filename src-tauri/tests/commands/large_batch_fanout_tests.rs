//! One command that writes a thousand blocks, and what its derived rows look
//! like once the materializer says it has settled.
//!
//! Each test runs on the app's split pools (two writers, `init_pools`): the
//! contention a large fan-out causes is on that pool, and the single test
//! pool hides it.

use super::prelude::*;
use agaric_lib::db::init_pools;
use agaric_store::pagination::MAX_BATCH_BLOCK_IDS;
use std::sync::atomic::Ordering;
use tempfile::TempDir;

struct Vault {
    write: SqlitePool,
    read: SqlitePool,
    mat: Materializer,
    page: BlockId,
    _dir: TempDir,
}

async fn vault() -> Vault {
    let dir = TempDir::new().unwrap();
    let pools = init_pools(&dir.path().join("notes.db")).await.unwrap();
    let mat = Materializer::with_read_pool(pools.write.clone(), pools.read.clone());
    let page = space_page(&pools.write, &mat).await;
    settle(&mat).await;
    Vault {
        write: pools.write,
        read: pools.read,
        mat,
        page,
        _dir: dir,
    }
}

fn content_spec(page: &BlockId, content: String) -> CreateBlockSpec {
    CreateBlockSpec {
        block_type: "content".into(),
        content,
        parent_id: Some(page.clone()),
        parent_index: None,
        block_id: None,
        position: None,
        properties: std::collections::HashMap::new(),
        typed_properties: std::collections::HashMap::new(),
    }
}

/// What the background queue left behind for `ids`, read after a settle.
#[derive(Debug, PartialEq, Eq)]
struct Derived {
    fts_rows: i64,
    agenda_rows: i64,
    page_ids: i64,
    shed: u64,
    /// `materializer_retry_queue`, as `(task_kind, last_error, rows)`.
    retry_rows: Vec<(String, Option<String>, i64)>,
}

async fn derived(vault: &Vault, ids: &[String]) -> Derived {
    let ids_json = serde_json::to_string(ids).unwrap();
    let count = |sql: &'static str| {
        let ids_json = ids_json.clone();
        let read = vault.read.clone();
        async move {
            sqlx::query_scalar::<_, i64>(sql)
                .bind(ids_json)
                .fetch_one(&read)
                .await
                .unwrap()
        }
    };
    Derived {
        fts_rows: count(
            "SELECT COUNT(*) FROM fts_blocks \
             WHERE block_id IN (SELECT value FROM json_each(?))",
        )
        .await,
        agenda_rows: count(
            "SELECT COUNT(*) FROM agenda_cache \
             WHERE block_id IN (SELECT value FROM json_each(?))",
        )
        .await,
        page_ids: count(
            "SELECT COUNT(*) FROM blocks \
             WHERE id IN (SELECT value FROM json_each(?)) AND page_id IS NOT NULL",
        )
        .await,
        shed: vault.mat.metrics().bg_dropped.load(Ordering::Relaxed),
        retry_rows: sqlx::query_as(
            "SELECT task_kind, last_error, COUNT(*) FROM materializer_retry_queue \
             GROUP BY task_kind, last_error ORDER BY task_kind, last_error",
        )
        .fetch_all(&vault.read)
        .await
        .unwrap(),
    }
}

fn all_derived(n: i64, dated: i64) -> Derived {
    Derived {
        fts_rows: n,
        agenda_rows: dated,
        page_ids: n,
        shed: 0,
        retry_rows: Vec::new(),
    }
}

/// The report's first case: one `create_blocks_batch` of the cap, then one
/// `set_property_batch` dating every block.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_batch_of_the_cap_then_a_date_on_each_is_whole_once_settled() {
    let vault = vault().await;
    let specs = (0..MAX_BATCH_BLOCK_IDS)
        .map(|i| content_spec(&vault.page, format!("batch block {i}")))
        .collect();
    let created = create_blocks_batch_inner(&vault.write, DEV, &vault.mat, specs)
        .await
        .unwrap();
    let ids: Vec<String> = created.iter().map(|b| b.id.to_string()).collect();
    let block_ids = created.iter().map(|b| b.id.clone()).collect();
    let updated = set_property_batch_inner(
        &vault.write,
        DEV,
        &vault.mat,
        block_ids,
        "due_date".into(),
        Some("2026-01-20".into()),
    )
    .await
    .unwrap();
    assert_eq!(updated, 1000, "every block of the batch took the date");

    settle(&vault.mat).await;

    assert_eq!(
        derived(&vault, &ids).await,
        all_derived(1000, 1000),
        "a settled queue owes the batch nothing"
    );
}

/// The report's import: a thousand dated tasks in one Markdown file.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_import_of_a_thousand_dated_tasks_is_whole_once_settled() {
    let vault = vault().await;
    let md: String = (0..1000)
        .map(|i| format!("- imported task {i}\n  due_date:: 2026-01-20\n"))
        .collect();
    let result = import_markdown_inner(
        &vault.write,
        DEV,
        &vault.mat,
        vault._dir.path(),
        md,
        Some("Thousand tasks.md".into()),
        TEST_SPACE_ID.into(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.blocks_created, 1000, "the import made every task");

    settle(&vault.mat).await;

    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM blocks WHERE block_type = 'content' AND content LIKE 'imported task %'",
    )
    .fetch_all(&vault.read)
    .await
    .unwrap();
    assert_eq!(ids.len(), 1000, "the fixture's blocks are the import's");
    assert_eq!(
        derived(&vault, &ids).await,
        all_derived(1000, 1000),
        "a settled queue owes the import nothing"
    );
}

/// Replace across pages at its cap: one `edit_blocks_batch` rewriting every
/// block, after which search finds the new text in each and the old in none.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replace_across_a_thousand_blocks_is_searchable_once_settled() {
    let vault = vault().await;
    let specs = (0..MAX_BATCH_BLOCK_IDS)
        .map(|i| content_spec(&vault.page, format!("heron sighting {i}")))
        .collect();
    let created = create_blocks_batch_inner(&vault.write, DEV, &vault.mat, specs)
        .await
        .unwrap();
    // The create's own fan-out is not this test's subject.
    settle(&vault.mat).await;
    let shed_by_fixture = vault.mat.metrics().bg_dropped.load(Ordering::Relaxed);

    let edits = created
        .iter()
        .enumerate()
        .map(|(i, block)| BlockEdit {
            block_id: block.id.clone(),
            expected: format!("heron sighting {i}"),
            to_text: format!("bittern sighting {i}"),
        })
        .collect();
    let reply = edit_blocks_batch_inner(&vault.write, DEV, &vault.mat, edits)
        .await
        .unwrap();
    assert_eq!(reply.skipped.len(), 0, "every block held its expected text");

    settle(&vault.mat).await;

    let matching = |needle: &'static str| {
        let read = vault.read.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM fts_blocks WHERE stripped LIKE ?")
                .bind(format!("{needle} sighting %"))
                .fetch_one(&read)
                .await
                .unwrap()
        }
    };
    assert_eq!(
        (
            matching("bittern").await,
            matching("heron").await,
            vault.mat.metrics().bg_dropped.load(Ordering::Relaxed) - shed_by_fixture,
        ),
        (1000, 0, 0),
        "the index holds the replaced text of every block, the old text of none, \
         and the replace shed nothing"
    );
}

/// Measurement, with no assertion: batches of 200 blocks that carry their date in the
/// create, one after another with no settle between, as a folder import or a
/// seeding script sends them, then fifty single creates while the queue is
/// still draining. Prints how long each commit took, the longest of the
/// single creates, how long the settle took and what the queue shed, for a
/// before-and-after of a change to the fan-out; the report's `database is
/// locked` is a commit here that waits out the 5 s busy timeout. Which writer
/// wins the lock is SQLite's poll timing, so the times are read as a band
/// across runs:
///
/// ```sh
/// cargo nextest run -p agaric --test commands --run-ignored only --no-capture \
///     -E 'test(measure_dated_batches_back_to_back)'
/// ```
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "measurement harness; run by the weekly bench-perf-gates lane"]
async fn measure_dated_batches_back_to_back() {
    let vault = vault().await;
    let mut ids = Vec::new();
    let mut commit_ms = Vec::new();
    let mut refused = Vec::new();
    for batch in 0..5 {
        let specs = (0..200)
            .map(|i| {
                let mut spec = content_spec(&vault.page, format!("dated {batch}-{i}"));
                spec.properties
                    .insert("due_date".into(), "2026-01-20".into());
                spec
            })
            .collect();
        let started = std::time::Instant::now();
        let created = create_blocks_batch_inner(&vault.write, DEV, &vault.mat, specs).await;
        commit_ms.push(started.elapsed().as_millis());
        match created {
            Ok(created) => ids.extend(created.iter().map(|b| b.id.to_string())),
            Err(e) => refused.push(format!("batch {batch}: {e}")),
        }
    }
    let mut slowest_single_ms = 0;
    for i in 0..50 {
        let started = std::time::Instant::now();
        let id = append_child(
            &vault.write,
            &vault.mat,
            &vault.page,
            &format!("single {i}"),
        )
        .await;
        slowest_single_ms = slowest_single_ms.max(started.elapsed().as_millis());
        ids.push(id.to_string());
    }
    let started = std::time::Instant::now();
    settle(&vault.mat).await;
    let settle_ms = started.elapsed().as_millis();

    println!(
        "measure_dated_batches_back_to_back: commit_ms={commit_ms:?} refused={refused:?} \
         slowest_single_ms={slowest_single_ms} settle_ms={settle_ms} bg_errors={} {:?}",
        vault.mat.metrics().bg_errors.load(Ordering::Relaxed),
        derived(&vault, &ids).await,
    );
}

/// The integrity check after a shed runs the shed tasks before it compares,
/// instead of reporting the rows they had not yet written. The baseline is
/// what the fixture itself diverges by: its space block is a raw insert with
/// no index row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_integrity_check_runs_what_the_queue_shed_before_it_reports() {
    use agaric_lib::commands::reconciliation::settled_reconciliation_report;
    let vault = vault().await;
    let today = chrono::NaiveDate::from_ymd_opt(2026, 1, 15).unwrap();
    let baseline = settled_reconciliation_report(&vault.read, &vault.mat, None, today)
        .await
        .unwrap();

    vault.mat.force_shed_after(0);
    append_child(
        &vault.write,
        &vault.mat,
        &vault.page,
        "shed before the check",
    )
    .await;
    vault.mat.force_shed_after(-1);
    assert_eq!(
        vault.mat.metrics().bg_dropped.load(Ordering::Relaxed),
        4,
        "the fixture shed the create's four tasks"
    );

    let report = settled_reconciliation_report(&vault.read, &vault.mat, None, today)
        .await
        .unwrap();

    assert_eq!(
        report.artefacts, baseline.artefacts,
        "the shed block adds no divergence to a settled vault"
    );
}

/// A page rename shed by a full queue still reaches the blocks that link to
/// the page: the reference reindex leaves a retry row, and a settle runs it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shed_rename_still_reaches_the_blocks_that_link_to_the_page() {
    let vault = vault().await;
    let target = create_page_in_space_inner(
        &vault.write,
        DEV,
        &vault.mat,
        None,
        "heron".into(),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    let referrer = append_child(
        &vault.write,
        &vault.mat,
        &vault.page,
        &format!("seen: [[{target}]]"),
    )
    .await;
    settle(&vault.mat).await;
    let stripped = || {
        let read = vault.read.clone();
        let id = referrer.to_string();
        async move {
            sqlx::query_scalar::<_, String>("SELECT stripped FROM fts_blocks WHERE block_id = ?")
                .bind(id)
                .fetch_one(&read)
                .await
                .unwrap()
        }
    };
    assert_eq!(
        stripped().await,
        "seen: heron",
        "the link is indexed as the page's title"
    );

    vault.mat.force_shed_after(0);
    edit_block_inner(&vault.write, DEV, &vault.mat, target, "bittern".into())
        .await
        .unwrap();
    vault.mat.force_shed_after(-1);
    settle(&vault.mat).await;

    assert_eq!(
        stripped().await,
        "seen: bittern",
        "the linking block is indexed under the page's new title"
    );
}
