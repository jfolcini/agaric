//! Link metadata command handlers (UX-165).

use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

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

/// Clear the auth_required flag for a URL (user retry).
#[instrument(skip(pool), err)]
pub async fn clear_link_metadata_auth_inner(
    pool: &SqlitePool,
    url: String,
) -> Result<(), AppError> {
    link_metadata::clear_auth_flag(pool, &url).await
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

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn clear_link_metadata_auth(
    pool: State<'_, WritePool>,
    url: String,
) -> Result<(), AppError> {
    clear_link_metadata_auth_inner(&pool.0, url).await
}

#[cfg(test)]
mod tests {
    use super::*;

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
