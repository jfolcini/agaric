//! Persisted Loro peer-id epoch (#792).
//!
//! ## Why this exists
//!
//! [`crate::loro::engine::peer_id_from_device_id`] maps the device id
//! to a deterministic Loro `PeerID` — deliberately stable across boots
//! so a device's op history stays credited to one peer. A snapshot
//! RESET (#607, the app-layer `snapshot::apply_snapshot`) breaks
//! the assumption behind that stability: it wipes `loro_doc_state`, so
//! the engines reload EMPTY and restart op counters at 0 under the
//! SAME peer id, forking the `(peer, counter)` space against this
//! device's pre-reset ops still held by peers. Outbound, peers then
//! silently drop every post-reset op (their version vector already
//! covers those ids); inbound, importing the peer's history into the
//! forked doc corrupts loro-internal's causal state (debug-assert
//! panic → SIGABRT in dev builds; silent corruption in release).
//!
//! The fix is a monotone **peer-id epoch** persisted in `app_settings`
//! (a table the RESET does NOT wipe):
//!
//! * Epoch `0` — the implicit value for every existing vault (the row
//!   is absent) — keeps the legacy `peer_id_from_device_id` mapping
//!   byte-for-byte, so upgrading never re-keys a healthy device.
//! * [`bump_peer_epoch`] runs INSIDE the RESET transaction, atomically
//!   with the `loro_doc_state` wipe: post-reset engines derive a fresh
//!   `PeerID` via [`crate::loro::engine::peer_id_for_epoch`], whose
//!   counters can safely restart at 0. A crash between the RESET
//!   commit and the in-memory registry reload is covered — the next
//!   boot reads the already-bumped epoch.
//!
//! The in-memory holder is `LoroEngineRegistry::peer_epoch`
//! (loaded at boot in `crate::run`, refreshed by
//! [`crate::loro::snapshot::reload_registry_from_db`] right after a
//! RESET).

use std::time::Duration;

use sqlx::{Sqlite, SqlitePool, Transaction};

use agaric_core::error::AppError;

/// `app_settings` key holding the current peer-id epoch as a decimal
/// string. Absent row == epoch `0` (the legacy mapping).
pub const PEER_EPOCH_KEY: &str = "loro.peer_id_epoch";

/// Bounded retry budget for a transient `app_settings` read failure
/// (audit #2023). A single `fetch_optional` may blip on e.g. a
/// momentarily busy SQLite file (`SQLITE_BUSY`) under a concurrent
/// writer; a couple of short-backoff retries absorb that without
/// risking the (peer, counter) fork that coercing the failure to epoch
/// `0` would cause (see [`load_peer_epoch`]). Kept tiny on purpose: the
/// goal is to ride out a single hiccup, not to mask a genuinely dead DB
/// — past the budget we fail closed rather than fork.
const READ_ATTEMPTS: u32 = 3;
const READ_BACKOFF: Duration = Duration::from_millis(25);

/// Read the persisted peer-id epoch.
///
/// ## Row-absent vs read-FAILED (audit #2023)
///
/// These two outcomes look identical to a naive caller but mean
/// opposite things for #792, so we MUST tell them apart:
///
/// * `Ok(None)` — the row genuinely does not exist. This is the normal
///   "never reset" state for every legacy / fresh vault, and its
///   correct epoch is `0` (the byte-for-byte legacy
///   `peer_id_from_device_id` mapping). We return `Ok(0)`.
/// * `Err(_)` — the SELECT itself failed (a transient `SQLITE_BUSY`, a
///   locked/contended file, an I/O error). The value is UNKNOWN. The
///   pre-#2023 code coerced this to `0` with a warn, which is the bug:
///   on a vault that went through a snapshot RESET the true epoch is
///   `>= 1`, so coercing to `0` re-derives this device's RETIRED
///   pre-reset PeerID and every lazily-created engine mints ops under
///   it — re-forking the exact `(peer, counter)` space #792's epoch
///   mechanism exists to prevent. We therefore do NOT coerce a read
///   failure to `0`.
///
/// To stay robust against a single transient blip (we must not brick
/// boot on one hiccup) we retry the read a small, bounded number of
/// times with a short backoff. Only if every attempt fails do we
/// propagate the error so the caller fails CLOSED (refuses to mint ops
/// under an unknown epoch) instead of silently forking.
///
/// An unparseable stored value is left as a fail-soft `Ok(0)` + warn:
/// it is a deterministic (non-transient) condition a retry cannot fix,
/// and it preserves the long-standing upgrade-compat contract. It is
/// out of scope for the transient-read-error audit (#2023).
pub async fn load_peer_epoch(pool: &SqlitePool) -> Result<u64, AppError> {
    load_peer_epoch_with(READ_ATTEMPTS, READ_BACKOFF, || {
        sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
            .bind(PEER_EPOCH_KEY)
            .fetch_optional(pool)
    })
    .await
}

