use super::*;

#[tokio::test]
async fn tags_cache_after_create_tag() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "TAG_FLUSH_1", "tag", "urgent").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("TAG_FLUSH_1"),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            index: None,
            content: "urgent".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT name, usage_count FROM tags_cache WHERE tag_id = 'TAG_FLUSH_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_some(),
        "tags_cache should have a row for the created tag"
    );
    let row = row.unwrap();
    assert_eq!(
        row.get::<String, _>("name"),
        "urgent",
        "tag name in cache should match created tag"
    );
    assert_eq!(
        row.get::<i32, _>("usage_count"),
        0,
        "usage_count should be 0 for a new tag with no references"
    );
}
#[tokio::test]
async fn pages_cache_after_create_page() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "PAGE_FLUSH_1", "page", "My Test Page").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("PAGE_FLUSH_1"),
            block_type: "page".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "My Test Page".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT title FROM pages_cache WHERE page_id = 'PAGE_FLUSH_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_some(),
        "pages_cache should have a row for the created page"
    );
    assert_eq!(
        row.unwrap().get::<String, _>("title"),
        "My Test Page",
        "page title in cache should match created page"
    );
}

#[tokio::test]
async fn enqueue_inbound_sync_rebuilds_refreshes_derived_caches() {
    // #4: after an inbound sync writes the per-block SQL
    // projection, the orchestrator enqueues this fan-out so the read-path
    // derived caches + FTS converge to the imported state. Seed a tag, a
    // page, and a content block directly (as `apply_remote`'s per-block
    // projection would), run the fan-out, and assert each corresponding
    // cache was rebuilt.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block_direct(&pool, "SYNC_TAG_1", "tag", "synced-tag").await;
    insert_block_direct(&pool, "SYNC_PAGE_1", "page", "Synced Page").await;
    insert_block_direct(&pool, "SYNC_NOTE_1", "content", "searchable inbound text").await;

    // #421: FTS is now driven from the changed-block set (per-block
    // `UpdateFtsBlock` for a small incremental import). Pass the seeded ids.
    let changed = [
        crate::ulid::BlockId::test_id("SYNC_TAG_1"),
        crate::ulid::BlockId::test_id("SYNC_PAGE_1"),
        crate::ulid::BlockId::test_id("SYNC_NOTE_1"),
    ];
    mat.enqueue_inbound_sync_rebuilds(&changed, &[])
        .await
        .expect("enqueue inbound sync rebuilds");
    // #2291: the 8 global rebuilds are now trailing-debounced; pump them
    // (and drain the FTS tasks enqueued inline) so the caches converge.
    mat.flush_inbound_rebuild_debounce().await;

    let tag_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache WHERE tag_id = 'SYNC_TAG_1'")
            .fetch_one(&pool)
            .await
            .expect("count tags_cache");
    assert_eq!(tag_rows, 1, "RebuildTagsCache ran for the synced tag block");

    let page_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pages_cache WHERE page_id = 'SYNC_PAGE_1'")
            .fetch_one(&pool)
            .await
            .expect("count pages_cache");
    assert_eq!(
        page_rows, 1,
        "RebuildPagesCache ran for the synced page block"
    );

    let fts_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM fts_blocks WHERE block_id = 'SYNC_NOTE_1'")
            .fetch_one(&pool)
            .await
            .expect("count fts_blocks");
    assert_eq!(
        fts_rows, 1,
        "RebuildFtsIndex ran for the synced content block"
    );
}

