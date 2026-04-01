//! Sync peer tracking — CRUD operations for the `peer_refs` table.
//!
//! Each row tracks a remote sync peer: the last hash received, the last hash
//! sent, the most recent sync timestamp, and a reset counter for detecting
//! protocol resets.

#![allow(dead_code)]

use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::AppError;

/// A row from the `peer_refs` table representing a remote sync peer.
#[derive(Debug, Clone, Serialize, sqlx::FromRow, specta::Type)]
pub struct PeerRef {
    pub peer_id: String,
    pub last_hash: Option<String>,
    pub last_sent_hash: Option<String>,
    pub synced_at: Option<String>,
    pub reset_count: i64,
    pub last_reset_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/// Fetch a single peer ref by `peer_id`.
///
/// Returns `None` if the peer does not exist.
pub async fn get_peer_ref(pool: &SqlitePool, peer_id: &str) -> Result<Option<PeerRef>, AppError> {
    let row = sqlx::query_as!(
        PeerRef,
        r#"SELECT peer_id, last_hash, last_sent_hash, synced_at,
                  reset_count as "reset_count!: i64", last_reset_at
           FROM peer_refs WHERE peer_id = ?"#,
        peer_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// List all peer refs, ordered by `synced_at` descending (most recently
/// synced first).  Peers that have never synced (`synced_at IS NULL`) appear
/// last.
pub async fn list_peer_refs(pool: &SqlitePool) -> Result<Vec<PeerRef>, AppError> {
    let rows = sqlx::query_as!(
        PeerRef,
        r#"SELECT peer_id, last_hash, last_sent_hash, synced_at,
                  reset_count as "reset_count!: i64", last_reset_at
           FROM peer_refs
           ORDER BY synced_at DESC"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/// Insert a new peer ref if it does not already exist.
///
/// Uses `INSERT OR IGNORE` so calling this for an existing peer is a no-op.
/// All optional fields default to `NULL` and `reset_count` defaults to 0.
pub async fn upsert_peer_ref(pool: &SqlitePool, peer_id: &str) -> Result<(), AppError> {
    sqlx::query!(
        "INSERT OR IGNORE INTO peer_refs (peer_id) VALUES (?)",
        peer_id,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Update sync state atomically after a successful sync exchange.
///
/// Sets `last_hash`, `last_sent_hash`, and `synced_at` (current UTC time).
/// Returns [`AppError::NotFound`] if `peer_id` does not exist.
///
/// **Caller responsibility:** this should run inside a `BEGIN IMMEDIATE`
/// transaction in production to prevent concurrent modifications.
pub async fn update_on_sync(
    pool: &SqlitePool,
    peer_id: &str,
    last_hash: &str,
    last_sent_hash: &str,
) -> Result<(), AppError> {
    let now = crate::now_rfc3339();
    let result = sqlx::query!(
        "UPDATE peer_refs SET last_hash = ?, last_sent_hash = ?, synced_at = ?
         WHERE peer_id = ?",
        last_hash,
        last_sent_hash,
        now,
        peer_id,
    )
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("peer_refs ({peer_id})")));
    }
    Ok(())
}

/// Increment the reset counter for a peer and record the reset timestamp.
///
/// Returns [`AppError::NotFound`] if `peer_id` does not exist.
pub async fn increment_reset_count(pool: &SqlitePool, peer_id: &str) -> Result<(), AppError> {
    let now = crate::now_rfc3339();
    let result = sqlx::query!(
        "UPDATE peer_refs SET reset_count = reset_count + 1, last_reset_at = ?
         WHERE peer_id = ?",
        now,
        peer_id,
    )
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("peer_refs ({peer_id})")));
    }
    Ok(())
}

/// Delete a peer ref by `peer_id`.
///
/// Returns [`AppError::NotFound`] if `peer_id` does not exist.
pub async fn delete_peer_ref(pool: &SqlitePool, peer_id: &str) -> Result<(), AppError> {
    let result = sqlx::query!("DELETE FROM peer_refs WHERE peer_id = ?", peer_id,)
        .execute(pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("peer_refs ({peer_id})")));
    }
    Ok(())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // ── Helpers ─────────────────────────────────────────────────────────

    /// Create a fresh SQLite pool with migrations applied (temp directory).
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    // ── get_peer_ref ────────────────────────────────────────────────────

    #[tokio::test]
    async fn get_nonexistent_peer_returns_none() {
        let (pool, _dir) = test_pool().await;

        let result = get_peer_ref(&pool, "no-such-peer").await.unwrap();
        assert!(
            result.is_none(),
            "get_peer_ref for nonexistent peer must return None"
        );
    }

    // ── upsert_peer_ref + get_peer_ref ──────────────────────────────────

    #[tokio::test]
    async fn upsert_creates_new_peer_and_get_retrieves_it() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-A").await.unwrap();

        let peer = get_peer_ref(&pool, "peer-A")
            .await
            .unwrap()
            .expect("peer-A must exist after upsert");

        assert_eq!(peer.peer_id, "peer-A", "peer_id must match");
        assert!(peer.last_hash.is_none(), "last_hash must default to NULL");
        assert!(
            peer.last_sent_hash.is_none(),
            "last_sent_hash must default to NULL"
        );
        assert!(peer.synced_at.is_none(), "synced_at must default to NULL");
        assert_eq!(peer.reset_count, 0, "reset_count must default to 0");
        assert!(
            peer.last_reset_at.is_none(),
            "last_reset_at must default to NULL"
        );
    }

    #[tokio::test]
    async fn upsert_existing_peer_is_noop() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-A").await.unwrap();
        // Update some state so we can verify upsert doesn't overwrite
        update_on_sync(&pool, "peer-A", "hash1", "sent1")
            .await
            .unwrap();

        // Second upsert should be a no-op (INSERT OR IGNORE)
        upsert_peer_ref(&pool, "peer-A").await.unwrap();

        let peer = get_peer_ref(&pool, "peer-A")
            .await
            .unwrap()
            .expect("peer-A must still exist");
        assert_eq!(
            peer.last_hash.as_deref(),
            Some("hash1"),
            "upsert must not overwrite existing data"
        );
    }

    // ── update_on_sync ──────────────────────────────────────────────────

    #[tokio::test]
    async fn update_on_sync_sets_fields_atomically() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-B").await.unwrap();
        update_on_sync(&pool, "peer-B", "abc123", "def456")
            .await
            .unwrap();

        let peer = get_peer_ref(&pool, "peer-B")
            .await
            .unwrap()
            .expect("peer-B must exist");

        assert_eq!(
            peer.last_hash.as_deref(),
            Some("abc123"),
            "last_hash must be updated"
        );
        assert_eq!(
            peer.last_sent_hash.as_deref(),
            Some("def456"),
            "last_sent_hash must be updated"
        );
        assert!(
            peer.synced_at.is_some(),
            "synced_at must be set after update_on_sync"
        );
    }

    #[tokio::test]
    async fn update_on_sync_nonexistent_peer_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        let result = update_on_sync(&pool, "ghost-peer", "h1", "h2").await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "update_on_sync on nonexistent peer must return AppError::NotFound"
        );
    }

    // ── increment_reset_count ───────────────────────────────────────────

    #[tokio::test]
    async fn increment_reset_count_increments_correctly() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-C").await.unwrap();

        // First increment: 0 -> 1
        increment_reset_count(&pool, "peer-C").await.unwrap();
        let peer = get_peer_ref(&pool, "peer-C")
            .await
            .unwrap()
            .expect("peer-C must exist");
        assert_eq!(
            peer.reset_count, 1,
            "reset_count must be 1 after first increment"
        );
        assert!(
            peer.last_reset_at.is_some(),
            "last_reset_at must be set after increment"
        );

        // Second increment: 1 -> 2
        increment_reset_count(&pool, "peer-C").await.unwrap();
        let peer = get_peer_ref(&pool, "peer-C")
            .await
            .unwrap()
            .expect("peer-C must exist");
        assert_eq!(
            peer.reset_count, 2,
            "reset_count must be 2 after second increment"
        );
    }

    #[tokio::test]
    async fn increment_reset_count_nonexistent_peer_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        let result = increment_reset_count(&pool, "ghost-peer").await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "increment_reset_count on nonexistent peer must return AppError::NotFound"
        );
    }

    // ── list_peer_refs ──────────────────────────────────────────────────

    #[tokio::test]
    async fn list_peer_refs_returns_all_peers() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-X").await.unwrap();
        upsert_peer_ref(&pool, "peer-Y").await.unwrap();
        upsert_peer_ref(&pool, "peer-Z").await.unwrap();

        // Sync two of them so they have synced_at timestamps
        update_on_sync(&pool, "peer-X", "hx", "sx").await.unwrap();
        // Small sleep to ensure distinct timestamps for ordering
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        update_on_sync(&pool, "peer-Z", "hz", "sz").await.unwrap();

        let peers = list_peer_refs(&pool).await.unwrap();

        assert_eq!(peers.len(), 3, "must return all 3 peers");
        // peer-Z synced most recently, should be first
        assert_eq!(
            peers[0].peer_id, "peer-Z",
            "most recently synced peer must be first"
        );
        assert_eq!(
            peers[1].peer_id, "peer-X",
            "second most recently synced peer must be second"
        );
        // peer-Y has NULL synced_at, should be last
        assert_eq!(peers[2].peer_id, "peer-Y", "never-synced peer must be last");
    }

    #[tokio::test]
    async fn list_peer_refs_empty_table_returns_empty_vec() {
        let (pool, _dir) = test_pool().await;

        let peers = list_peer_refs(&pool).await.unwrap();
        assert!(
            peers.is_empty(),
            "list_peer_refs on empty table must return empty vec"
        );
    }

    // ── delete_peer_ref ─────────────────────────────────────────────────

    #[tokio::test]
    async fn delete_peer_ref_removes_peer() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-D").await.unwrap();
        assert!(
            get_peer_ref(&pool, "peer-D").await.unwrap().is_some(),
            "peer-D must exist before delete"
        );

        delete_peer_ref(&pool, "peer-D").await.unwrap();

        assert!(
            get_peer_ref(&pool, "peer-D").await.unwrap().is_none(),
            "peer-D must not exist after delete"
        );
    }

    #[tokio::test]
    async fn delete_nonexistent_peer_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        let result = delete_peer_ref(&pool, "ghost-peer").await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "delete_peer_ref on nonexistent peer must return AppError::NotFound"
        );
    }
}
