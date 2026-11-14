//! Writes a small vault through a RELEASED build's own boot path and command
//! layer. `scripts/gen-release-vault.sh <tag>` copies this file into a
//! checkout of the tag as an example and runs it there; it is never compiled
//! at head, so it may only use what the tag it is run at exports.
//!
//! Usage: `gen_release_vault <empty output dir>`. Writes `notes.db`,
//! `attachments/`, `device-id`, `export-projects.txt` (the tag's own Markdown
//! export of the "Projects" page) and `counts.txt` (how many blocks and ops
//! the tag left, and the seq its compaction purged through).

use agaric_core::ulid::BlockId;
use agaric_lib::commands::{
    add_attachment_with_bytes_inner, add_tag_inner, compact_op_log_cmd_inner, create_block_inner,
    create_block_inner_with_space, create_page_in_space_inner, create_property_def_inner,
    delete_block_inner, edit_block_inner, export_page_markdown_inner, move_block_inner,
    set_due_date_inner, set_page_aliases_inner, set_peer_address_inner, set_priority_inner,
    set_property_inner, set_scheduled_date_inner, set_todo_state_inner, update_peer_name_inner,
};
use agaric_lib::materializer::Materializer;
use agaric_lib::ulid::verify_active;
use agaric_store::space::{SpaceId, SpaceScope};
use sqlx::SqlitePool;

/// The device this vault is paired with: its device id, and the iroh endpoint
/// id pairing pinned it to (RFC 8032's first test vector, a real ed25519
/// point, which the tag's `bind_endpoint_id` requires).
const PEER: &str = "0f6b2c1e-8d43-4a57-9c1e-2b7a5d9e4f10";
const PEER_ENDPOINT_ID: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

const DAY_MS: i64 = 86_400_000;

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

    // A task with every promoted column, and a nested child (its text, with
    // the link out, is written after the compaction).
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

    // A year passes and the daily job compacts the log. The engine snapshots
    // were saved long before; the ops' age is the one thing no command can
    // write, so it is set on the rows.
    v.mat.flush().await.unwrap();
    let saved =
        agaric_engine::loro::snapshot::save_engines_and_advance_cursor(&pools.write, &v.mat).await;
    assert!(saved >= 1, "the engine snapshot must be saved before the purge");
    let mut tx = v.pool.begin().await.unwrap();
    agaric_store::op_log::enable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    sqlx::query("UPDATE op_log SET created_at = created_at - ?")
        .bind(400 * DAY_MS)
        .execute(&mut *tx)
        .await
        .unwrap();
    agaric_store::op_log::disable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let purged = compact_op_log_cmd_inner(&v.pool, 90).await.unwrap();
    assert!(purged.ops_deleted > 0, "the aged ops must be purged");

    // Written after the compaction: an edit of a block whose create op is
    // gone, an attachment, a paired device, the second space.
    edit_block_inner(
        &v.pool,
        &v.device,
        &v.mat,
        nested,
        format!("Notes live in [[{reading}]] zebrafish"),
    )
    .await
    .unwrap();
    v.mat.flush_background().await.unwrap();

    add_attachment_with_bytes_inner(
        &v.pool,
        &v.device,
        &v.mat,
        &out,
        book,
        "margin-notes.txt".into(),
        "text/plain".into(),
        b"Bytes the release wrote to disk.\n".to_vec(),
    )
    .await
    .unwrap();
    v.mat.flush_background().await.unwrap();

    // The row pairing pins a peer with, then the two commands the device list
    // edits it through. Pairing itself needs a second device on the wire.
    agaric_store::peer_refs::bind_endpoint_id(&v.pool, PEER, PEER_ENDPOINT_ID)
        .await
        .unwrap();
    update_peer_name_inner(&v.pool, PEER.into(), Some("Phone".into()))
        .await
        .unwrap();
    set_peer_address_inner(&v.pool, PEER.into(), "192.168.1.20:4433".into())
        .await
        .unwrap();

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

    let blocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pools.write)
        .await
        .unwrap();
    let ops: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pools.write)
        .await
        .unwrap();
    let frontier: String =
        sqlx::query_scalar("SELECT up_to_seqs FROM compaction_watermark WHERE id = 1")
            .fetch_one(&pools.write)
            .await
            .unwrap();
    let frontier: std::collections::BTreeMap<String, i64> =
        serde_json::from_str(&frontier).unwrap();
    std::fs::write(
        out.join("counts.txt"),
        format!(
            "blocks {blocks}\nops {ops}\ncompacted_through {}\n",
            frontier[&v.device]
        ),
    )
    .unwrap();

    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pools.write)
        .await
        .unwrap();
    pools.read.close().await;
    pools.write.close().await;
}