/// #2264: a complete no-op inbound import (changed AND purged both empty —
/// a redelivered / echoed delta) must enqueue NOTHING: nothing was
/// projected, so every derived cache is already consistent. Observable via
/// a seeded tag block whose `tags_cache` row would appear iff
/// `RebuildTagsCache` ran.
#[tokio::test]
async fn enqueue_inbound_sync_rebuilds_noop_import_enqueues_nothing() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block_direct(&pool, "NOOP_TAG_1", "tag", "would-be-cached").await;

    mat.enqueue_inbound_sync_rebuilds(&[], &[])
        .await
        .expect("enqueue inbound sync rebuilds");
    mat.flush_background().await.expect("flush background");

    let tag_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache WHERE tag_id = 'NOOP_TAG_1'")
            .fetch_one(&pool)
            .await
            .expect("count tags_cache");
    assert_eq!(
        tag_rows, 0,
        "a no-op inbound import must not enqueue any cache rebuild"
    );
}

/// #2264: a purge-ONLY inbound import (changed empty, purged non-empty)
/// must still fan out — Pass D removed base-table rows and the aggregate
/// caches only converge through these rebuilds.
#[tokio::test]
async fn enqueue_inbound_sync_rebuilds_purge_only_import_still_fans_out() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block_direct(&pool, "PURGE_TAG_1", "tag", "still-cached").await;

    let purged = [crate::ulid::BlockId::test_id("GONE_BLOCK_1")];
    mat.enqueue_inbound_sync_rebuilds(&[], &purged)
        .await
        .expect("enqueue inbound sync rebuilds");
    // #2291: pump the trailing-debounced global fan-out.
    mat.flush_inbound_rebuild_debounce().await;

    let tag_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache WHERE tag_id = 'PURGE_TAG_1'")
            .fetch_one(&pool)
            .await
            .expect("count tags_cache");
    assert_eq!(
        tag_rows, 1,
        "a purge-only inbound import must still run the derived-cache fan-out"
    );
}

/// #2265: the inbound fan-out must NOT rebuild `block_tag_inherited` (that
/// cache is refreshed synchronously — and scoped — by `import_and_project`
/// before the fan-out is enqueued), while #2264 keeps `RebuildPageIds` so a
/// moved subtree's descendants converge on their new `page_id`.
///
/// Seed a shape where both a global tag-inheritance rebuild and a page-id
/// rebuild WOULD write rows: a page → parent(tagged) → child chain with the
/// child's `page_id` left NULL (as after an inbound structural move). After
/// the fan-out: `page_id` is repaired (RebuildPageIds retained) but no
/// inherited row appears (RebuildTagInheritanceCache dropped).
#[tokio::test]
async fn enqueue_inbound_sync_rebuilds_skips_tag_inheritance_but_rebuilds_page_ids() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block_direct(&pool, "INH_PAGE_1", "page", "Inh Page").await;
    insert_block_direct(&pool, "INH_TAG_1", "tag", "inh-tag").await;
    insert_block_direct(&pool, "INH_PARENT_1", "content", "parent").await;
    insert_block_direct(&pool, "INH_CHILD_1", "content", "child").await;
    sqlx::query("UPDATE blocks SET parent_id = 'INH_PAGE_1', page_id = 'INH_PAGE_1' WHERE id = 'INH_PARENT_1'")
        .execute(&pool)
        .await
        .unwrap();
    // Child hangs off the parent but its page_id is stale (NULL), as after
    // an inbound move whose per-block projection touched only the moved
    // block's own row.
    sqlx::query("UPDATE blocks SET parent_id = 'INH_PARENT_1' WHERE id = 'INH_CHILD_1'")
        .execute(&pool)
        .await
        .unwrap();
    insert_block_tag(&pool, "INH_PARENT_1", "INH_TAG_1").await;

    let changed = [crate::ulid::BlockId::test_id("INH_CHILD_1")];
    mat.enqueue_inbound_sync_rebuilds(&changed, &[])
        .await
        .expect("enqueue inbound sync rebuilds");
    // #2291: pump the trailing-debounced global fan-out.
    mat.flush_inbound_rebuild_debounce().await;

    let child_page_id: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = 'INH_CHILD_1'")
            .fetch_one(&pool)
            .await
            .expect("read child page_id");
    assert_eq!(
        child_page_id.as_deref(),
        Some("INH_PAGE_1"),
        "RebuildPageIds must be retained in the inbound fan-out (descendants' \
         page_id after an inbound move)"
    );

    let inherited_rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_tag_inherited WHERE block_id = 'INH_CHILD_1'",
    )
    .fetch_one(&pool)
    .await
    .expect("count block_tag_inherited");
    assert_eq!(
        inherited_rows, 0,
        "the inbound fan-out must not rebuild block_tag_inherited — \
         import_and_project already refreshed it synchronously (scoped)"
    );
}

