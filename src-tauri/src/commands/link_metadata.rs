//! Link metadata command handlers.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};

use sqlx::SqlitePool;
use tauri::State;
use tokio::sync::watch;

use super::sanitize_internal_error;
use crate::db::{ReadPool, WritePool};
use crate::error::AppError;
use crate::link_metadata::{self, LinkMetadata};

// ---------------------------------------------------------------------------
// #2200 — fetch_link_metadata single-flight dedup
// ---------------------------------------------------------------------------
//
// Before #2200, M concurrent `fetch_link_metadata` calls for the same cold URL
// (e.g. every renderer that mentions the link firing on first paint) each ran
// an independent HTTP fetch + cache upsert — M network round-trips and M
// writer-pool acquisitions for one result. The single-flight coordinator below
// collapses concurrent identical-URL fetches onto ONE execution: the first
// caller leads (spawns the fetch), the rest await the shared result via a
// `watch` channel.
//
// Design notes:
//   * The fetch runs in a detached `tokio::spawn` so it completes (and cleans
//     up its map entry) even if every awaiting caller is cancelled — followers
//     never end up orphaned waiting on a future no one drives.
//   * The map entry is removed BEFORE the result is published, so a call that
//     arrives after completion re-fetches. Errors are therefore never cached
//     beyond the in-flight window (failure-then-retry works); only the DB
//     cache (populated on success by `upsert`) persists a hit.
//   * The map is bounded (`MAX_INFLIGHT`): once that many distinct URLs are in
//     flight, extra cold URLs bypass dedup and fetch directly rather than
//     growing the map without bound under a pathological fan-out.
//   * `AppError` is not `Clone`, so the shared result is an
//     `Arc<Result<LinkMetadata, AppError>>` and each waiter reconstructs an
//     owned error via [`clone_link_error`] (message + kind preserved for the
//     string-carrying variants that link fetches actually produce).

/// Shared, cloneable outcome of one in-flight fetch.
type SharedResult = Arc<Result<LinkMetadata, AppError>>;

/// Upper bound on distinct URLs tracked for dedup at once. Beyond this, extra
/// cold URLs bypass the in-flight map (fetch directly) so it can't grow
/// unbounded. 256 comfortably covers a page's worth of distinct links while
/// bounding worst-case memory.
const MAX_INFLIGHT: usize = 256;

fn inflight() -> &'static Mutex<HashMap<String, watch::Receiver<Option<SharedResult>>>> {
    static MAP: OnceLock<Mutex<HashMap<String, watch::Receiver<Option<SharedResult>>>>> =
        OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Reconstruct an owned [`AppError`] from a shared reference. `AppError` is not
/// `Clone` (it wraps non-`Clone` sources like `sqlx::Error`), so followers of a
/// failed single-flight fetch rebuild the error: the string-carrying variants
/// that link fetches actually emit (network failures are
/// `AppError::InvalidOperation`) are preserved verbatim; source-bearing
/// variants fall back to their `Display` string under `InvalidOperation`,
/// which keeps the human-readable cause intact.
fn clone_link_error(err: &AppError) -> AppError {
    match err {
        AppError::InvalidOperation(m) => AppError::InvalidOperation(m.clone()),
        AppError::NotFound(m) => AppError::NotFound(m.clone()),
        AppError::Conflict(m) => AppError::Conflict(m.clone()),
        AppError::Validation { code, message } => AppError::Validation {
            code: *code,
            message: message.clone(),
        },
        AppError::Internal(m) => AppError::Internal(m.clone()),
        other => AppError::InvalidOperation(other.to_string()),
    }
}

