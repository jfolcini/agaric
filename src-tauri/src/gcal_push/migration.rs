//! FEAT-3p9 Milestone 1 — one-shot bootstrap that copies the legacy
//! single-space Google Calendar config + OAuth tokens into the
//! per-space `gcal_space_config` row keyed by
//! [`SPACE_PERSONAL_ULID`].
//!
//! M1 leaves the existing `gcal_settings` table + connector / oauth /
//! lease / commands code paths untouched. The migration rewrites only
//! the new pieces it owns:
//!
//! - inserts (or updates, defensively) the per-space config row for
//!   the seeded "Personal" space; and
//! - rewrites the legacy keychain entry (`oauth_tokens`) into the
//!   per-space-suffixed entry (`oauth_tokens_<SPACE_PERSONAL_ULID>`)
//!   via two `TokenStore` arguments wired by the caller.
//!
//! The whole thing is idempotent: a `gcal_per_space_migrated` row in
//! `gcal_settings` (TEXT, value `"true"`) gates re-runs. Crash-safe:
//! every step is independently observable, partial failures only set
//! the flag once everything finished.
//!
//! M2 will switch the production code paths over to read/write the
//! per-space row + per-space keychain entry. Until then the legacy
//! `gcal_settings` row keeps working — that is the whole point of the
//! purely-additive M1.
//!
//! [`SPACE_PERSONAL_ULID`]: crate::spaces::bootstrap::SPACE_PERSONAL_ULID

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::now_rfc3339;
use crate::spaces::bootstrap::SPACE_PERSONAL_ULID;

use super::keyring_store::{GcalEventEmitter, TokenStore};
use super::models::{self, GcalSpaceConfig};

/// `gcal_settings` key gating one-shot migration re-runs. Stored as
/// `"true"` once the migration has completed; absent or `"false"`
/// means "still to do / partially done".
const MIGRATION_FLAG_KEY: &str = "gcal_per_space_migrated";

