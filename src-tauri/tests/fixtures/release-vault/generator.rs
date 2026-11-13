//! Writes a small vault through a RELEASED build's own boot path and command
//! layer. `scripts/gen-release-vault.sh <tag>` copies this file into a
//! checkout of the tag as an example and runs it there; it is never compiled
//! at head, so it may only use what the tag it is run at exports.
//!
//! Usage: `gen_release_vault <empty output dir>`. Writes `notes.db`,
//! `device-id` and `export-projects.txt` (the tag's own Markdown export of the
//! "Projects" page).

use agaric_core::ulid::BlockId;
use agaric_lib::commands::{
    add_tag_inner, create_block_inner, create_block_inner_with_space, create_page_in_space_inner,
    create_property_def_inner, delete_block_inner, edit_block_inner, export_page_markdown_inner,
    move_block_inner, set_due_date_inner, set_page_aliases_inner, set_priority_inner,
    set_property_inner, set_scheduled_date_inner, set_todo_state_inner,
};
use agaric_lib::materializer::Materializer;
use agaric_lib::ulid::verify_active;
use agaric_store::space::{SpaceId, SpaceScope};
use sqlx::SqlitePool;

struct Vault {
    pool: SqlitePool,
    mat: Materializer,
    device: String,
}

impl Vault {
    async fn block(&self, parent: &BlockId, content: &str) -> BlockId {
        let row = create_block_inner(
            &self.pool,
            &self.device,
            &self.mat,
            "content".into(),
            content.into(),
            Some(parent.clone()),
            None,
        )
        .await
        .unwrap();
        self.mat.flush_background().await.unwrap();
        row.id
    }

    async fn page(&self, space: &str, title: &str) -> BlockId {
        let id = create_page_in_space_inner(
            &self.pool,
            &self.device,
            &self.mat,
            None,
            title.into(),
            space.into(),
        )
        .await
        .unwrap();
        self.mat.flush_background().await.unwrap();
        id
    }

    #[allow(clippy::too_many_arguments)]
    async fn property(
        &self,
        block: &BlockId,
        key: &str,
        text: Option<&str>,
        num: Option<f64>,
        date: Option<&str>,
        reference: Option<&BlockId>,
        boolean: Option<bool>,
    ) {
        let active = verify_active(&self.pool, block).await.unwrap();
        set_property_inner(
            &self.pool,
            &self.device,
            &self.mat,
            active,
            key.into(),
            text.map(Into::into),
            num,
            date.map(Into::into),
            reference.map(|r| r.as_str().to_owned()),
            boolean,
            None,
        )
        .await
        .unwrap();
        self.mat.flush_background().await.unwrap();
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let out = std::path::PathBuf::from(std::env::args().nth(1).expect("usage: <output dir>"));
    let device = agaric_sync::device::get_or_create_device_id(&out.join("device-id")).unwrap();

    // The app's boot, in its order: pools (migrations), materializer, crash
    // recovery, the seeded spaces.
    let pools = agaric_lib::db::init_pools(&out.join("notes.db"))
        .await
        .unwrap();
    let mat = Materializer::with_read_pool(pools.write.clone(), pools.read.clone());
    agaric_lib::recovery::recover_at_boot(&pools.write, &device, &mat, &mat.loro_state().registry)
        .await
        .unwrap();
    agaric_lib::spaces::bootstrap_spaces(&pools.write, &device, &mat)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    let v = Vault {
        pool: pools.write.clone(),
        mat,
        device,
    };
    let personal = agaric_lib::spaces::bootstrap::SPACE_PERSONAL_ULID;
    let work = agaric_lib::spaces::bootstrap::SPACE_WORK_ULID;

    // Personal: a linked pair of pages, an alias, a tag.
    let projects = v.page(personal, "Projects").await;
    let reading = v.page(personal, "Reading").await;
    set_page_aliases_inner(
        &v.pool,
        &v.device,
        &v.mat,
        reading.as_str(),
        vec!["Books".into()],
    )
    .await
    .unwrap();
    let tag = create_block_inner_with_space(
        &v.pool,
        &v.device,
        &v.mat,
        "tag".into(),
        "fixture-tag".into(),
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(personal)),
        None,
    )
    .await
    .unwrap()
    .id;
    v.mat.flush_background().await.unwrap();

