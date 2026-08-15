use super::*;

// ====================================================================
// page_link_cache integration (SQL-review §H-2)
// ====================================================================

/// `ReindexBlockLinks` fans out the per-block rollup into
/// `page_link_cache` after writing `block_links`. Seed page A with 5
/// content blocks linking to page B, dispatch the task, flush, and
/// assert the cache row has `edge_count = 5`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reindex_block_links_populates_page_link_cache() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page_a = "PA000000000000000000000000";
    let page_b = "PB000000000000000000000000";
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', 'A')")
        .bind(page_a)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', 'B')")
        .bind(page_b)
        .execute(&pool)
        .await
        .unwrap();

    let mut child_ids: Vec<String> = Vec::with_capacity(5);
    for i in 0..5 {
        let child_id = format!("C{i:025}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, ?, ?)",
        )
        .bind(&child_id)
        .bind(format!("link [[{page_b}]]"))
        .bind(page_a)
        .bind(i64::from(i) + 1)
        .execute(&pool)
        .await
        .unwrap();
        child_ids.push(child_id);
    }

    for child_id in &child_ids {
        mat.enqueue_background(MaterializeTask::ReindexBlockLinks {
            block_id: std::sync::Arc::from(child_id.as_str()),
        })
        .await
        .unwrap();
    }
    mat.flush_background().await.unwrap();

    let row: (String, String, i64) =
        sqlx::query_as("SELECT source_page_id, target_page_id, edge_count FROM page_link_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        row,
        (page_a.to_string(), page_b.to_string(), 5),
        "ReindexBlockLinks must roll up to page_link_cache with edge_count = 5"
    );

    mat.shutdown();
}

/// #3842 regression — a block whose `page_id` is still NULL when
/// `ReindexBlockLinks` runs rolls its links up under a CONTENT-BLOCK key, and
/// the deferred `SetBlockPageId` that later supplies the real owning page must
/// repair that: exactly one `page_link_cache` row, keyed on the real page,
/// with the spurious content-block-keyed row GONE.
///
/// Seeded in the FK-clean shape production actually commits. The
/// engine-less create fallback
/// (`agaric_engine::apply::sql_only::apply_create_block_sql_only`, reachable
/// on a space-unresolved / engine-uninit miss) routes through
/// `project_create_block_to_sql`, which derives `page_id` from
/// `block_type == "page"` alone — so a NON-page create commits with
/// `blocks.page_id IS NULL` while its parent `C` exists and sits on page `P`.
/// That is the storable state: `blocks.parent_id REFERENCES blocks(id)` (0089)
/// means the issue's literal "parent row not delivered yet" narrative cannot
/// survive a commit under `foreign_keys = ON`, but it is the SAME mechanism —
/// `page_id` NULL at reindex time, stamped by a later `SetBlockPageId`.
///
/// Sequence:
///
/// 1. `C` (content, on page `P`, `page_id` stamped) and `B` (content under
///    `C`, links `[[T]]`, `page_id` NULL) are both committed.
/// 2. `B`'s fan-out drains in the historically-broken relative order:
///    `ReindexBlockLinks` (which keys the rollup on `COALESCE(NULL, C, B)` =
///    `C`) and only then `SetBlockPageId` (which stamps `B.page_id = P`).
///
/// Ordering the two tasks the other way round — also done in
/// `invalidations_for_op` — does NOT cover every case: a parent arriving in a
/// LATER op batch moves the key after the create's fan-out has drained, which
/// no intra-arm ordering can fix. What fixes it is `SetBlockPageId` re-running
/// the per-block reindex whenever it actually MOVES `page_id`, which is what
/// the drain order below exercises.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_block_page_id_repairs_rollup_written_under_absent_parent_3842() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page_p = "PP000000000000000000000000";
    let page_t = "PT000000000000000000000000";
    let parent_c = "CC000000000000000000000000";
    let child_b = "BB000000000000000000000000";

    for (id, title) in [(page_p, "P"), (page_t, "T")] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', ?, ?)",
        )
        .bind(id)
        .bind(title)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }

    // (1a) The parent: a content block on page P, page_id stamped.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id, position) \
         VALUES (?, 'content', 'parent', ?, ?, 1)",
    )
    .bind(parent_c)
    .bind(page_p)
    .bind(page_p)
    .execute(&pool)
    .await
    .unwrap();

    // (1b) The child, committed with page_id NULL — the sql_only create
    // fallback's row shape. FK-clean: C is already present.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', ?, ?, 1)",
    )
    .bind(child_b)
    .bind(format!("link [[{page_t}]]"))
    .bind(parent_c)
    .execute(&pool)
    .await
    .unwrap();

    // (2a) The reindex runs while B.page_id is still NULL.
    mat.enqueue_background(MaterializeTask::ReindexBlockLinks {
        block_id: std::sync::Arc::from(child_b),
    })
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Seed check (this is the defect's entry state, not the assertion under
    // test): the rollup landed under the CONTENT block C, not under page P.
    let seeded: Vec<(String, String)> = sqlx::query_as(
        "SELECT source_page_id, target_page_id FROM page_link_cache ORDER BY source_page_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        seeded,
        vec![(parent_c.to_string(), page_t.to_string())],
        "seed: with page_id unresolved the rollup keys on the content block"
    );

    // (2b) The deferred page_id stamp — the repair point.
    mat.enqueue_background(MaterializeTask::SetBlockPageId {
        block_id: std::sync::Arc::from(child_b),
    })
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let page_id: Option<String> = sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
        .bind(child_b)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        page_id.as_deref(),
        Some(page_p),
        "SetBlockPageId must inherit the delivered parent's owning page"
    );

    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT source_page_id, target_page_id, edge_count FROM page_link_cache \
         ORDER BY source_page_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![(page_p.to_string(), page_t.to_string(), 1)],
        "page_link_cache must hold EXACTLY the page-keyed edge — the correct row \
         written AND the spurious content-block-keyed row swept (#3842)"
    );
    let spurious: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_link_cache WHERE source_page_id = ?")
            .bind(parent_c)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        spurious, 0,
        "the row keyed on the non-page block must be gone, not merely joined by a second row"
    );

    mat.shutdown();
}

