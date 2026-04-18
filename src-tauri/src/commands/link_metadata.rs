//! Link metadata command handlers (UX-165).

use sqlx::SqlitePool;
use tauri::State;

use crate::db::{ReadPool, WritePool};
use crate::error::AppError;
use crate::link_metadata::{self, LinkMetadata};

/// Fetch metadata for a URL (HTTP fetch + store in cache).
/// Returns cached metadata if fresh (< 7 days), otherwise fetches from network.
pub async fn fetch_link_metadata_inner(
    pool: &SqlitePool,
    url: String,
) -> Result<LinkMetadata, AppError> {
    // Check cache first — return if fresh (< 7 days)
    if let Some(cached) = link_metadata::get_cached(pool, &url).await? {
        if !is_stale(&cached.fetched_at, 7) {
            return Ok(cached);
        }
    }
    // Fetch from network
    let meta = link_metadata::fetch_metadata(&url).await?;
    link_metadata::upsert(pool, &meta).await?;
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
    pool: State<'_, WritePool>,
    url: String,
) -> Result<LinkMetadata, AppError> {
    fetch_link_metadata_inner(&pool.0, url).await
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
    use crate::db::init_pool;
    use crate::link_metadata::{self, LinkMetadata};
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
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
        let result = fetch_link_metadata_inner(&pool, "https://example.com/cached".to_string())
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

        let result = fetch_link_metadata_inner(&pool, "https://private.example.com".to_string())
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
            fetch_link_metadata_inner(&pool, "http://127.0.0.1:1/nonexistent".to_string()).await;

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
            fetch_link_metadata_inner(&pool, "http://127.0.0.1:1/stale-entry".to_string()).await;

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

        let result = fetch_link_metadata_inner(&pool, "https://minimal.example.com".to_string())
            .await
            .unwrap();

        assert_eq!(result.fetched_at, now);
        assert!(result.title.is_none());
        assert!(result.favicon_url.is_none());
        assert!(result.description.is_none());
        assert!(!result.auth_required);
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