/// Migrate the legacy single-space GCal config and OAuth tokens into
/// the per-space `gcal_space_config` row keyed by
/// [`SPACE_PERSONAL_ULID`].
///
/// Idempotent: a `gcal_per_space_migrated` setting in `gcal_settings`
/// (TEXT, value `"true"`) gates the migration so it runs at most once
/// per device. Crash-safe: each step (DB row copy, keychain entry
/// rewrite, flag set) is independently observable, and on partial
/// failure the next call resumes by re-checking the flag and the
/// already-migrated state.
///
/// # Failure model
///
/// - DB error → return [`AppError::Database`] (caller logs + retries
///   on next boot).
/// - Keychain unavailable → log warning, copy the DB row anyway, do
///   NOT set the flag (so the next boot retries the keychain step).
///   Returns `Ok(())` — the migration has not failed permanently, it
///   is just incomplete and idempotent retry handles it.
/// - No legacy connection (`gcal_settings.calendar_id == ""` AND the
///   legacy keychain has no token entry) → set the flag and return
///   immediately. Nothing to migrate.
///
/// # Errors
///
/// [`AppError::Database`] on SQL errors. Keychain failures do **not**
/// surface as errors (the function returns `Ok(())` after logging) so
/// the connector can keep booting; the next call resumes the keychain
/// step.
pub async fn migrate_legacy_gcal_to_personal_space(
    pool: &SqlitePool,
    legacy_token_store: &dyn TokenStore,
    personal_token_store: &dyn TokenStore,
    _emitter: &dyn GcalEventEmitter,
    now: DateTime<Utc>,
) -> Result<(), AppError> {
    // Step 1: fast-path on the idempotency flag.
    if read_migration_flag(pool).await? {
        tracing::debug!(
            target: "gcal",
            "gcal_per_space_migrated flag already set; skipping FEAT-3p9 M1 migration"
        );
        return Ok(());
    }

    // Step 2: read every legacy `gcal_settings` row we care about.
    let legacy = read_legacy_settings(pool).await?;

    // Step 2b: try to load the legacy keychain entry. If the load
    // itself fails (e.g. keyring unavailable on a headless box), we
    // can neither decide nothing-to-migrate nor do the per-space copy
    // — log, leave the flag unset, and let the next boot retry.
    let legacy_token = match legacy_token_store.load().await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(
                target: "gcal",
                error = %e,
                "FEAT-3p9 M1 migration: legacy keychain load failed; \
                 leaving gcal_per_space_migrated unset for next-boot retry"
            );
            return Ok(());
        }
    };

    // Step 2c: nothing-to-migrate fast-path.
    if legacy.calendar_id.is_empty() && legacy_token.is_none() {
        tracing::info!(
            target: "gcal",
            legacy_calendar_id = "",
            migrated = false,
            keychain_migrated = false,
            "FEAT-3p9 M1 migration: no legacy GCal connection; setting flag and returning"
        );
        set_migration_flag(pool).await?;
        return Ok(());
    }

    // Step 3: defence-in-depth — skip the DB upsert when a row already
    // exists for SPACE_PERSONAL_ULID (should not happen in M1, but
    // means we never accidentally clobber a future row a later phase
    // wrote first).
    let existing = models::get_space_config(pool, SPACE_PERSONAL_ULID).await?;
    if existing.is_none() {
        let config = build_personal_space_config(&legacy, now);
        // Step 4: persist the per-space row.
        models::upsert_space_config(pool, &config).await?;
    }

    // Step 5: migrate the keychain entry (if any).
    let mut keychain_migrated = false;
    if let Some(token) = legacy_token {
        match personal_token_store.store(&token).await {
            Ok(()) => {
                keychain_migrated = true;
                // Failing to delete the legacy entry is non-fatal —
                // the per-space entry already shadows it for new
                // call sites and the legacy entry will be cleaned up
                // on the next disconnect (M2+).
                if let Err(e) = legacy_token_store.clear().await {
                    tracing::warn!(
                        target: "gcal",
                        error = %e,
                        "FEAT-3p9 M1 migration: failed to clear legacy \
                         keychain entry after copying — continuing"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    target: "gcal",
                    error = %e,
                    "FEAT-3p9 M1 migration: per-space keychain store failed; \
                     DB row already migrated, leaving flag unset for retry"
                );
                return Ok(());
            }
        }
    }

    // Step 6: mark the migration complete only after every step that
    // could fail has succeeded.
    set_migration_flag(pool).await?;

    tracing::info!(
        target: "gcal",
        legacy_calendar_id = %legacy.calendar_id,
        migrated = true,
        keychain_migrated,
        "FEAT-3p9 M1 migration: legacy GCal config copied to Personal space"
    );
    Ok(())
}

/// The six legacy `gcal_settings` rows the migration consumes.
struct LegacySettings {
    calendar_id: String,
    privacy_mode: String,
    window_days: i64,
    push_lease_device_id: String,
    push_lease_expires_at: String,
    oauth_account_email: String,
}

/// Read every legacy `gcal_settings` row touched by this migration.
/// Empty / missing rows fall back to spec defaults so the migration
/// never panics on a partly-corrupted seed.
async fn read_legacy_settings(pool: &SqlitePool) -> Result<LegacySettings, AppError> {
    use models::GcalSettingKey::{
        CalendarId, OauthAccountEmail, PrivacyMode, PushLeaseDeviceId, PushLeaseExpiresAt,
        WindowDays,
    };

    let calendar_id = models::get_setting(pool, CalendarId)
        .await?
        .unwrap_or_default();
    let privacy_mode = models::get_setting(pool, PrivacyMode)
        .await?
        .unwrap_or_else(|| "full".to_owned());
    // window_days is stored as a string ("30") in the legacy KV.
    // Fall back to 30 on parse / missing-row failure.
    let window_days = models::get_setting(pool, WindowDays)
        .await?
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(30);
    let push_lease_device_id = models::get_setting(pool, PushLeaseDeviceId)
        .await?
        .unwrap_or_default();
    let push_lease_expires_at = models::get_setting(pool, PushLeaseExpiresAt)
        .await?
        .unwrap_or_default();
    let oauth_account_email = models::get_setting(pool, OauthAccountEmail)
        .await?
        .unwrap_or_default();

    Ok(LegacySettings {
        calendar_id,
        privacy_mode,
        window_days,
        push_lease_device_id,
        push_lease_expires_at,
        oauth_account_email,
    })
}