/// #3842 DURABILITY regression — the roll-up repair must survive a failure of
/// the reindex that performs it.
///
/// The repair signal is inherently transient: `set_block_page_id_from_parent_in_tx`
/// commits the `page_id` write, and the reindex that fixes the roll-up runs
/// AFTER it. If that reindex errors (`begin_immediate_logged` surfacing
/// `SQLITE_BUSY` under a sync burst) or the process is killed in between, a
/// re-run's null-safe guard matches ZERO rows — the write already landed — so
/// `changed` is `false` and the repair is skipped FOREVER, leaving exactly the
/// spurious-row-plus-missing-row state #3842 exists to fix. This is the #2831
/// defect class (a dependent maintenance step coupled to a transient diff), so
/// the fix takes the #2831 shape: a durable, idempotent `ReindexBlockLinks`
/// obligation seeded INSIDE the transaction that commits the `page_id` write.
///
/// The failure is injected for real, not simulated: `block_links` is renamed
/// out from under the handler, which makes the reindex (whose very first step,
/// `pre_diff_target_pages`, reads that table) fail while the `page_id` write —
/// which touches only `blocks` — still commits. The table is then restored and
/// the retry queue swept, exactly as the periodic sweeper would.
///
/// Without the durable obligation this test is RED at the final assertion: the
/// only retry row is `SetBlockPageId`, whose re-run observes an unchanged
/// `page_id` and does nothing, so the cache keeps the content-block-keyed row
/// and never gains the page-keyed one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_block_page_id_rollup_repair_survives_a_failed_reindex_3842() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page_p = "PP000000000000000000000000";
    let page_t = "PT000000000000000000000000";
    let parent_c = "CC000000000000000000000000";
    let child_b = "BB000000000000000000000000";

    for (id, title) in [(page_p, "P"), (page_t, "T")] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', ?, ?)",
        )
        .bind(id)
        .bind(title)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id, position) \
         VALUES (?, 'content', 'parent', ?, ?, 1)",
    )
    .bind(parent_c)
    .bind(page_p)
    .bind(page_p)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', ?, ?, 1)",
    )
    .bind(child_b)
    .bind(format!("link [[{page_t}]]"))
    .bind(parent_c)
    .execute(&pool)
    .await
    .unwrap();

    // The reindex runs while B.page_id is still NULL: the rollup lands under
    // the CONTENT block C. This is the defect's entry state.
    mat.enqueue_background(MaterializeTask::ReindexBlockLinks {
        block_id: std::sync::Arc::from(child_b),
    })
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    let seeded: Vec<(String, String)> = sqlx::query_as(
        "SELECT source_page_id, target_page_id FROM page_link_cache ORDER BY source_page_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        seeded,
        vec![(parent_c.to_string(), page_t.to_string())],
        "seed: with page_id unresolved the rollup keys on the content block"
    );

    // --- Inject the failure. `block_links` disappears, so the reindex fails at
    // its first read; the `page_id` write (blocks only) still commits. ---
    sqlx::query("ALTER TABLE block_links RENAME TO block_links_offline_3842")
        .execute(&pool)
        .await
        .unwrap();

    let task = MaterializeTask::SetBlockPageId {
        block_id: std::sync::Arc::from(child_b),
    };
    let result = crate::materializer::handlers::handle_background_task_metered(
        &pool,
        &task,
        None,
        None,
        mat.metrics(),
    )
    .await;
    // Model production regardless of how the handler reports the failure: the
    // consumer persists a retry row for a task that returns `Err`. With the
    // durable obligation the handler returns `Ok` (the repair is owed by the
    // seeded row, not by re-running this task); without it the handler returns
    // `Err` and the ONLY durable trace is a `SetBlockPageId` row.
    if let Err(e) = &result {
        crate::materializer::retry_queue::record_failure(
            &pool,
            &task,
            &e.to_string(),
            mat.metrics(),
        )
        .await
        .unwrap();
    }

    // The `page_id` write committed — which is precisely why a `SetBlockPageId`
    // re-run can no longer detect that a repair is owed.
    let page_id: Option<String> = sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
        .bind(child_b)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        page_id.as_deref(),
        Some(page_p),
        "the page_id write must have committed — the repair is owed from here on"
    );

    // --- The failure window closes; the sweeper runs. ---
    sqlx::query("ALTER TABLE block_links_offline_3842 RENAME TO block_links")
        .execute(&pool)
        .await
        .unwrap();
    // Make every persisted row due NOW. The backoff schedule is not what this
    // test is about — durability is — and a freshly seeded obligation is due
    // immediately anyway (`next_attempt_at = now`), so this only stops the
    // test from depending on wall-clock timing.
    sqlx::query("UPDATE materializer_retry_queue SET next_attempt_at = 0")
        .execute(&pool)
        .await
        .unwrap();
    let re_enqueued = crate::materializer::retry_queue::sweep_once(&pool, &pool, &mat)
        .await
        .unwrap();
    assert!(
        re_enqueued >= 1,
        "the sweeper must re-enqueue the durable obligation left by the failed repair"
    );
    mat.flush_background().await.unwrap();

    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT source_page_id, target_page_id, edge_count FROM page_link_cache \
         ORDER BY source_page_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![(page_p.to_string(), page_t.to_string(), 1)],
        "the repair must survive the reindex failure: after the retry the rollup holds \
         EXACTLY the page-keyed edge, with the content-block-keyed row swept (#3842). \
         A transient `page_id_changed` signal loses this permanently."
    );

    // The obligation is cleared once the repair durably succeeds.
    let owed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM materializer_retry_queue WHERE block_id = ? AND task_kind = ?",
    )
    .bind(child_b)
    .bind("ReindexBlockLinks")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(owed, 0, "a completed repair leaves no obligation behind");

    mat.shutdown();
}

