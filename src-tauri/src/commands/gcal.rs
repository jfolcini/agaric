//! FEAT-5e — Tauri commands backing the Settings "Google Calendar"
//! tab.  Consumed from the frontend in FEAT-5f.
//!
//! Five commands:
//!
//! * `get_gcal_status` — connection + lease snapshot for the Settings
//!   tab.
//! * `force_gcal_resync` — fire-and-forget full-window resync.  Wakes
//!   the connector task via [`crate::gcal_push::connector::GcalConnectorHandle::force_resync`].
//! * `disconnect_gcal { delete_calendar }` — clears OAuth tokens +
//!   emits `gcal:push_disabled`.  Optionally deletes the GCal calendar.
//! * `set_gcal_window_days(n)` — persists the window clamped to
//!   `[7, 90]`.
//! * `set_gcal_privacy_mode(mode)` — persists `"full"` or `"minimal"`.
//!
//! Each command has an `inner_*` function taking `&SqlitePool` + trait
//! objects for testability — the Tauri wrapper is the only part that
//! touches `AppHandle` / `State`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::gcal_push::connector::{GcalClient, GcalConnectorHandle};
use crate::gcal_push::keyring_store::{GcalEvent, GcalEventEmitter, TokenStore};
use crate::gcal_push::lease::{self, LeaseState};
use crate::gcal_push::models::{self, GcalSettingKey};

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/// Holder metadata for the push-lease, surfaced to the Settings tab so
/// users can see which device is currently pushing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LeaseHolder {
    pub held_by_this_device: bool,
    pub device_id: Option<String>,
    pub expires_at: Option<String>,
}

/// Full status snapshot for the Settings tab.  `connected` reflects
/// the presence of an OAuth token in the keychain; `calendar_id` is
/// only populated after the first push-cycle has created the
/// dedicated calendar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GcalStatus {
    pub enabled: bool,
    pub connected: bool,
    pub account_email: Option<String>,
    pub calendar_id: Option<String>,
    pub window_days: i64,
    pub privacy_mode: String,
    pub last_push_at: Option<String>,
    pub last_error: Option<String>,
    pub push_lease: LeaseHolder,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Convert a [`LeaseState`] into the frontend-facing [`LeaseHolder`]
/// shape, given this device's id.
fn lease_state_to_holder(state: &LeaseState, this_device: &str) -> LeaseHolder {
    LeaseHolder {
        held_by_this_device: !state.device_id.is_empty() && state.device_id == this_device,
        device_id: if state.device_id.is_empty() {
            None
        } else {
            Some(state.device_id.clone())
        },
        expires_at: state
            .expires_at
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    }
}

