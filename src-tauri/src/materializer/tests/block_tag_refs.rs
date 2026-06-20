use super::*;

// ======================================================================
// ReindexBlockTagRefs / RebuildBlockTagRefsCache
// ======================================================================

#[test]
fn dedup_block_tag_refs_collapses_same_block_id() {
    let d = dedup_tasks(vec![
        MaterializeTask::ReindexBlockTagRefs {
            block_id: "a".into(),
        },
        MaterializeTask::ReindexBlockTagRefs {
            block_id: "b".into(),
        },
        MaterializeTask::ReindexBlockTagRefs {
            block_id: "a".into(),
        },
        MaterializeTask::RebuildBlockTagRefsCache,
        MaterializeTask::ReindexBlockTagRefs {
            block_id: "c".into(),
        },
    ]);
    assert_eq!(
        d.len(),
        4,
        "dedup should collapse same block_id reindex (a) but keep distinct ones (b, c) and the one RebuildBlockTagRefsCache"
    );
}

#[test]
fn dedup_reindex_block_tag_refs_and_block_links_independent() {
    // The two tasks share a block_id but are different task types and
    // must coexist through dedup.
    let d = dedup_tasks(vec![
        MaterializeTask::ReindexBlockTagRefs {
            block_id: "X".into(),
        },
        MaterializeTask::ReindexBlockLinks {
            block_id: "X".into(),
        },
        MaterializeTask::ReindexBlockTagRefs {
            block_id: "X".into(),
        },
        MaterializeTask::ReindexBlockLinks {
            block_id: "X".into(),
        },
    ]);
    assert_eq!(
        d.len(),
        2,
        "links and tag-refs reindex share the block but have distinct dedup buckets"
    );
}

#[test]
fn dedup_rebuild_block_tag_refs_cache_collapses() {
    let d = dedup_tasks(vec![
        MaterializeTask::RebuildBlockTagRefsCache,
        MaterializeTask::RebuildBlockTagRefsCache,
        MaterializeTask::RebuildBlockTagRefsCache,
    ]);
    assert_eq!(
        d.len(),
        1,
        "repeated RebuildBlockTagRefsCache collapses to one via discriminant dedup"
    );
}

#[tokio::test]
async fn handle_bg_reindex_block_tag_refs_runs() {
    let (pool, _dir) = test_pool().await;
    // Fresh pool starts with no rows so the handler is a no-op on a
    // nonexistent block_id — the contract is "must not error".
    handle_background_task(
        &pool,
        &MaterializeTask::ReindexBlockTagRefs {
            block_id: "01HBTRBLK0000000000000NONE".into(),
        },
        None,
        None,
    )
    .await
    .unwrap();
    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM block_tag_refs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "nonexistent block produces no rows");
}

#[tokio::test]
async fn handle_bg_rebuild_block_tag_refs_cache_runs() {
    let (pool, _dir) = test_pool().await;
    // Seed a tag + a content block with an inline ref.
    let tag = "01HBTRTAGHBG00000000000001";
    let src = "01HBTRBLKHBG00000000000001";
    insert_block_direct(&pool, tag, "tag", "bg-tag").await;
    insert_block_direct(&pool, src, "content", &format!("#[{tag}]")).await;

    handle_background_task(
        &pool,
        &MaterializeTask::RebuildBlockTagRefsCache,
        None,
        None,
    )
    .await
    .unwrap();

    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM block_tag_refs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "full rebuild via materializer handler must populate the row"
    );
}

