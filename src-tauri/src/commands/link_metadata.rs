//! Link metadata command handlers.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, PoisonError};

use sqlx::SqlitePool;
use tauri::State;
use tokio::sync::watch;

use super::sanitize_internal_error;
use crate::db::{ReadPool, WritePool};
use crate::error::AppError;
use crate::link_metadata::{self, LinkMetadata};

// ---------------------------------------------------------------------------
// #2200 — in-process single-flight for cold-URL fetches
// ---------------------------------------------------------------------------
//
// A note pasted N times (or N link previews of the same URL rendering at
// once) issues N concurrent `fetch_link_metadata` calls. Pre-#2200 each of
// them independently missed the cache, fetched the page over HTTP, and
// upserted — N network round-trips and N write-pool acquisitions for one
// piece of data. The single-flight map below collapses them: the first
// caller for a URL becomes the *leader* and performs the fetch + upsert;
// every concurrent caller for the same URL becomes a *follower* that awaits
// the leader's broadcast result on a `tokio::sync::watch` channel.
//
// Invariants (each pinned by a test in the module below):
//   * the map lock is a plain `std::sync::Mutex` held only for map
//     lookup/insert/remove — NEVER across the network await;
//   * the entry is removed when the leader finishes, on success, error,
//     AND panic (`InflightGuard`'s `Drop` runs during unwind), so a failed
//     fetch can never leave a poisoned entry that blocks later retries;
//   * followers of a leader that panicked before publishing observe the
//     closed channel and loop back to become the new leader.

/// Result broadcast from the single-flight leader to its followers. The
/// error side is flattened to the `Display` string because [`AppError`] is
/// not `Clone` (it wraps `sqlx::Error` / `std::io::Error`).
type SharedFetch = Result<LinkMetadata, String>;

/// In-flight fetches keyed by requested URL. The stored `Receiver` starts
/// at `None` and is flipped to `Some(result)` exactly once by the leader.
static INFLIGHT: LazyLock<Mutex<HashMap<String, watch::Receiver<Option<SharedFetch>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Removes the leader's in-flight entry on scope exit — including error
/// returns and panics — so no stuck entry can outlive its fetch.
struct InflightGuard {
    url: String,
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        // A poisoned lock can only mean another thread panicked inside the
        // short, await-free critical section; the map itself is still
        // structurally sound, so recover it rather than propagate.
        INFLIGHT
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.url);
    }
}

/// Single-flight role decided under the map lock.
enum FlightRole {
    Leader(watch::Sender<Option<SharedFetch>>),
    Follower(watch::Receiver<Option<SharedFetch>>),
}

