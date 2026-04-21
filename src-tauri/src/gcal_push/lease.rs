//! FEAT-5e — Push-lease primitives.
//!
//! Multi-device Agaric installations must **not** race on the Google
//! Calendar push surface.  If two devices both try to `calendars.insert`
//! the dedicated "Agaric Agenda" calendar on first connect, the user ends
//! up with two calendars on the same account; if two devices both push
//! the daily digest for the same date, the remote event flips back and
//! forth every few seconds.
//!
//! The push-lease is a single-row CAS-guarded claim on two
//! `gcal_settings` rows:
//!
//! * `push_lease_device_id` — the device currently authoritative.  Empty
//!   string when unheld.
//! * `push_lease_expires_at` — RFC 3339 UTC deadline at which a
//!   stale-but-not-released lease may be seized by another device.
//!
//! A lease must be **renewed** every [`LEASE_RENEW_INTERVAL_SECS`] and
//! expires [`LEASE_EXPIRY_SECS`] after its last renewal — the 3-to-1
//! margin tolerates a missed tick (e.g., a slow sqlite flush) without
//! handing the lease to another device.
//!
//! # Clock injection
//!
//! All operations accept an explicit `now: DateTime<Utc>` parameter so
//! tests can advance the clock without `tokio::time::pause` (which is
//! brittle under multi-threaded runtimes and cannot drive expiry-based
//! SQL comparisons).  Production callers pass `Utc::now()`.

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use sqlx::SqlitePool;

use crate::error::AppError;

use super::models::{self, GcalSettingKey};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// How often the active device should call [`claim_lease`] to refresh
/// the lease.  Aligned with FEAT-5 parent § "Multi-device push-lease".
pub const LEASE_RENEW_INTERVAL_SECS: u64 = 60;

/// How long after the last renewal a lease is considered stale and may
/// be seized by another device.  Must be >> [`LEASE_RENEW_INTERVAL_SECS`]
/// so a single missed renewal does not force a hand-off.
pub const LEASE_EXPIRY_SECS: u64 = 180;

// ---------------------------------------------------------------------------
// LeaseState — current holder snapshot
// ---------------------------------------------------------------------------

/// Snapshot of the two lease rows in `gcal_settings`.  Returned by
/// [`read_current_lease`] and used by FEAT-5e's `get_gcal_status`
/// command to report the holder to the Settings UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseState {
    /// The currently-authoritative device ID, or empty string when the
    /// lease is unheld.
    pub device_id: String,
    /// RFC 3339 UTC expiry deadline.  `None` when the lease is unheld
    /// or the row value fails to parse (treated as unheld by the CAS
    /// path so a corrupt row does not permanently deny claim).
    pub expires_at: Option<DateTime<Utc>>,
}

impl LeaseState {
    /// Return `true` iff `device_id` matches the holder and the lease
    /// has not expired at `now`.
    #[must_use]
    pub fn is_held_by(&self, device_id: &str, now: DateTime<Utc>) -> bool {
        !self.device_id.is_empty()
            && self.device_id == device_id
            && self.expires_at.is_some_and(|exp| exp > now)
    }

    /// Return `true` iff the lease is held by *some* non-empty device and
    /// has not yet expired at `now`.
    #[must_use]
    pub fn is_live(&self, now: DateTime<Utc>) -> bool {
        !self.device_id.is_empty() && self.expires_at.is_some_and(|exp| exp > now)
    }
}

// ---------------------------------------------------------------------------
// read_current_lease
// ---------------------------------------------------------------------------

/// Fetch the current lease snapshot.  Used by `get_gcal_status` and by
/// diagnostics.
///
/// A missing `push_lease_device_id` row is treated as `device_id = ""`
/// (unheld) rather than returning an error — the migration seeds every
/// known key, so a missing row is a DB corruption signal, not a normal
/// path.
///
/// # Errors
/// [`AppError::Database`] on SQL errors.
pub async fn read_current_lease(pool: &SqlitePool) -> Result<LeaseState, AppError> {
    let device_id = models::get_setting(pool, GcalSettingKey::PushLeaseDeviceId)
        .await?
        .unwrap_or_default();
    let expires_raw = models::get_setting(pool, GcalSettingKey::PushLeaseExpiresAt)
        .await?
        .unwrap_or_default();
    let expires_at = parse_rfc3339(&expires_raw);
    Ok(LeaseState {
        device_id,
        expires_at,
    })
}