    // A task with every promoted column, and a nested child that links out.
    let task = v.block(&projects, "Write the upgrade test").await;
    let active = verify_active(&v.pool, &task).await.unwrap();
    set_todo_state_inner(
        &v.pool,
        &v.device,
        &v.mat,
        active.clone(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    set_priority_inner(&v.pool, &v.device, &v.mat, active.clone(), Some("1".into()))
        .await
        .unwrap();
    set_due_date_inner(
        &v.pool,
        &v.device,
        &v.mat,
        active.clone(),
        Some("2031-03-04".into()),
    )
    .await
    .unwrap();
    set_scheduled_date_inner(
        &v.pool,
        &v.device,
        &v.mat,
        active,
        Some("2031-03-01".into()),
    )
    .await
    .unwrap();
    v.mat.flush_background().await.unwrap();
    let nested = v.block(&task, "placeholder").await;
    edit_block_inner(
        &v.pool,
        &v.device,
        &v.mat,
        nested.clone(),
        format!("Notes live in [[{reading}]] zebrafish"),
    )
    .await
    .unwrap();
    v.mat.flush_background().await.unwrap();

    // A tagged block.
    let tagged = v.block(&projects, "A block the tag is on").await;
    add_tag_inner(&v.pool, &v.device, &v.mat, tagged, tag)
        .await
        .unwrap();
    v.mat.flush_background().await.unwrap();

    // A repeating task.
    let repeating = v.block(&projects, "Water the plants").await;
    let active = verify_active(&v.pool, &repeating).await.unwrap();
    set_todo_state_inner(
        &v.pool,
        &v.device,
        &v.mat,
        active.clone(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    set_due_date_inner(
        &v.pool,
        &v.device,
        &v.mat,
        active,
        Some("2031-03-05".into()),
    )
    .await
    .unwrap();
    v.property(&repeating, "repeat", Some("+1w"), None, None, None, None)
        .await;

    // One property of each value type, on one block.
    for (key, value_type, options) in [
        ("author", "text", None),
        ("pages", "number", None),
        ("finished", "date", None),
        ("status", "select", Some(r#"["reading","done"]"#)),
        ("related", "ref", None),
        ("owned", "boolean", None),
        ("source", "url", None),
    ] {
        create_property_def_inner(
            &v.pool,
            &v.device,
            &v.mat,
            personal,
            key.into(),
            value_type.into(),
            options.map(Into::into),
        )
        .await
        .unwrap();
    }
    v.mat.flush_background().await.unwrap();
    let book = v.block(&reading, "The Dispossessed").await;
    v.property(
        &book,
        "author",
        Some("Ursula K. Le Guin"),
        None,
        None,
        None,
        None,
    )
    .await;
    v.property(&book, "pages", None, Some(387.0), None, None, None)
        .await;
    v.property(
        &book,
        "finished",
        None,
        None,
        Some("2026-10-31"),
        None,
        None,
    )
    .await;
    v.property(&book, "status", Some("done"), None, None, None, None)
        .await;
    v.property(&book, "related", None, None, None, Some(&projects), None)
        .await;
    v.property(&book, "owned", None, None, None, None, Some(true))
        .await;
    v.property(
        &book,
        "source",
        Some("https://example.com/dispossessed"),
        None,
        None,
        None,
        None,
    )
    .await;

    // A block moved to the top of its page.
    let moved = v.block(&reading, "Moved to the top").await;
    move_block_inner(&v.pool, &v.device, &v.mat, moved, Some(reading.clone()), 0)
        .await
        .unwrap();
    v.mat.flush_background().await.unwrap();

    // A trashed page with a child.
    let draft = v.page(personal, "Old draft").await;
    v.block(&draft, "Thrown away").await;
    delete_block_inner(&v.pool, &v.device, &v.mat, draft)
        .await
        .unwrap();
    v.mat.flush_background().await.unwrap();

    // The second space.
    let meetings = v.page(work, "Meetings").await;
    v.block(&meetings, "Standup at ten").await;

    let export = export_page_markdown_inner(&pools.read, projects.as_str())
        .await
        .unwrap();
    std::fs::write(out.join("export-projects.txt"), export).unwrap();

    // A clean exit, as the app's `RunEvent::Exit` handler makes it: nothing
    // queued, every space's engine snapshot saved, the WAL folded into
    // `notes.db`.
    v.mat.flush().await.unwrap();
    let saved =
        agaric_engine::loro::snapshot::save_engines_and_advance_cursor(&pools.write, &v.mat).await;
    assert!(
        saved >= 2,
        "both spaces' engine snapshots must be saved, got {saved}"
    );
    v.mat.shutdown();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pools.write)
        .await
        .unwrap();
    pools.read.close().await;
    pools.write.close().await;
}
