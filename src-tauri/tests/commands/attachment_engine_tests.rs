//! Attachment metadata through the engine (#5608): the commands write the
//! space's Loro doc and the `attachments` row in one transaction, so the
//! metadata reaches other devices on an ordinary sync.

use crate::prelude::*;
use agaric_engine::loro::engine::EngineAttachment;

/// A page in the test space, made through the commands so its attachments
/// take the engine path.
async fn page(pool: &SqlitePool, mat: &Materializer) -> BlockId {
    ensure_test_space(pool).await;
    mark_block_as_space(pool, TEST_SPACE_ID).await;
    create_page_in_space_inner(pool, DEV, mat, None, "Photos".into(), TEST_SPACE_ID.into())
        .await
        .unwrap()
}

fn engine_entries(mat: &Materializer, block_id: &BlockId) -> Vec<EngineAttachment> {
    let space = SpaceId::from_trusted(TEST_SPACE_ID);
    let mut guard = mat.loro_state().registry.for_space(&space, DEV).unwrap();
    guard
        .engine_mut()
        .read_attachments(block_id.as_str())
        .unwrap()
        .unwrap_or_default()
}

async fn add(
    pool: &SqlitePool,
    mat: &Materializer,
    dir: &std::path::Path,
    block_id: &BlockId,
    bytes: &[u8],
) -> AttachmentRow {
    add_attachment_with_bytes_inner(
        pool,
        DEV,
        mat,
        dir,
        block_id.clone(),
        "photo.png".into(),
        "image/png".into(),
        bytes.to_vec(),
    )
    .await
    .unwrap()
}

async fn op_fs_path(pool: &SqlitePool, attachment_id: &str) -> String {
    op_field(pool, attachment_id, "fs_path").await.unwrap()
}

/// `field` of `attachment_id`'s `add_attachment` payload.
async fn op_field(pool: &SqlitePool, attachment_id: &str, field: &str) -> Option<String> {
    sqlx::query_scalar(
        "SELECT json_extract(payload, '$.' || ?) FROM op_log \
         WHERE op_type = 'add_attachment' AND attachment_id = ?",
    )
    .bind(field)
    .bind(attachment_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachment_commands_write_the_engine_entry_with_the_row_5608() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = page(&pool, &mat).await;

    let row = add(&pool, &mat, dir.path(), &page, b"png!").await;
    let entry = engine_entries(&mat, &page).remove(0);
    assert_eq!(
        entry.attachment_id,
        row.id.as_str(),
        "the add entered the doc"
    );
    assert_eq!(
        (
            entry.fields.filename.as_str(),
            entry.fields.fs_path.as_str(),
            entry.fields.size_bytes,
            entry.fields.created_at,
            entry.fields.content_hash.as_deref(),
            entry.deleted_at,
        ),
        (
            "photo.png",
            row.fs_path.as_str(),
            4,
            row.created_at,
            row.content_hash.as_deref(),
            None
        ),
        "with the row's fields"
    );
    assert_eq!(
        op_field(&pool, row.id.as_str(), "content_hash").await,
        row.content_hash,
        "the op carries the bytes' hash to peers"
    );

    rename_attachment_inner(&pool, DEV, &mat, row.id.clone(), "renamed.png".into())
        .await
        .unwrap();
    assert_eq!(
        engine_entries(&mat, &page)[0].fields.filename,
        "renamed.png",
        "a rename reaches the doc"
    );

    delete_attachment_inner(&pool, DEV, &mat, dir.path(), row.id.clone())
        .await
        .unwrap();
    assert!(
        engine_entries(&mat, &page)[0].deleted_at.is_some(),
        "a delete tombstones the entry"
    );
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE id = ?")
        .bind(row.id.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 0, "and removes the row");
}

/// A second copy of the same bytes stores the first copy's path (#1993); the
/// op and the engine name that stored path, so a peer and an undo resolve the
/// file the row holds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deduplicated_add_names_the_stored_path_in_its_op_and_entry_5608() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = page(&pool, &mat).await;

    let first = add(&pool, &mat, dir.path(), &page, b"same bytes").await;
    let second = add(&pool, &mat, dir.path(), &page, b"same bytes").await;

    assert_eq!(second.fs_path, first.fs_path, "the dedup reused the blob");
    assert_eq!(
        op_fs_path(&pool, second.id.as_str()).await,
        second.fs_path,
        "the op names the stored path"
    );
    let entries = engine_entries(&mat, &page);
    let entry = entries
        .iter()
        .find(|e| e.attachment_id == second.id.as_str())
        .expect("second entry");
    assert_eq!(entry.fields.fs_path, second.fs_path, "and so does the doc");
    let hash: Option<String> =
        sqlx::query_scalar("SELECT content_hash FROM attachments WHERE id = ?")
            .bind(second.id.as_str())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(hash, second.content_hash, "the row keeps its content hash");
}