/// Core of [`load_peer_epoch`], factored out so the retry / fail-closed
/// classification is unit-testable without a live DB (audit #2023): the
/// fetcher is an injectable `async` closure, so a test can simulate a
/// row-absent read (`Ok(None)`), a stored value (`Ok(Some)`), and a
/// hard read failure (`Err`).
async fn load_peer_epoch_with<F, Fut>(
    attempts: u32,
    backoff: Duration,
    mut fetch: F,
) -> Result<u64, AppError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Option<String>, sqlx::Error>>,
{
    let attempts = attempts.max(1);
    let mut last_err: Option<sqlx::Error> = None;
    for attempt in 1..=attempts {
        match fetch().await {
            // Row genuinely absent — the legitimate never-reset state.
            Ok(None) => return Ok(0),
            Ok(Some(s)) => {
                return match s.parse::<u64>() {
                    Ok(epoch) => Ok(epoch),
                    Err(e) => {
                        tracing::warn!(
                            value = %s,
                            error = %e,
                            "loro: peer_epoch row is not a u64; degrading to \
                             epoch 0 (#792)"
                        );
                        Ok(0)
                    }
                };
            }
            // Read FAILED — value unknown. Retry a bounded number of
            // times to ride out a transient blip; never coerce to 0.
            Err(e) => {
                tracing::warn!(
                    attempt,
                    attempts,
                    error = %e,
                    "loro: failed to read peer_epoch; retrying before \
                     failing closed (#2023)"
                );
                last_err = Some(e);
                if attempt < attempts {
                    tokio::time::sleep(backoff).await;
                }
            }
        }
    }
    // Every attempt failed: the epoch is unknown. Fail CLOSED rather
    // than coerce to 0 and risk re-forking a post-reset vault (#2023).
    let err = last_err.expect("loop ran at least once with no Ok return");
    tracing::error!(
        attempts,
        error = %err,
        "loro: peer_epoch read failed after retries; refusing to default to \
         epoch 0 (would risk re-forking the (peer, counter) space on a reset \
         vault) — propagating error (#2023)"
    );
    Err(AppError::from(err))
}