// ---------------------------------------------------------------------------
// claim_lease (CAS) + renewal
// ---------------------------------------------------------------------------

/// Attempt to claim (or renew) the push lease for `device_id` at `now`.
///
/// Returns `Ok(true)` when this device now holds the lease (fresh claim
/// or renewal), `Ok(false)` when another device's live lease blocks us.
///
/// # Semantics
///
/// The CAS succeeds when **any** of the following holds in the DB:
///
/// * `push_lease_device_id` is empty → nobody currently holds.
/// * `push_lease_device_id` equals `device_id` → we are renewing.
/// * `push_lease_expires_at` is before `now` → a previous holder let
///   their lease lapse without explicitly releasing; we seize.
///
/// On success, both `push_lease_device_id` and `push_lease_expires_at`
/// are written in a single BEGIN IMMEDIATE transaction to rule out two
/// devices seeing a stale lease in parallel and both succeeding.
///
/// # Errors
/// [`AppError::Database`] on SQL errors.  [`AppError::NotFound`] if the
/// seeded `gcal_settings` rows were manually deleted (would indicate DB
/// corruption).
pub async fn claim_lease(
    pool: &SqlitePool,
    device_id: &str,
    now: DateTime<Utc>,
) -> Result<bool, AppError> {
    // Start a BEGIN IMMEDIATE tx so we serialize against any concurrent
    // claim_lease / release_lease call on the same DB — SQLite's
    // `BEGIN IMMEDIATE` escalates to the reserved lock, guaranteeing
    // only one writer observes the pre-image.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Read the current holder.  We intentionally ignore errors parsing
    // the `expires_at` cell — a corrupt cell is treated as "stale",
    // which the next overwrite will fix.
    let holder_key = GcalSettingKey::PushLeaseDeviceId.as_str();
    let expires_key = GcalSettingKey::PushLeaseExpiresAt.as_str();

    let holder_row = sqlx::query!(
        "SELECT value FROM gcal_settings WHERE key = ?",
        holder_key,
    )
    .fetch_optional(&mut *tx)
    .await?;
    let current_holder = holder_row.map(|r| r.value).unwrap_or_default();

    let expires_row = sqlx::query!(
        "SELECT value FROM gcal_settings WHERE key = ?",
        expires_key,
    )
    .fetch_optional(&mut *tx)
    .await?;
    let current_expires = expires_row
        .map(|r| r.value)
        .and_then(|v| parse_rfc3339(&v));

    let is_empty = current_holder.is_empty();
    let is_self = current_holder == device_id;
    let is_stale = current_expires.is_none_or(|exp| exp <= now);

    if !(is_empty || is_self || is_stale) {
        // Another live holder.
        tx.rollback().await?;
        return Ok(false);
    }

    // CAS succeeds — write both rows atomically.  We write the
    // `expires_at` first, then `device_id`, so any observer that sees
    // our device_id reads a fresh (not a stale) expiry.  SQLite
    // serialises the writes within the tx.
    let new_expiry =
        (now + ChronoDuration::seconds(LEASE_EXPIRY_SECS as i64)).to_rfc3339_opts(
            chrono::SecondsFormat::Millis,
            true,
        );

    let updated_at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let exp_res = sqlx::query!(
        "UPDATE gcal_settings SET value = ?, updated_at = ? WHERE key = ?",
        new_expiry,
        updated_at,
        expires_key,
    )
    .execute(&mut *tx)
    .await?;
    if exp_res.rows_affected() == 0 {
        tx.rollback().await?;
        return Err(AppError::NotFound(format!(
            "gcal_settings row missing for key '{expires_key}'"
        )));
    }

    let dev_res = sqlx::query!(
        "UPDATE gcal_settings SET value = ?, updated_at = ? WHERE key = ?",
        device_id,
        updated_at,
        holder_key,
    )
    .execute(&mut *tx)
    .await?;
    if dev_res.rows_affected() == 0 {
        tx.rollback().await?;
        return Err(AppError::NotFound(format!(
            "gcal_settings row missing for key '{holder_key}'"
        )));
    }

    tx.commit().await?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// release_lease
// ---------------------------------------------------------------------------

/// Release the lease iff `device_id` is currently the holder.
///
/// A release by a non-holder is a no-op (returns `Ok(())`).  Intended
/// for the graceful-shutdown path — a crash recovery relies on the
/// stale-expiry seizure path in [`claim_lease`] instead.
///
/// # Errors
/// [`AppError::Database`] on SQL errors.
pub async fn release_lease(pool: &SqlitePool, device_id: &str) -> Result<(), AppError> {
    let holder_key = GcalSettingKey::PushLeaseDeviceId.as_str();
    let expires_key = GcalSettingKey::PushLeaseExpiresAt.as_str();

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Only clear if we hold it.  Using the WHERE clause on the UPDATE
    // makes this a single-round-trip CAS.
    let updated_at = crate::now_rfc3339();
    let cleared = sqlx::query!(
        "UPDATE gcal_settings SET value = '', updated_at = ? \
         WHERE key = ? AND value = ?",
        updated_at,
        holder_key,
        device_id,
    )
    .execute(&mut *tx)
    .await?;

    if cleared.rows_affected() > 0 {
        // Also wipe the expiry cell so a subsequent claim_lease sees a
        // clean pair rather than a stale deadline on an empty holder.
        sqlx::query!(
            "UPDATE gcal_settings SET value = '', updated_at = ? WHERE key = ?",
            updated_at,
            expires_key,
        )
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Parse an RFC 3339 UTC timestamp.  Returns `None` on any parse
/// failure — callers treat that as "lease unheld / stale", which is
/// safe because the next `claim_lease` will overwrite the cell.
fn parse_rfc3339(s: &str) -> Option<DateTime<Utc>> {
    if s.is_empty() {
        return None;
    }
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use chrono::{Duration as ChronoDuration, TimeZone};
    use std::path::PathBuf;
    use tempfile::TempDir;

    const DEV_A: &str = "device-AAAAAAAAAAAAAAAAAAAAAAAAAA";
    const DEV_B: &str = "device-BBBBBBBBBBBBBBBBBBBBBBBBBB";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    fn t0() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 4, 22, 10, 0, 0).unwrap()
    }

    // ── claim_lease happy path ─────────────────────────────────────

    #[tokio::test]
    async fn claim_on_fresh_db_succeeds_for_device_a() {
        let (pool, _dir) = test_pool().await;
        let got = claim_lease(&pool, DEV_A, t0()).await.unwrap();
        assert!(got, "fresh claim must succeed");

        let state = read_current_lease(&pool).await.unwrap();
        assert_eq!(state.device_id, DEV_A);
        assert!(
            state.expires_at.is_some(),
            "expires_at must be populated after claim"
        );
    }

    #[tokio::test]
    async fn immediate_reclaim_by_other_device_is_denied() {
        let (pool, _dir) = test_pool().await;
        assert!(claim_lease(&pool, DEV_A, t0()).await.unwrap());
        let got = claim_lease(&pool, DEV_B, t0() + ChronoDuration::seconds(1))
            .await
            .unwrap();
        assert!(!got, "second device must be blocked while lease is live");

        let state = read_current_lease(&pool).await.unwrap();
        assert_eq!(state.device_id, DEV_A, "A must remain the holder");
    }

    #[tokio::test]
    async fn after_expiry_elapses_other_device_can_claim() {
        let (pool, _dir) = test_pool().await;
        assert!(claim_lease(&pool, DEV_A, t0()).await.unwrap());

        // Jump past the expiry deadline.
        let later = t0() + ChronoDuration::seconds(LEASE_EXPIRY_SECS as i64 + 1);
        let got = claim_lease(&pool, DEV_B, later).await.unwrap();
        assert!(got, "B must seize after A's lease expired");

        let state = read_current_lease(&pool).await.unwrap();
        assert_eq!(state.device_id, DEV_B, "holder swaps to B after seizure");
    }

    #[tokio::test]
    async fn reclaim_by_same_device_refreshes_updated_at() {
        let (pool, _dir) = test_pool().await;
        assert!(claim_lease(&pool, DEV_A, t0()).await.unwrap());

        // Read the first updated_at.
        let first_state = read_current_lease(&pool).await.unwrap();
        let first_expires = first_state.expires_at.expect("set");

        // Renewal one minute later — still within the previous expiry.
        let later = t0() + ChronoDuration::seconds(60);
        let got = claim_lease(&pool, DEV_A, later).await.unwrap();
        assert!(got, "same-device renewal must succeed");

        let second_state = read_current_lease(&pool).await.unwrap();
        let second_expires = second_state.expires_at.expect("set");
        assert!(
            second_expires > first_expires,
            "expires_at must advance on renewal: first={first_expires:?} second={second_expires:?}"
        );
    }

    // ── release_lease ──────────────────────────────────────────────

    #[tokio::test]
    async fn release_by_holder_clears_lease() {
        let (pool, _dir) = test_pool().await;
        assert!(claim_lease(&pool, DEV_A, t0()).await.unwrap());
        release_lease(&pool, DEV_A).await.unwrap();

        let state = read_current_lease(&pool).await.unwrap();
        assert_eq!(
            state.device_id, "",
            "release by holder must clear the device_id"
        );
        assert!(
            state.expires_at.is_none(),
            "release by holder must clear the expires_at"
        );
    }

    #[tokio::test]
    async fn release_by_non_holder_is_noop() {
        let (pool, _dir) = test_pool().await;
        assert!(claim_lease(&pool, DEV_A, t0()).await.unwrap());

        // B tries to release — must be ignored.
        release_lease(&pool, DEV_B).await.unwrap();

        let state = read_current_lease(&pool).await.unwrap();
        assert_eq!(
            state.device_id, DEV_A,
            "release by non-holder must leave A's lease intact"
        );
        assert!(
            state.expires_at.is_some(),
            "non-holder release must not clear expires_at"
        );
    }

    // ── LeaseState helpers ─────────────────────────────────────────

    #[tokio::test]
    async fn is_held_by_returns_true_only_for_active_holder() {
        let (pool, _dir) = test_pool().await;
        assert!(claim_lease(&pool, DEV_A, t0()).await.unwrap());

        let state = read_current_lease(&pool).await.unwrap();
        assert!(state.is_held_by(DEV_A, t0()));
        assert!(!state.is_held_by(DEV_B, t0()));
        assert!(
            !state.is_held_by(DEV_A, t0() + ChronoDuration::seconds(LEASE_EXPIRY_SECS as i64 + 1)),
            "expired lease must not be held_by the original holder"
        );
    }

    #[tokio::test]
    async fn is_live_flips_after_expiry() {
        let (pool, _dir) = test_pool().await;
        assert!(claim_lease(&pool, DEV_A, t0()).await.unwrap());

        let state = read_current_lease(&pool).await.unwrap();
        assert!(state.is_live(t0()), "lease must be live immediately");
        assert!(
            !state.is_live(t0() + ChronoDuration::seconds(LEASE_EXPIRY_SECS as i64 + 1)),
            "lease must not be live past expiry"
        );
    }

    #[test]
    fn parse_rfc3339_handles_empty_and_malformed() {
        assert_eq!(parse_rfc3339(""), None);
        assert_eq!(parse_rfc3339("not a timestamp"), None);
        let valid = parse_rfc3339("2026-04-22T10:00:00Z");
        assert!(valid.is_some());
    }
}