fn optionalize(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

async fn last_push_at(pool: &SqlitePool) -> Result<Option<String>, AppError> {
    // Most-recent `last_pushed_at` across every row in
    // `gcal_agenda_event_map`.  `SELECT MAX(...)` returns `NULL` when
    // the table is empty — mapped to `None`.
    let row = sqlx::query!("SELECT MAX(last_pushed_at) AS ts FROM gcal_agenda_event_map")
        .fetch_one(pool)
        .await?;
    Ok(row.ts.filter(|s| !s.is_empty()))
}

// ---------------------------------------------------------------------------
// get_gcal_status
// ---------------------------------------------------------------------------

/// Pure implementation of [`get_gcal_status`] — the Tauri wrapper just
/// resolves managed state and forwards here.
pub async fn get_gcal_status_inner(
    pool: &SqlitePool,
    token_store: &Arc<dyn TokenStore>,
    this_device: &str,
) -> Result<GcalStatus, AppError> {
    let connected = token_store.load().await?.is_some();
    let account_email = models::get_setting(pool, GcalSettingKey::OauthAccountEmail)
        .await?
        .unwrap_or_default();
    let calendar_id = models::get_setting(pool, GcalSettingKey::CalendarId)
        .await?
        .unwrap_or_default();
    let privacy_mode = models::get_setting(pool, GcalSettingKey::PrivacyMode)
        .await?
        .unwrap_or_else(|| "full".to_owned());
    let window_raw = models::get_setting(pool, GcalSettingKey::WindowDays)
        .await?
        .unwrap_or_default();
    let window_days = window_raw
        .parse::<i64>()
        .unwrap_or(crate::gcal_push::connector::DEFAULT_WINDOW_DAYS);
    let push_lease = lease::read_current_lease(pool).await?;
    let last_push = last_push_at(pool).await?;

    Ok(GcalStatus {
        enabled: connected,
        connected,
        account_email: optionalize(account_email),
        calendar_id: optionalize(calendar_id),
        window_days,
        privacy_mode,
        last_push_at: last_push,
        last_error: None, // FEAT-5f wires in-memory last-error surface
        push_lease: lease_state_to_holder(&push_lease, this_device),
    })
}

// ---------------------------------------------------------------------------
// force_gcal_resync
// ---------------------------------------------------------------------------

/// Pure implementation of [`force_gcal_resync`].  The handle's
/// `force_resync()` method is infallible; the inner fn returns the
/// assertable result for tests.
pub fn force_gcal_resync_inner(handle: &GcalConnectorHandle) {
    handle.force_resync();
}

// ---------------------------------------------------------------------------
// disconnect_gcal
// ---------------------------------------------------------------------------

/// Pure implementation of [`disconnect_gcal`].  Clears OAuth tokens,
/// emits `gcal:push_disabled`, and optionally deletes the dedicated
/// calendar.  All steps are idempotent — the user may click disconnect
/// multiple times without error.
pub async fn disconnect_gcal_inner<C: GcalClient + ?Sized>(
    pool: &SqlitePool,
    client: &C,
    token_store: &Arc<dyn TokenStore>,
    emitter: &Arc<dyn GcalEventEmitter>,
    delete_calendar: bool,
) -> Result<(), AppError> {
    // Load a token for the optional calendar-delete call BEFORE we
    // clear the store.  If the token is gone we cannot delete remotely;
    // that is a soft failure (logged, no error surfaced).
    let token = if delete_calendar {
        token_store.load().await?
    } else {
        None
    };

    // Optional remote delete.  If the token is missing OR the client
    // fails, we log and continue — the local cleanup MUST still happen.
    if delete_calendar {
        let calendar_id = models::get_setting(pool, GcalSettingKey::CalendarId)
            .await?
            .unwrap_or_default();
        match (token, calendar_id.as_str()) {
            (Some(tok), cid) if !cid.is_empty() => {
                if let Err(e) = client.delete_calendar(&tok, cid).await {
                    tracing::warn!(
                        target: "gcal",
                        error = %e,
                        "delete_calendar failed; continuing with local disconnect",
                    );
                }
            }
            _ => {
                tracing::warn!(
                    target: "gcal",
                    "delete_calendar requested but no token or no calendar_id — skipping remote delete",
                );
            }
        }
        // Always clear the calendar_id + wipe map rows locally.
        models::set_setting(pool, GcalSettingKey::CalendarId, "").await?;
        sqlx::query!("DELETE FROM gcal_agenda_event_map")
            .execute(pool)
            .await?;
    }

    // Clear OAuth tokens and the displayed email.  A keyring failure
    // is logged but swallowed — the UI has already toggled off.
    if let Err(e) = token_store.clear().await {
        tracing::warn!(
            target: "gcal",
            error = %e,
            "token_store.clear failed during disconnect",
        );
    }
    models::set_setting(pool, GcalSettingKey::OauthAccountEmail, "").await?;

    // Signal the frontend.
    emitter.emit(GcalEvent::PushDisabled);
    Ok(())
}

// ---------------------------------------------------------------------------
// set_gcal_window_days
// ---------------------------------------------------------------------------

/// Pure implementation of [`set_gcal_window_days`].  Input is clamped
/// to `[MIN_WINDOW_DAYS, MAX_WINDOW_DAYS]` before persistence so the
/// connector does not have to re-validate.
pub async fn set_gcal_window_days_inner(pool: &SqlitePool, n: i32) -> Result<i32, AppError> {
    let clamped = i32::try_from(
        i64::from(n).clamp(
            crate::gcal_push::connector::MIN_WINDOW_DAYS,
            crate::gcal_push::connector::MAX_WINDOW_DAYS,
        ),
    )
    .unwrap_or(crate::gcal_push::connector::DEFAULT_WINDOW_DAYS as i32);
    models::set_setting(pool, GcalSettingKey::WindowDays, &clamped.to_string()).await?;
    Ok(clamped)
}

// ---------------------------------------------------------------------------
// set_gcal_privacy_mode
// ---------------------------------------------------------------------------

/// Pure implementation of [`set_gcal_privacy_mode`].  Accepts only
/// `"full"` or `"minimal"`; any other value is rejected as
/// [`AppError::Validation`].
pub async fn set_gcal_privacy_mode_inner(pool: &SqlitePool, mode: &str) -> Result<(), AppError> {
    match mode {
        "full" | "minimal" => {
            models::set_setting(pool, GcalSettingKey::PrivacyMode, mode).await?;
            Ok(())
        }
        other => Err(AppError::Validation(format!(
            "gcal.privacy_mode.invalid: '{other}' (expected 'full' or 'minimal')"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Tauri wrappers
// ---------------------------------------------------------------------------

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_gcal_status(
    pool: tauri::State<'_, crate::db::ReadPool>,
    token_store: tauri::State<'_, GcalTokenStoreState>,
    device_id: tauri::State<'_, crate::device::DeviceId>,
) -> Result<GcalStatus, AppError> {
    get_gcal_status_inner(&pool.inner().0, &token_store.inner().0, device_id.as_str()).await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn force_gcal_resync(
    handle: tauri::State<'_, GcalConnectorHandle>,
) -> Result<(), AppError> {
    force_gcal_resync_inner(handle.inner());
    Ok(())
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn disconnect_gcal(
    pool: tauri::State<'_, crate::db::WritePool>,
    client: tauri::State<'_, GcalClientState>,
    token_store: tauri::State<'_, GcalTokenStoreState>,
    emitter: tauri::State<'_, GcalEventEmitterState>,
    delete_calendar: bool,
) -> Result<(), AppError> {
    disconnect_gcal_inner(
        &pool.inner().0,
        client.inner().0.as_ref(),
        &token_store.inner().0,
        &emitter.inner().0,
        delete_calendar,
    )
    .await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn set_gcal_window_days(
    pool: tauri::State<'_, crate::db::WritePool>,
    n: i32,
) -> Result<i32, AppError> {
    set_gcal_window_days_inner(&pool.inner().0, n).await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn set_gcal_privacy_mode(
    pool: tauri::State<'_, crate::db::WritePool>,
    mode: String,
) -> Result<(), AppError> {
    set_gcal_privacy_mode_inner(&pool.inner().0, &mode).await
}

// ---------------------------------------------------------------------------
// Managed-state wrappers (so tauri::State resolves over trait objects)
// ---------------------------------------------------------------------------

/// Newtype wrapping the `Arc<dyn TokenStore>` so Tauri managed state
/// can hold the trait object without `TokenStore` having to be a
/// concrete type.
pub struct GcalTokenStoreState(pub Arc<dyn TokenStore>);

/// Newtype wrapping the `Arc<dyn GcalEventEmitter>`.
pub struct GcalEventEmitterState(pub Arc<dyn GcalEventEmitter>);

/// Newtype wrapping the `Arc<dyn GcalClient>` — used by
/// [`disconnect_gcal`] to invoke `delete_calendar`.
pub struct GcalClientState(pub Arc<dyn GcalClient>);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::gcal_push::connector::testing::{dummy_token, MockGcalClient};
    use crate::gcal_push::keyring_store::{MockTokenStore, NoopEventEmitter, RecordingEventEmitter};
    use std::path::PathBuf;
    use tempfile::TempDir;

    const THIS_DEVICE: &str = "device-THIS";
    const OTHER_DEVICE: &str = "device-OTHER";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    async fn store_with(token: Option<crate::gcal_push::oauth::Token>) -> Arc<dyn TokenStore> {
        let s = MockTokenStore::new();
        if let Some(t) = token {
            s.store(&t).await.unwrap();
        }
        Arc::new(s)
    }

    fn noop_emitter() -> Arc<dyn GcalEventEmitter> {
        Arc::new(NoopEventEmitter)
    }

    // ── get_gcal_status_inner ──────────────────────────────────────

    #[tokio::test]
    async fn get_status_no_tokens_reports_disconnected() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(None).await;
        let status = get_gcal_status_inner(&pool, &store, THIS_DEVICE).await.unwrap();
        assert!(!status.connected, "no tokens → not connected");
        assert!(!status.enabled, "no tokens → not enabled");
        assert_eq!(status.account_email, None);
        assert_eq!(status.calendar_id, None);
        assert_eq!(status.privacy_mode, "full", "default privacy is 'full'");
        assert_eq!(status.window_days, 30, "default window is 30");
        assert!(!status.push_lease.held_by_this_device);
        assert_eq!(status.push_lease.device_id, None);
    }

    #[tokio::test]
    async fn get_status_connected_without_calendar_or_lease() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(Some(dummy_token())).await;
        models::set_setting(&pool, GcalSettingKey::OauthAccountEmail, "me@example.com")
            .await
            .unwrap();
        let status = get_gcal_status_inner(&pool, &store, THIS_DEVICE).await.unwrap();
        assert!(status.connected);
        assert_eq!(
            status.account_email.as_deref(),
            Some("me@example.com")
        );
        assert_eq!(status.calendar_id, None);
        assert!(!status.push_lease.held_by_this_device);
    }

    #[tokio::test]
    async fn get_status_with_calendar_and_lease_held_by_this_device() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(Some(dummy_token())).await;
        models::set_setting(&pool, GcalSettingKey::CalendarId, "cal_XYZ")
            .await
            .unwrap();
        models::set_setting(&pool, GcalSettingKey::OauthAccountEmail, "me@example.com")
            .await
            .unwrap();
        // Claim the lease as THIS_DEVICE.
        let now = chrono::Utc::now();
        assert!(lease::claim_lease(&pool, THIS_DEVICE, now).await.unwrap());

        let status = get_gcal_status_inner(&pool, &store, THIS_DEVICE).await.unwrap();
        assert_eq!(status.calendar_id.as_deref(), Some("cal_XYZ"));
        assert!(status.push_lease.held_by_this_device);
        assert_eq!(
            status.push_lease.device_id.as_deref(),
            Some(THIS_DEVICE)
        );
        assert!(
            status.push_lease.expires_at.is_some(),
            "lease expiry must be populated"
        );
    }

    #[tokio::test]
    async fn get_status_reports_lease_held_by_other_device() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(Some(dummy_token())).await;
        let now = chrono::Utc::now();
        assert!(lease::claim_lease(&pool, OTHER_DEVICE, now).await.unwrap());

        let status = get_gcal_status_inner(&pool, &store, THIS_DEVICE).await.unwrap();
        assert!(!status.push_lease.held_by_this_device);
        assert_eq!(
            status.push_lease.device_id.as_deref(),
            Some(OTHER_DEVICE),
        );
    }

    // ── set_gcal_window_days_inner ─────────────────────────────────

    #[tokio::test]
    async fn set_window_days_happy_path_persists_value() {
        let (pool, _dir) = test_pool().await;
        let got = set_gcal_window_days_inner(&pool, 30).await.unwrap();
        assert_eq!(got, 30);
        let stored = models::get_setting(&pool, GcalSettingKey::WindowDays)
            .await
            .unwrap()
            .unwrap_or_default();
        assert_eq!(stored, "30");
    }

    #[tokio::test]
    async fn set_window_days_clamps_below_min() {
        let (pool, _dir) = test_pool().await;
        let got = set_gcal_window_days_inner(&pool, 6).await.unwrap();
        assert_eq!(got, 7, "value below MIN_WINDOW_DAYS must clamp to 7");
        let stored = models::get_setting(&pool, GcalSettingKey::WindowDays)
            .await
            .unwrap()
            .unwrap_or_default();
        assert_eq!(stored, "7");
    }

    #[tokio::test]
    async fn set_window_days_clamps_above_max() {
        let (pool, _dir) = test_pool().await;
        let got = set_gcal_window_days_inner(&pool, 91).await.unwrap();
        assert_eq!(got, 90, "value above MAX_WINDOW_DAYS must clamp to 90");
        let stored = models::get_setting(&pool, GcalSettingKey::WindowDays)
            .await
            .unwrap()
            .unwrap_or_default();
        assert_eq!(stored, "90");
    }

    // ── set_gcal_privacy_mode_inner ────────────────────────────────

    #[tokio::test]
    async fn set_privacy_mode_accepts_full_and_minimal() {
        let (pool, _dir) = test_pool().await;
        set_gcal_privacy_mode_inner(&pool, "full").await.unwrap();
        assert_eq!(
            models::get_setting(&pool, GcalSettingKey::PrivacyMode)
                .await
                .unwrap()
                .as_deref(),
            Some("full"),
        );
        set_gcal_privacy_mode_inner(&pool, "minimal").await.unwrap();
        assert_eq!(
            models::get_setting(&pool, GcalSettingKey::PrivacyMode)
                .await
                .unwrap()
                .as_deref(),
            Some("minimal"),
        );
    }

    #[tokio::test]
    async fn set_privacy_mode_rejects_invalid() {
        let (pool, _dir) = test_pool().await;
        let err = set_gcal_privacy_mode_inner(&pool, "snoop").await.unwrap_err();
        assert!(
            matches!(err, AppError::Validation(ref msg) if msg.contains("gcal.privacy_mode.invalid")),
            "invalid privacy mode must surface Validation(gcal.privacy_mode.invalid), got {err:?}",
        );
    }

    // ── disconnect_gcal_inner ──────────────────────────────────────

    #[tokio::test]
    async fn disconnect_without_delete_calendar_clears_tokens_only() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(Some(dummy_token())).await;
        let client = Arc::new(MockGcalClient::new());
        let client_trait: Arc<dyn GcalClient> = client.clone();
        let recorder = Arc::new(RecordingEventEmitter::new());
        let emitter: Arc<dyn GcalEventEmitter> = recorder.clone();

        // Seed a calendar_id to verify it survives.
        models::set_setting(&pool, GcalSettingKey::CalendarId, "cal_KEEP")
            .await
            .unwrap();
        models::set_setting(&pool, GcalSettingKey::OauthAccountEmail, "me@example.com")
            .await
            .unwrap();

        disconnect_gcal_inner(&pool, client_trait.as_ref(), &store, &emitter, false)
            .await
            .unwrap();

        // Tokens cleared.
        assert!(
            store.load().await.unwrap().is_none(),
            "tokens must be cleared after disconnect"
        );
        // calendar_id preserved.
        assert_eq!(
            models::get_setting(&pool, GcalSettingKey::CalendarId)
                .await
                .unwrap()
                .as_deref(),
            Some("cal_KEEP"),
            "calendar_id must survive disconnect(delete_calendar=false)",
        );
        // account_email cleared.
        assert_eq!(
            models::get_setting(&pool, GcalSettingKey::OauthAccountEmail)
                .await
                .unwrap()
                .unwrap_or_default(),
            "",
        );
        // Mock client NOT invoked for calendar delete.
        let state = client.state.lock().await;
        let deletes = state
            .calls
            .iter()
            .filter(|c| matches!(
                c,
                crate::gcal_push::connector::testing::MockCall::DeleteCalendar { .. }
            ))
            .count();
        assert_eq!(deletes, 0, "delete_calendar must not be called");
        drop(state);
        // Event emitted.
        assert!(
            recorder.events().contains(&GcalEvent::PushDisabled),
            "push_disabled must be emitted, got {:?}",
            recorder.events()
        );
    }

    #[tokio::test]
    async fn disconnect_with_delete_calendar_invokes_mock_delete() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(Some(dummy_token())).await;
        let client = Arc::new(MockGcalClient::new());
        let client_trait: Arc<dyn GcalClient> = client.clone();
        let emitter = noop_emitter();

        models::set_setting(&pool, GcalSettingKey::CalendarId, "cal_XYZ")
            .await
            .unwrap();
        // Seed a map row to verify it is wiped.
        let entry = crate::gcal_push::models::GcalAgendaEventMap {
            date: "2026-04-22".to_owned(),
            gcal_event_id: "evt_1".to_owned(),
            last_pushed_hash: "deadbeef".to_owned(),
            last_pushed_at: crate::now_rfc3339(),
        };
        crate::gcal_push::models::upsert_event_map(&pool, &entry)
            .await
            .unwrap();

        disconnect_gcal_inner(&pool, client_trait.as_ref(), &store, &emitter, true)
            .await
            .unwrap();

        // Mock received delete_calendar.
        let state = client.state.lock().await;
        let deletes = state
            .calls
            .iter()
            .filter(|c| matches!(
                c,
                crate::gcal_push::connector::testing::MockCall::DeleteCalendar { .. }
            ))
            .count();
        assert_eq!(
            deletes, 1,
            "delete_calendar must be called exactly once when delete_calendar=true"
        );
        drop(state);

        // calendar_id cleared.
        let cal_id = models::get_setting(&pool, GcalSettingKey::CalendarId)
            .await
            .unwrap()
            .unwrap_or_default();
        assert_eq!(cal_id, "", "calendar_id must be cleared");
        // Map rows wiped.
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM gcal_agenda_event_map")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0, "event map must be wiped");
        // Tokens cleared.
        assert!(store.load().await.unwrap().is_none());
    }

    // ── force_gcal_resync_inner ────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn force_gcal_resync_inner_fires_force_sweep_notify() {
        use crate::gcal_push::connector::{DirtyEvent, GcalConnectorHandle};
        use tokio::sync::Notify;

        // Construct a handle by hand — `spawn_connector` wires the
        // same primitives in production.
        let force_sweep = Arc::new(Notify::new());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<DirtyEvent>();
        let handle = GcalConnectorHandle::__test_new(tx, force_sweep.clone());

        // Register a waiter before the call so we can observe the
        // wake-up.
        let signal = force_sweep.clone();
        let waiter = tokio::spawn(async move { signal.notified().await });
        tokio::task::yield_now().await;

        force_gcal_resync_inner(&handle);

        tokio::time::timeout(std::time::Duration::from_millis(500), waiter)
            .await
            .expect("force_resync must wake the notify")
            .expect("waiter task joined cleanly");
    }
}