/// Increment the persisted peer-id epoch inside the caller's
/// transaction and return the new value.
///
/// Called from `apply_snapshot` (the RESET path) in the SAME
/// transaction that wipes `loro_doc_state`, so "CRDT history gone" and
/// "peer id retired" commit atomically — there is no crash window in
/// which a wiped vault could boot back onto the old peer id and fork
/// the `(peer, counter)` space (#792).
pub async fn bump_peer_epoch(tx: &mut Transaction<'_, Sqlite>) -> Result<u64, AppError> {
    let now = agaric_store::db::now_ms();
    let new_value: String = sqlx::query_scalar(
        "INSERT INTO app_settings (key, value, updated_at) \
         VALUES (?, '1', ?) \
         ON CONFLICT(key) DO UPDATE SET \
             value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), \
             updated_at = ? \
         RETURNING value",
    )
    .bind(PEER_EPOCH_KEY)
    .bind(now)
    .bind(now)
    .fetch_one(&mut **tx)
    .await?;
    new_value.parse::<u64>().map_err(|e| {
        AppError::validation(format!(
            "loro: peer_epoch bump produced non-u64 value {new_value:?}: {e}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        agaric_store::test_support::test_pool().await
    }

    /// A vault that never went through a RESET has no epoch row —
    /// `load_peer_epoch` must report the legacy epoch 0. Existing-vault
    /// upgrade-compatibility pin for #792.
    #[tokio::test]
    async fn load_peer_epoch_defaults_to_zero_when_row_absent_792() {
        let (pool, _dir) = test_pool().await;
        assert_eq!(load_peer_epoch(&pool).await.expect("load"), 0);
    }

    /// Each bump increments by exactly 1 and the bumped value is what a
    /// subsequent load observes — the boot path's source of truth.
    #[tokio::test]
    async fn bump_peer_epoch_increments_and_persists_792() {
        let (pool, _dir) = test_pool().await;

        let mut tx = pool.begin().await.expect("begin");
        let first = bump_peer_epoch(&mut tx).await.expect("bump 1");
        tx.commit().await.expect("commit");
        assert_eq!(first, 1, "first bump seeds the row at 1");
        assert_eq!(load_peer_epoch(&pool).await.expect("load"), 1);

        let mut tx = pool.begin().await.expect("begin");
        let second = bump_peer_epoch(&mut tx).await.expect("bump 2");
        tx.commit().await.expect("commit");
        assert_eq!(second, 2, "second bump increments the existing row");
        assert_eq!(load_peer_epoch(&pool).await.expect("load"), 2);
    }

    /// A rolled-back bump must leave the persisted epoch untouched —
    /// this is what makes bumping inside the RESET tx atomic with the
    /// `loro_doc_state` wipe (a failed `apply_snapshot` rolls both
    /// back; the engines reload onto the OLD epoch, matching the
    /// restored pre-reset `loro_doc_state` rows).
    #[tokio::test]
    async fn bump_peer_epoch_rolls_back_with_the_tx_792() {
        let (pool, _dir) = test_pool().await;

        let mut tx = pool.begin().await.expect("begin");
        let bumped = bump_peer_epoch(&mut tx).await.expect("bump");
        assert_eq!(bumped, 1);
        tx.rollback().await.expect("rollback");

        assert_eq!(
            load_peer_epoch(&pool).await.expect("load"),
            0,
            "a rolled-back RESET must not retire the peer id"
        );
    }

    /// An unparseable epoch value degrades to 0 with a warn rather than
    /// failing boot (fail-soft contract).
    #[tokio::test]
    async fn load_peer_epoch_degrades_to_zero_on_garbage_792() {
        let (pool, _dir) = test_pool().await;
        sqlx::query("INSERT INTO app_settings (key, value, updated_at) VALUES (?, 'nonsense', 0)")
            .bind(PEER_EPOCH_KEY)
            .execute(&pool)
            .await
            .expect("seed garbage");
        assert_eq!(load_peer_epoch(&pool).await.expect("load"), 0);
    }

    // ---- audit #2023: row-absent vs read-FAILED -------------------------
    //
    // These pin the core fix: a read FAILURE must never be coerced to
    // epoch 0 (which would re-fork the (peer, counter) space on a
    // post-reset vault). We exercise the retry / fail-closed
    // classification directly through `load_peer_epoch_with` so we can
    // inject `Err` without a real DB outage.

    use std::sync::atomic::{AtomicU32, Ordering};

    const NO_BACKOFF: Duration = Duration::from_millis(0);

    /// Row genuinely absent (`Ok(None)`) is the legitimate never-reset
    /// state → epoch 0, with NO retry (it's not an error).
    #[tokio::test]
    async fn load_with_row_absent_yields_zero_without_retry_2023() {
        let calls = AtomicU32::new(0);
        let got = load_peer_epoch_with(3, NO_BACKOFF, || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(None) }
        })
        .await
        .expect("absent row must succeed as epoch 0");
        assert_eq!(got, 0, "absent row is the legacy epoch 0");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "row-absent is not an error and must not be retried"
        );
    }

    /// A persistent read FAILURE must NOT silently yield 0 — it must
    /// retry the full budget and then propagate an error so the caller
    /// fails closed instead of forking (the heart of audit #2023).
    #[tokio::test]
    async fn load_with_persistent_read_failure_retries_then_errors_2023() {
        let calls = AtomicU32::new(0);
        let result = load_peer_epoch_with(3, NO_BACKOFF, || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err(sqlx::Error::PoolClosed) }
        })
        .await;
        assert!(
            result.is_err(),
            "a read failure must propagate an error, NOT default to epoch 0 \
             (#2023: defaulting would re-fork a reset vault)"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "a hard read failure must exhaust the bounded retry budget"
        );
    }

    /// A transient blip that clears on a later attempt must NOT brick
    /// the load: the retry rides it out and returns the real epoch.
    #[tokio::test]
    async fn load_with_transient_failure_then_success_recovers_2023() {
        let calls = AtomicU32::new(0);
        let got = load_peer_epoch_with(3, NO_BACKOFF, || {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            async move {
                if n == 0 {
                    Err(sqlx::Error::PoolTimedOut) // first attempt blips
                } else {
                    Ok(Some("7".to_string())) // recovers on retry
                }
            }
        })
        .await
        .expect("a transient blip must not brick the load");
        assert_eq!(got, 7, "the recovered read must report the real epoch");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "should stop retrying as soon as a read succeeds"
        );
    }

    /// Unparseable stored value stays a fail-soft 0 (deterministic, not
    /// a transient read error) and must not be retried.
    #[tokio::test]
    async fn load_with_unparseable_value_is_fail_soft_zero_2023() {
        let calls = AtomicU32::new(0);
        let got = load_peer_epoch_with(3, NO_BACKOFF, || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(Some("nonsense".to_string())) }
        })
        .await
        .expect("garbage value is fail-soft, not an error");
        assert_eq!(got, 0, "unparseable value degrades to 0");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "a parse failure is deterministic and must not be retried"
        );
    }
}
