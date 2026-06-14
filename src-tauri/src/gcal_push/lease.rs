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

    // L-132: read both lease cells in a single round-trip.  The
    // 2-row read is identical in cost to the previous 2 single-row
    // reads but halves the SQL chatter (and the SQLite VFS hit count
    // matters under fsync-heavy workloads).
    //
    // We intentionally ignore errors parsing the `expires_at` cell —
    // a corrupt cell is treated as "stale", which the next overwrite
    // will fix.
    let holder_key = GcalSettingKey::PushLeaseDeviceId.as_str();
    let expires_key = GcalSettingKey::PushLeaseExpiresAt.as_str();

    let rows = sqlx::query!(
        "SELECT key, value FROM gcal_settings WHERE key IN (?, ?)",
        holder_key,
        expires_key,
    )
    .fetch_all(&mut *tx)
    .await?;

    let mut current_holder = String::new();
    let mut current_expires_raw = String::new();
    for row in rows {
        match row.key.as_str() {
            k if k == holder_key => current_holder = row.value,
            k if k == expires_key => current_expires_raw = row.value,
            _ => {} // unreachable given the WHERE clause but harmless
        }
    }
    let current_expires = parse_rfc3339(&current_expires_raw);

    let is_empty = current_holder.is_empty();
    let is_self = current_holder == device_id;
    let is_stale = current_expires.is_none_or(|exp| exp <= now);

    if !(is_empty || is_self || is_stale) {
        // Another live holder.
        tx.rollback().await?;
        return Ok(false);
    }

    // L-132: CAS succeeds — write both rows in a single round-trip
    // using `CASE … WHEN … THEN …` to dispatch on the key column.
    // SQLite serialises the column updates within the row, and the
    // surrounding BEGIN IMMEDIATE serialises the whole tx, so any
    // observer reads either both pre-images or both post-images —
    // never a mix.  Round-trip count drops from 2 SELECTs + 2
    // UPDATEs (4 round-trips inside the tx) to 1 SELECT + 1 UPDATE
    // (2 round-trips inside the tx).
    let new_expiry = (now + ChronoDuration::seconds(LEASE_EXPIRY_SECS.cast_signed()))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let updated_at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let res = sqlx::query!(
        "UPDATE gcal_settings \
         SET value = CASE key WHEN ? THEN ? WHEN ? THEN ? ELSE value END, \
             updated_at = ? \
         WHERE key IN (?, ?)",
        holder_key,
        device_id,
        expires_key,
        new_expiry,
        updated_at,
        holder_key,
        expires_key,
    )
    .execute(&mut *tx)
    .await?;

    // Both seeded rows must exist — the migration creates them and we
    // never delete them.  Less than 2 rows updated is a DB corruption
    // signal.
    if res.rows_affected() != 2 {
        tx.rollback().await?;
        return Err(AppError::NotFound(format!(
            "gcal_settings: expected 2 lease rows, updated {} (keys: '{holder_key}', '{expires_key}')",
            res.rows_affected()
        )));
    }

    tx.commit().await?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// renew_lease (extend-only, never claims)
// ---------------------------------------------------------------------------

