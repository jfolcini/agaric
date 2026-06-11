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
//!
//! DB access here uses runtime `sqlx::query`/`query_as` (not the
//! compile-time `query!` macros) by design: the `link_metadata` table is
//! a device-local, regenerable cache (never synced), and its STRICT +
//! CHECK column affinity already enforces row shape at write time. The
//! runtime form keeps this isolated helper free of an offline-`.sqlx`
//! dependency; it is an intentional choice, not an oversight — do not
//! convert these to macros.

use std::sync::OnceLock;

use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;

use crate::db::now_ms;
use crate::error::AppError;

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
    /// Milliseconds since the UNIX epoch (UTC) — see `crate::db::now_ms`.
    /// Exposed to the frontend as a `number` (#109 Phase 2; was an RFC 3339
    /// string before the INTEGER-ms timestamp migration).
    pub fetched_at: i64,
    pub auth_required: bool,
    /// MAINT-213 (PEND-24 M4 follow-up): `true` when the most recent
    /// fetch saw a terminal "this resource is gone" status (HTTP 404 or
    /// 410). Distinct from `auth_required` (401/403, transient
    /// sign-in) and from "transient" (5xx — both flags false plus
    /// `title.is_none()`). The frontend uses this to render a "(not
    /// found)" tag and suppress the favicon.
    ///
    /// `#[serde(default)]` so any legacy serialized blob — e.g. a
    /// cached snapshot deserialized before this field existed — keeps
    /// deserializing cleanly as `false`.
    #[serde(default)]
    pub not_found: bool,
}

// ---------------------------------------------------------------------------
// HTTP fetching
// ---------------------------------------------------------------------------

/// Maximum response body size (512 KB).
const MAX_BODY_SIZE: usize = 512 * 1024;

/// Return the process-global `reqwest::Client`, lazily built on first
/// use. `reqwest::Client` is `Arc`-backed, so cloning is cheap; the
/// `OnceLock` keeps us from re-building (a ~ms operation that would
/// thrash connection pooling if done per `fetch_metadata()` call).
fn shared_client() -> Result<reqwest::Client, AppError> {
    static CELL: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(existing) = CELL.get() {
        return Ok(existing.clone());
    }
    let built = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("Agaric/1.0")
        .build()
        .map_err(|e| AppError::InvalidOperation(format!("HTTP client error: {e}")))?;
    // Benign race: two threads may both get into `build()` on first
    // call; whichever `get_or_init`s first wins, the other's client
    // is dropped. Either way the stored client is a valid shared
    // handle.
    Ok(CELL.get_or_init(|| built).clone())
}

/// Fetch metadata for a URL by downloading the page and parsing HTML.
pub async fn fetch_metadata(url: &str) -> Result<LinkMetadata, AppError> {
    let client = shared_client()?;

    let response =
        client.get(url).send().await.map_err(|e| {
            AppError::InvalidOperation(format!("Network error fetching {url}: {e}"))
        })?;

    let status = response.status().as_u16();
    let final_url = response.url().to_string();

    // PEND-24 M4 — short-circuit on non-2xx so 4xx/5xx HTML error pages
    // (e.g. a 404 with `<title>Page not found</title>`) don't get parsed
    // and cached as the target page's metadata.
    //
    // MAINT-213: classify the non-2xx into three terminal categories so
    // the frontend can render distinct UX:
    //   * `auth_required` (401/403): sign-in card / reauth flow
    //   * `not_found` (404/410): terminal "page is gone" presentation
    //   * neither flag, `title.is_none()`: transient (5xx / other) —
    //     the frontend infers "may retry later"
    //
    // #628: key the error-state row under the **requested** `url`, not
    // `final_url` — the cache upsert keys on `meta.url` and every lookup
    // (`get_cached(pool, &url)`) uses the requested url, so storing the
    // post-redirect `final_url` here meant a redirected non-2xx (e.g.
    // http→https→404) was cached under a key that is never queried and
    // refetched on every render. `final_url` stays relevant only for
    // `detect_auth_required` on the 2xx path below.
    if !response.status().is_success() {
        return Ok(LinkMetadata {
            url: url.to_string(),
            title: None,
            favicon_url: None,
            description: None,
            fetched_at: now_ms(),
            auth_required: status == 401 || status == 403,
            not_found: status == 404 || status == 410,
        });
    }

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
        // Not HTML — return minimal metadata with no parsed fields.
        // This branch is only reachable when the status is 2xx (the
        // non-2xx short-circuit above already returned), so the
        // `auth_required` / `not_found` guards are defensive — they
        // will always be `false` here.
        return Ok(LinkMetadata {
            url: url.to_string(),
            title: None,
            favicon_url: parse_favicon("", url),
            description: None,
            fetched_at: now_ms(),
            auth_required: status == 401 || status == 403,
            not_found: status == 404 || status == 410,
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
        fetched_at: now_ms(),
        auth_required,
        // 2xx by construction (non-2xx short-circuited above) — the
        // "soft 404" / login-page detection lives entirely in
        // `auth_required` via `detect_auth_required`.
        not_found: false,
    })
}

