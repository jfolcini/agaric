use super::*;
use crate::db::init_pool;
use crate::op::MoveBlockPayload;
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use tempfile::TempDir;

const A: &str = "01HZ0000000000000000000MVA";
const B: &str = "01HZ0000000000000000000MVB";

async fn fresh_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("move_cycle.db");
    let pool = init_pool(&db_path).await.expect("init_pool");
    (pool, dir)
}

/// #383: the SQL-only MoveBlock fallback must refuse to write a
/// `parent_id` cycle. Seed A → B (B is a child of A); a replayed/malformed
/// op that tries to move A *under* B would make B (A's descendant) A's
/// parent — a cycle. The fallback must detect it and skip the UPDATE,
/// leaving A's parent_id untouched.
#[tokio::test]
async fn apply_move_block_sql_only_skips_cycle() {
    let (pool, _dir) = fresh_pool().await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'A', NULL, 1)",
    )
    .bind(A)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'B', ?, 1)",
    )
    .bind(B)
    .bind(A)
    .execute(&pool)
    .await
    .unwrap();

    let mut conn = pool.acquire().await.expect("acquire");
    // Attempt the cycle: move A under B (B is A's descendant).
    apply_move_block_sql_only(
        &mut conn,
        MoveBlockPayload {
            block_id: BlockId::from_trusted(A),
            new_parent_id: Some(BlockId::from_trusted(B)),
            new_position: 1,
            new_index: None,
        },
    )
    .await
    .expect("fallback returns Ok (no-op-warn, not error)");
    drop(conn);

    // A's parent_id must still be NULL — the cycle write was skipped.
    let parent: Option<String> = sqlx::query_scalar("SELECT parent_id FROM blocks WHERE id = ?")
        .bind(A)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        parent.is_none(),
        "cycle move must be skipped; A.parent_id should remain NULL, got {parent:?}"
    );
}

/// Control: a legitimate (non-cycle) move via the SQL-only fallback still
/// writes the new parent_id.
#[tokio::test]
async fn apply_move_block_sql_only_allows_non_cycle() {
    let (pool, _dir) = fresh_pool().await;
    // Two unrelated blocks: A (root) and B (root). Move A under B — no cycle.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'A', NULL, 1)",
    )
    .bind(A)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'B', NULL, 2)",
    )
    .bind(B)
    .execute(&pool)
    .await
    .unwrap();

    let mut conn = pool.acquire().await.expect("acquire");
    apply_move_block_sql_only(
        &mut conn,
        MoveBlockPayload {
            block_id: BlockId::from_trusted(A),
            new_parent_id: Some(BlockId::from_trusted(B)),
            new_position: 3,
            new_index: None,
        },
    )
    .await
    .expect("non-cycle move");
    drop(conn);

    let parent: Option<String> = sqlx::query_scalar("SELECT parent_id FROM blocks WHERE id = ?")
        .bind(A)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        parent.as_deref(),
        Some(B),
        "non-cycle move must write the new parent_id"
    );
}