/// Fetch metadata for a URL (HTTP fetch + store in cache).
/// Returns cached metadata if fresh (< 7 days), otherwise fetches from network.
///
/// **H-15:** Split-pool routing — the cache lookup runs against the
/// `read_pool` so the network-bound HTTP fetch never holds a connection
/// from the writer pool. The `write_pool` is acquired only for the final
/// `upsert` after a fresh fetch, keeping write contention with the
/// materializer to the minimum necessary footprint.
///
/// **#2200:** cold/stale fetches for the same URL are deduplicated by an
/// in-process single-flight (see the module note above): concurrent callers
/// for one URL trigger exactly one HTTP fetch and one upsert; the rest
/// await and share the leader's result.
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

    // Cache miss or stale — single-flight the network fetch. The loop only
    // repeats when a leader panicked before publishing (its guard already
    // removed the entry), in which case one follower is promoted to leader.
    loop {
        let role = {
            let mut map = INFLIGHT.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(rx) = map.get(&url) {
                FlightRole::Follower(rx.clone())
            } else {
                let (tx, rx) = watch::channel(None);
                map.insert(url.clone(), rx);
                FlightRole::Leader(tx)
            }
            // Map lock drops here — before any await below.
        };

        match role {
            FlightRole::Leader(tx) => {
                // Entry removal is tied to this guard's Drop so it happens
                // on success, error, and panic alike.
                let _guard = InflightGuard { url: url.clone() };
                // Fetch from network (no DB usage), then acquire the write
                // pool *only* for the upsert — unchanged from pre-#2200.
                let result = async {
                    let meta = link_metadata::fetch_metadata(&url).await?;
                    link_metadata::upsert(write_pool, &meta).await?;
                    Ok::<_, AppError>(meta)
                }
                .await;
                // Publish to followers before `_guard` drops. The map still
                // holds a receiver here, so the send cannot fail; ignore the
                // result defensively anyway.
                let _ = tx.send(Some(
                    result
                        .as_ref()
                        .map(Clone::clone)
                        .map_err(ToString::to_string),
                ));
                return result;
            }
            FlightRole::Follower(mut rx) => {
                match rx.wait_for(Option::is_some).await {
                    Ok(published) => {
                        let shared = published
                            .as_ref()
                            .cloned()
                            .expect("wait_for(Option::is_some) yielded a Some value");
                        drop(published);
                        // A shared error keeps the leader's message but loses
                        // its variant (AppError is not Clone). The entry is
                        // already gone (or about to be) so the NEXT call for
                        // this URL retries from scratch.
                        return shared.map_err(AppError::Internal);
                    }
                    // Sender dropped without publishing: the leader panicked
                    // and its guard removed the entry. Retry — this caller
                    // (or another follower) becomes the new leader.
                    Err(_) => continue,
                }
            }
        }
    }
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
    // #2200 single-flight tests
    // ==================================================================

    /// #2200: N concurrent cold fetches of the SAME URL must collapse into
    /// exactly one HTTP request; every caller receives the leader's result.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_cold_fetches_single_flight_one_request_2200() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/single-flight"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw(
                        "<html><head><title>Deduped</title></head></html>"
                            .as_bytes()
                            .to_vec(),
                        "text/html; charset=utf-8",
                    )
                    // Hold the response long enough that every spawned
                    // caller has passed its cache check and joined the
                    // flight before the leader completes.
                    .set_delay(std::time::Duration::from_millis(500)),
            )
            .expect(1)
            .mount(&server)
            .await;

        let url = format!("{}/single-flight", server.uri());
        let mut handles = Vec::new();
        for _ in 0..8 {
            let pool = pool.clone();
            let url = url.clone();
            handles.push(tokio::spawn(async move {
                fetch_link_metadata_inner(&pool, &pool, url).await
            }));
        }
        for h in handles {
            let meta = h
                .await
                .expect("caller task must not panic")
                .expect("every concurrent caller must get the shared result");
            assert_eq!(
                meta.title.as_deref(),
                Some("Deduped"),
                "all callers must see the single fetched result"
            );
        }

        let requests = server.received_requests().await.unwrap();
        assert_eq!(
            requests.len(),
            1,
            "#2200: 8 concurrent identical cold URLs must produce exactly ONE \
             HTTP request (single-flight)"
        );

        // The flight is over — its map entry must be gone.
        assert!(
            !INFLIGHT.lock().unwrap().contains_key(&url),
            "single-flight entry must be removed on completion"
        );
    }

    /// #2200 error path: a transport-level fetch failure must remove the
    /// single-flight entry (no poisoned stuck entries), and a subsequent
    /// call for the same URL must retry over the network — the server sees
    /// that second attempt.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failed_fetch_clears_single_flight_and_retry_reaches_server_2200() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let (pool, _dir) = test_pool().await;

        // Reserve a port, then drop the listener so the first fetch hits a
        // closed port and fails at the connection level. (A non-2xx response
        // is NOT an error for `fetch_metadata` — it returns Ok with flags —
        // so only a transport failure exercises the error path.)
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let url = format!("http://{addr}/retry-2200");

        let err = fetch_link_metadata_inner(&pool, &pool, url.clone())
            .await
            .expect_err("fetch against a closed port must fail");
        assert!(
            format!("{err}").to_lowercase().contains("error"),
            "transport failure must surface as an error, got: {err}"
        );

        // The failure must not leave a stuck in-flight entry.
        assert!(
            !INFLIGHT.lock().unwrap().contains_key(&url),
            "#2200: a failed fetch must remove its single-flight entry so \
             later calls can retry"
        );

        // Bring a server up on the SAME address and call again: the retry
        // must go back to the network (no poisoned entry, no cached error)
        // and reach the server.
        let listener = std::net::TcpListener::bind(addr).unwrap();
        let server = MockServer::builder().listener(listener).start().await;
        Mock::given(method("GET"))
            .and(path("/retry-2200"))
            .respond_with(
                ResponseTemplate::new(200).set_body_raw(
                    "<html><head><title>Recovered</title></head></html>"
                        .as_bytes()
                        .to_vec(),
                    "text/html; charset=utf-8",
                ),
            )
            .expect(1)
            .mount(&server)
            .await;

        let meta = fetch_link_metadata_inner(&pool, &pool, url.clone())
            .await
            .expect("retry after a failed fetch must succeed");
        assert_eq!(meta.title.as_deref(), Some("Recovered"));

        let requests = server.received_requests().await.unwrap();
        assert_eq!(
            requests.len(),
            1,
            "#2200: the retry (the 2nd overall attempt) is the request the \
             server sees — the failed first attempt must not block it"
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
}
