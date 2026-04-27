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
}