/// #3842 companion — the stale-key recompute must NOT wipe a key another
/// block still legitimately rolls up to, and must leave that key's
/// `edge_count` correct rather than stale.
///
/// Two children of `C` (a content block on page `P`) start with NULL
/// `page_id`, so both roll up under the `parent_id` fallback and the
/// `(C → T)` row legitimately counts 2. `SetBlockPageId` then moves only
/// `B` onto page `P`. Afterwards `C` must keep its row — `X` still supports
/// it — but with `edge_count = 1`, and `P` must gain its own row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn page_link_rollup_recount_keeps_supported_old_key_3842() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page_p = "PP000000000000000000000000";
    let page_t = "PT000000000000000000000000";
    let parent_c = "CC000000000000000000000000";
    let child_b = "BB000000000000000000000000";
    let child_x = "XX000000000000000000000000";

    for (id, title) in [(page_p, "P"), (page_t, "T")] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', ?, ?)",
        )
        .bind(id)
        .bind(title)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id, position) \
         VALUES (?, 'content', 'parent', ?, ?, 1)",
    )
    .bind(parent_c)
    .bind(page_p)
    .bind(page_p)
    .execute(&pool)
    .await
    .unwrap();
    // Both children land with page_id still NULL — the pre-`SetBlockPageId`
    // state — so both roll up under the `parent_id` fallback.
    for kid in [child_b, child_x] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, ?, 1)",
        )
        .bind(kid)
        .bind(format!("link [[{page_t}]]"))
        .bind(parent_c)
        .execute(&pool)
        .await
        .unwrap();
        mat.enqueue_background(MaterializeTask::ReindexBlockLinks {
            block_id: std::sync::Arc::from(kid),
        })
        .await
        .unwrap();
    }
    mat.flush_background().await.unwrap();

    let seeded: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT source_page_id, target_page_id, edge_count FROM page_link_cache")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        seeded,
        vec![(parent_c.to_string(), page_t.to_string(), 2)],
        "seed: both page_id-less children roll up under the parent key"
    );

    // Only B gets its owning page stamped.
    mat.enqueue_background(MaterializeTask::SetBlockPageId {
        block_id: std::sync::Arc::from(child_b),
    })
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT source_page_id, target_page_id, edge_count FROM page_link_cache \
         ORDER BY source_page_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            (parent_c.to_string(), page_t.to_string(), 1),
            (page_p.to_string(), page_t.to_string(), 1),
        ],
        "the old key keeps the edge X still supports (recounted to 1) and the \
         new page key gains B's edge"
    );

    mat.shutdown();
}

