// --- verify_active: DB-backed ---

mod verify_active_db {
    use crate::db::init_pool;
    use crate::ulid::*;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a block row directly. Bypasses the command layer because
    /// these tests need to set `deleted_at` to specific states that the
    /// regular create path doesn't expose.
    async fn insert_block(pool: &SqlitePool, id: &str, deleted_at: Option<i64>) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
             VALUES (?, 'content', '', NULL, 1, ?)",
        )
        .bind(id)
        .bind(deleted_at)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn verify_active_accepts_live_block() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "ACTBLK01", None).await;

        let raw = BlockId::from_trusted("ACTBLK01");
        let active = verify_active(&pool, &raw)
            .await
            .expect("live block must verify");
        assert_eq!(active.as_str(), "ACTBLK01");
    }

    #[tokio::test]
    async fn verify_active_rejects_soft_deleted_block() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "DELBLK01", Some(1_735_689_600_000)).await;

        let raw = BlockId::from_trusted("DELBLK01");
        let err = verify_active(&pool, &raw)
            .await
            .expect_err("soft-deleted block must be rejected");
        match err {
            AppError::Validation { message: msg, .. } => {
                assert!(
                    msg.contains("soft-deleted"),
                    "error must mention soft-deleted, got: {msg}",
                );
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn verify_active_rejects_nonexistent_block() {
        let (pool, _dir) = test_pool().await;

        let raw = BlockId::from_trusted("NOPEBLK1");
        let err = verify_active(&pool, &raw)
            .await
            .expect_err("missing block must be rejected");
        assert!(
            matches!(err, AppError::NotFound(_)),
            "expected NotFound, got {err:?}",
        );
    }

    /// `verify_active` accepts a `BlockId` regardless of how the caller
    /// produced it (literal `from_trusted`, deserialized JSON, etc.) —
    /// the activeness check is purely SQL-driven.
    #[tokio::test]
    async fn verify_active_normalises_lowercase_id_lookup() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "01ARZ3NDEKTSV4RRFFQ69G5FAV", None).await;

        // Caller hands us a lowercased ULID — `from_trusted` uppercases
        // it before the SQL lookup, so the row is found.
        let raw = BlockId::from_trusted("01arz3ndektsv4rrffq69g5fav");
        let active = verify_active(&pool, &raw)
            .await
            .expect("lookup must hit the row regardless of input casing");
        assert_eq!(active.as_str(), "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    }
}