/// Compose the per-space row for the seeded Personal space from the
/// legacy KV snapshot.
fn build_personal_space_config(legacy: &LegacySettings, now: DateTime<Utc>) -> GcalSpaceConfig {
    let mut cfg = models::default_space_config(SPACE_PERSONAL_ULID, now);
    cfg.account_email = legacy.oauth_account_email.clone();
    cfg.calendar_id = legacy.calendar_id.clone();
    cfg.window_days = legacy.window_days;
    cfg.privacy_mode = legacy.privacy_mode.clone();
    cfg.push_lease_device_id = legacy.push_lease_device_id.clone();
    cfg.push_lease_expires_at = legacy.push_lease_expires_at.clone();
    // last_push_at + last_error are new in M1 — they have no legacy
    // analogues to copy from. Default helper already leaves them empty.
    cfg
}

/// Read the `gcal_per_space_migrated` flag. Treats a missing row as
/// `"false"` (= migration still to do) so this works on a freshly
/// migrated DB where only the six seeded keys are present.
async fn read_migration_flag(pool: &SqlitePool) -> Result<bool, AppError> {
    let row = sqlx::query_scalar!(
        "SELECT value FROM gcal_settings WHERE key = ?",
        MIGRATION_FLAG_KEY,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.as_deref() == Some("true"))
}