/// #2291 test helper: read the test-only fan-out fire counter.
fn debounce_fires(mat: &Materializer) -> u64 {
    mat.inbound_rebuild_debounce
        .fanout_fires
        .load(std::sync::atomic::Ordering::Relaxed)
}

/// #2291 test helper: yield enough scheduler turns for the debounce loop to
/// react to a fresh arm or an already-advanced timer (register its
/// `sleep_until`, or wake → fire → re-park). Time is driven explicitly with
/// `tokio::time::advance`, so this only needs to hand the runtime turns, not
/// advance the clock.
async fn settle() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

/// #2291 test helper: arm the debounce via a purge-only inbound import
/// (`changed` empty → no FTS side-tasks), isolating the global fan-out
/// signal, then settle so the loop registers/recomputes its deadline.
async fn arm_debounce(mat: &Materializer, purged: &[crate::ulid::BlockId]) {
    mat.enqueue_inbound_sync_rebuilds(&[], purged)
        .await
        .expect("arm inbound rebuild debounce");
    settle().await;
}

/// #2291: a burst of inbound imports arriving within the trailing
/// `INBOUND_REBUILD_DEBOUNCE` window must collapse to EXACTLY ONE run of the
/// 8 global rebuilds (not one per import). Observed via the test-only
/// `fanout_fires` counter the debounce loop bumps on each fire.
///
/// Virtual time is driven with `tokio::time::pause()` + `advance()` (the
/// pool/materializer are built under real time first, since `start_paused`
/// auto-advance would fast-forward over sqlx's real-I/O acquire timeout).
#[tokio::test]
async fn inbound_rebuild_debounce_coalesces_burst_to_single_fanout() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    tokio::time::pause();
    let purged = [crate::ulid::BlockId::test_id("GONE_1")];

    // Arm 5 times, each 50ms apart — all within the 300ms debounce window.
    for _ in 0..5 {
        arm_debounce(&mat, &purged).await;
        tokio::time::advance(std::time::Duration::from_millis(50)).await;
        settle().await;
    }
    assert_eq!(
        debounce_fires(&mat),
        0,
        "no fan-out may fire while the trailing window keeps being reset"
    );

    // Let the trailing window elapse from the last arm.
    tokio::time::advance(std::time::Duration::from_millis(400)).await;
    settle().await;
    assert_eq!(
        debounce_fires(&mat),
        1,
        "a burst of 5 arms within the debounce window must collapse to ONE fan-out"
    );
}

/// #2291: a single inbound import arms the debounce, and the fan-out fires
/// exactly once after the trailing window elapses.
#[tokio::test]
async fn inbound_rebuild_debounce_trailing_fire() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    tokio::time::pause();
    let purged = [crate::ulid::BlockId::test_id("GONE_2")];

    arm_debounce(&mat, &purged).await;
    assert_eq!(
        debounce_fires(&mat),
        0,
        "the fan-out must not fire synchronously with the arm"
    );

    tokio::time::advance(std::time::Duration::from_millis(400)).await;
    settle().await;
    assert_eq!(
        debounce_fires(&mat),
        1,
        "one arm must fire exactly one trailing fan-out"
    );
}

