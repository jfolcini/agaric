//! #6567 — head's boot over a vault a released build wrote.
//!
//! Every other database the suite opens was written by the code under test.
//! `tests/fixtures/release-vault/<tag>/` was written by the tag's own boot
//! path and command layer (`scripts/gen-release-vault.sh`; what it holds is in
//! the README beside it), so this is the one place head's migrations, engine
//! rehydrate, crash recovery and version-triggered cache rebuilds run over
//! rows and snapshots head did not produce.
//!
//! Not covered: the tag's UI, sync state, attachments on disk.

use crate::commands::pages::{
    ListPagesWithMetadataFilter, PageSort, list_pages_with_metadata_inner,
};
use crate::commands::{
    count_agenda_batch_by_source_inner, count_trash_inner, edit_block_inner,
    export_page_markdown_inner, get_properties_inner, list_all_tags_in_space_inner,
    resolve_page_by_alias_inner, search_blocks_inner,
};
use crate::spaces::{SPACE_PERSONAL_ULID, SPACE_WORK_ULID};
use agaric_core::ulid::BlockId;
use agaric_store::search_types::SearchFilter;
use agaric_store::space::{SpaceId, SpaceScope};
use std::path::PathBuf;

const RELEASE: &str = "0.23.0";

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/release-vault")
        .join(RELEASE)
        .join(name)
}

struct Booted {
    _dir: tempfile::TempDir,
    pools: crate::db::DbPools,
    materializer: crate::materializer::Materializer,
    device_id: String,
}

/// The app's boot phases over a copy of the released vault: pools (the
/// pre-migration backup and the migrations), the materializer, engine
/// rehydrate with crash recovery and the space bootstrap, then the cache
/// gating that rebuilds what a changed derivation rule left behind.
fn boot_released_vault() -> Booted {
    let dir = tempfile::tempdir().expect("throwaway app-data dir");
    let packed = std::fs::File::open(fixture("notes.db.gz")).expect("the committed vault");
    std::io::copy(
        &mut flate2::read::GzDecoder::new(packed),
        &mut std::fs::File::create(dir.path().join("notes.db")).expect("create notes.db"),
    )
    .expect("unpack the vault");
    let device_id = std::fs::read_to_string(fixture("device-id"))
        .expect("the vault's device id")
        .trim()
        .to_owned();

    let pools = tauri::async_runtime::block_on(crate::db::init_pools(&dir.path().join("notes.db")))
        .expect("head opens and migrates the released vault");
    let (_lifecycle, materializer) = super::build_materializer(&pools, dir.path());
    let report = super::recover_and_bootstrap(&pools, &device_id, &materializer)
        .expect("head boots the released vault");
    assert!(
        !report.replay_failed(),
        "boot replay failed: {:?}",
        report.replay_errors
    );
    tauri::async_runtime::block_on(async {
        super::boot_cache_gating(
            pools.write.clone(),
            pools.read.clone(),
            materializer.clone(),
        )
        .await;
        materializer.flush().await.expect("drain the boot rebuilds");
    });
    Booted {
        _dir: dir,
        pools,
        materializer,
        device_id,
    }
}

async fn count(pool: &sqlx::SqlitePool, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

async fn block_id(pool: &sqlx::SqlitePool, content: &str) -> BlockId {
    let id: String = sqlx::query_scalar("SELECT id FROM blocks WHERE content = ?")
        .bind(content)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("the vault's block {content:?}: {e}"));
    BlockId::from_trusted(&id)
}

async fn search_hits(pool: &sqlx::SqlitePool, word: &str) -> usize {
    let filter: SearchFilter = serde_json::from_value(serde_json::json!({
        "scope": { "kind": "spaces", "space_ids": [SPACE_PERSONAL_ULID] },
    }))
    .unwrap();
    search_blocks_inner(pool, word.into(), None, Some(50), filter, None)
        .await
        .unwrap()
        .items
        .len()
}

async fn assert_no_divergences(vault: &Booted, when: &str) {
    let report = crate::commands::reconciliation::settled_reconciliation_report(
        &vault.pools.read,
        &vault.materializer,
        None,
        chrono::Local::now().date_naive(),
    )
    .await
    .unwrap();
    assert_eq!(
        report.total_divergences, 0,
        "{when}, the op log, the engine and the derived views must agree: {:?}",
        report.artefacts
    );
}

/// The page titles of `space` with their `(inbound_link_count,
/// child_block_count)`, as the Pages list reads them.
async fn pages_list(pool: &sqlx::SqlitePool, space: &str) -> Vec<(String, i64, i64)> {
    list_pages_with_metadata_inner(
        pool,
        ListPagesWithMetadataFilter {
            sort: PageSort::Alphabetical,
            space_id: space.into(),
            filters: Vec::new(),
        },
        None,
        Some(50),
    )
    .await
    .unwrap()
    .items
    .into_iter()
    .map(|page| {
        (
            page.content.unwrap_or_default(),
            page.inbound_link_count,
            page.child_block_count,
        )
    })
    .collect()
}