/// Set the `gcal_per_space_migrated` flag to `"true"` via
/// `INSERT OR REPLACE` so the row is created on first run and updated
/// on any future re-run (re-run never happens in practice — the flag
/// is the gate for re-running — but `OR REPLACE` keeps the call
/// idempotent if it ever does).
async fn set_migration_flag(pool: &SqlitePool) -> Result<(), AppError> {
    let updated_at = now_rfc3339();
    sqlx::query!(
        "INSERT OR REPLACE INTO gcal_settings (key, value, updated_at) \
         VALUES (?, 'true', ?)",
        MIGRATION_FLAG_KEY,
        updated_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::gcal_push::keyring_store::{
        MockTokenStore, NoopEventEmitter, RecordingEventEmitter,
    };
    use crate::gcal_push::oauth::Token;
    use chrono::TimeZone;
    use secrecy::{ExposeSecret, SecretString};
    use std::path::PathBuf;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    fn fixed_now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 4, 22, 10, 30, 0).unwrap()
    }

    fn sample_token() -> Token {
        Token {
            access: SecretString::from("ACCESS-TOKEN-ABC"),
            refresh: SecretString::from("REFRESH-TOKEN-XYZ"),
            expires_at: Utc.with_ymd_and_hms(2026, 4, 22, 11, 30, 0).unwrap(),
        }
    }

    /// Seed the legacy `gcal_settings` row that represents a
    /// "connected" install (calendar_id set, privacy mode minimal,
    /// push lease held by some device).
    async fn seed_connected_legacy_settings(pool: &SqlitePool) {
        sqlx::query("UPDATE gcal_settings SET value = ? WHERE key = 'calendar_id'")
            .bind("legacy_cal_id_123")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("UPDATE gcal_settings SET value = ? WHERE key = 'privacy_mode'")
            .bind("minimal")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("UPDATE gcal_settings SET value = ? WHERE key = 'window_days'")
            .bind("14")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("UPDATE gcal_settings SET value = ? WHERE key = 'push_lease_device_id'")
            .bind("device-legacy")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("UPDATE gcal_settings SET value = ? WHERE key = 'push_lease_expires_at'")
            .bind("2026-04-22T11:00:00Z")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("UPDATE gcal_settings SET value = ? WHERE key = 'oauth_account_email'")
            .bind("user@example.com")
            .execute(pool)
            .await
            .unwrap();
    }

    // ── Happy path ──────────────────────────────────────────────────

    #[tokio::test]
    async fn happy_path_migrates_db_row_and_keychain_and_sets_flag() {
        let (pool, _dir) = test_pool().await;
        seed_connected_legacy_settings(&pool).await;

        let legacy = MockTokenStore::new();
        legacy.store(&sample_token()).await.unwrap();
        let personal = MockTokenStore::new();
        let emitter = NoopEventEmitter;

        migrate_legacy_gcal_to_personal_space(&pool, &legacy, &personal, &emitter, fixed_now())
            .await
            .unwrap();

        // DB row exists with legacy values copied across.
        let cfg = models::get_space_config(&pool, SPACE_PERSONAL_ULID)
            .await
            .unwrap()
            .expect("Personal-space row must be created");
        assert_eq!(cfg.calendar_id, "legacy_cal_id_123");
        assert_eq!(cfg.privacy_mode, "minimal");
        assert_eq!(cfg.window_days, 14);
        assert_eq!(cfg.push_lease_device_id, "device-legacy");
        assert_eq!(cfg.push_lease_expires_at, "2026-04-22T11:00:00Z");
        assert_eq!(cfg.account_email, "user@example.com");

        // Per-space keychain has the token.
        let migrated_token = personal
            .load()
            .await
            .unwrap()
            .expect("personal keychain must hold the token");
        assert_eq!(
            migrated_token.access.expose_secret(),
            sample_token().access.expose_secret(),
        );

        // Legacy keychain is cleared.
        assert!(legacy.load().await.unwrap().is_none());

        // Idempotency flag is set.
        assert!(read_migration_flag(&pool).await.unwrap());

        // Second call is a no-op.
        let listed_before = models::list_space_configs(&pool).await.unwrap();
        migrate_legacy_gcal_to_personal_space(&pool, &legacy, &personal, &emitter, fixed_now())
            .await
            .unwrap();
        let listed_after = models::list_space_configs(&pool).await.unwrap();
        assert_eq!(
            listed_before, listed_after,
            "second call must not mutate per-space rows"
        );
    }

    // ── Nothing to migrate ──────────────────────────────────────────

    #[tokio::test]
    async fn nothing_to_migrate_sets_flag_and_creates_no_row() {
        let (pool, _dir) = test_pool().await;
        // Seeded legacy settings have empty calendar_id; no token in the
        // legacy keychain. Nothing to migrate.
        let legacy = MockTokenStore::new();
        let personal = MockTokenStore::new();
        let emitter = NoopEventEmitter;

        migrate_legacy_gcal_to_personal_space(&pool, &legacy, &personal, &emitter, fixed_now())
            .await
            .unwrap();

        assert!(
            models::list_space_configs(&pool).await.unwrap().is_empty(),
            "no-op migration must not create any per-space row"
        );
        assert!(read_migration_flag(&pool).await.unwrap());

        // Second call is also a no-op.
        migrate_legacy_gcal_to_personal_space(&pool, &legacy, &personal, &emitter, fixed_now())
            .await
            .unwrap();
        assert!(models::list_space_configs(&pool).await.unwrap().is_empty());
    }

    // ── Partial state: DB only ──────────────────────────────────────

    #[tokio::test]
    async fn db_row_only_migrates_db_and_sets_flag() {
        let (pool, _dir) = test_pool().await;
        seed_connected_legacy_settings(&pool).await;
        // Connected DB but no token in the legacy keychain.
        let legacy = MockTokenStore::new();
        let personal = MockTokenStore::new();
        let emitter = NoopEventEmitter;

        migrate_legacy_gcal_to_personal_space(&pool, &legacy, &personal, &emitter, fixed_now())
            .await
            .unwrap();

        let cfg = models::get_space_config(&pool, SPACE_PERSONAL_ULID)
            .await
            .unwrap()
            .expect("DB row must be migrated even without a keychain token");
        assert_eq!(cfg.calendar_id, "legacy_cal_id_123");
        assert!(personal.load().await.unwrap().is_none());
        assert!(read_migration_flag(&pool).await.unwrap());
    }

    // ── Partial state: token only ───────────────────────────────────

    #[tokio::test]
    async fn token_only_migrates_token_and_sets_flag() {
        let (pool, _dir) = test_pool().await;
        // Legacy DB is at spec defaults (calendar_id == ""), but the
        // keychain has a token. Unusual but keeps idempotency clean.
        let legacy = MockTokenStore::new();
        legacy.store(&sample_token()).await.unwrap();
        let personal = MockTokenStore::new();
        let emitter = NoopEventEmitter;

        migrate_legacy_gcal_to_personal_space(&pool, &legacy, &personal, &emitter, fixed_now())
            .await
            .unwrap();

        // Per-space row is still created (with empty calendar_id) so
        // the per-space data model has a place to land.
        let cfg = models::get_space_config(&pool, SPACE_PERSONAL_ULID)
            .await
            .unwrap()
            .expect("token-only migration still creates the per-space row");
        assert_eq!(cfg.calendar_id, "");

        let migrated_token = personal
            .load()
            .await
            .unwrap()
            .expect("personal keychain must hold the token");
        assert_eq!(
            migrated_token.access.expose_secret(),
            sample_token().access.expose_secret(),
        );
        assert!(legacy.load().await.unwrap().is_none());
        assert!(read_migration_flag(&pool).await.unwrap());
    }

    // ── Pre-existing per-space row ──────────────────────────────────

    #[tokio::test]
    async fn pre_existing_personal_row_is_not_overwritten_but_flag_is_set() {
        let (pool, _dir) = test_pool().await;
        seed_connected_legacy_settings(&pool).await;

        // Pre-existing row written by some earlier code path.
        let mut existing = models::default_space_config(SPACE_PERSONAL_ULID, fixed_now());
        existing.calendar_id = "pre_existing_cal".into();
        existing.privacy_mode = "full".into();
        existing.window_days = 90;
        models::upsert_space_config(&pool, &existing).await.unwrap();

        let legacy = MockTokenStore::new();
        legacy.store(&sample_token()).await.unwrap();
        let personal = MockTokenStore::new();
        let emitter = NoopEventEmitter;

        migrate_legacy_gcal_to_personal_space(&pool, &legacy, &personal, &emitter, fixed_now())
            .await
            .unwrap();

        // Pre-existing row preserved.
        let cfg = models::get_space_config(&pool, SPACE_PERSONAL_ULID)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cfg.calendar_id, "pre_existing_cal");
        assert_eq!(cfg.window_days, 90);
        // Keychain step still ran.
        assert!(personal.load().await.unwrap().is_some());
        assert!(read_migration_flag(&pool).await.unwrap());
    }

    // ── Keychain unavailable on store ───────────────────────────────

    #[tokio::test]
    async fn keychain_unavailable_migrates_db_but_does_not_set_flag() {
        let (pool, _dir) = test_pool().await;
        seed_connected_legacy_settings(&pool).await;

        let legacy = MockTokenStore::new();
        legacy.store(&sample_token()).await.unwrap();

        // First-call personal store fails on every `store(...)` to
        // simulate `keyring.unavailable`.
        let personal = MockTokenStore::new();
        personal.inject_store_error("keyring.unavailable: simulated");
        let emitter = NoopEventEmitter;

        migrate_legacy_gcal_to_personal_space(&pool, &legacy, &personal, &emitter, fixed_now())
            .await
            .unwrap();

        // DB row was still upserted.
        let cfg = models::get_space_config(&pool, SPACE_PERSONAL_ULID)
            .await
            .unwrap()
            .expect("DB row migrates even on keychain failure");
        assert_eq!(cfg.calendar_id, "legacy_cal_id_123");

        // Per-space store is empty (the simulated failure rejected the write).
        assert!(personal.load().await.unwrap().is_none());

        // Legacy keychain still has the token (we only clear after a
        // successful per-space write).
        assert!(legacy.load().await.unwrap().is_some());

        // Flag is NOT set — next boot retries.
        assert!(!read_migration_flag(&pool).await.unwrap());

        // Second call retries the keychain step. Construct a fresh
        // `personal` that succeeds and re-run.
        let personal_retry = MockTokenStore::new();
        migrate_legacy_gcal_to_personal_space(
            &pool,
            &legacy,
            &personal_retry,
            &emitter,
            fixed_now(),
        )
        .await
        .unwrap();

        assert!(personal_retry.load().await.unwrap().is_some());
        assert!(legacy.load().await.unwrap().is_none());
        assert!(read_migration_flag(&pool).await.unwrap());
    }

    // ── Idempotency end-to-end ──────────────────────────────────────

    #[tokio::test]
    async fn calling_migration_twice_produces_identical_end_state() {
        let (pool, _dir) = test_pool().await;
        seed_connected_legacy_settings(&pool).await;

        let legacy = MockTokenStore::new();
        legacy.store(&sample_token()).await.unwrap();
        let personal = MockTokenStore::new();
        let emitter = NoopEventEmitter;

        migrate_legacy_gcal_to_personal_space(&pool, &legacy, &personal, &emitter, fixed_now())
            .await
            .unwrap();

        let cfg_first = models::get_space_config(&pool, SPACE_PERSONAL_ULID)
            .await
            .unwrap()
            .unwrap();
        let token_first = personal.load().await.unwrap();
        let flag_first = read_migration_flag(&pool).await.unwrap();

        migrate_legacy_gcal_to_personal_space(&pool, &legacy, &personal, &emitter, fixed_now())
            .await
            .unwrap();

        let cfg_second = models::get_space_config(&pool, SPACE_PERSONAL_ULID)
            .await
            .unwrap()
            .unwrap();
        let token_second = personal.load().await.unwrap();
        let flag_second = read_migration_flag(&pool).await.unwrap();

        // Per-space row, keychain entry, and flag are all unchanged.
        assert_eq!(cfg_first, cfg_second);
        assert_eq!(
            token_first
                .as_ref()
                .map(|t| t.access.expose_secret().to_owned()),
            token_second
                .as_ref()
                .map(|t| t.access.expose_secret().to_owned()),
        );
        assert_eq!(flag_first, flag_second);
        assert!(flag_second);
    }

    // ── Flag is honoured on entry ───────────────────────────────────

    #[tokio::test]
    async fn flag_already_true_short_circuits_without_touching_anything() {
        let (pool, _dir) = test_pool().await;
        // Set the flag manually to simulate a prior successful run.
        set_migration_flag(&pool).await.unwrap();
        // Seed a "connected" legacy state — if the migration ran, it
        // would copy this; the flag must short-circuit it.
        seed_connected_legacy_settings(&pool).await;

        let legacy = MockTokenStore::new();
        legacy.store(&sample_token()).await.unwrap();
        let personal = MockTokenStore::new();
        let emitter = RecordingEventEmitter::new();

        migrate_legacy_gcal_to_personal_space(&pool, &legacy, &personal, &emitter, fixed_now())
            .await
            .unwrap();

        // No per-space row created.
        assert!(models::list_space_configs(&pool).await.unwrap().is_empty());
        // Legacy keychain untouched.
        assert!(legacy.load().await.unwrap().is_some());
        assert!(personal.load().await.unwrap().is_none());
    }
}