#[tokio::test]
async fn handle_bg_reindex_block_tag_refs_split_path() {
    let (pool, _dir) = test_pool().await;
    let tag = "01HBTRTAGSPL00000000000001";
    let src = "01HBTRBLKSPL00000000000001";
    insert_block_direct(&pool, tag, "tag", "spl").await;
    insert_block_direct(&pool, src, "content", &format!("#[{tag}]")).await;

    handle_background_task(
        &pool,
        &MaterializeTask::ReindexBlockTagRefs {
            block_id: src.into(),
        },
        Some(&pool), // same pool used for both read and write
        None,
    )
    .await
    .unwrap();

    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM block_tag_refs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "split-pool reindex path produces the same row");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_edit_block_enqueues_reindex_block_tag_refs() {
    // Verifies that the edit_block dispatch arm enqueues
    // ReindexBlockTagRefs against the block_id in the op payload, and
    // that the background handler scans the content and populates
    // block_tag_refs. To avoid a race between the foreground ApplyOp
    // (which commits the new content) and the background reindex
    // (which reads it), we seed the new content directly and then
    // dispatch only the background arm — the same code path that
    // `dispatch_op` uses once ApplyOp has flushed.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let tag = "01HBTRTAGDSPEDT00000000001";
    let src = "01HBTRBLKDSPEDT00000000001";
    insert_block_direct(&pool, tag, "tag", "e").await;
    insert_block_direct(&pool, src, "content", &format!("edited: #[{tag}]")).await;

    let r = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(src),
            to_text: format!("edited: #[{tag}]"),
            prev_edit: None,
        }),
    )
    .await;

    // dispatch_edit_background is the path taken by the command handler
    // after the op has been durably written and the edit applied.
    mat.dispatch_edit_background(&r, "content").unwrap();
    mat.flush_background().await.unwrap();

    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM block_tag_refs WHERE source_id = ? AND tag_id = ?",
    )
    .bind(src)
    .bind(tag)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "edit_block must enqueue ReindexBlockTagRefs and populate the row"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_create_block_with_inline_ref_populates_row() {
    // Same race-avoidance rationale as the edit_block test above: seed
    // the block directly, then verify that the background arm of
    // create_block dispatch enqueues ReindexBlockTagRefs and the handler
    // scans content to populate block_tag_refs.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let tag = "01HBTRTAGDSPCR000000000001";
    let src = "01HBTRBLKDSPCR000000000001";
    insert_block_direct(&pool, tag, "tag", "c").await;
    insert_block_direct(
        &pool,
        src,
        "content",
        &format!("fresh with inline ref: #[{tag}]"),
    )
    .await;

    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(src),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: format!("fresh with inline ref: #[{tag}]"),
        }),
    )
    .await;

    mat.dispatch_background(&r).unwrap();
    mat.flush_background().await.unwrap();

    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM block_tag_refs WHERE source_id = ? AND tag_id = ?",
    )
    .bind(src)
    .bind(tag)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "create_block with non-empty content must enqueue ReindexBlockTagRefs"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_delete_block_fires_rebuild_block_tag_refs_cache() {
    // Verifies that a `delete_block` op triggers the full-cache-rebuild
    // fan-out (including `RebuildBlockTagRefsCache`). We arrange the
    // world so that the rebuild is *observable*: the source block is
    // already soft-deleted at the moment the rebuild runs, so its row
    // in block_tag_refs must disappear after the rebuild scans content.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let tag = "01HBTRTAGDSPDEL00000000001";
    let src = "01HBTRBLKDSPDEL00000000001";
    insert_block_direct(&pool, tag, "tag", "d").await;
    insert_block_direct(&pool, src, "content", &format!("#[{tag}]")).await;
    // Pre-populate block_tag_refs so we can observe the rebuild clearing
    // it once the source gets soft-deleted.
    sqlx::query!(
        "INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)",
        src,
        tag,
    )
    .execute(&pool)
    .await
    .unwrap();
    // Soft-delete the source directly so the rebuild observes the
    // deletion regardless of whether the foreground ApplyOp has landed
    // by the time the background consumer starts.
    soft_delete_block_direct(&pool, src).await;

    let r = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id(src),
        }),
    )
    .await;

    // Trigger just the background fan-out; we don't need the foreground
    // ApplyOp for this assertion (the row is already soft-deleted).
    mat.dispatch_background(&r).unwrap();
    mat.flush_background().await.unwrap();

    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM block_tag_refs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "delete_block fires RebuildBlockTagRefsCache which drops rows for soft-deleted sources"
    );
}

// `full_cache_rebuild_tasks_has_seven_entries_in_canonical_order`
// (above, in the section) already asserts that
// FULL_CACHE_REBUILD_TASKS includes `RebuildBlockTagRefsCache` at slot 6.
// Keep that single authoritative assertion rather than duplicating it
// here.
