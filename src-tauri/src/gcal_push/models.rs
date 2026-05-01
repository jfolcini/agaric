//! FEAT-5a — sqlx row structs and typed helpers for the two tables that
//! back the Agaric → Google Calendar push connector.
//!
//! The tables are defined in `migrations/0032_gcal_agenda.sql`:
//!
//! * `gcal_agenda_event_map(date PK, gcal_event_id, last_pushed_hash,
//!   last_pushed_at)` — date → remote event mapping, ≤ `window_days`
//!   rows in steady state.  No secondary index; queries hit the PK.
//!
//! * `gcal_settings(key PK, value, updated_at)` — typed KV for the
//!   connector.  Six keys are seeded by the migration; their typed
//!   names live in [`GcalSettingKey`].  OAuth tokens live in the OS
//!   keychain (FEAT-5b), NOT this table.
//!
//! Nothing in this module reads or writes the op log, emits Tauri
//! events, or touches the materializer — it is pure persistence for a
//! local-device connector.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::now_rfc3339;

// ---------------------------------------------------------------------------
// Row structs
// ---------------------------------------------------------------------------

/// One row of `gcal_agenda_event_map` — the local date → remote Google
/// Calendar event mapping that carries that date's agenda digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, sqlx::FromRow)]
pub struct GcalAgendaEventMap {
    /// `YYYY-MM-DD` local calendar date (the PK).
    pub date: String,
    /// The GCal event ID returned by `events.insert`.
    pub gcal_event_id: String,
    /// Blake3 hash of the canonicalised digest body we last pushed.
    /// Compared against a freshly computed hash to decide between
    /// skip / patch / delete in the FEAT-5e connector.
    pub last_pushed_hash: String,
    /// RFC 3339 UTC timestamp of the last successful push.
    pub last_pushed_at: String,
}

/// One row of `gcal_settings` — a typed KV pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, sqlx::FromRow)]
pub struct GcalSettingRow {
    pub key: String,
    pub value: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Typed setting keys
// ---------------------------------------------------------------------------

/// The exhaustive set of keys stored in `gcal_settings`.  Using this
/// enum (instead of bare `&str` literals) across call sites stops typo
/// drift and lets the compiler catch the addition of a new key.
///
/// Every variant has a seed row created by
/// `migrations/0032_gcal_agenda.sql`, so [`get_setting`] always finds a
/// row in a freshly migrated database — a `None` return means the row
/// was subsequently deleted (indicates DB corruption or manual
/// tampering).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GcalSettingKey {
    /// Agaric-owned GCal calendar ID (from `calendars.insert`).
    /// Populated by FEAT-5e on first successful connect.
    CalendarId,
    /// `"full"` (default) or `"minimal"` — controls how much agenda
    /// detail the digest event contains (FEAT-5d).
    PrivacyMode,
    /// Integer-as-string, `[7, 90]`, default `"30"` — how many days
    /// forward the connector syncs.
    WindowDays,
    /// The device that currently holds the push lease (FEAT-5e).
    /// Empty string when unheld.
    PushLeaseDeviceId,
    /// RFC 3339 UTC expiry for the current push lease.  Empty string
    /// when unheld.
    PushLeaseExpiresAt,
    /// Email address of the connected Google account (display only —
    /// the access/refresh tokens live in the OS keychain, not here).
    ///
    /// **M-94:** the value stored here is the **unverified** `email`
    /// claim decoded from Google's ID token by
    /// [`crate::gcal_push::oauth::extract_email_from_id_token`].  Its
    /// signature is NOT checked against Google's JWKS — we trust the
    /// TLS channel to the token endpoint and nothing more.  Read this
    /// setting only for user-visible display (Settings tab "Connected
    /// as …" label, bug-report scrubbing); never use it as an
    /// authoritative identity for authorization or account-binding
    /// decisions.
    OauthAccountEmail,
}

impl GcalSettingKey {
    /// Return the exact string used as the `key` column in
    /// `gcal_settings`.  The strings here MUST match the seed
    /// statements in `migrations/0032_gcal_agenda.sql`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            GcalSettingKey::CalendarId => "calendar_id",
            GcalSettingKey::PrivacyMode => "privacy_mode",
            GcalSettingKey::WindowDays => "window_days",
            GcalSettingKey::PushLeaseDeviceId => "push_lease_device_id",
            GcalSettingKey::PushLeaseExpiresAt => "push_lease_expires_at",
            GcalSettingKey::OauthAccountEmail => "oauth_account_email",
        }
    }

    /// The six keys seeded by the migration, in declaration order.
    #[must_use]
    pub const fn all() -> [GcalSettingKey; 6] {
        [
            GcalSettingKey::CalendarId,
            GcalSettingKey::PrivacyMode,
            GcalSettingKey::WindowDays,
            GcalSettingKey::PushLeaseDeviceId,
            GcalSettingKey::PushLeaseExpiresAt,
            GcalSettingKey::OauthAccountEmail,
        ]
    }
}

