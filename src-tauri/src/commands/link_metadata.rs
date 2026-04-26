//! Link metadata command handlers (UX-165).

use sqlx::SqlitePool;
use tauri::State;

use crate::db::{ReadPool, WritePool};
use crate::error::AppError;
use crate::link_metadata::{self, LinkMetadata};

/// Fetch metadata for a URL (HTTP fetch + store in cache).
/// Returns cached metadata if fresh (< 7 days), otherwise fetches from network.
///
/// **H-15:** Split-pool routing — the cache lookup runs against the
/// `read_pool` so the network-bound HTTP fetch never holds a connection
/// from the writer pool. The `write_pool` is acquired only for the final
/// `upsert` after a fresh fetch, keeping write contention with the
/// materializer to the minimum necessary footprint.
pub async fn fetch_link_metadata_inner(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    url: String,
) -> Result<LinkMetadata, AppError> {
    // Check cache first — return if fresh (< 7 days). Read-only path:
    // never touches the write pool on a cache hit.
    if let Some(cached) = link_metadata::get_cached(read_pool, &url).await? {
        if !is_stale(&cached.fetched_at, 7) {
            return Ok(cached);
        }
    }
    // Cache miss or stale — fetch from network (no DB usage), then
    // acquire the write pool *only* for the upsert.
    let meta = link_metadata::fetch_metadata(&url).await?;
    link_metadata::upsert(write_pool, &meta).await?;
    Ok(meta)
}

/// Get cached metadata only (no network fetch).
pub async fn get_link_metadata_inner(
    pool: &SqlitePool,
    url: String,
) -> Result<Option<LinkMetadata>, AppError> {
    link_metadata::get_cached(pool, &url).await
}