/// Needs a process of its own (nextest): boot recovery runs once per process,
/// and the test reads the process-global `sql_only_fallback_count` delta.
#[test]
fn head_boots_the_vault_the_last_release_wrote_6567() {
    let vault = boot_released_vault();
    let pool = &vault.pools.read;
    let personal = SpaceScope::Active(SpaceId::from_trusted(SPACE_PERSONAL_ULID));
    tauri::async_runtime::block_on(async {
        assert_no_divergences(&vault, "after boot").await;

        assert_eq!(
            (
                count(pool, "SELECT COUNT(*) FROM blocks").await,
                count(pool, "SELECT COUNT(*) FROM op_log").await,
            ),
            (15, 61),
            "boot keeps every block and op the release wrote, and appends none"
        );
        assert_eq!(
            pages_list(pool, SPACE_PERSONAL_ULID).await,
            [("Projects".to_owned(), 0, 4), ("Reading".to_owned(), 1, 2)],
            "Personal's live pages, with their link and child counts"
        );
        assert_eq!(
            pages_list(pool, SPACE_WORK_ULID).await,
            [("Meetings".to_owned(), 0, 1)],
            "Work's page"
        );
        assert_eq!(
            count_trash_inner(pool, SPACE_PERSONAL_ULID).await.unwrap(),
            2,
            "the trashed page and its child are still in the trash"
        );

        let projects = block_id(pool, "Projects").await;
        let reading = block_id(pool, "Reading").await;
        assert_eq!(
            export_page_markdown_inner(pool, projects.as_str())
                .await
                .unwrap(),
            std::fs::read_to_string(fixture("export-projects.txt")).unwrap(),
            "head exports the page as the release exported it"
        );
        assert_eq!(
            resolve_page_by_alias_inner(pool, "Books", &personal)
                .await
                .unwrap(),
            Some((reading.as_str().to_owned(), Some("Reading".to_owned()))),
            "the alias still names its page"
        );
        let tags: Vec<_> = list_all_tags_in_space_inner(pool, SPACE_PERSONAL_ULID)
            .await
            .unwrap()
            .into_iter()
            .map(|tag| (tag.name, tag.usage_count))
            .collect();
        assert_eq!(
            tags,
            [("fixture-tag".to_owned(), 1)],
            "the tag and its one use"
        );
        assert_eq!(
            count_agenda_batch_by_source_inner(pool, vec!["2031-03-04".into()], &personal)
                .await
                .unwrap()["2031-03-04"],
            [("column:due_date".to_owned(), 1)].into(),
            "the task is on the agenda on its due date"
        );

        let mut properties: Vec<_> =
            get_properties_inner(pool, block_id(pool, "The Dispossessed").await)
                .await
                .unwrap()
                .into_iter()
                .map(|p| {
                    let value = p
                        .value_text
                        .or(p.value_date)
                        .or(p.value_ref)
                        .or(p.value_num.map(|n| n.to_string()))
                        .or(p.value_bool.map(|b| b.to_string()));
                    (p.key, value.unwrap_or_default())
                })
                .collect();
        properties.sort();
        let expected = [
            ("author", "Ursula K. Le Guin"),
            ("finished", "2026-10-31"),
            ("owned", "1"),
            ("pages", "387"),
            ("related", projects.as_str()),
            ("source", "https://example.com/dispossessed"),
            ("status", "done"),
        ]
        .map(|(key, value)| (key.to_owned(), value.to_owned()));
        assert_eq!(properties, expected, "one property of each value type");

        // A write after the upgrade goes through the engine the release's
        // snapshot rehydrated, and the views follow it.
        assert_eq!(
            search_hits(pool, "zebrafish").await,
            1,
            "search finds the old text"
        );
        let fallbacks = crate::materializer::sql_only_fallback_count();
        edit_block_inner(
            &vault.pools.write,
            &vault.device_id,
            &vault.materializer,
            block_id(pool, &format!("Notes live in [[{reading}]] zebrafish")).await,
            "axolotl".into(),
        )
        .await
        .unwrap();
        vault.materializer.flush().await.unwrap();
        assert_eq!(
            crate::materializer::sql_only_fallback_count(),
            fallbacks,
            "the edit must take the engine path, not the SQL-only fallback"
        );
        assert_eq!(
            (
                search_hits(pool, "axolotl").await,
                search_hits(pool, "zebrafish").await
            ),
            (1, 0),
            "search follows the edit"
        );
        assert_eq!(
            pages_list(pool, SPACE_PERSONAL_ULID).await[1],
            ("Reading".to_owned(), 0, 2),
            "the edit removed the only link to Reading"
        );
        assert_no_divergences(&vault, "after a write").await;
    });
}