/// #2291: a sustained stream of imports each arriving *within* the debounce
/// window (so the trailing deadline never elapses) must still fire by the
/// `INBOUND_REBUILD_MAX_WAIT` cap measured from the first arm — the fan-out
/// can never be starved forever.
#[tokio::test]
async fn inbound_rebuild_debounce_max_wait_cap_fires_despite_continuous_arming() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    tokio::time::pause();
    let purged = [crate::ulid::BlockId::test_id("GONE_3")];

    // Arm every 250ms — under the 300ms DEBOUNCE — so the trailing window
    // is perpetually reset. Arm for ~1s first (< the 2s MAX_WAIT) and
    // confirm nothing has fired: only the cap can break the stalemate.
    for _ in 0..4 {
        arm_debounce(&mat, &purged).await;
        tokio::time::advance(std::time::Duration::from_millis(250)).await;
        settle().await;
    }
    assert_eq!(
        debounce_fires(&mat),
        0,
        "before MAX_WAIT, continuous sub-DEBOUNCE arming must NOT fire"
    );

    // Keep arming past MAX_WAIT (total virtual time > 2s from the first arm).
    for _ in 0..6 {
        arm_debounce(&mat, &purged).await;
        tokio::time::advance(std::time::Duration::from_millis(250)).await;
        settle().await;
    }
    assert!(
        debounce_fires(&mat) >= 1,
        "the MAX_WAIT cap must force a fan-out even while arming continues"
    );
}

#[tokio::test]
async fn tags_cache_after_delete() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "TAG_DEL_1", "tag", "to-delete").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("TAG_DEL_1"),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            index: None,
            content: "to-delete".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT tag_id FROM tags_cache WHERE tag_id = 'TAG_DEL_1'")
            .fetch_optional(&pool)
            .await
            .unwrap()
            .is_some(),
        "tag should exist in cache before deletion"
    );
    soft_delete_block_direct(&pool, "TAG_DEL_1").await;
    let del = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("TAG_DEL_1"),
        }),
    )
    .await;
    mat.dispatch_op(&del).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT tag_id FROM tags_cache WHERE tag_id = 'TAG_DEL_1'")
            .fetch_optional(&pool)
            .await
            .unwrap()
            .is_none(),
        "tag should be removed from cache after deletion"
    );
}
#[tokio::test]
async fn tags_usage_count() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "TAG_USE_1", "tag", "important").await;
    insert_block_direct(&pool, "BLK_USE_1", "content", "some note").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("TAG_USE_1"),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            index: None,
            content: "important".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        sqlx::query("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_USE_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<i32, _>("usage_count"),
        0,
        "usage_count should be 0 before any tag is applied"
    );
    insert_block_tag(&pool, "BLK_USE_1", "TAG_USE_1").await;
    let add = make_op_record(
        &pool,
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::test_id("BLK_USE_1"),
            tag_id: BlockId::test_id("TAG_USE_1"),
        }),
    )
    .await;
    mat.dispatch_op(&add).await.unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        sqlx::query("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_USE_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<i32, _>("usage_count"),
        1,
        "usage_count should be 1 after adding tag to one block"
    );
}
#[tokio::test]
async fn agenda_cache_after_set_property() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK_AGD_1", "content", "task").await;
    insert_property_date(&pool, "BLK_AGD_1", "due", "2025-03-15").await;
    let r = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK_AGD_1"),
            key: "due".into(),
            value_text: None,
            value_num: None,
            value_date: Some("2025-03-15".into()),
            value_ref: None,
            value_bool: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT date, source FROM agenda_cache WHERE block_id = 'BLK_AGD_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_some(),
        "agenda_cache should have a row after setting a date property"
    );
    let row = row.unwrap();
    assert_eq!(
        row.get::<String, _>("date"),
        "2025-03-15",
        "agenda date should match the set property value"
    );
    assert_eq!(
        row.get::<String, _>("source"),
        "property:due",
        "agenda source should indicate the property key"
    );
}