/// Read a response body up to `max_bytes`, discarding excess.
///
/// L-90: streams chunks via [`reqwest::Response::chunk`] and stops as soon as
/// the accumulator hits `max_bytes` (then drops the response, which closes
/// the connection and aborts the rest of the download). Pre-2025 this used
/// `response.bytes().await?`, which materialized the entire body into memory
/// before the size check — a misbehaving server returning gigabytes of data
/// would OOM the process. The contract is unchanged: the function never
/// errors on oversize input, it just returns the first `max_bytes` bytes
/// (lossy-decoded as UTF-8).
async fn read_body_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, reqwest::Error> {
    // Pre-size the accumulator from `Content-Length` when the server is
    // honest, capped at `max_bytes`. The header is untrusted — the per-chunk
    // bound below is the real safety net — but a useful heuristic to avoid
    // repeated reallocs on the common case.
    let cap = response
        .content_length()
        .and_then(|n| usize::try_from(n).ok())
        .map_or(0, |n| n.min(max_bytes));
    let mut buf: Vec<u8> = Vec::with_capacity(cap);

    while let Some(chunk) = response.chunk().await? {
        let remaining = max_bytes.saturating_sub(buf.len());
        if remaining == 0 {
            break;
        }
        if chunk.len() <= remaining {
            buf.extend_from_slice(&chunk);
        } else {
            buf.extend_from_slice(&chunk[..remaining]);
            break;
        }
    }

    // Explicitly drop the response so the underlying connection is closed
    // and any remaining body bytes are not pulled across the wire.
    drop(response);

    Ok(String::from_utf8_lossy(&buf).into_owned())
}

// ---------------------------------------------------------------------------
// DB operations (runtime queries, NOT compile-time macros)
// ---------------------------------------------------------------------------

/// Retrieve cached metadata for a URL.
pub async fn get_cached(pool: &SqlitePool, url: &str) -> Result<Option<LinkMetadata>, AppError> {
    let row = sqlx::query_as::<_, LinkMetadataRow>(
        "SELECT url, title, favicon_url, description, fetched_at, auth_required, not_found \
         FROM link_metadata WHERE url = ?",
    )
    .bind(url)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(Into::into))
}

/// Insert or replace cached metadata for a URL.
pub async fn upsert(pool: &SqlitePool, meta: &LinkMetadata) -> Result<(), AppError> {
    let auth_flag: i32 = i32::from(meta.auth_required);
    let not_found_flag: i32 = i32::from(meta.not_found);
    sqlx::query(
        "INSERT OR REPLACE INTO link_metadata \
         (url, title, favicon_url, description, fetched_at, auth_required, not_found) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&meta.url)
    .bind(&meta.title)
    .bind(&meta.favicon_url)
    .bind(&meta.description)
    .bind(meta.fetched_at)
    .bind(auth_flag)
    .bind(not_found_flag)
    .execute(pool)
    .await?;

    Ok(())
}

/// Delete stale non-auth entries older than `max_age_days`.
/// Returns the number of rows deleted.
pub async fn cleanup_stale(pool: &SqlitePool, max_age_days: u32) -> Result<u64, AppError> {
    // `fetched_at` is now epoch-ms (#109 Phase 2): subtract the window in ms
    // from the current instant rather than formatting an RFC 3339 cutoff.
    let cutoff_ms = now_ms() - i64::from(max_age_days) * 86_400_000;

    let result =
        sqlx::query("DELETE FROM link_metadata WHERE auth_required = 0 AND fetched_at < ?")
            .bind(cutoff_ms)
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
    fetched_at: i64,
    auth_required: i32,
    not_found: i32,
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
            not_found: row.not_found != 0,
        }
    }
}