/// Run `fetch` for `url` under process-wide single-flight. Concurrent callers
/// for the same URL await a single execution; the result is shared, but errors
/// are NOT cached beyond the in-flight window. When more than [`MAX_INFLIGHT`]
/// distinct URLs are already in flight, `fetch` runs directly (no dedup) to
/// keep the map bounded.
async fn single_flight_fetch<F, Fut>(url: String, fetch: F) -> Result<LinkMetadata, AppError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<LinkMetadata, AppError>> + Send + 'static,
{
    // Decide the role while holding the (std, `!Send`) mutex in a tight scope
    // with NO await inside, so the guard is provably dropped before any await
    // and this future stays `Send`.
    enum Plan {
        Lead(
            watch::Sender<Option<SharedResult>>,
            watch::Receiver<Option<SharedResult>>,
        ),
        Follow(watch::Receiver<Option<SharedResult>>),
        Bypass,
    }
    let plan = {
        let mut map = inflight().lock().expect("inflight map mutex poisoned");
        if let Some(existing) = map.get(&url) {
            Plan::Follow(existing.clone())
        } else if map.len() >= MAX_INFLIGHT {
            Plan::Bypass
        } else {
            let (tx, rx) = watch::channel(None);
            map.insert(url.clone(), rx.clone());
            Plan::Lead(tx, rx)
        }
    };

    let mut rx = match plan {
        // Bounded: bypass dedup entirely rather than grow the map.
        Plan::Bypass => return fetch().await,
        Plan::Follow(rx) => rx,
        Plan::Lead(tx, rx) => {
            // Detached so the fetch (and its map cleanup) completes regardless
            // of any single awaiting caller being dropped.
            let fut = fetch();
            let key = url.clone();
            tokio::spawn(async move {
                let result: SharedResult = Arc::new(fut.await);
                // Remove BEFORE publishing so a call arriving after completion
                // re-fetches — errors are never cached past this window.
                inflight()
                    .lock()
                    .expect("inflight map mutex poisoned")
                    .remove(&key);
                let _ = tx.send(Some(result));
            });
            rx
        }
    };

    loop {
        if let Some(shared) = rx.borrow_and_update().as_ref().cloned() {
            return match shared.as_ref() {
                Ok(meta) => Ok(meta.clone()),
                Err(e) => Err(clone_link_error(e)),
            };
        }
        if rx.changed().await.is_err() {
            // Sender dropped without publishing — the spawned task panicked.
            return Err(AppError::Internal(
                "link metadata single-flight task dropped before publishing a result".into(),
            ));
        }
    }
}

/// Fetch metadata for a URL (HTTP fetch + store in cache).
/// Returns cached metadata if fresh (< 7 days), otherwise fetches from network.
///
/// **H-15:** Split-pool routing — the cache lookup runs against the
/// `read_pool` so the network-bound HTTP fetch never holds a connection
/// from the writer pool. The `write_pool` is acquired only for the final
/// `upsert` after a fresh fetch, keeping write contention with the
/// materializer to the minimum necessary footprint.
#[tracing::instrument(skip(read_pool, write_pool, url), err)]
pub async fn fetch_link_metadata_inner(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    url: String,
) -> Result<LinkMetadata, AppError> {
    // Check cache first — return if fresh (< 7 days). Read-only path:
    // never touches the write pool on a cache hit.
    if let Some(cached) = link_metadata::get_cached(read_pool, &url).await?
        && !is_stale(cached.fetched_at, 7)
    {
        return Ok(cached);
    }
    // Cache miss or stale — fetch from network (no DB usage), then acquire the
    // write pool *only* for the upsert. #2200: route the fetch+upsert through
    // the single-flight coordinator so M concurrent callers for the same cold
    // URL collapse onto one network round-trip + one upsert instead of racing.
    // `SqlitePool` is a cheap `Arc` clone, so the owned captures below keep the
    // spawned fetch `'static` without duplicating any real connection state.
    let write_pool = write_pool.clone();
    let fetch_url = url.clone();
    single_flight_fetch(url, move || async move {
        let meta = link_metadata::fetch_metadata(&fetch_url).await?;
        link_metadata::upsert(&write_pool, &meta).await?;
        Ok(meta)
    })
    .await
}

/// Get cached metadata only (no network fetch).
#[tracing::instrument(skip(pool, url), err)]
pub async fn get_link_metadata_inner(
    pool: &SqlitePool,
    url: String,
) -> Result<Option<LinkMetadata>, AppError> {
    link_metadata::get_cached(pool, &url).await
}