/// Check if a `fetched_at` timestamp (RFC 3339) is older than `max_days`.
fn is_stale(fetched_at: &str, max_days: u32) -> bool {
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(fetched_at) else {
        // If we can't parse it, treat as stale
        return true;
    };
    let age = chrono::Utc::now() - parsed.with_timezone(&chrono::Utc);
    age.num_days() > i64::from(max_days)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn fetch_link_metadata(
    read_pool: State<'_, ReadPool>,
    write_pool: State<'_, WritePool>,
    url: String,
) -> Result<LinkMetadata, AppError> {
    fetch_link_metadata_inner(&read_pool.0, &write_pool.0, url).await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_link_metadata(
    pool: State<'_, ReadPool>,
    url: String,
) -> Result<Option<LinkMetadata>, AppError> {
    get_link_metadata_inner(&pool.0, url).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_pool, init_pools, DbPools};
    use crate::link_metadata::{self, LinkMetadata};
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Split read/write pool fixture — H-15 verification.
    ///
    /// Mirrors the production `init_pools` configuration so the
    /// `query_only` pragma on the read pool is enforced. Tests that
    /// pass the read pool where a write would be expected will fail
    /// at the SQLite layer, giving us a hard runtime check that the
    /// inner function routes reads vs writes to the correct pool.
    async fn test_pools_split() -> (DbPools, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pools = init_pools(&db_path).await.unwrap();
        (pools, dir)
    }

    // ==================================================================
    // fetch_link_metadata_inner tests
    // ==================================================================

    #[tokio::test]
    async fn cache_hit_returns_cached_data_without_http() {
        let (pool, _dir) = test_pool().await;

        // Insert fresh metadata (fetched "now") directly into the DB.
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let meta = LinkMetadata {
            url: "https://example.com/cached".to_string(),
            title: Some("Cached Title".to_string()),
            favicon_url: Some("https://example.com/favicon.ico".to_string()),
            description: Some("Cached description".to_string()),
            fetched_at: now.clone(),
            auth_required: false,
        };
        link_metadata::upsert(&pool, &meta).await.unwrap();

        // Call the inner function — should return cached data without HTTP.
        // Legacy single-pool tests pass the same pool for both args; the
        // split-pool semantics are exercised in the dedicated
        // `*_split_pool*` tests below.
        let result =
            fetch_link_metadata_inner(&pool, &pool, "https://example.com/cached".to_string())
                .await
                .unwrap();

        // The fetched_at timestamp must match what we inserted, proving no
        // network fetch occurred (a fresh fetch would set a new timestamp).
        assert_eq!(
            result.fetched_at, now,
            "fetched_at must match the cached row — no HTTP fetch should have happened"
        );
        assert_eq!(result.title.as_deref(), Some("Cached Title"));
        assert_eq!(
            result.favicon_url.as_deref(),
            Some("https://example.com/favicon.ico")
        );
        assert_eq!(result.description.as_deref(), Some("Cached description"));
        assert!(!result.auth_required);
    }

    #[tokio::test]
    async fn cache_hit_preserves_auth_required_flag() {
        let (pool, _dir) = test_pool().await;

        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let meta = LinkMetadata {
            url: "https://private.example.com".to_string(),
            title: None,
            favicon_url: None,
            description: None,
            fetched_at: now.clone(),
            auth_required: true,
        };
        link_metadata::upsert(&pool, &meta).await.unwrap();

        let result =
            fetch_link_metadata_inner(&pool, &pool, "https://private.example.com".to_string())
                .await
                .unwrap();

        assert_eq!(result.fetched_at, now, "should return cached row");
        assert!(
            result.auth_required,
            "auth_required flag must be preserved from cache"
        );
    }

    #[tokio::test]
    async fn cache_miss_triggers_http_fetch() {
        let (pool, _dir) = test_pool().await;

        // No cached entry exists. Call with an unreachable URL so the HTTP
        // fetch fails, proving the function attempted a network call.
        let result =
            fetch_link_metadata_inner(&pool, &pool, "http://127.0.0.1:1/nonexistent".to_string())
                .await;

        assert!(
            result.is_err(),
            "should error because HTTP fetch to unreachable URL fails"
        );
        let err_msg = format!("{}", result.unwrap_err());
        assert!(
            err_msg.contains("Network error") || err_msg.contains("error"),
            "error should mention network/fetch failure, got: {err_msg}"
        );
    }

    #[tokio::test]
    async fn stale_cache_triggers_refetch() {
        let (pool, _dir) = test_pool().await;

        // Insert metadata that is 8 days old (stale by the 7-day threshold).
        let eight_days_ago = (chrono::Utc::now() - chrono::Duration::days(8))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let meta = LinkMetadata {
            url: "http://127.0.0.1:1/stale-entry".to_string(),
            title: Some("Stale Title".to_string()),
            favicon_url: None,
            description: None,
            fetched_at: eight_days_ago,
            auth_required: false,
        };
        link_metadata::upsert(&pool, &meta).await.unwrap();

        // The stale entry should cause a refetch attempt, which will fail
        // because the URL is unreachable.
        let result =
            fetch_link_metadata_inner(&pool, &pool, "http://127.0.0.1:1/stale-entry".to_string())
                .await;

        assert!(
            result.is_err(),
            "stale cache should trigger HTTP refetch (which fails for unreachable URL)"
        );
    }

    #[tokio::test]
    async fn cache_hit_with_all_none_fields() {
        let (pool, _dir) = test_pool().await;

        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let meta = LinkMetadata {
            url: "https://minimal.example.com".to_string(),
            title: None,
            favicon_url: None,
            description: None,
            fetched_at: now.clone(),
            auth_required: false,
        };
        link_metadata::upsert(&pool, &meta).await.unwrap();

        let result =
            fetch_link_metadata_inner(&pool, &pool, "https://minimal.example.com".to_string())
                .await
                .unwrap();

        assert_eq!(result.fetched_at, now);
        assert!(result.title.is_none());
        assert!(result.favicon_url.is_none());
        assert!(result.description.is_none());
        assert!(!result.auth_required);
    }

    // ==================================================================
    // H-15 split-pool routing tests
    //
    // These tests verify that `fetch_link_metadata_inner` correctly routes
    // its DB operations across separate read/write pools so the network-
    // bound HTTP fetch never blocks writers in the materializer.
    // ==================================================================

    #[tokio::test]
    async fn cache_hit_uses_read_pool_only() {
        // Pre-insert a fresh cached row via the write pool, then close the
        // write pool. A subsequent cache-hit must succeed using only the
        // read pool — if the inner function touches the write pool on the
        // hit path the call will fail with a "PoolClosed" error.
        let (pools, _dir) = test_pools_split().await;

        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let meta = LinkMetadata {
            url: "https://example.com/split-cache-hit".to_string(),
            title: Some("Split-Pool Cached".to_string()),
            favicon_url: None,
            description: None,
            fetched_at: now.clone(),
            auth_required: false,
        };
        link_metadata::upsert(&pools.write, &meta).await.unwrap();

        // Close the write pool — any acquire against it will now fail.
        // The cache-hit path must not go anywhere near the write pool.
        pools.write.close().await;

        let result = fetch_link_metadata_inner(
            &pools.read,
            &pools.write,
            "https://example.com/split-cache-hit".to_string(),
        )
        .await
        .expect("cache hit must not touch the (closed) write pool");

        assert_eq!(result.fetched_at, now);
        assert_eq!(result.title.as_deref(), Some("Split-Pool Cached"));
    }

    #[tokio::test]
    async fn cache_lookup_runs_against_read_pool_query_only() {
        // The read pool has PRAGMA query_only = ON. If the inner function
        // mistakenly issued a write through the read pool argument, it
        // would error. This test seeds the cache via the write pool and
        // confirms the lookup succeeds against the (read-only) read pool.
        let (pools, _dir) = test_pools_split().await;

        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let meta = LinkMetadata {
            url: "https://example.com/query-only-lookup".to_string(),
            title: Some("Read-only Lookup".to_string()),
            favicon_url: None,
            description: None,
            fetched_at: now.clone(),
            auth_required: false,
        };
        link_metadata::upsert(&pools.write, &meta).await.unwrap();

        let result = fetch_link_metadata_inner(
            &pools.read,
            &pools.write,
            "https://example.com/query-only-lookup".to_string(),
        )
        .await
        .expect("query_only-pinned read pool must satisfy the cache lookup");

        assert_eq!(result.fetched_at, now);
        assert_eq!(result.title.as_deref(), Some("Read-only Lookup"));
    }

    #[tokio::test]
    async fn cache_miss_consults_read_pool_then_attempts_write() {
        // No cache row exists. The inner function should: (1) consult the
        // read pool — returning None — then (2) attempt the HTTP fetch and
        // upsert via the write pool. We use an unreachable URL so the HTTP
        // fetch fails, but that proves the read-pool lookup happened
        // first (it would have returned cached data if any existed) and
        // that the function correctly proceeded past the read step.
        let (pools, _dir) = test_pools_split().await;

        let result = fetch_link_metadata_inner(
            &pools.read,
            &pools.write,
            "http://127.0.0.1:1/split-miss".to_string(),
        )
        .await;

        assert!(
            result.is_err(),
            "cache miss with unreachable URL should error after the read-pool lookup returns None"
        );

        // The write pool must remain functional after the failed call —
        // the failure should be from the HTTP layer, not from a pool
        // misuse that poisoned the writer.
        let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM link_metadata")
            .fetch_one(&pools.write)
            .await
            .expect("write pool must still be usable after the failed fetch");
        assert_eq!(
            row_count, 0,
            "no cache row should have been written for an unreachable URL"
        );
    }

    // ==================================================================
    // get_link_metadata_inner tests
    // ==================================================================

    #[tokio::test]
    async fn get_inner_returns_none_when_no_cache() {
        let (pool, _dir) = test_pool().await;

        let result = get_link_metadata_inner(&pool, "https://missing.example.com".to_string())
            .await
            .unwrap();

        assert!(result.is_none(), "should return None for uncached URL");
    }

    #[tokio::test]
    async fn get_inner_returns_cached_metadata() {
        let (pool, _dir) = test_pool().await;

        let meta = LinkMetadata {
            url: "https://cached.example.com".to_string(),
            title: Some("Cached".to_string()),
            favicon_url: Some("https://cached.example.com/icon.png".to_string()),
            description: Some("A cached page".to_string()),
            fetched_at: "2025-06-01T10:00:00.000Z".to_string(),
            auth_required: false,
        };
        link_metadata::upsert(&pool, &meta).await.unwrap();

        let result = get_link_metadata_inner(&pool, "https://cached.example.com".to_string())
            .await
            .unwrap()
            .expect("should return Some for cached URL");

        assert_eq!(result.url, "https://cached.example.com");
        assert_eq!(result.title.as_deref(), Some("Cached"));
        assert_eq!(result.description.as_deref(), Some("A cached page"));
    }

    // ==================================================================
    // is_stale tests (existing)
    // ==================================================================

    #[test]
    fn is_stale_fresh_entry() {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        assert!(!is_stale(&now, 7));
    }

    #[test]
    fn is_stale_at_boundary() {
        let exactly_seven = (chrono::Utc::now() - chrono::Duration::days(7))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        assert!(
            !is_stale(&exactly_seven, 7),
            "exactly 7 days should NOT be stale"
        );
    }

    #[test]
    fn is_stale_after_boundary() {
        let eight_days = (chrono::Utc::now() - chrono::Duration::days(8))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        assert!(is_stale(&eight_days, 7), "8 days should be stale");
    }

    #[test]
    fn is_stale_invalid_timestamp() {
        assert!(is_stale("not-a-date", 7));
        assert!(is_stale("", 7));
    }

    #[test]
    fn is_stale_future_timestamp() {
        let future = (chrono::Utc::now() + chrono::Duration::days(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        assert!(!is_stale(&future, 7));
    }
}