/// #2667 helper: pad a short seed into a 26-char, `[0-9A-Z]`-only ULID-shaped
/// id so the `#[ULID]` inline-tag-ref regex (`TAG_REF_RE`) matches it.
fn ulid26_2667(seed: &str) -> String {
    let s = format!("{:0<26}", seed.to_ascii_uppercase());
    assert_eq!(s.len(), 26, "seed too long for a 26-char ULID");
    s
}

/// #2667 helper: snapshot the whole `block_tag_refs` table as an ordered
/// `Vec<(source_id, tag_id)>` so two states can be compared for byte-identity.
async fn snapshot_block_tag_refs(pool: &SqlitePool) -> Vec<(String, String)> {
    sqlx::query_as::<_, (String, String)>(
        "SELECT source_id, tag_id FROM block_tag_refs ORDER BY source_id, tag_id",
    )
    .fetch_all(pool)
    .await
    .expect("snapshot block_tag_refs")
}

/// #2667 — EQUIVALENCE: a below-threshold inbound delta drives `block_tag_refs`
/// per changed block (`ReindexBlockTagRefs`), NOT the global rebuild. Prove the
/// scoped path is byte-identical to the global `RebuildBlockTagRefsCache` (no
/// under-invalidation): apply a small delta, snapshot `block_tag_refs`, then run
/// the FULL rebuild on the same pool and assert the table is unchanged. Mirrors
/// the #2669 equivalence approach and the #421 FTS narrowing this parallels.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inbound_block_tag_refs_scoped_equals_global_rebuild_2667() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let tag_a = ulid26_2667("TAGA");
    let tag_b = ulid26_2667("TAGB");
    let note1 = ulid26_2667("NOTE1");
    let note2 = ulid26_2667("NOTE2");
    // A block that references a tag but is SOFT-DELETED — its rows must be
    // cleared by the per-block reindex (content is unreadable under the
    // `deleted_at IS NULL` filter), exactly as the full rebuild excludes it.
    let note_del = ulid26_2667("NOTEDEL");
    // An inline `#[ULID]` pointing at a NON-tag (content) block: matches the
    // regex but must produce NO row in either path.
    let note3 = ulid26_2667("NOTE3");
    let plain = ulid26_2667("PLAIN");

    // Per-block SQL projection an inbound apply_remote would have written.
    insert_block_direct(&pool, &tag_a, "tag", "urgent").await;
    insert_block_direct(&pool, &tag_b, "tag", "later").await;
    insert_block_direct(&pool, &note1, "content", &format!("see #[{tag_a}] now")).await;
    insert_block_direct(
        &pool,
        &note2,
        "content",
        &format!("#[{tag_a}] and #[{tag_b}] here"),
    )
    .await;
    insert_block_direct(&pool, &note_del, "content", &format!("gone #[{tag_a}]")).await;
    insert_block_direct(&pool, &plain, "content", "not a tag target").await;
    // note3 references `plain` (a content block) — must be filtered out.
    insert_block_direct(&pool, &note3, "content", &format!("stray #[{plain}]")).await;
    soft_delete_block_direct(&pool, &note_del).await;

    // Below threshold → per-block `ReindexBlockTagRefs`, enqueued inline.
    let changed = [
        crate::ulid::BlockId::test_id(&tag_a),
        crate::ulid::BlockId::test_id(&tag_b),
        crate::ulid::BlockId::test_id(&note1),
        crate::ulid::BlockId::test_id(&note2),
        crate::ulid::BlockId::test_id(&note_del),
        crate::ulid::BlockId::test_id(&note3),
    ];
    // This 6-block delta is far below the per-block threshold
    // (`SYNC_BLOCK_TAG_REFS_PER_BLOCK_MAX` = BACKGROUND_CAPACITY/4 = 256), so
    // it takes the scoped per-block path, not the global fallback.
    mat.enqueue_inbound_sync_rebuilds(&changed, &[])
        .await
        .expect("enqueue inbound sync rebuilds");
    // Drains the inline per-block `ReindexBlockTagRefs` (and fires the global
    // 7-task debounced set, which does NOT include block_tag_refs).
    mat.flush_inbound_rebuild_debounce().await;

    let scoped = snapshot_block_tag_refs(&pool).await;

    // The scoped path must have produced the expected rows: note1→tag_a,
    // note2→{tag_a,tag_b}; note_del cleared (soft-deleted); note3→plain dropped
    // (non-tag target).
    let expected: Vec<(String, String)> = {
        let mut v = vec![
            (note1.clone(), tag_a.clone()),
            (note2.clone(), tag_a.clone()),
            (note2.clone(), tag_b.clone()),
        ];
        v.sort();
        v
    };
    assert_eq!(
        scoped, expected,
        "scoped per-block reindex produced the wrong block_tag_refs rows",
    );

    // CRUX: run the FULL global rebuild on the same pool. If the scoped path
    // under-invalidated ANY row, the table would change here.
    agaric_store::cache::rebuild_block_tag_refs_cache(&pool)
        .await
        .expect("global RebuildBlockTagRefsCache");
    let after_global = snapshot_block_tag_refs(&pool).await;

    assert_eq!(
        scoped, after_global,
        "#2667: per-changed-block ReindexBlockTagRefs must be BYTE-IDENTICAL to \
         the global RebuildBlockTagRefsCache — a difference means the scoped \
         path under- or over-invalidated block_tag_refs",
    );
}