/// #3842 — the `P1 → P2` sufficiency assumption, made EXECUTABLE.
///
/// The stale-key sweep in `reindex_page_link_cache_for_block` recomputes
/// `{parent_id, own id}`. That is sufficient for `SetBlockPageId` ONLY because
/// the key the block vacates is always NULL-derived: the sole production
/// enqueue site (`dispatch.rs`'s create arm) fires on a block whose `page_id`
/// is still NULL, and `set_block_page_id_from_parent_in_tx` writes the PARENT's
/// `page_id`. A move between two REAL pages would strand rows under the old
/// page, which the sweep never visits — silently reintroducing #3842.
///
/// Nothing in the type system pins that, so the handler pins it with a
/// `debug_assert!` (and, in release, degrades to a durable full
/// `RebuildPageLinkCache` obligation). This test is that guard's teeth: it
/// manufactures the `P1 → P2` write the assumption forbids and requires the
/// guard to fire. If a future change adds a second `SetBlockPageId` enqueue
/// site that can move `page_id` between pages, the guard — not a silently
/// wrong `page_link_cache` — is what surfaces it.
///
/// Paired with `set_block_page_id_demotion_to_null_does_not_trip_the_guard_3894`,
/// which pins the OTHER side of the narrowed condition: this test requires the
/// panic on `Some(P1) → Some(P2)`, that one requires its ABSENCE on
/// `Some(P) → NULL`. Together they say the assert fires on exactly the
/// unreachable transition and not on the reachable one.
///
/// Debug-only: `debug_assert!` compiles out under `--release`.
#[cfg(debug_assertions)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[should_panic(expected = "moved blocks.page_id between two existing pages")]
async fn set_block_page_id_page_to_page_move_trips_the_stale_key_guard_3842() {
    let (pool, _dir) = test_pool().await;

    let page_1 = "P1000000000000000000000000";
    let page_2 = "P2000000000000000000000000";
    let parent_c = "CC000000000000000000000000";
    let child_b = "BB000000000000000000000000";

    for id in [page_1, page_2] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', 'p', ?)",
        )
        .bind(id)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }
    // The parent sits on P2 …
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id, position) \
         VALUES (?, 'content', 'parent', ?, ?, 1)",
    )
    .bind(parent_c)
    .bind(page_2)
    .bind(page_2)
    .execute(&pool)
    .await
    .unwrap();
    // … while the child still carries P1: a page → page move, not the
    // NULL → page stamp the sweep's key set assumes.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id, position) \
         VALUES (?, 'content', 'child', ?, ?, 1)",
    )
    .bind(child_b)
    .bind(parent_c)
    .bind(page_1)
    .execute(&pool)
    .await
    .unwrap();

    crate::materializer::handlers::handle_background_task(
        &pool,
        &MaterializeTask::SetBlockPageId {
            block_id: std::sync::Arc::from(child_b),
        },
        None,
        None,
    )
    .await
    .unwrap();
}