/// Extend the expiry of a lease **only if `device_id` is the current,
/// non-expired holder** — the high-frequency keep-alive driven by the
/// task loop every [`LEASE_RENEW_INTERVAL_SECS`].
///
/// Returns `Ok(true)` when this device held the lease and its expiry was
/// pushed forward; `Ok(false)` when this device is *not* the live holder
/// (unheld, held by someone else, or our own lease already lapsed) — in
/// which case **nothing is written**.
///
/// # Why this is not `claim_lease`
///
/// [`claim_lease`] is a *seizure* primitive: it succeeds on an empty or
/// stale holder and takes the lease.  Renewal must never do that — the
/// keep-alive runs far more often than the reconcile cycle, and seizing
/// a lapsed-but-recently-ours (or empty) lease from the renew arm would
/// (a) double the claim paths racing the reconcile cycle and (b) let a
/// device that has *missed* a renewal grab the lease back out from under
/// a sibling that legitimately seized it. Renewal therefore only ever
/// *extends* a hold we already, verifiably, possess.
///
/// The CAS guard is the SQL `WHERE` clause: the holder cell must still
/// equal `device_id` (so a sibling that seized in between is respected)
/// **and** the expiry cell must still be in the future at `now` (so a
/// lease we already let lapse is left for the reconcile-cycle's
/// [`claim_lease`] to re-seize, rather than silently resurrected). The
/// whole thing runs inside a `BEGIN IMMEDIATE` tx, identical to
/// [`claim_lease`], so it serialises against any concurrent claim /
/// release / renew on the same DB.
///
/// # Errors
/// [`AppError::Database`] on SQL errors.
pub async fn renew_lease(
    pool: &SqlitePool,
    device_id: &str,
    now: DateTime<Utc>,
) -> Result<bool, AppError> {
    let holder_key = GcalSettingKey::PushLeaseDeviceId.as_str();
    let expires_key = GcalSettingKey::PushLeaseExpiresAt.as_str();

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Read the current holder + expiry under the reserved lock so the
    // "are we still the live holder?" decision and the write that
    // depends on it cannot straddle a concurrent claim/release.
    let rows = sqlx::query!(
        "SELECT key, value FROM gcal_settings WHERE key IN (?, ?)",
        holder_key,
        expires_key,
    )
    .fetch_all(&mut *tx)
    .await?;

    let mut current_holder = String::new();
    let mut current_expires_raw = String::new();
    for row in rows {
        match row.key.as_str() {
            k if k == holder_key => current_holder = row.value,
            k if k == expires_key => current_expires_raw = row.value,
            _ => {}
        }
    }
    let current_expires = parse_rfc3339(&current_expires_raw);

    // Renewal is a strict no-op unless this device is the live holder:
    // the holder cell must be us AND the lease must not have lapsed.
    let held_by_us = current_holder == device_id
        && !device_id.is_empty()
        && current_expires.is_some_and(|exp| exp > now);

    if !held_by_us {
        tx.rollback().await?;
        return Ok(false);
    }

    // Push the expiry forward.  We deliberately reuse the *exact* batched
    // `CASE … WHEN …` UPDATE string from `claim_lease` — rewriting the
    // holder cell to the same `device_id` it already holds is idempotent,
    // and sharing the query string keeps the compile-checked `query!`
    // offline cache (`.sqlx`) entry shared with `claim_lease` rather than
    // introducing a brand-new SQL shape. Both seeded rows are stamped
    // with the same `updated_at`, exactly as on a renewal-via-claim.
    let new_expiry = (now + ChronoDuration::seconds(LEASE_EXPIRY_SECS.cast_signed()))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let updated_at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let res = sqlx::query!(
        "UPDATE gcal_settings \
         SET value = CASE key WHEN ? THEN ? WHEN ? THEN ? ELSE value END, \
             updated_at = ? \
         WHERE key IN (?, ?)",
        holder_key,
        device_id,
        expires_key,
        new_expiry,
        updated_at,
        holder_key,
        expires_key,
    )
    .execute(&mut *tx)
    .await?;

    // The holder-cell guard above already proved we own the live lease;
    // both seeded rows always exist (migration seeds them, we never
    // delete them), so the batched UPDATE touches both. Fewer than 2 is
    // a DB-corruption signal — surface it as a no-op renewal rather than
    // a hard error so the keep-alive arm never tears down the loop.
    if res.rows_affected() != 2 {
        tx.rollback().await?;
        return Ok(false);
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
        let later = t0() + ChronoDuration::seconds(LEASE_EXPIRY_SECS.cast_signed() + 1);
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

    // ── renew_lease (#691 keep-alive, extend-only) ─────────────────

    #[tokio::test]
    async fn renew_by_holder_extends_expiry() {
        let (pool, _dir) = test_pool().await;
        assert!(claim_lease(&pool, DEV_A, t0()).await.unwrap());

        let first = read_current_lease(&pool).await.unwrap();
        let first_expires = first.expires_at.expect("set");

        // One renewal interval later — still well within the live lease.
        let later = t0() + ChronoDuration::seconds(LEASE_RENEW_INTERVAL_SECS.cast_signed());
        let renewed = renew_lease(&pool, DEV_A, later).await.unwrap();
        assert!(renewed, "the live holder's renewal must succeed");

        let second = read_current_lease(&pool).await.unwrap();
        let second_expires = second.expires_at.expect("set");
        assert_eq!(second.device_id, DEV_A, "holder unchanged by renewal");
        assert!(
            second_expires > first_expires,
            "renewal must push the expiry forward: first={first_expires:?} second={second_expires:?}"
        );
        // The new expiry is exactly LEASE_EXPIRY_SECS past `later`.
        assert_eq!(
            second_expires,
            later + ChronoDuration::seconds(LEASE_EXPIRY_SECS.cast_signed()),
            "expiry must be LEASE_EXPIRY_SECS past the renewal instant"
        );
    }

    #[tokio::test]
    async fn renew_by_non_holder_is_noop_and_does_not_claim() {
        let (pool, _dir) = test_pool().await;
        // A holds the lease.
        assert!(claim_lease(&pool, DEV_A, t0()).await.unwrap());
        let before = read_current_lease(&pool).await.unwrap();

        // B (not the holder) attempts a renewal — must NOT claim and
        // must NOT touch any cell.
        let renewed = renew_lease(&pool, DEV_B, t0() + ChronoDuration::seconds(1))
            .await
            .unwrap();
        assert!(!renewed, "a non-holder renewal must report false");

        let after = read_current_lease(&pool).await.unwrap();
        assert_eq!(after.device_id, DEV_A, "non-holder renewal must not claim");
        assert_eq!(
            after.expires_at, before.expires_at,
            "non-holder renewal must not extend (or touch) the expiry"
        );
    }

    #[tokio::test]
    async fn renew_on_unheld_lease_is_noop_and_does_not_claim() {
        let (pool, _dir) = test_pool().await;
        // Fresh DB — lease is unheld.  A renewal must never seize it.
        let renewed = renew_lease(&pool, DEV_A, t0()).await.unwrap();
        assert!(!renewed, "renewal on an unheld lease must report false");

        let state = read_current_lease(&pool).await.unwrap();
        assert_eq!(
            state.device_id, "",
            "renewal must never claim an unheld lease — that is claim_lease's job"
        );
        assert!(
            state.expires_at.is_none(),
            "renewal on an unheld lease must not populate expires_at"
        );
    }

    #[tokio::test]
    async fn renew_after_own_lease_lapsed_is_noop() {
        let (pool, _dir) = test_pool().await;
        assert!(claim_lease(&pool, DEV_A, t0()).await.unwrap());

        // A misses every renewal; its own lease lapses.  A late renewal
        // must NOT resurrect it — re-seizure belongs to claim_lease on
        // the reconcile path so a sibling that grabbed the stale lease
        // is respected.
        let lapsed = t0() + ChronoDuration::seconds(LEASE_EXPIRY_SECS.cast_signed() + 1);
        let renewed = renew_lease(&pool, DEV_A, lapsed).await.unwrap();
        assert!(
            !renewed,
            "renewing an already-lapsed own lease must be a no-op"
        );

        // The stale holder/expiry are left untouched for claim_lease to
        // overwrite — renewal wrote nothing.
        let state = read_current_lease(&pool).await.unwrap();
        assert!(
            !state.is_live(lapsed),
            "lapsed lease must remain not-live after a no-op renewal"
        );
    }

    #[tokio::test]
    async fn renew_does_not_interfere_after_sibling_seized() {
        let (pool, _dir) = test_pool().await;
        // A claims, lets it lapse, B seizes via the reconcile path.
        assert!(claim_lease(&pool, DEV_A, t0()).await.unwrap());
        let seize_at = t0() + ChronoDuration::seconds(LEASE_EXPIRY_SECS.cast_signed() + 1);
        assert!(claim_lease(&pool, DEV_B, seize_at).await.unwrap());

        // A's keep-alive arm fires again — it must NOT claw the lease
        // back from B; renewal only extends a hold we actually own.
        let renewed = renew_lease(&pool, DEV_A, seize_at + ChronoDuration::seconds(1))
            .await
            .unwrap();
        assert!(!renewed, "A must not renew a lease now owned by B");

        let state = read_current_lease(&pool).await.unwrap();
        assert_eq!(state.device_id, DEV_B, "B must remain the holder");
    }

    // ── #691 keep-alive cadence on the interval ────────────────────
    //
    // Proves the renewal *cadence* drives `renew_lease` once per
    // interval tick — mirroring the task-loop's `select!` keep-alive
    // arm — and that the running expiry stays ahead of
    // `LEASE_EXPIRY_SECS` across enough ticks to span more than one
    // expiry window.  Without the keep-alive the lease would lapse; with
    // it the lease is continuously held.
    //
    // We deliberately do NOT `tokio::time::pause()` here: under a paused
    // clock sqlx's connection-pool acquire timer never fires and the DB
    // calls deadlock (`PoolTimedOut`) — the very brittleness the module
    // doc warns about.  Instead we drive a real, tiny `tokio::time::
    // interval` for the *cadence* and an injected logical clock (stepped
    // by the production `LEASE_RENEW_INTERVAL_SECS`) for the *lease SQL*
    // comparisons, exactly as production does (wall-clock interval vs.
    // `clock.now()` for the lease).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn renew_interval_keeps_lease_live_across_ticks() {
        let (pool, _dir) = test_pool().await;
        // Production steps the lease clock by LEASE_RENEW_INTERVAL_SECS
        // per tick.  We keep that for the lease arithmetic but use a tiny
        // real interval so the test runs in milliseconds.
        let step = LEASE_RENEW_INTERVAL_SECS;

        // A claims at logical t0.
        assert!(claim_lease(&pool, DEV_A, t0()).await.unwrap());

        let mut renew = tokio::time::interval(std::time::Duration::from_millis(2));
        renew.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Consume the immediate first tick (interval fires at once).
        renew.tick().await;

        // Drive several keep-alive ticks; each real tick steps the
        // logical lease clock by one renewal interval and renews.
        let mut logical = t0();
        let ticks: u64 = 4;
        for i in 1..=ticks {
            renew.tick().await;
            logical += ChronoDuration::seconds(step.cast_signed());

            let ok = renew_lease(&pool, DEV_A, logical).await.unwrap();
            assert!(ok, "keep-alive renewal #{i} must succeed while A holds");

            let state = read_current_lease(&pool).await.unwrap();
            assert!(
                state.is_live(logical),
                "lease must stay live at tick #{i} (logical={logical:?})"
            );
            assert!(
                state.is_held_by(DEV_A, logical),
                "A must remain the live holder at tick #{i}"
            );
        }

        // After `ticks` renewal intervals (240 s) — longer than
        // LEASE_EXPIRY_SECS (180 s) — the lease is still live purely
        // because the keep-alive kept extending it.  Without renewal it
        // would have lapsed.
        assert!(
            (step * ticks) > LEASE_EXPIRY_SECS,
            "test precondition: total elapsed must exceed a single expiry window"
        );
        let final_state = read_current_lease(&pool).await.unwrap();
        assert!(
            final_state.is_held_by(DEV_A, logical),
            "lease must still be held after spanning more than one expiry window"
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
            !state.is_held_by(
                DEV_A,
                t0() + ChronoDuration::seconds(LEASE_EXPIRY_SECS.cast_signed() + 1)
            ),
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
            !state.is_live(t0() + ChronoDuration::seconds(LEASE_EXPIRY_SECS.cast_signed() + 1)),
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

    // ── L-132: batched-write atomicity ──────────────────────────────
    //
    // After the L-132 refactor `claim_lease` writes both lease cells
    // in a single `UPDATE … CASE … WHEN …` round-trip.  This test
    // asserts that on a successful claim (a) both rows reach the new
    // values together and (b) the `updated_at` column matches across
    // both rows — neither would hold if the batched UPDATE silently
    // wrote only one row.
    #[tokio::test]
    async fn claim_writes_both_lease_rows_atomically_l132() {
        let (pool, _dir) = test_pool().await;
        let now = t0();
        assert!(claim_lease(&pool, DEV_A, now).await.unwrap());

        // Read both rows directly from the table — bypass
        // `read_current_lease` so we also see `updated_at`.
        let holder_key = GcalSettingKey::PushLeaseDeviceId.as_str();
        let expires_key = GcalSettingKey::PushLeaseExpiresAt.as_str();
        let rows = sqlx::query!(
            "SELECT key, value, updated_at FROM gcal_settings WHERE key IN (?, ?)",
            holder_key,
            expires_key,
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 2, "both lease rows must exist after a claim");

        let holder_row = rows
            .iter()
            .find(|r| r.key == holder_key)
            .expect("holder row");
        let expires_row = rows
            .iter()
            .find(|r| r.key == expires_key)
            .expect("expires row");

        assert_eq!(holder_row.value, DEV_A, "holder row updated to DEV_A");
        assert!(
            !expires_row.value.is_empty(),
            "expires row updated to a non-empty timestamp"
        );
        assert_eq!(
            holder_row.updated_at, expires_row.updated_at,
            "batched UPDATE must stamp both rows with the same updated_at, \
             got holder='{:?}' expires='{:?}'",
            holder_row.updated_at, expires_row.updated_at
        );
    }

    // ── TEST-51: concurrent claim race ─────────────────────────────
    //
    // Two devices race for the lease at the *same* logical clock.  The
    // existing tests above all serialise their `t0() + Ns` clocks; this
    // one demonstrates that even when two `claim_lease` calls overlap
    // on the wall clock, SQLite's `BEGIN IMMEDIATE` serialises the
    // writers and exactly one device wins the lease — the other
    // observes the live holder and returns `Ok(false)`.
    //
    // We assert the *exclusive-or* shape (one `Ok(true)`, one
    // `Ok(false)`) rather than which device wins — the scheduler is
    // free to interleave either way.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_claim_two_devices_serialise_to_exactly_one_winner() {
        let (pool, _dir) = test_pool().await;
        let now = t0();

        // Spawn both claims at the same `now` so neither has a
        // freshness advantage.  Cloning the pool is cheap (Arc) and
        // matches the production wiring where each connector handler
        // task holds its own clone.
        let pool_a = pool.clone();
        let pool_b = pool.clone();

        let handle_a = tokio::spawn(async move { claim_lease(&pool_a, DEV_A, now).await });
        let handle_b = tokio::spawn(async move { claim_lease(&pool_b, DEV_B, now).await });

        let (res_a, res_b) = tokio::join!(handle_a, handle_b);
        let res_a = res_a
            .expect("task A joined")
            .expect("claim_lease A returned Ok");
        let res_b = res_b
            .expect("task B joined")
            .expect("claim_lease B returned Ok");

        // Exactly one winner.  XOR over the two booleans.
        assert!(
            res_a ^ res_b,
            "exactly one device must win the lease under concurrent claim, got A={res_a} B={res_b}"
        );

        // Whichever device returned `true` must now hold the lease in
        // the DB, and the other must NOT be the holder.
        let state = read_current_lease(&pool).await.unwrap();
        let expected_holder = if res_a { DEV_A } else { DEV_B };
        assert_eq!(
            state.device_id, expected_holder,
            "DB must reflect the winning claim"
        );
        assert!(
            state.expires_at.is_some(),
            "winning claim must populate expires_at"
        );
    }
}