/// Check if a `fetched_at` timestamp (epoch milliseconds, #109 Phase 2) is
/// older than `max_days`. Comparison is at whole-day resolution to preserve
/// the pre-migration `num_days() > max_days` semantics: an age of exactly
/// `max_days` is fresh, `max_days + 1` whole days is stale. A future
/// timestamp (negative age) is never stale.
fn is_stale(fetched_at: i64, max_days: u32) -> bool {
    const MS_PER_DAY: i64 = 86_400_000;
    let age_ms = (crate::db::now_ms() - fetched_at).max(0);
    age_ms / MS_PER_DAY > i64::from(max_days)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Tauri command: fetch (or refresh) link metadata for a URL. Cache
/// hits return immediately; stale or missing entries trigger an HTTP
/// fetch and an upsert into the cache. Delegates to
/// [`fetch_link_metadata_inner`].
#[tauri::command]
#[specta::specta]
pub async fn fetch_link_metadata(
    read_pool: State<'_, ReadPool>,
    write_pool: State<'_, WritePool>,
    url: String,
) -> Result<LinkMetadata, AppError> {
    fetch_link_metadata_inner(&read_pool.0, &write_pool.0, url)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: read cached link metadata only (no network fetch).
/// Returns `None` if the URL has not been seen. Delegates to
/// [`get_link_metadata_inner`].
#[tauri::command]
#[specta::specta]
pub async fn get_link_metadata(
    pool: State<'_, ReadPool>,
    url: String,
) -> Result<Option<LinkMetadata>, AppError> {
    get_link_metadata_inner(&pool.0, url)
        .await
        .map_err(sanitize_internal_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{DbPools, init_pool, init_pools};
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
        let now = crate::db::now_ms();
        let meta = LinkMetadata {
            url: "https://example.com/cached".to_string(),
            title: Some("Cached Title".to_string()),
            favicon_url: Some("https://example.com/favicon.ico".to_string()),
            description: Some("Cached description".to_string()),
            fetched_at: now,
            auth_required: false,
            not_found: false,
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

        let now = crate::db::now_ms();
        let meta = LinkMetadata {
            url: "https://private.example.com".to_string(),
            title: None,
            favicon_url: None,
            description: None,
            fetched_at: now,
            auth_required: true,
            not_found: false,
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
        let eight_days_ago = crate::db::now_ms() - 8 * 86_400_000;
        let meta = LinkMetadata {
            url: "http://127.0.0.1:1/stale-entry".to_string(),
            title: Some("Stale Title".to_string()),
            favicon_url: None,
            description: None,
            fetched_at: eight_days_ago,
            auth_required: false,
            not_found: false,
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

        let now = crate::db::now_ms();
        let meta = LinkMetadata {
            url: "https://minimal.example.com".to_string(),
            title: None,
            favicon_url: None,
            description: None,
            fetched_at: now,
            auth_required: false,
            not_found: false,
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

        let now = crate::db::now_ms();
        let meta = LinkMetadata {
            url: "https://example.com/split-cache-hit".to_string(),
            title: Some("Split-Pool Cached".to_string()),
            favicon_url: None,
            description: None,
            fetched_at: now,
            auth_required: false,
            not_found: false,
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

        let now = crate::db::now_ms();
        let meta = LinkMetadata {
            url: "https://example.com/query-only-lookup".to_string(),
            title: Some("Read-only Lookup".to_string()),
            favicon_url: None,
            description: None,
            fetched_at: now,
            auth_required: false,
            not_found: false,
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
            fetched_at: 1_748_772_000_000, // 2025-06-01T10:00:00Z in epoch ms
            auth_required: false,
            not_found: false,
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

    const MS_PER_DAY: i64 = 86_400_000;

    #[test]
    fn is_stale_fresh_entry() {
        assert!(!is_stale(crate::db::now_ms(), 7));
    }

    #[test]
    fn is_stale_at_boundary() {
        // Exactly 7 whole days old: `age / MS_PER_DAY == 7`, which is not
        // `> 7`, so still fresh — matches the pre-migration day-resolution
        // semantics.
        let exactly_seven = crate::db::now_ms() - 7 * MS_PER_DAY;
        assert!(
            !is_stale(exactly_seven, 7),
            "exactly 7 days should NOT be stale"
        );
    }

    #[test]
    fn is_stale_after_boundary() {
        let eight_days = crate::db::now_ms() - 8 * MS_PER_DAY;
        assert!(is_stale(eight_days, 7), "8 days should be stale");
    }

    #[test]
    fn is_stale_zero_timestamp() {
        // Epoch 0 (1970) is far older than any window — always stale.
        assert!(is_stale(0, 7));
    }

    #[test]
    fn is_stale_future_timestamp() {
        let future = crate::db::now_ms() + MS_PER_DAY;
        assert!(!is_stale(future, 7), "a future timestamp is never stale");
    }

    // ==================================================================
    // #2200 single-flight dedup tests
    // ==================================================================

    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn dummy_meta(url: &str) -> LinkMetadata {
        LinkMetadata {
            url: url.to_string(),
            title: Some("t".to_string()),
            favicon_url: None,
            description: None,
            fetched_at: crate::db::now_ms(),
            auth_required: false,
            not_found: false,
        }
    }

    /// Concurrent callers for the same URL must share ONE fetch: the counting
    /// closure fires exactly once across 8 simultaneous requests.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn single_flight_dedups_concurrent_identical_urls() {
        let calls = Arc::new(AtomicUsize::new(0));
        let url = "https://single-flight.test/dedup".to_string();

        let mut handles = Vec::new();
        for _ in 0..8 {
            let calls = calls.clone();
            let url_outer = url.clone();
            handles.push(tokio::spawn(async move {
                super::single_flight_fetch(url_outer.clone(), move || {
                    let calls = calls.clone();
                    let url_inner = url_outer.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        // Hold the in-flight window open long enough for all
                        // concurrent callers to register as followers.
                        tokio::time::sleep(Duration::from_millis(150)).await;
                        Ok(dummy_meta(&url_inner))
                    }
                })
                .await
            }));
        }

        for h in handles {
            let meta = h
                .await
                .expect("task must not panic")
                .expect("fetch must succeed");
            assert_eq!(meta.url, url, "every caller gets the shared metadata");
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "8 concurrent identical-URL fetches must collapse onto a single execution"
        );
    }

    /// A failed fetch must NOT be cached in the in-flight map: the next call
    /// re-runs a fresh fetch (which here succeeds), proving the error window
    /// closed with the leader's completion.
    #[tokio::test]
    async fn single_flight_failure_then_retry_runs_fresh_fetch() {
        let url = "https://single-flight.test/retry".to_string();

        let r1 = super::single_flight_fetch(url.clone(), || async {
            Err(AppError::InvalidOperation(
                "boom: simulated fetch failure".into(),
            ))
        })
        .await;
        assert!(r1.is_err(), "first fetch must surface the error");
        assert!(
            format!("{}", r1.unwrap_err()).contains("boom"),
            "the leader's error must propagate faithfully"
        );

        // The map entry was removed before publishing, so this leads a brand-new
        // fetch rather than replaying the cached failure.
        let url_for_ok = url.clone();
        let r2 =
            super::single_flight_fetch(
                url.clone(),
                move || async move { Ok(dummy_meta(&url_for_ok)) },
            )
            .await;
        assert!(
            r2.is_ok(),
            "a retry after failure must run a fresh fetch, not replay the cached error"
        );
        assert_eq!(r2.unwrap().url, url);
    }

    /// Concurrent followers of a FAILING leader all receive the (reconstructed)
    /// error — the failure is fanned out, then the window closes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn single_flight_failure_fans_out_to_followers() {
        let calls = Arc::new(AtomicUsize::new(0));
        let url = "https://single-flight.test/fail-fanout".to_string();

        let mut handles = Vec::new();
        for _ in 0..6 {
            let calls = calls.clone();
            let url_outer = url.clone();
            handles.push(tokio::spawn(async move {
                super::single_flight_fetch(url_outer, move || {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(150)).await;
                        Err(AppError::InvalidOperation("shared failure".into()))
                    }
                })
                .await
            }));
        }

        for h in handles {
            let res = h.await.expect("task must not panic");
            assert!(
                res.is_err(),
                "every follower must observe the shared failure"
            );
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "the failing fetch must still run exactly once for all followers"
        );
    }
}