/// #3894 — the `Some(P) → NULL` DEMOTION must NOT trip the `P1 → P2` guard,
/// and must still degrade.
///
/// The guard's `debug_assert!` originally fired on `changed && previous
/// .is_some()`, which covers two different transitions. The page-to-page move
/// is genuinely unreachable today and deserves the panic. The demotion is
/// reachable RIGHT NOW: `resolve_owning_page` stamps `page_id` by walking the
/// `parent_id` chain, while `set_block_page_id_from_parent_in_tx` copies only
/// `parent.page_id`, so a retried `SetBlockPageId` whose parent's own stamp
/// has not landed inherits NULL off a block that already carries a real page.
/// Asserting on `previous` alone panicked the background worker in debug/test
/// builds on a production-reachable shape.
///
/// This test manufactures exactly that shape and requires two things: the
/// handler RETURNS (no panic — this test is not `#[should_panic]`, and it is
/// not gated on `debug_assertions`, so the debug build is where it has teeth),
/// and the degradation is UNCHANGED — a demotion still vacates a real page key
/// the `{parent_id, own id}` sweep cannot reach, so it still owes the durable
/// full `RebuildPageLinkCache` obligation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_block_page_id_demotion_to_null_does_not_trip_the_guard_3894() {
    let (pool, _dir) = test_pool().await;

    let page_p = "PP000000000000000000000000";
    let page_t = "PT000000000000000000000000";
    let parent_c = "CC000000000000000000000000";
    let child_b = "BB000000000000000000000000";

    for id in [page_p, page_t] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', 'p', ?)",
        )
        .bind(id)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }
    // The parent's OWN `page_id` stamp has not landed yet — the state a
    // pending/failed `SetBlockPageId` on the parent leaves behind.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id, position) \
         VALUES (?, 'content', 'parent', ?, NULL, 1)",
    )
    .bind(parent_c)
    .bind(page_p)
    .execute(&pool)
    .await
    .unwrap();
    // … while the child already carries the real page P and links to T.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id, position) \
         VALUES (?, 'content', ?, ?, ?, 1)",
    )
    .bind(child_b)
    .bind(format!("link [[{page_t}]]"))
    .bind(parent_c)
    .bind(page_p)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(child_b)
        .bind(page_t)
        .execute(&pool)
        .await
        .unwrap();
    // The rollup as it stood BEFORE the demotion: keyed on the real page P.
    // This is the row the demotion strands, since the per-block sweep only
    // visits `{parent_id, own id}` = `{CC…, BB…}`.
    sqlx::query(
        "INSERT INTO page_link_cache \
             (source_page_id, target_page_id, edge_count, src_deleted, tgt_deleted, tgt_is_page) \
         VALUES (?, ?, 1, 0, 0, 1)",
    )
    .bind(page_p)
    .bind(page_t)
    .execute(&pool)
    .await
    .unwrap();

    crate::materializer::handlers::handle_background_task(
        &pool,
        &MaterializeTask::SetBlockPageId {
            block_id: std::sync::Arc::from(child_b),
        },
        None,
        None,
    )
    .await
    .expect("a Some(P) → NULL demotion must not panic or error the worker");

    let page_id: Option<String> = sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
        .bind(child_b)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        page_id, None,
        "seed check: the write under test must really be a demotion off a real \
         page, not a no-op"
    );

    let owed_full_rebuild: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM materializer_retry_queue WHERE block_id = ? AND task_kind = ?",
    )
    .bind(crate::materializer::retry_queue::GLOBAL_TASK_SENTINEL)
    .bind("RebuildPageLinkCache")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        owed_full_rebuild, 1,
        "narrowing the assert must not narrow the DEGRADATION: a demotion \
         vacates the real page key P, which the {{parent_id, own id}} sweep \
         never visits, so the durable full RebuildPageLinkCache obligation is \
         still owed"
    );

    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT source_page_id, target_page_id, edge_count FROM page_link_cache \
         ORDER BY source_page_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            (parent_c.to_string(), page_t.to_string(), 1),
            (page_p.to_string(), page_t.to_string(), 1),
        ],
        "the sweep recomputes the NEW key (the parent) and leaves the vacated \
         page key P stranded — which is precisely what the seeded full rebuild \
         above exists to clean up"
    );
}

/// The `RebuildPageLinkCache` task is part of `FULL_CACHE_REBUILD_TASKS`.
/// Enqueue it directly and assert the rollup populates the cache from
/// raw `block_links` rows.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rebuild_page_link_cache_task_populates_cache() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page_a = "PA000000000000000000000000";
    let page_b = "PB000000000000000000000000";
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', 'A')")
        .bind(page_a)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', 'B')")
        .bind(page_b)
        .execute(&pool)
        .await
        .unwrap();
    let child = "C0000000000000000000000000";
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', 'x', ?, 1)",
    )
    .bind(child)
    .bind(page_a)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(child)
        .bind(page_b)
        .execute(&pool)
        .await
        .unwrap();

    mat.enqueue_background(MaterializeTask::RebuildPageLinkCache)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_link_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "RebuildPageLinkCache must populate cache from raw block_links"
    );

    mat.shutdown();
}
