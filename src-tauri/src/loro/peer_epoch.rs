//! Persisted Loro peer-id epoch (#792).
//!
//! ## Why this exists
//!
//! [`crate::loro::engine::peer_id_from_device_id`] maps the device id
//! to a deterministic Loro `PeerID` — deliberately stable across boots
//! so a device's op history stays credited to one peer. A snapshot
//! RESET (#607, [`crate::snapshot::apply_snapshot`]) breaks
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

use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::error::AppError;

/// `app_settings` key holding the current peer-id epoch as a decimal
/// string. Absent row == epoch `0` (the legacy mapping).
pub const PEER_EPOCH_KEY: &str = "loro.peer_id_epoch";

/// Read the persisted peer-id epoch. Fail-soft: a missing row is the
/// normal "never reset" state (`0`); a read error or an unparseable
/// value degrades to `0` with a loud warn rather than failing boot —
/// epoch `0` reproduces the pre-#792 behaviour, never anything worse.
pub async fn load_peer_epoch(pool: &SqlitePool) -> u64 {
    let row: Result<Option<String>, sqlx::Error> =
        sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
            .bind(PEER_EPOCH_KEY)
            .fetch_optional(pool)
            .await;
    match row {
        Ok(None) => 0,
        Ok(Some(s)) => match s.parse::<u64>() {
            Ok(epoch) => epoch,
            Err(e) => {
                tracing::warn!(
                    value = %s,
                    error = %e,
                    "loro: peer_epoch row is not a u64; degrading to epoch 0 (#792)"
                );
                0
            }
        },
        Err(e) => {
            tracing::warn!(
                error = %e,
                "loro: failed to read peer_epoch; degrading to epoch 0 (#792)"
            );
            0
        }
    }
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
    let now = crate::db::now_ms();
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
        AppError::Validation(format!(
            "loro: peer_epoch bump produced non-u64 value {new_value:?}: {e}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .expect("init_pool");
        (pool, dir)
    }

    /// A vault that never went through a RESET has no epoch row —
    /// `load_peer_epoch` must report the legacy epoch 0. Existing-vault
    /// upgrade-compatibility pin for #792.
    #[tokio::test]
    async fn load_peer_epoch_defaults_to_zero_when_row_absent_792() {
        let (pool, _dir) = test_pool().await;
        assert_eq!(load_peer_epoch(&pool).await, 0);
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
        assert_eq!(load_peer_epoch(&pool).await, 1);

        let mut tx = pool.begin().await.expect("begin");
        let second = bump_peer_epoch(&mut tx).await.expect("bump 2");
        tx.commit().await.expect("commit");
        assert_eq!(second, 2, "second bump increments the existing row");
        assert_eq!(load_peer_epoch(&pool).await, 2);
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
            load_peer_epoch(&pool).await,
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
        assert_eq!(load_peer_epoch(&pool).await, 0);
    }
}
