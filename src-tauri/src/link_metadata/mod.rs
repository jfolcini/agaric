//! UX-165: Link metadata fetching and caching.
//!
//! Fetches `<title>`, favicon URL, and description from external URLs,
//! stores them in a local SQLite cache (`link_metadata` table) that is
//! NOT synced between devices. Each device fetches independently.
//!
//! Module layout:
//! - `html_parser` — pure HTML parsing + URL helpers (no I/O, no DB)
//! - this file (`mod.rs`) — HTTP client, DB operations, and the
//!   `LinkMetadata` type. Re-exports the public parsing API from
//!   `html_parser` to preserve the original single-file API surface.

use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::now_rfc3339;

mod html_parser;

#[cfg(test)]
mod tests;

// Re-export the public parsing API so callers keep using
// `crate::link_metadata::parse_title`, `parse_favicon`, etc.
pub use html_parser::{detect_auth_required, parse_description, parse_favicon, parse_title};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Type)]
pub struct LinkMetadata {
    pub url: String,
    pub title: Option<String>,
    pub favicon_url: Option<String>,
    pub description: Option<String>,
    pub fetched_at: String,
    pub auth_required: bool,
}

// ---------------------------------------------------------------------------
// HTTP fetching
// ---------------------------------------------------------------------------

/// Maximum response body size (512 KB).
const MAX_BODY_SIZE: usize = 512 * 1024;

/// Fetch metadata for a URL by downloading the page and parsing HTML.
pub async fn fetch_metadata(url: &str) -> Result<LinkMetadata, AppError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("Agaric/1.0")
        .build()
        .map_err(|e| AppError::InvalidOperation(format!("HTTP client error: {e}")))?;

    let response =
        client.get(url).send().await.map_err(|e| {
            AppError::InvalidOperation(format!("Network error fetching {url}: {e}"))
        })?;

    let status = response.status().as_u16();
    let final_url = response.url().to_string();

    // Check Content-Type — only fetch text/html
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_lowercase();

    let mime_type = content_type.split(';').next().unwrap_or("");

    if !mime_type.contains("text/html")
        && !mime_type.contains("text/xhtml")
        && !mime_type.contains("application/xhtml")
    {
        // Not HTML — return minimal metadata with no parsed fields
        return Ok(LinkMetadata {
            url: url.to_string(),
            title: None,
            favicon_url: parse_favicon("", url),
            description: None,
            fetched_at: now_rfc3339(),
            auth_required: status == 401 || status == 403,
        });
    }

    // Read body with size limit
    let body = read_body_limited(response, MAX_BODY_SIZE)
        .await
        .map_err(|e| {
            AppError::InvalidOperation(format!("Network error reading body from {url}: {e}"))
        })?;

    let title = parse_title(&body);
    let favicon_url = parse_favicon(&body, url);
    let description = parse_description(&body);
    let auth_required = detect_auth_required(status, url, &final_url, &body);

    Ok(LinkMetadata {
        url: url.to_string(),
        title,
        favicon_url,
        description,
        fetched_at: now_rfc3339(),
        auth_required,
    })
}

/// Read a response body up to `max_bytes`, discarding excess.
async fn read_body_limited(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, reqwest::Error> {
    let bytes = response.bytes().await?;
    let truncated = if bytes.len() > max_bytes {
        &bytes[..max_bytes]
    } else {
        &bytes
    };
    Ok(String::from_utf8_lossy(truncated).into_owned())
}

// ---------------------------------------------------------------------------
// DB operations (runtime queries, NOT compile-time macros)
// ---------------------------------------------------------------------------

/// Retrieve cached metadata for a URL.
pub async fn get_cached(pool: &SqlitePool, url: &str) -> Result<Option<LinkMetadata>, AppError> {
    let row = sqlx::query_as::<_, LinkMetadataRow>(
        "SELECT url, title, favicon_url, description, fetched_at, auth_required \
         FROM link_metadata WHERE url = ?",
    )
    .bind(url)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(Into::into))
}

/// Insert or replace cached metadata for a URL.
pub async fn upsert(pool: &SqlitePool, meta: &LinkMetadata) -> Result<(), AppError> {
    let auth_flag: i32 = if meta.auth_required { 1 } else { 0 };
    sqlx::query(
        "INSERT OR REPLACE INTO link_metadata \
         (url, title, favicon_url, description, fetched_at, auth_required) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&meta.url)
    .bind(&meta.title)
    .bind(&meta.favicon_url)
    .bind(&meta.description)
    .bind(&meta.fetched_at)
    .bind(auth_flag)
    .execute(pool)
    .await?;

    Ok(())
}

/// Clear the `auth_required` flag for a URL and update `fetched_at` to now.
pub async fn clear_auth_flag(pool: &SqlitePool, url: &str) -> Result<(), AppError> {
    let now = now_rfc3339();
    sqlx::query("UPDATE link_metadata SET auth_required = 0, fetched_at = ? WHERE url = ?")
        .bind(&now)
        .bind(url)
        .execute(pool)
        .await?;

    Ok(())
}

/// Delete stale non-auth entries older than `max_age_days`.
/// Returns the number of rows deleted.
pub async fn cleanup_stale(pool: &SqlitePool, max_age_days: u32) -> Result<u64, AppError> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(i64::from(max_age_days));
    let cutoff_str = cutoff.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let result =
        sqlx::query("DELETE FROM link_metadata WHERE auth_required = 0 AND fetched_at < ?")
            .bind(&cutoff_str)
            .execute(pool)
            .await?;

    Ok(result.rows_affected())
}

// ---------------------------------------------------------------------------
// Internal DB row type
// ---------------------------------------------------------------------------

#[derive(Debug, sqlx::FromRow)]
struct LinkMetadataRow {
    url: String,
    title: Option<String>,
    favicon_url: Option<String>,
    description: Option<String>,
    fetched_at: String,
    auth_required: i32,
}

impl From<LinkMetadataRow> for LinkMetadata {
    fn from(row: LinkMetadataRow) -> Self {
        Self {
            url: row.url,
            title: row.title,
            favicon_url: row.favicon_url,
            description: row.description,
            fetched_at: row.fetched_at,
            auth_required: row.auth_required != 0,
        }
    }
}