// ---------------------------------------------------------------------------
// Setting helpers
// ---------------------------------------------------------------------------

/// Read a typed setting by key.
///
/// Returns `Ok(Some(value))` in the normal case, `Ok(None)` only if the
/// row has been deleted (which should never happen — the migration
/// seeds every known key).  A missing row is treated as a non-error so
/// callers can log and fall back to a sensible default during recovery.
///
/// # Errors
/// [`AppError::Database`] on SQL errors.
pub async fn get_setting(
    pool: &SqlitePool,
    key: GcalSettingKey,
) -> Result<Option<String>, AppError> {
    let key_str = key.as_str();
    let row = sqlx::query!("SELECT value FROM gcal_settings WHERE key = ?", key_str,)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.value))
}

/// Write a typed setting by key, on an arbitrary `sqlx::Executor`.
/// Use this overload when the write must run on a `Transaction`
/// (e.g. wrapped in a `BEGIN IMMEDIATE` along with sibling writes for
/// atomicity) — passing the `&mut Transaction` avoids both the
/// deadlock against an outer write lock and the loss of atomicity
/// that would happen if we routed the same UPDATE through the pool.
///
/// `key` is a raw string here (rather than a typed [`GcalSettingKey`])
/// so the generic `Executor` bound doesn't have to spell out the
/// extra constraint when callers want to interpolate
/// `GcalSettingKey::*.as_str()` inline.  Pair with [`set_setting`]
/// for the typed pool variant — that is just a thin wrapper over
/// this function.
///
/// MAINT-151(i).
///
/// # Errors
/// * [`AppError::NotFound`] — the seeded row for `key` is missing.
/// * [`AppError::Database`] — SQL error.
pub async fn set_setting_in_tx<'a, E>(executor: E, key: &str, value: &str) -> Result<(), AppError>
where
    E: sqlx::Executor<'a, Database = sqlx::Sqlite>,
{
    let updated_at = now_rfc3339();
    let result = sqlx::query!(
        "UPDATE gcal_settings SET value = ?, updated_at = ? WHERE key = ?",
        value,
        updated_at,
        key,
    )
    .execute(executor)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "gcal_settings row missing for key '{key}'"
        )));
    }
    Ok(())
}

/// Write a typed setting by key on the connection pool.  Refuses to
/// create new rows — every valid key is seeded by the migration, so
/// a zero-row update means someone deleted the seed and the caller
/// needs to know.
///
/// Thin wrapper over [`set_setting_in_tx`]; transaction-bound writers
/// should call that directly with their `&mut Transaction`.
///
/// # Errors
/// * [`AppError::NotFound`] — the seeded row for `key` is missing.
/// * [`AppError::Database`] — SQL error.
pub async fn set_setting(
    pool: &SqlitePool,
    key: GcalSettingKey,
    value: &str,
) -> Result<(), AppError> {
    set_setting_in_tx(pool, key.as_str(), value).await
}

// ---------------------------------------------------------------------------
// Event-map helpers
// ---------------------------------------------------------------------------

