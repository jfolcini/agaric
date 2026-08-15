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

/// #3909 — the `P1 → P2` write DEGRADES; it does not panic the worker.
///
/// The stale-key sweep in `reindex_page_link_cache_for_block` recomputes
/// `{parent_id, own id}`. That is sufficient for `SetBlockPageId` only while
/// the key the block vacates is NULL-derived, because
/// `set_block_page_id_from_parent_in_tx` writes the PARENT's `page_id`. A move
/// between two REAL pages strands rows under the old page, which the sweep
/// never visits — silently reintroducing #3842. The handler's answer is a
/// durable full `RebuildPageLinkCache` obligation, seeded in the SAME
/// transaction as the `page_id` write.
///
/// #3894 additionally asserted the shape away with a `debug_assert!`, on the
/// premise that `dispatch.rs`'s create arm is the sole production enqueue site,
/// so `Some(P1) → Some(P2)` could only come from a future second one. There is
/// already a second one: the retry sweeper's `RetryKind::SetBlockPageId`
/// rehydration (pinned by
/// `sweep_once_reenqueues_set_block_page_id_second_site_3909`), which re-runs
/// the task after ≥ 1 minute of backoff — long enough for the parent to have
/// moved to another page, at which point the retry copies the parent's NEW
/// value over the child's OLD one. That makes the transition a DATA
/// disagreement between parent and child rather than a programming error, and
/// asserting on it bought nothing except a panicking background worker with a
/// write transaction open, in precisely the dev/test builds where such a
/// disagreement is easiest to manufacture. #3909 downgraded it to an
/// unconditional `tracing::error!` with the same payload.
///
/// So this test now requires what the panic used to hide: the handler RETURNS,
/// `blocks.page_id` is repaired to the parent's page, and the durable full
/// `RebuildPageLinkCache` obligation — the thing that actually saves the
/// stranded rows — is owed. It is no longer gated on `debug_assertions`,
/// because the behaviour it pins is now the same in both profiles.
///
/// Paired with `set_block_page_id_demotion_to_null_is_refused_3908`, which pins
/// the other transition off a real page: `Some(P) → NULL` is refused at the
/// write itself, so it vacates nothing and owes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_block_page_id_page_to_page_move_degrades_instead_of_panicking_3909() {
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
    .expect(
        "a Some(P1) → Some(P2) stamp must not panic or error the background \
         worker: the retry sweeper can re-run this task after the parent has \
         moved to another page, so the shape is reachable data, not a \
         programming error (#3909)",
    );

    let page_id: Option<String> = sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
        .bind(child_b)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        page_id.as_deref(),
        Some(page_2),
        "the write itself is correct and must land: the child now belongs to \
         the parent's page. #3908 refuses only the NULL demotion, where the \
         inherited value is `unknown`; here the parent names a real page"
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
        "vacating a REAL page key must owe a durable full RebuildPageLinkCache \
         — the per-block sweep covers only {{parent_id, own id}}, so the rows \
         keyed on P1 are otherwise stranded (#3842). This obligation is the \
         whole reason the transition is survivable, and the debug_assert! that \
         used to abort here made it unobservable in test builds (#3909)"
    );
}

/// #3908 — the `Some(P) → NULL` DEMOTION is REFUSED, so `blocks.page_id` stays
/// CORRECT (and, a fortiori, the `P1 → P2` guard is not tripped — #3894).
///
/// `resolve_owning_page` stamps `page_id` by walking the `parent_id` chain,
/// while `set_block_page_id_from_parent_in_tx` copies only `parent.page_id`, so
/// a retried `SetBlockPageId` whose parent's own stamp has not landed inherits
/// NULL off a block that already carries a real page. #3894 stopped that shape
/// from panicking the background worker (the assert was narrowed to the
/// genuinely unreachable `P1 → P2` move) and made the vacated roll-up key owe a
/// durable full rebuild — but nothing repaired `blocks.page_id` itself, so the
/// block stayed DETACHED from its page: wrong for the roll-up key, for
/// `pages_cache.inbound_link_count` (whose recompute filters
/// `src.page_id IS NOT NULL`), for the `COALESCE(b.space_id, p.space_id)` space
/// resolution, and for every other `page_id` consumer.
///
/// #3908 closes it at the write instead of repairing it downstream: a NULL
/// inherited value means "the parent cannot tell me the owning page yet", not
/// "this block has no owning page", so the incremental arm leaves the column
/// alone and defers the second reading to `rebuild_page_ids`, which re-derives
/// ownership vault-wide and is the only thing entitled to null a block.
///
/// This test manufactures exactly that shape and requires FOUR things: the
/// handler RETURNS (no panic — this test is not `#[should_panic]` and is not
/// gated on `debug_assertions`, so the debug build is where it has teeth);
/// `blocks.page_id` still names the real page; NO durable full-rebuild
/// obligation is owed (nothing was vacated, so nothing is owed); and the
/// roll-up is untouched — no stranded row under `P`, no spurious row under the
/// content parent. A final re-run after the parent's own stamp lands shows the
/// retry SUPPLYING the information the demotion used to destroy.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_block_page_id_demotion_to_null_is_refused_3908() {
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
    // The rollup as it stands BEFORE the task: keyed on the real page P, which
    // is what `COALESCE(page_id, parent_id, id)` yields for B. A demotion would
    // strand this row, since the per-block sweep only visits
    // `{parent_id, own id}` = `{CC…, BB…}`.
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
        page_id.as_deref(),
        Some(page_p),
        "the block must still be attached to its real owning page: the write \
         inherits only `parent.page_id`, so a NULL there is `unknown`, not \
         `no page` — nulling it detaches the block from every page_id consumer \
         (roll-up key, inbound_link_count, space resolution) and only \
         rebuild_page_ids may decide a block genuinely owns no page (#3908)"
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
        owed_full_rebuild, 0,
        "a refused demotion vacates NOTHING, so it must not seed the durable \
         full RebuildPageLinkCache obligation the vacating write owed (#3908 \
         replaces #3894's repair-after-the-fact with prevention)"
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
        "the roll-up key never moved, so the cache must be untouched: the row \
         under the real page P survives and no row appears under the \
         content-block parent C"
    );

    // The retry SUPPLIES what the demotion would have destroyed: once the
    // parent's own stamp lands, re-running the child's task is a genuine no-op
    // rather than a repair of self-inflicted damage.
    for id in [parent_c, child_b] {
        crate::materializer::handlers::handle_background_task(
            &pool,
            &MaterializeTask::SetBlockPageId {
                block_id: std::sync::Arc::from(id),
            },
            None,
            None,
        )
        .await
        .expect("the follow-up stamps must succeed");
    }
    let converged: Vec<Option<String>> =
        sqlx::query_scalar("SELECT page_id FROM blocks WHERE id IN (?, ?) ORDER BY id")
            .bind(child_b)
            .bind(parent_c)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        converged,
        vec![Some(page_p.to_string()), Some(page_p.to_string())],
        "once the parent's stamp lands, parent and child agree on the owning \
         page — the state the demotion path could only reach by way of a \
         vault-wide RebuildPageIds"
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