/// #2667 — a PURGE-only inbound import (`changed_blocks` empty) enqueues NO
/// `block_tag_refs` task: the `ON DELETE CASCADE` FKs (migration 0034) already
/// removed the purged block's / tag's rows, and the resulting table still
/// matches a full rebuild. Guards the `inbound_sync_block_tag_refs_tasks`
/// empty-set branch end-to-end.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inbound_block_tag_refs_purge_only_matches_global_2667() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let tag_a = ulid26_2667("PTAGA");
    let note1 = ulid26_2667("PNOTE1");
    insert_block_direct(&pool, &tag_a, "tag", "urgent").await;
    insert_block_direct(&pool, &note1, "content", &format!("ref #[{tag_a}]")).await;

    // Establish the live rows via a normal small delta.
    let changed = [
        crate::ulid::BlockId::test_id(&tag_a),
        crate::ulid::BlockId::test_id(&note1),
    ];
    mat.enqueue_inbound_sync_rebuilds(&changed, &[])
        .await
        .expect("seed inbound rebuild");
    mat.flush_inbound_rebuild_debounce().await;
    assert_eq!(
        snapshot_block_tag_refs(&pool).await,
        vec![(note1.clone(), tag_a.clone())],
        "row should exist before the purge",
    );

    // Hard-purge note1 (FK ON DELETE CASCADE removes its block_tag_refs rows).
    sqlx::query("DELETE FROM blocks WHERE id = ?")
        .bind(&note1)
        .execute(&pool)
        .await
        .expect("purge note1");

    // Purge-only import: changed empty, purged non-empty. Must enqueue NOTHING
    // for block_tag_refs (cascade already swept the row).
    let purged = [crate::ulid::BlockId::test_id(&note1)];
    mat.enqueue_inbound_sync_rebuilds(&[], &purged)
        .await
        .expect("purge-only inbound rebuild");
    mat.flush_inbound_rebuild_debounce().await;

    let after_scoped = snapshot_block_tag_refs(&pool).await;
    assert!(
        after_scoped.is_empty(),
        "cascade should have removed the purged block's block_tag_refs row",
    );

    agaric_store::cache::rebuild_block_tag_refs_cache(&pool)
        .await
        .expect("global rebuild after purge");
    assert_eq!(
        snapshot_block_tag_refs(&pool).await,
        after_scoped,
        "#2667: purge-only path (cascade, no task) must match a full rebuild",
    );
}