/// Fetch the event-map row for a given local date, if one exists.
///
/// # Errors
/// [`AppError::Database`] on SQL errors.
pub async fn get_event_map_for_date(
    pool: &SqlitePool,
    date: &str,
) -> Result<Option<GcalAgendaEventMap>, AppError> {
    let row = sqlx::query_as!(
        GcalAgendaEventMap,
        "SELECT date, gcal_event_id, last_pushed_hash, last_pushed_at \
         FROM gcal_agenda_event_map WHERE date = ?",
        date,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Insert or replace the event-map row for a date.  Idempotent — the
/// second call for the same date overwrites the first.
///
/// # Errors
/// [`AppError::Database`] on SQL errors.
pub async fn upsert_event_map(
    pool: &SqlitePool,
    entry: &GcalAgendaEventMap,
) -> Result<(), AppError> {
    sqlx::query!(
        "INSERT OR REPLACE INTO gcal_agenda_event_map \
            (date, gcal_event_id, last_pushed_hash, last_pushed_at) \
         VALUES (?, ?, ?, ?)",
        entry.date,
        entry.gcal_event_id,
        entry.last_pushed_hash,
        entry.last_pushed_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Delete the event-map row for a date.  Silent on a missing row —
/// FEAT-5e's prune sweep can call this without pre-checking.
///
/// # Errors
/// [`AppError::Database`] on SQL errors.
pub async fn delete_event_map_by_date(pool: &SqlitePool, date: &str) -> Result<(), AppError> {
    sqlx::query!("DELETE FROM gcal_agenda_event_map WHERE date = ?", date)
        .execute(pool)
        .await?;
    Ok(())
}

/// List every date currently present in the event-map, ordered
/// ascending.  FEAT-5e's prune sweep uses this to find rows outside
/// `[today, today + window_days]` when the window shrinks.
///
/// # Errors
/// [`AppError::Database`] on SQL errors.
pub async fn list_event_map_dates(pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query!("SELECT date FROM gcal_agenda_event_map ORDER BY date ASC")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| r.date).collect())
}

// ---------------------------------------------------------------------------
// FEAT-3p9 M1 — per-space config row + helpers
// ---------------------------------------------------------------------------

/// One row of `gcal_space_config` (migration `0041_gcal_space_config.sql`)
/// — the per-space split of the legacy `gcal_settings` KV.
///
/// Empty strings represent "unset" for every TEXT column (matches the
/// `gcal_settings` convention) so the schema can stay NOT NULL without
/// requiring callers to construct `Option<String>` chains.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, sqlx::FromRow)]
pub struct GcalSpaceConfig {
    /// PK — Crockford-base32 ULID of the page block flagged
    /// `is_space = "true"` (e.g. `SPACE_PERSONAL_ULID`). Not enforced
    /// by FK, mirroring the rest of the spaces properties model.
    pub space_id: String,
    /// Unverified email decoded from the OAuth ID token (display only).
    pub account_email: String,
    /// Agaric-owned Google Calendar id; empty when not connected.
    pub calendar_id: String,
    /// `[7, 90]`, default `30` — how many days forward the connector
    /// syncs for this space.
    pub window_days: i64,
    /// `"full"` (default) or `"minimal"` — privacy classification for
    /// the digest event body.
    pub privacy_mode: String,
    /// RFC 3339 UTC of the last successful push for this space; empty
    /// when never pushed.
    pub last_push_at: String,
    /// Short error category (e.g. `keyring.unavailable`); empty when
    /// the connector is healthy. Settings UI surface only.
    pub last_error: String,
    /// Device currently holding the per-space push lease; empty when
    /// unheld. M2 will populate this; M1 only migrates the legacy
    /// single-space lease into the Personal-space row.
    pub push_lease_device_id: String,
    /// RFC 3339 UTC lease expiry; empty when unheld.
    pub push_lease_expires_at: String,
    /// RFC 3339 UTC creation timestamp.
    pub created_at: String,
    /// RFC 3339 UTC last-modified timestamp; bumped on every upsert.
    pub updated_at: String,
}

/// Build a fresh-defaults `GcalSpaceConfig` for `space_id`, with
/// `created_at == updated_at == now` and every other field at its
/// migration-default value.
#[must_use]
pub fn default_space_config(space_id: &str, now: DateTime<Utc>) -> GcalSpaceConfig {
    let ts = now.to_rfc3339_opts(SecondsFormat::Secs, true);
    GcalSpaceConfig {
        space_id: space_id.to_owned(),
        account_email: String::new(),
        calendar_id: String::new(),
        window_days: 30,
        privacy_mode: "full".to_owned(),
        last_push_at: String::new(),
        last_error: String::new(),
        push_lease_device_id: String::new(),
        push_lease_expires_at: String::new(),
        created_at: ts.clone(),
        updated_at: ts,
    }
}

/// Fetch the per-space config row for `space_id`, or `Ok(None)` if it
/// has not been seeded yet.
///
/// # Errors
/// [`AppError::Database`] on SQL errors.
pub async fn get_space_config(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<Option<GcalSpaceConfig>, AppError> {
    let row = sqlx::query_as!(
        GcalSpaceConfig,
        "SELECT space_id, account_email, calendar_id, window_days, \
                privacy_mode, last_push_at, last_error, \
                push_lease_device_id, push_lease_expires_at, \
                created_at, updated_at \
         FROM gcal_space_config WHERE space_id = ?",
        space_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Insert or update the per-space config row.
///
/// On update, every column except `space_id` and `created_at` is
/// replaced from `config`, and `updated_at` is bumped to the current
/// RFC 3339 UTC timestamp via [`now_rfc3339`] (overriding whatever
/// `config.updated_at` carried).
///
/// # Errors
/// [`AppError::Database`] on SQL errors.
pub async fn upsert_space_config(
    pool: &SqlitePool,
    config: &GcalSpaceConfig,
) -> Result<(), AppError> {
    let updated_at = now_rfc3339();
    sqlx::query!(
        "INSERT INTO gcal_space_config \
            (space_id, account_email, calendar_id, window_days, privacy_mode, \
             last_push_at, last_error, push_lease_device_id, push_lease_expires_at, \
             created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(space_id) DO UPDATE SET \
            account_email         = excluded.account_email, \
            calendar_id           = excluded.calendar_id, \
            window_days           = excluded.window_days, \
            privacy_mode          = excluded.privacy_mode, \
            last_push_at          = excluded.last_push_at, \
            last_error            = excluded.last_error, \
            push_lease_device_id  = excluded.push_lease_device_id, \
            push_lease_expires_at = excluded.push_lease_expires_at, \
            updated_at            = excluded.updated_at",
        config.space_id,
        config.account_email,
        config.calendar_id,
        config.window_days,
        config.privacy_mode,
        config.last_push_at,
        config.last_error,
        config.push_lease_device_id,
        config.push_lease_expires_at,
        config.created_at,
        updated_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Delete the per-space config row, silent on a missing row.
///
/// # Errors
/// [`AppError::Database`] on SQL errors.
pub async fn delete_space_config(pool: &SqlitePool, space_id: &str) -> Result<(), AppError> {
    sqlx::query!("DELETE FROM gcal_space_config WHERE space_id = ?", space_id,)
        .execute(pool)
        .await?;
    Ok(())
}

/// List every per-space config row, ordered ascending by `space_id`
/// for deterministic test output.
///
/// # Errors
/// [`AppError::Database`] on SQL errors.
pub async fn list_space_configs(pool: &SqlitePool) -> Result<Vec<GcalSpaceConfig>, AppError> {
    let rows = sqlx::query_as!(
        GcalSpaceConfig,
        "SELECT space_id, account_email, calendar_id, window_days, \
                privacy_mode, last_push_at, last_error, \
                push_lease_device_id, push_lease_expires_at, \
                created_at, updated_at \
         FROM gcal_space_config ORDER BY space_id ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // ── Fixtures ─────────────────────────────────────────────────────

    const FIXED_DATE: &str = "2026-04-22";
    const FIXED_DATE_B: &str = "2026-04-23";
    const FIXED_EVENT_ID: &str = "gcal_evt_abc123";
    const FIXED_EVENT_ID_B: &str = "gcal_evt_def456";
    const FIXED_HASH: &str =
        "blake3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const FIXED_HASH_B: &str =
        "blake3_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const FIXED_TS: &str = "2026-04-22T10:30:00Z";
    const FIXED_TS_B: &str = "2026-04-23T10:30:00Z";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    fn sample_entry() -> GcalAgendaEventMap {
        GcalAgendaEventMap {
            date: FIXED_DATE.to_owned(),
            gcal_event_id: FIXED_EVENT_ID.to_owned(),
            last_pushed_hash: FIXED_HASH.to_owned(),
            last_pushed_at: FIXED_TS.to_owned(),
        }
    }

    // ── Migration smoke ─────────────────────────────────────────────

    #[tokio::test]
    async fn migration_creates_gcal_agenda_event_map_with_exact_columns() {
        let (pool, _dir) = test_pool().await;
        let cols: Vec<(i64, String, String, i64, Option<String>, i64)> =
            sqlx::query_as("PRAGMA table_info('gcal_agenda_event_map')")
                .fetch_all(&pool)
                .await
                .unwrap();
        let names: Vec<&str> = cols.iter().map(|c| c.1.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "date",
                "gcal_event_id",
                "last_pushed_hash",
                "last_pushed_at"
            ],
            "gcal_agenda_event_map must have the 4 spec columns in order"
        );
        // date is the PK (column 0, pk flag = 1).
        assert_eq!(cols[0].5, 1, "`date` must be the PRIMARY KEY column");
    }

    #[tokio::test]
    async fn migration_creates_gcal_settings_with_exact_columns() {
        let (pool, _dir) = test_pool().await;
        let cols: Vec<(i64, String, String, i64, Option<String>, i64)> =
            sqlx::query_as("PRAGMA table_info('gcal_settings')")
                .fetch_all(&pool)
                .await
                .unwrap();
        let names: Vec<&str> = cols.iter().map(|c| c.1.as_str()).collect();
        assert_eq!(
            names,
            vec!["key", "value", "updated_at"],
            "gcal_settings must have the 3 spec columns in order"
        );
        assert_eq!(cols[0].5, 1, "`key` must be the PRIMARY KEY column");
    }

    #[tokio::test]
    async fn migration_does_not_create_index_on_event_map() {
        // Spec line 809: "No index needed on gcal_agenda_event_map —
        // the table is tiny". Only the implicit PK auto-index should
        // exist (SQLite auto-creates these with names prefixed
        // `sqlite_autoindex_`).
        let (pool, _dir) = test_pool().await;
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master \
             WHERE type = 'index' AND tbl_name = 'gcal_agenda_event_map' \
               AND name NOT LIKE 'sqlite_autoindex_%'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(
            rows.is_empty(),
            "gcal_agenda_event_map must have no user-defined indexes, found {rows:?}"
        );
    }

    #[tokio::test]
    async fn migration_seeds_exactly_six_gcal_settings_rows() {
        let (pool, _dir) = test_pool().await;
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM gcal_settings")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 6, "migration must seed all six known keys");
    }

    #[tokio::test]
    async fn migration_seed_defaults_match_spec() {
        let (pool, _dir) = test_pool().await;
        let expected: &[(GcalSettingKey, &str)] = &[
            (GcalSettingKey::CalendarId, ""),
            (GcalSettingKey::PrivacyMode, "full"),
            (GcalSettingKey::WindowDays, "30"),
            (GcalSettingKey::PushLeaseDeviceId, ""),
            (GcalSettingKey::PushLeaseExpiresAt, ""),
            (GcalSettingKey::OauthAccountEmail, ""),
        ];
        for (key, want) in expected {
            let got = get_setting(&pool, *key).await.unwrap();
            assert_eq!(
                got.as_deref(),
                Some(*want),
                "seed value for {} must be {want:?}",
                key.as_str()
            );
        }
    }

    // ── GcalSettingKey ──────────────────────────────────────────────

    #[test]
    fn setting_key_as_str_matches_migration_seed_strings() {
        assert_eq!(GcalSettingKey::CalendarId.as_str(), "calendar_id");
        assert_eq!(GcalSettingKey::PrivacyMode.as_str(), "privacy_mode");
        assert_eq!(GcalSettingKey::WindowDays.as_str(), "window_days");
        assert_eq!(
            GcalSettingKey::PushLeaseDeviceId.as_str(),
            "push_lease_device_id"
        );
        assert_eq!(
            GcalSettingKey::PushLeaseExpiresAt.as_str(),
            "push_lease_expires_at"
        );
        assert_eq!(
            GcalSettingKey::OauthAccountEmail.as_str(),
            "oauth_account_email"
        );
    }

    #[test]
    fn setting_key_all_has_no_duplicates_and_lists_six() {
        let keys = GcalSettingKey::all();
        assert_eq!(keys.len(), 6);
        let mut strs: Vec<&str> = keys.iter().map(|k| k.as_str()).collect();
        strs.sort_unstable();
        let mut dedup = strs.clone();
        dedup.dedup();
        assert_eq!(strs, dedup, "GcalSettingKey::all() must be deduped");
    }

    // ── get_setting / set_setting ───────────────────────────────────

    #[tokio::test]
    async fn set_setting_then_get_setting_roundtrips_for_every_key() {
        let (pool, _dir) = test_pool().await;
        for (idx, key) in GcalSettingKey::all().iter().enumerate() {
            let value = format!("roundtrip-value-{idx}");
            set_setting(&pool, *key, &value).await.unwrap();
            let got = get_setting(&pool, *key).await.unwrap();
            assert_eq!(
                got.as_deref(),
                Some(value.as_str()),
                "value for {} must roundtrip",
                key.as_str()
            );
        }
    }

    #[tokio::test]
    async fn set_setting_updates_updated_at_column() {
        let (pool, _dir) = test_pool().await;

        // Read the seeded updated_at first.
        let before: (String,) =
            sqlx::query_as("SELECT updated_at FROM gcal_settings WHERE key = 'privacy_mode'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            before.0, "1970-01-01T00:00:00Z",
            "seed timestamp must be the migration sentinel"
        );

        set_setting(&pool, GcalSettingKey::PrivacyMode, "minimal")
            .await
            .unwrap();

        let after: (String,) =
            sqlx::query_as("SELECT updated_at FROM gcal_settings WHERE key = 'privacy_mode'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_ne!(
            before.0, after.0,
            "updated_at must change after set_setting"
        );
    }

    #[tokio::test]
    async fn set_setting_on_missing_seed_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        // Delete the seed row for `calendar_id` to simulate corruption.
        sqlx::query("DELETE FROM gcal_settings WHERE key = 'calendar_id'")
            .execute(&pool)
            .await
            .unwrap();

        let result = set_setting(&pool, GcalSettingKey::CalendarId, "primary").await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "set_setting on missing seed must return AppError::NotFound, got {result:?}"
        );
    }

    #[tokio::test]
    async fn get_setting_on_missing_seed_returns_ok_none() {
        let (pool, _dir) = test_pool().await;

        sqlx::query("DELETE FROM gcal_settings WHERE key = 'oauth_account_email'")
            .execute(&pool)
            .await
            .unwrap();

        let got = get_setting(&pool, GcalSettingKey::OauthAccountEmail)
            .await
            .unwrap();
        assert_eq!(
            got, None,
            "get_setting must return Ok(None) for a missing seed row"
        );
    }

    // ── event-map helpers ───────────────────────────────────────────

    #[tokio::test]
    async fn upsert_event_map_then_get_returns_exact_row() {
        let (pool, _dir) = test_pool().await;
        let entry = sample_entry();
        upsert_event_map(&pool, &entry).await.unwrap();

        let got = get_event_map_for_date(&pool, FIXED_DATE).await.unwrap();
        assert_eq!(
            got.as_ref(),
            Some(&entry),
            "event-map roundtrip must preserve every field"
        );
    }

    #[tokio::test]
    async fn get_event_map_for_date_returns_none_when_missing() {
        let (pool, _dir) = test_pool().await;
        let got = get_event_map_for_date(&pool, FIXED_DATE).await.unwrap();
        assert_eq!(got, None, "missing date must yield None");
    }

    #[tokio::test]
    async fn upsert_event_map_replaces_existing_row_for_same_date() {
        let (pool, _dir) = test_pool().await;

        let first = sample_entry();
        upsert_event_map(&pool, &first).await.unwrap();

        let second = GcalAgendaEventMap {
            date: FIXED_DATE.to_owned(),
            gcal_event_id: FIXED_EVENT_ID_B.to_owned(),
            last_pushed_hash: FIXED_HASH_B.to_owned(),
            last_pushed_at: FIXED_TS_B.to_owned(),
        };
        upsert_event_map(&pool, &second).await.unwrap();

        // Still exactly one row for that date.
        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM gcal_agenda_event_map WHERE date = ?")
                .bind(FIXED_DATE)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            count.0, 1,
            "upsert must not duplicate rows for the same date"
        );

        let got = get_event_map_for_date(&pool, FIXED_DATE)
            .await
            .unwrap()
            .expect("row must still exist");
        assert_eq!(got, second, "second upsert must fully replace first");
    }

    #[tokio::test]
    async fn delete_event_map_by_date_removes_row() {
        let (pool, _dir) = test_pool().await;
        let entry = sample_entry();
        upsert_event_map(&pool, &entry).await.unwrap();
        delete_event_map_by_date(&pool, FIXED_DATE).await.unwrap();
        let got = get_event_map_for_date(&pool, FIXED_DATE).await.unwrap();
        assert_eq!(got, None, "row must be gone after delete");
    }

    #[tokio::test]
    async fn delete_event_map_by_date_is_silent_on_missing() {
        let (pool, _dir) = test_pool().await;
        // No row for this date — delete must still succeed.
        delete_event_map_by_date(&pool, "2099-01-01").await.unwrap();
    }

    #[tokio::test]
    async fn list_event_map_dates_returns_dates_in_ascending_order() {
        let (pool, _dir) = test_pool().await;

        // Insert three dates out of order.
        let dates = ["2026-04-25", "2026-04-22", "2026-04-24"];
        for d in dates {
            upsert_event_map(
                &pool,
                &GcalAgendaEventMap {
                    date: d.to_owned(),
                    gcal_event_id: format!("evt_{d}"),
                    last_pushed_hash: FIXED_HASH.to_owned(),
                    last_pushed_at: FIXED_TS.to_owned(),
                },
            )
            .await
            .unwrap();
        }

        let listed = list_event_map_dates(&pool).await.unwrap();
        assert_eq!(
            listed,
            vec![
                "2026-04-22".to_owned(),
                "2026-04-24".to_owned(),
                "2026-04-25".to_owned(),
            ],
            "list must be ascending by date"
        );
    }

    #[tokio::test]
    async fn list_event_map_dates_returns_empty_when_no_rows() {
        let (pool, _dir) = test_pool().await;
        let listed = list_event_map_dates(&pool).await.unwrap();
        assert!(listed.is_empty(), "empty table must list zero dates");
    }

    #[tokio::test]
    async fn upsert_event_map_accepts_two_different_dates_independently() {
        let (pool, _dir) = test_pool().await;

        let a = sample_entry();
        let b = GcalAgendaEventMap {
            date: FIXED_DATE_B.to_owned(),
            gcal_event_id: FIXED_EVENT_ID_B.to_owned(),
            last_pushed_hash: FIXED_HASH_B.to_owned(),
            last_pushed_at: FIXED_TS_B.to_owned(),
        };
        upsert_event_map(&pool, &a).await.unwrap();
        upsert_event_map(&pool, &b).await.unwrap();

        let listed = list_event_map_dates(&pool).await.unwrap();
        assert_eq!(listed.len(), 2, "two distinct dates must coexist");
    }

    // ── Serde roundtrip ─────────────────────────────────────────────

    #[test]
    fn gcal_agenda_event_map_serde_roundtrip_preserves_every_field() {
        let entry = GcalAgendaEventMap {
            date: FIXED_DATE.to_owned(),
            gcal_event_id: FIXED_EVENT_ID.to_owned(),
            last_pushed_hash: FIXED_HASH.to_owned(),
            last_pushed_at: FIXED_TS.to_owned(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        let back: GcalAgendaEventMap = serde_json::from_str(&json).unwrap();
        assert_eq!(entry, back);
    }

    #[test]
    fn gcal_setting_row_serde_roundtrip_preserves_every_field() {
        let row = GcalSettingRow {
            key: "privacy_mode".to_owned(),
            value: "minimal".to_owned(),
            updated_at: FIXED_TS.to_owned(),
        };
        let json = serde_json::to_string(&row).unwrap();
        let back: GcalSettingRow = serde_json::from_str(&json).unwrap();
        assert_eq!(row, back);
    }

    // ── FEAT-3p9 M1 — gcal_space_config helpers ─────────────────────

    use chrono::TimeZone;

    const SPACE_A: &str = "00000000000000000AGAR1CPER";
    const SPACE_B: &str = "00000000000000000AGAR1CWRK";

    fn fixed_now() -> chrono::DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 4, 22, 10, 30, 0).unwrap()
    }

    #[test]
    fn default_space_config_has_migration_default_values() {
        let cfg = default_space_config(SPACE_A, fixed_now());
        assert_eq!(cfg.space_id, SPACE_A);
        assert_eq!(cfg.account_email, "");
        assert_eq!(cfg.calendar_id, "");
        assert_eq!(cfg.window_days, 30);
        assert_eq!(cfg.privacy_mode, "full");
        assert_eq!(cfg.last_push_at, "");
        assert_eq!(cfg.last_error, "");
        assert_eq!(cfg.push_lease_device_id, "");
        assert_eq!(cfg.push_lease_expires_at, "");
        assert_eq!(cfg.created_at, "2026-04-22T10:30:00Z");
        assert_eq!(cfg.updated_at, cfg.created_at);
    }

    #[tokio::test]
    async fn migration_creates_gcal_space_config_with_exact_columns() {
        let (pool, _dir) = test_pool().await;
        let cols: Vec<(i64, String, String, i64, Option<String>, i64)> =
            sqlx::query_as("PRAGMA table_info('gcal_space_config')")
                .fetch_all(&pool)
                .await
                .unwrap();
        let names: Vec<&str> = cols.iter().map(|c| c.1.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "space_id",
                "account_email",
                "calendar_id",
                "window_days",
                "privacy_mode",
                "last_push_at",
                "last_error",
                "push_lease_device_id",
                "push_lease_expires_at",
                "created_at",
                "updated_at",
            ],
            "gcal_space_config must have the 11 spec columns in order"
        );
        assert_eq!(cols[0].5, 1, "`space_id` must be the PRIMARY KEY column");
    }

    #[tokio::test]
    async fn get_space_config_on_missing_returns_none() {
        let (pool, _dir) = test_pool().await;
        let got = get_space_config(&pool, SPACE_A).await.unwrap();
        assert_eq!(got, None);
    }

    #[tokio::test]
    async fn upsert_space_config_then_get_returns_row() {
        let (pool, _dir) = test_pool().await;
        let cfg = default_space_config(SPACE_A, fixed_now());
        upsert_space_config(&pool, &cfg).await.unwrap();

        let got = get_space_config(&pool, SPACE_A)
            .await
            .unwrap()
            .expect("row must exist after upsert");
        assert_eq!(got.space_id, cfg.space_id);
        assert_eq!(got.window_days, 30);
        assert_eq!(got.privacy_mode, "full");
        assert_eq!(got.created_at, cfg.created_at);
        // updated_at is bumped to wall-clock now() by upsert, so just
        // assert it is non-empty (the contract is "always bumps").
        assert!(!got.updated_at.is_empty());
    }

    #[tokio::test]
    async fn upsert_space_config_is_idempotent_and_updates_columns() {
        let (pool, _dir) = test_pool().await;
        let mut cfg = default_space_config(SPACE_A, fixed_now());
        upsert_space_config(&pool, &cfg).await.unwrap();

        // Mutate every non-PK column and re-upsert.
        cfg.account_email = "user@example.com".into();
        cfg.calendar_id = "cal123".into();
        cfg.window_days = 14;
        cfg.privacy_mode = "minimal".into();
        cfg.last_push_at = "2026-04-22T10:31:00Z".into();
        cfg.last_error = "throttled".into();
        cfg.push_lease_device_id = "device-abc".into();
        cfg.push_lease_expires_at = "2026-04-22T11:31:00Z".into();
        upsert_space_config(&pool, &cfg).await.unwrap();

        // Still exactly one row.
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM gcal_space_config")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1, "upsert must not duplicate rows");

        let got = get_space_config(&pool, SPACE_A).await.unwrap().unwrap();
        assert_eq!(got.account_email, "user@example.com");
        assert_eq!(got.calendar_id, "cal123");
        assert_eq!(got.window_days, 14);
        assert_eq!(got.privacy_mode, "minimal");
        assert_eq!(got.last_push_at, "2026-04-22T10:31:00Z");
        assert_eq!(got.last_error, "throttled");
        assert_eq!(got.push_lease_device_id, "device-abc");
        assert_eq!(got.push_lease_expires_at, "2026-04-22T11:31:00Z");
        // created_at is preserved across upsert.
        assert_eq!(got.created_at, cfg.created_at);
    }

    #[tokio::test]
    async fn delete_space_config_removes_row() {
        let (pool, _dir) = test_pool().await;
        let cfg = default_space_config(SPACE_A, fixed_now());
        upsert_space_config(&pool, &cfg).await.unwrap();

        delete_space_config(&pool, SPACE_A).await.unwrap();
        let got = get_space_config(&pool, SPACE_A).await.unwrap();
        assert_eq!(got, None);
    }

    #[tokio::test]
    async fn delete_space_config_is_silent_on_missing() {
        let (pool, _dir) = test_pool().await;
        delete_space_config(&pool, SPACE_A).await.unwrap();
    }

    #[tokio::test]
    async fn list_space_configs_returns_rows_ordered_by_space_id() {
        let (pool, _dir) = test_pool().await;
        // Insert in reverse order — list must still come back ascending.
        let cfg_b = default_space_config(SPACE_B, fixed_now());
        upsert_space_config(&pool, &cfg_b).await.unwrap();
        let cfg_a = default_space_config(SPACE_A, fixed_now());
        upsert_space_config(&pool, &cfg_a).await.unwrap();

        let listed = list_space_configs(&pool).await.unwrap();
        let ids: Vec<&str> = listed.iter().map(|c| c.space_id.as_str()).collect();
        assert_eq!(
            ids,
            vec![SPACE_A, SPACE_B],
            "list_space_configs must order by space_id ASC"
        );
    }

    #[tokio::test]
    async fn list_space_configs_returns_empty_when_no_rows() {
        let (pool, _dir) = test_pool().await;
        let listed = list_space_configs(&pool).await.unwrap();
        assert!(listed.is_empty());
    }

    #[test]
    fn gcal_space_config_serde_roundtrip_preserves_every_field() {
        let cfg = GcalSpaceConfig {
            space_id: SPACE_A.into(),
            account_email: "u@example.com".into(),
            calendar_id: "cal".into(),
            window_days: 42,
            privacy_mode: "minimal".into(),
            last_push_at: FIXED_TS.into(),
            last_error: "err".into(),
            push_lease_device_id: "dev".into(),
            push_lease_expires_at: FIXED_TS_B.into(),
            created_at: FIXED_TS.into(),
            updated_at: FIXED_TS_B.into(),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: GcalSpaceConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(cfg, back);
    }
}
