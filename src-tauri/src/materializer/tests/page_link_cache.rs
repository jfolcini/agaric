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
        .bind(i as i64 + 1)
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
